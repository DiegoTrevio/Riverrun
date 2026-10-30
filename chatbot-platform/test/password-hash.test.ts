/**
 * Hash de contraseñas: scrypt con los parámetros de OWASP (más bajos en pruebas con PASSWORD_HASH_COST=test), los hashes de
 * antes se siguen aceptando y se recalculan al entrar, y a lo más 4 cálculos a la vez con 64 en espera (una avalancha de
 * intentos no agota la memoria del servidor).
 */
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { hashPassword, needsRehash, verifyPassword } = await import('../src/auth.js');
let h: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  if (ok) h = await createHarness();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

/** Como guardaba las contraseñas la versión anterior: scrypt con los parámetros por omisión de Node. */
const oldHash = (pw: string) => {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(pw, salt, 64).toString('base64')}`;
};

test('el hash lleva sus parámetros (los de prueba aquí) y se verifica', async () => {
  const stored = await hashPassword('una-frase-de-prueba-larga');
  assert.match(stored, /^scrypt\$ln=10,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await verifyPassword('una-frase-de-prueba-larga', stored), true);
  assert.equal(await verifyPassword('otra-frase-de-prueba', stored), false);
  assert.equal(needsRehash(stored), false);
});

test('un hash de antes se sigue aceptando y pide recalcularse', async () => {
  const stored = oldHash('clave-de-antes-larga');
  assert.equal(await verifyPassword('clave-de-antes-larga', stored), true);
  assert.equal(await verifyPassword('otra-clave-de-antes', stored), false);
  assert.equal(needsRehash(stored), true);
  assert.equal(needsRehash('scrypt$ln=15,r=8,p=3$AAAA$AAAA'), true, 'parámetros distintos a los vigentes');
});

test('un hash con parámetros fuera de rango no se calcula', async () => {
  assert.equal(await verifyPassword('lo-que-sea-largo', 'scrypt$ln=30,r=8,p=1$AAAA$AAAA'), false);
  assert.equal(await verifyPassword('lo-que-sea-largo', 'texto-cualquiera'), false);
});

test('a lo más 4 cálculos a la vez y 64 esperando: el siguiente responde 503', async () => {
  const held: ((err: Error | null, key: Buffer) => void)[] = [];
  const m = mock.method(crypto, 'scrypt', (...args: unknown[]) => { held.push(args.at(-1) as (err: Error | null, key: Buffer) => void); });
  const calls = Array.from({ length: 68 }, () => hashPassword('una-frase-cualquiera-larga'));
  await new Promise((r) => setImmediate(r));
  assert.equal(held.length, 4, 'solo 4 calculan');
  await assert.rejects(hashPassword('otra-frase-cualquiera-larga'), (e: any) => e.statusCode === 503 && e.message === 'Hay muchos intentos, prueba en unos segundos');
  m.mock.restore();
  for (const cb of held) cb(null, Buffer.alloc(64));
  assert.equal((await Promise.all(calls)).length, 68, 'los que esperaban terminan');
});

t('quien entra con un hash de antes queda con el nuevo', async () => {
  const created = await h.authed('POST', '/api/users', { account_id: null, name: 'Vieja', email: 'vieja@hash.mx', password: 'Pz-127-Qx-327-Kv', role: 'superadmin' });
  assert.equal(created.statusCode, 200, created.body);
  await pool.query(`UPDATE users SET password_hash = $1 WHERE email = 'vieja@hash.mx'`, [oldHash('Pz-127-Qx-327-Kv')]);
  const r = await h.app.inject({ method: 'POST', url: '/api/login', payload: { email: 'vieja@hash.mx', password: 'Pz-127-Qx-327-Kv' } });
  assert.notEqual(r.statusCode, 401, r.body);
  assert.match((await pool.query(`SELECT password_hash FROM users WHERE email = 'vieja@hash.mx'`)).rows[0].password_hash, /^scrypt\$ln=10,r=8,p=1\$/);
});
