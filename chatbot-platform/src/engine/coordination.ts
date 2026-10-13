import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import type pg from 'pg';
import { pool, query } from '../db.js';
import { config } from '../config.js';

type Scope = { client: pg.PoolClient; operation: string; part: number; broken: boolean; control?: number; keys: Set<string> };
const scope = new AsyncLocalStorage<Scope>();
/** Timers/background work must never inherit a session that the parent is about to release. */
export function detached<T>(fn:()=>T):T { return scope.exit(fn); }
export class DeliveryUncertain extends Error { constructor() { super('delivery_uncertain'); } }
export class OwnershipLost extends Error { constructor() { super('worker_ownership_lost'); } }
export const currentOperation = () => scope.getStore()?.operation;
export const nextDelivery = () => { const s = scope.getStore(); return { operation: s?.operation ?? `manual:${crypto.randomUUID()}`, part: s ? s.part++ : 0 }; };
export function setControlVersion(value: number) { const s = scope.getStore(); if (s) s.control = value; }
export function controlVersion() { return scope.getStore()?.control; }
export async function operationScope<T>(operation: string, fn: () => Promise<T>) {
  const s = scope.getStore();
  return s ? scope.run({ ...s, operation, part: 0 }, fn) : fn();
}
export async function assertOwnership() {
  const s = scope.getStore();
  if (!s) return;
  if (s.broken) throw new OwnershipLost();
  try { await s.client.query('SELECT 1'); }
  catch { s.broken = true; throw new OwnershipLost(); }
}

/** Session locks cover the entire operation, including waiting for external APIs. Lease expiry alone cannot steal it. */
export async function coordinated<T>(key: string, operation: string, fn: () => Promise<T>, globalLimit = false): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const parent = scope.getStore();
  if (parent) {
    if (parent.keys.has(key)) return { acquired: true, value: await fn() };
    await assertOwnership();
    const ok = (await parent.client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok', [`riverrun:${key}`])).rows[0].ok;
    if (!ok) return { acquired: false };
    parent.keys.add(key);
    try { return { acquired: true, value: await fn() }; }
    finally { parent.keys.delete(key); await parent.client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`riverrun:${key}`]).catch(() => { parent.broken = true; }); }
  }
  const client = await pool.connect();
  const held: string[] = [];
  const s: Scope = { client, operation, part: 0, broken: false, keys: new Set([key]) };
  const onError = () => { s.broken = true; };
  client.on('error', onError);
  const lock = async (name: string) => {
    const r = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok', [`riverrun:${name}`])).rows[0];
    if (r.ok) held.push(`riverrun:${name}`);
    return r.ok === true;
  };
  try {
    if (!await lock(key)) return { acquired: false };
    if (globalLimit) {
      await client.query('INSERT INTO worker_limits(id,concurrency) VALUES(true,$1) ON CONFLICT DO NOTHING', [config.queue.concurrency]);
      const n = (await client.query('SELECT concurrency FROM worker_limits WHERE id=true')).rows[0].concurrency;
      let slot = false;
      for (let i = 0; i < n && !slot; i++) slot = await lock(`worker-slot:${i}`);
      if (!slot) return { acquired: false };
    }
    const r = await scope.run(s, fn);
    await assertOwnershipIn(s);
    return { acquired: true, value: r };
  } finally {
    for (const name of held.reverse()) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [name]).catch(() => { s.broken = true; });
    client.removeListener('error', onError);
    client.release(s.broken);
  }
}
async function assertOwnershipIn(s: Scope) {
  if (s.broken) throw new OwnershipLost();
  try { await s.client.query('SELECT 1'); } catch { s.broken = true; throw new OwnershipLost(); }
}

export async function interruptedOperation(operation: string) {
  const rows = await query('SELECT 1 FROM delivery_attempts WHERE operation_key=$1 AND state IN (\'sending\',\'sent\',\'uncertain\') LIMIT 1', [operation]);
  return rows.length > 0;
}
