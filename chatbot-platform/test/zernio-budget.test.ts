/** Zernio (PAY-23): una cuenta que manda en bucle se frena sola, sin agotar la cubeta que comparten todos los negocios. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { dbAvailable, migrate, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { takeZernioAccountBudget, ZERNIO_PER_ACCOUNT_PER_MIN, ZernioBusyError } = await import('../src/channels/zernio-budget.js');

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';

before(async () => {
  if (!ok) return;
  await migrate();
  await pool.query(`DELETE FROM rate_limits WHERE key LIKE 'zernio-acct:%'`);
});
after(async () => {
  await pool.end();
});

t('una cuenta tiene su propio tope por minuto; al pasarlo se detiene ella, no las demás', async () => {
  for (let i = 0; i < ZERNIO_PER_ACCOUNT_PER_MIN; i++) await takeZernioAccountBudget(A, 'interactive');
  await assert.rejects(takeZernioAccountBudget(A, 'interactive'), (e: any) => e.status === 429 && /demasiadas acciones a las redes/.test(e.message));
  await assert.rejects(takeZernioAccountBudget(A, 'background'), (e) => e instanceof ZernioBusyError, 'lo de segundo plano se reintenta después');
  await takeZernioAccountBudget(B, 'interactive');
});
