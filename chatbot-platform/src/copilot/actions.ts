/**
 * Lo que la persona hace con las tarjetas del Copiloto: confirmar una propuesta (se ejecuta exactamente lo que se
 * guardó, con la sesión de quien confirma), descartarla y deshacer lo que ya se hizo (solo si el registro sigue como
 * lo dejó la acción). Cada resultado queda como aviso en el hilo para que el Copiloto lo sepa en el siguiente turno.
 */
import { trackSubSpend, type SubSpend } from '../ai/sub-spend.js';
import { HttpError } from '../access.js';
import { config } from '../config.js';
import { logEvent } from '../logs.js';
import { recordSecurity } from '../security-log.js';
import { mintCopilotGrant, revokeCopilotGrant } from '../identity/copilot-grant.js';
import { verifySessionCode } from '../identity/mfa.js';
import type { User } from '../types.js';
import { ToolError } from './executor.js';
import { allowed, type Ctx } from './registry.js';
import { contextFor, type RunnerDeps } from './runner.js';
import * as cs from './store.js';

/** Valor en una ruta con puntos («contact.tags»). */
function at(obj: any, path: string): unknown {
  return path.split('.').reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), obj);
}

/** Los campos de `paths` de un registro, para compararlos con la foto de después. */
export function pickPaths(obj: unknown, paths: string[]): Record<string, unknown> {
  return Object.fromEntries(paths.map((p) => [p, at(obj, p) ?? null]));
}

async function ctxFor(deps: RunnerDeps, action: cs.Action, user: User, cookie: string, ip?: string, grant?: string): Promise<Ctx> {
  return contextFor({ deps, user, accountId: action.account_id, cookie, ip, threadId: action.thread_id, turnId: action.turn_id, page: {}, actionId: action.id, grant });
}

const TOO_MANY = 'Demasiados códigos equivocados. Espera 15 minutos e inténtalo de nuevo.';
const LOCKED = 'Bloqueamos la verificación por una hora por demasiados intentos. Si no fuiste tú, cambia tu contraseña.';

/**
 * El código de verificación de una propuesta `code`: con los mismos topes y bloqueo que el diálogo del panel (no da
 * intentos de más). Un código equivocado deja la propuesta como estaba.
 */
async function checkCode(user: User, sessionId: string | null | undefined, code: string | undefined) {
  if (!config.copilot.codeActions) throw new HttpError(403, 'Esta acción la tienes que hacer tú desde el panel.');
  if (!code) throw new HttpError(400, 'Escribe tu código de verificación en la tarjeta para confirmar', undefined, { code: 'code_required' });
  if (!sessionId) throw new HttpError(401, 'Inicia sesión');
  const check = await verifySessionCode(user.id, sessionId, code);
  if (check.result === 'too_many') throw new HttpError(429, TOO_MANY);
  if (check.result === 'locked') throw new HttpError(429, LOCKED);
  if (check.result === 'no_user') throw new HttpError(401, 'Inicia sesión');
  if (check.result !== 'ok') throw new HttpError(400, 'El código no es correcto', undefined, { code: 'bad_code' });
}

// Va con el turno de la acción: si se borran los datos del cliente, el aviso (que lleva su nombre) se borra con él. Lleva
// la acción como referencia: el historial le agrega su resultado (el id de lo que se creó, para seguir con lo demás).
const note = (action: cs.Action, content: string) => cs.addMessage({ thread_id: action.thread_id, turn_id: action.turn_id, role: 'event', content, refs: [action.id] });

function toolFor(deps: RunnerDeps, action: cs.Action, user: User) {
  const def = deps.tools.find((t) => t.name === action.tool);
  if (!def || !allowed(def, user)) throw new HttpError(403, 'Tu usuario no puede hacer esta acción');
  return def;
}

