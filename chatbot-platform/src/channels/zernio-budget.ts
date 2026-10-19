import { sleep } from '../engine/transport.js';
import { query, queryOne } from '../db.js';

/**
 * Presupuesto de llamadas a Zernio. El límite por minuto es de la llave (una sola para todos los negocios) y depende de
 * cuántas cuentas hay conectadas: 60 con 2 o menos, 600 hasta 2000 y 1200 con más (o el que Zernio informa en
 * X-RateLimit-Limit). Se reparte entre todos los procesos con una cubeta de fichas en la base. Lo que hace una persona
 * (enviar, conectar) espera un poco si se acabaron; lo que corre solo (revisiones, estadísticas) deja siempre libre el
 * 30 % y, si no alcanza, se reintenta después.
 */

const KEY = 'zernio';
export type ZernioPriority = 'interactive' | 'background';

/** Lo que corre en segundo plano no encontró lugar: se vuelve a intentar más tarde. */
export class ZernioBusyError extends Error {
  constructor() {
    super('Zernio está ocupado (límite de llamadas por minuto de la plataforma); se reintenta más tarde');
  }
}

let cached = { capacity: 0, at: 0 };

/** Zernio dice en cada respuesta el límite real de la llave (X-RateLimit-Limit): manda sobre la estimación. */
export function noteZernioLimit(limit: number) {
  if (Number.isFinite(limit) && limit > 0) cached = { capacity: Math.floor(limit * 0.9), at: Date.now() };
}

/** Llamadas por minuto que se permiten (el 90 % del límite de Zernio, para dejar margen). */
export async function zernioCapacity(): Promise<number> {
  const env = Number(process.env.ZERNIO_RATE_PER_MIN);
  if (Number.isFinite(env) && env > 0) return env;
  if (cached.capacity && Date.now() - cached.at < 300_000) return cached.capacity;
  const n = (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM social_accounts WHERE status <> 'disconnected'`))?.n ?? 0;
  const limit = n <= 2 ? 60 : n <= 2000 ? 600 : 1200;
  cached = { capacity: Math.floor(limit * 0.9), at: Date.now() };
  return cached.capacity;
}

/** Un intento de tomar una ficha (sin esperar). Lo de segundo plano solo pasa si después queda libre el 30 %. */
export async function tryTakeZernioBudget(priority: ZernioPriority = 'interactive'): Promise<boolean> {
  const cap = await zernioCapacity();
  const minFree = priority === 'background' ? 0.3 : 0;
  // Las fichas se reponen según el tiempo pasado desde la última toma (capacidad por minuto / 60 cada segundo).
  const row = await queryOne(
    `INSERT INTO rate_buckets AS b (key, tokens, capacity, per_sec) VALUES ($1, $2::float8 - 1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET tokens = LEAST($2::float8, b.tokens + EXTRACT(EPOCH FROM now() - b.updated_at) * $3::float8) - 1, capacity = $2, per_sec = $3, updated_at = now()
       WHERE LEAST($2::float8, b.tokens + EXTRACT(EPOCH FROM now() - b.updated_at) * $3::float8) >= 1 + $4::float8 * $2::float8
     RETURNING tokens`,
    [KEY, cap, cap / 60, minFree]);
  return !!row;
}

/** Toma una ficha antes de llamar a Zernio. Sin base disponible no se limita (nunca detiene un envío por eso). */
export async function takeZernioBudget(priority: ZernioPriority = 'interactive'): Promise<void> {
  const background = priority === 'background';
  const deadline = Date.now() + (background ? 60_000 : 10_000);
  for (;;) {
    let ok: boolean;
    try {
      ok = await tryTakeZernioBudget(priority);
    } catch {
      return;
    }
    if (ok) return;
    if (Date.now() > deadline) {
      if (background) throw new ZernioBusyError();
      return;
    }
    await sleep(500);
  }
}

/** Zernio respondió 429: la cubeta queda vacía para que todos los procesos esperen a que se llene. */
export async function drainZernioBudget(): Promise<void> {
  await query(`UPDATE rate_buckets SET tokens = 0, updated_at = now() WHERE key = $1`, [KEY]).catch(() => undefined);
}

/** Fichas disponibles ahora (para el panel del administrador). */
export async function zernioBudgetStatus(): Promise<{ tokens: number; capacity: number }> {
  const cap = await zernioCapacity();
  const row = await queryOne<{ tokens: number }>(
    `SELECT LEAST($2::float8, tokens + EXTRACT(EPOCH FROM now() - updated_at) * $3::float8) AS tokens FROM rate_buckets WHERE key = $1`, [KEY, cap, cap / 60]);
  return { tokens: Math.max(0, Number(row?.tokens ?? cap)), capacity: cap };
}
