import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationQueue } from '../src/engine/queue.js';

test('cerrar cancela temporizadores y rechaza trabajo nuevo', async () => {
  let calls = 0;
  const queue = new ConversationQueue(async () => { calls++; return {status:'done'}; });
  queue.schedule('pending', 60_000);
  await queue.stop();
  queue.schedule('new', 0);
  await assert.rejects(queue.exclusive('new', async () => 1), /cerrada/);
  assert.equal(queue.size, 0);
  assert.equal(calls, 0);
});

test('cerrar espera el procesamiento activo y evita reintentos', async () => {
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const queue = new ConversationQueue(async () => {
    started();
    await new Promise<void>(resolve => { release = resolve; });
    return {status:'error'};
  }, 2, 60_000);
  queue.schedule('active', 0);
  await running;
  let stopped = false;
  const stopping = queue.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(queue.size, 0);
});

test('cerrar espera una operación exclusiva activa', async () => {
  let release!: () => void;
  const queue = new ConversationQueue(async () => ({status:'done'}));
  const operation = queue.exclusive('playground', () => new Promise<void>(resolve => { release = resolve; }));
  let stopped = false;
  const stopping = queue.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await Promise.all([operation, stopping]);
  assert.equal(queue.size, 0);
});

test('cerrar impide que una operación exclusiva en espera empiece después', async () => {
  let release!: () => void;
  const queue = new ConversationQueue(async () => ({status:'done'}));
  const first = queue.exclusive('same', () => new Promise<void>(resolve => { release = resolve; }));
  let called = false;
  const waiting = assert.rejects(queue.exclusive('same', async () => { called = true; }), /cerrada/);
  const closing = queue.stop();
  release();
  await Promise.all([first, waiting, closing]);
  assert.equal(called, false);
  assert.equal(queue.size, 0);
});

test('un mensaje que llega durante una operación exclusiva se procesa después de ella', async () => {
  const runs: string[] = [];
  const queue = new ConversationQueue(async (id) => { runs.push(id); return {status:'done'}; });
  await queue.exclusive('chat', async () => { queue.schedule('chat', 0); });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.deepEqual(runs, ['chat']);
  await queue.stop();
});