export async function confirmAction(deps: RunnerDeps, o: {
  action: cs.Action; user: User; cookie: string; ip?: string; seenHash: string;
  /** Propuestas `code`: el código escrito en la tarjeta y la sesión de quien confirma. */
  code?: string; sessionId?: string | null;
}): Promise<cs.Action> {
  const { action, user } = o;
  const def = toolFor(deps, action, user);
  if (action.status !== 'proposed') throw new HttpError(409, 'Esta propuesta ya se resolvió');
  if (action.expires_at && new Date(action.expires_at).getTime() < Date.now()) {
    await cs.updateAction(action.id, { status: 'expired' });
    throw new HttpError(410, 'La propuesta caducó; pídela de nuevo al Copiloto');
  }
  if (o.seenHash !== action.args_hash) throw new HttpError(409, 'La propuesta cambió; revisa la tarjeta antes de confirmar');
  // El código se revisa después de lo anterior (un código revisado ya no sirve otra vez) y antes de tomar la propuesta.
  const withCode = action.risk === 'code';
  if (withCode) await checkCode(user, o.sessionId, o.code);
  const claimed = await cs.claimProposal(action.id, user.id, o.seenHash);
  if (!claimed) throw new HttpError(409, 'Esta propuesta ya se resolvió');
  const parsed = def.schema.safeParse(claimed.args);
  if (!parsed.success) {
    await cs.updateAction(action.id, { status: 'failed', error: 'Los datos guardados ya no son válidos' });
    throw new HttpError(409, 'Los datos de la propuesta ya no son válidos; pídela de nuevo');
  }
  // Permiso de un uso para las rutas delicadas que esta herramienta declara; se revoca al terminar, pase lo que pase.
  const grant = withCode && def.grants?.length && o.sessionId
    ? mintCopilotGrant({ userId: user.id, sessionId: o.sessionId, actionId: action.id, routes: def.grants, uses: def.grantUses })
    : undefined;
  if (withCode) {
    await recordSecurity({ kind: 'copilot.code_confirmed', accountId: action.account_id, userId: user.id, email: user.email, ip: o.ip, target: action.tool, details: { copilot_action_id: action.id } }).catch(() => undefined);
  }
  const ctx: Ctx = { ...(await ctxFor(deps, claimed, user, o.cookie, o.ip, grant)), proposal: claimed.preview ?? undefined };
  try {
    // AI-9: lo que la herramienta gasta en IA por dentro (cambiar instrucciones, diseñar un flujo…) cuenta para el tope
    // del día del Copiloto, en el pedido que la propuso.
    const sub: SubSpend = { usd: 0, calls: 0 };
    let r: Awaited<ReturnType<typeof def.execute>>;
    try {
      r = await cs.withLease(action.id, () => trackSubSpend(sub, () => def.execute(parsed.data, ctx)));
    } finally {
      if (sub.usd > 0 && action.turn_id) await cs.addSubCost(action.turn_id, sub.usd).catch(() => undefined);
    }
    const title = r.title ?? claimed.title;
    // Lo que se confirmó con código no se deshace desde la tarjeta: deshacerlo también sería una acción delicada.
    const undo = withCode ? null : r.undo ?? null;
    const updated = (await cs.updateAction(action.id, {
      status: 'done', title, result: r.data ?? null, links: r.links ?? claimed.links, before: r.before ?? null, after: r.after ?? null, undo,
      undo_until: undo ? new Date(Date.now() + config.copilot.undoDays * 86400_000) : null, executed_at: new Date(),
      ...(r.preview ? { preview: r.preview } : {}),
      contact_ids: [...new Set([...claimed.contact_ids, ...(r.contactIds ?? [])])],
    }))!;
    await note(updated, `Confirmaste: ${claimed.title} → hecho.`);
    await logEvent({ level: 'info', source: 'copilot', message: `Copiloto (${user.email}, confirmado${withCode ? ' con código' : ''}): ${title}`, accountId: action.account_id, details: { copilot_action_id: action.id, tool: action.tool, turn_id: action.turn_id, risk: claimed.risk, confirmed: true } }).catch(() => undefined);
    return updated;
  } catch (e) {
    const message = e instanceof ToolError ? e.message : 'La acción falló en el servidor';
    const updated = (await cs.updateAction(action.id, { status: 'failed', error: message }))!;
    await note(updated, `Confirmaste: ${claimed.title} → falló: ${message}.`);
    return updated;
  } finally {
    revokeCopilotGrant(grant);
  }
}

