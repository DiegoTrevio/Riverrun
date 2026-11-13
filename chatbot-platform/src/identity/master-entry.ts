/**
 * Registro de cuándo la cuenta maestra entra a un negocio. El selector del panel lo anota al cambiar de perfil
 * (`POST /api/accounts/:id/switch`), pero la API acepta `account_id` en cualquier petición del maestro: por eso este
 * gancho también lo anota en el servidor, aunque el perfil se pida sin pasar por el selector (otra pestaña, un enlace,
 * un script con su sesión). Una fila por persona y perfil cada media hora; sin consultas extra dentro de esa ventana.
 */
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actor, recordSecurityOnce } from '../security-log.js';
import * as store from '../store/index.js';

/** Cada cuánto se vuelve a anotar que la misma persona entró al mismo perfil. */
export const ACCOUNT_ENTRY_MINUTES = 30;
const WINDOW_MS = ACCOUNT_ENTRY_MINUTES * 60_000;
/** Tope de la memoria de entradas recientes (el maestro son pocas personas; esto solo evita que crezca sin fin). */
const MAX_REMEMBERED = 5000;
const noted = new Map<string, number>();
const Uuid = z.string().uuid();

type Req = Pick<FastifyRequest, 'ip' | 'headers'> & { user?: { id: string; email?: string; role?: string } };

const keyFor = (userId: string, accountId: string) => `account-entered:${userId}:${accountId}`;
const fresh = (key: string) => (noted.get(key) ?? 0) > Date.now();

/** Anota que la cuenta maestra entró a `account` (ya comprobado que existe). Nunca lanza: anotar no rompe la petición. */
export async function noteAccountEntry(req: Req, account: { id: string; name: string }): Promise<void> {
  if (!req.user) return;
  const key = keyFor(req.user.id, account.id);
  if (fresh(key)) return;
  // El candado de la base (security_alerts) evita filas repetidas entre réplicas; el mapa solo ahorra la consulta.
  await recordSecurityOnce(key, ACCOUNT_ENTRY_MINUTES, { kind: 'account.entered', accountId: account.id, ...actor(req), target: account.name });
  if (noted.size >= MAX_REMEMBERED) noted.clear();
  noted.set(key, Date.now() + WINDOW_MS);
}

/**
 * Todos los `account_id` válidos que trae una petición: en la dirección (también repetidos) y en el cuerpo. Se anotan
 * todos, para que uno en la dirección no esconda otro distinto en el cuerpo.
 */
function requestedAccounts(req: FastifyRequest): string[] {
  const fromQuery = (req.query as Record<string, unknown> | undefined)?.account_id;
  const body = req.body;
  const fromBody = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).account_id : undefined;
  const values = [fromQuery, fromBody].flatMap((v) => (Array.isArray(v) ? v : [v]));
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && Uuid.safeParse(v).success))];
}

/** Gancho para todas las rutas con sesión: anota las entradas del maestro a un perfil pedidas con `account_id`. */
export async function masterEntryHook(req: FastifyRequest): Promise<void> {
  const user = (req as Req).user;
  if (user?.role !== 'superadmin') return;
  for (const accountId of requestedAccounts(req)) {
    if (fresh(keyFor(user.id, accountId))) continue;
    const account = await store.getAccount(accountId);
    if (account) await noteAccountEntry(req as Req, account);
  }
}