export async function declineAction(o: { action: cs.Action; user: User }): Promise<cs.Action> {
  if (o.action.status !== 'proposed') throw new HttpError(409, 'Esta propuesta ya se resolvió');
  const updated = await cs.updateAction(o.action.id, { status: 'declined' });
  await note(updated!, `Descartaste: ${o.action.title}.`);
  return updated!;
}

export async function undoAction(deps: RunnerDeps, o: { action: cs.Action; user: User; cookie: string; ip?: string }): Promise<cs.Action> {
  const { action, user } = o;
  if (action.status !== 'done' || !action.undo) throw new HttpError(409, 'Esta acción no se puede deshacer');
  if (action.undo_until && new Date(action.undo_until).getTime() < Date.now()) throw new HttpError(410, 'Ya pasó el tiempo para deshacer esta acción');
  const def = toolFor(deps, action, user);
  const claimed = await cs.claimUndo(action.id, user.id);
  if (!claimed) throw new HttpError(409, 'Esta acción ya se está deshaciendo o ya se deshizo');
  const ctx = await ctxFor(deps, claimed, user, o.cookie, o.ip);
  const recipe = claimed.undo!;
  try {
    await cs.withLease(action.id, async () => {
      if (recipe.custom) {
        if (!def.undo) throw new ToolError('no_disponible', 'Esta acción no se puede deshacer');
        await def.undo(recipe.custom.params, ctx);
      } else {
        if (recipe.check) {
          const current = await ctx.call.get(recipe.check.url);
          if (cs.stableJson(pickPaths(current, recipe.check.pick)) !== cs.stableJson(recipe.check.expect)) {
            throw new ToolError('conflicto', 'El registro cambió después de esta acción; para no pisar esos cambios, no lo deshice.');
          }
        }
        for (const step of recipe.steps ?? []) await ctx.call.send(step.method, step.url, step.body);
      }
    });
  } catch (e) {
    await cs.updateAction(action.id, { status: 'done' });
    if (e instanceof ToolError) throw new HttpError(e.code === 'conflicto' || e.code === 'no_encontrado' ? 409 : e.code === 'sin_permiso' ? 403 : 400, e.message);
    throw new HttpError(500, 'No se pudo deshacer');
  }
  const updated = (await cs.updateAction(action.id, { status: 'undone', undone_at: new Date() }))!;
  await note(updated, `Deshiciste: ${action.title}.`);
  await logEvent({ level: 'info', source: 'copilot', message: `Copiloto (${user.email}): deshizo «${action.title}»`, accountId: action.account_id, details: { copilot_action_id: action.id, tool: action.tool, undo: true } }).catch(() => undefined);
  return updated;
}

/** Deshace lo que hizo un turno, de lo último a lo primero. Lo que no se puede, se reporta y se sigue con lo demás. */
export async function undoTurn(deps: RunnerDeps, o: { turnId: string; user: User; cookie: string; ip?: string }) {
  const actions = (await cs.turnActions(o.turnId)).filter((a) => a.user_id === o.user.id && a.status === 'done' && a.undo).reverse();
  const undone: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const a of actions) {
    try {
      await undoAction(deps, { action: a, user: o.user, cookie: o.cookie, ip: o.ip });
      undone.push(a.id);
    } catch (e: any) {
      failed.push({ id: a.id, error: e?.message ?? 'No se pudo deshacer' });
    }
  }
  return { undone, failed };
}
