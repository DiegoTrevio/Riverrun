/**
 * Lo que la persona hace con las tarjetas del Copiloto: confirmar una propuesta (se ejecuta exactamente lo que se
 * guardó, con la sesión de quien confirma), descartarla y deshacer lo que ya se hizo (solo si el registro sigue como
 * lo dejó la acción). Cada resultado queda como aviso en el hilo para que el Copiloto lo sepa en el siguiente turno.
 */
import { HttpError } from '../access.js';
import { config } from '../config.js';
import { logEvent } from '../logs.js';
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

async function ctxFor(deps: RunnerDeps, action: cs.Action, user: User, cookie: string, ip?: string): Promise<Ctx> {
  return contextFor({ deps, user, accountId: action.account_id, cookie, ip, threadId: action.thread_id, turnId: action.turn_id, page: {}, actionId: action.id });
}

// Va con el turno de la acción: si se borran los datos del cliente, el aviso (que lleva su nombre) se borra con él.
const note = (action: cs.Action, content: string) => cs.addMessage({ thread_id: action.thread_id, turn_id: action.turn_id, role: 'event', content });

function toolFor(deps: RunnerDeps, action: cs.Action, user: User) {
  const def = deps.tools.find((t) => t.name === action.tool);
  if (!def || !allowed(def, user)) throw new HttpError(403, 'Tu usuario no puede hacer esta acción');
  return def;
}

export async function confirmAction(deps: RunnerDeps, o: { action: cs.Action; user: User; cookie: string; ip?: string; seenHash: string }): Promise<cs.Action> {
  const { action, user } = o;
  const def = toolFor(deps, action, user);
  if (action.status !== 'proposed') throw new HttpError(409, 'Esta propuesta ya se resolvió');
  if (action.expires_at && new Date(action.expires_at).getTime() < Date.now()) {
    await cs.updateAction(action.id, { status: 'expired' });
    throw new HttpError(410, 'La propuesta caducó; pídela de nuevo al Copiloto');
  }
  if (o.seenHash !== action.args_hash) throw new HttpError(409, 'La propuesta cambió; revisa la tarjeta antes de confirmar');
  const claimed = await cs.claimProposal(action.id, user.id, o.seenHash);
  if (!claimed) throw new HttpError(409, 'Esta propuesta ya se resolvió');
  const parsed = def.schema.safeParse(claimed.args);
  if (!parsed.success) {
    await cs.updateAction(action.id, { status: 'failed', error: 'Los datos guardados ya no son válidos' });
    throw new HttpError(409, 'Los datos de la propuesta ya no son válidos; pídela de nuevo');
  }
  const ctx: Ctx = { ...(await ctxFor(deps, claimed, user, o.cookie, o.ip)), proposal: claimed.preview ?? undefined };
  try {
    const r = await def.execute(parsed.data, ctx);
    const title = r.title ?? claimed.title;
    const updated = (await cs.updateAction(action.id, {
      status: 'done', title, result: r.data ?? null, links: r.links ?? claimed.links, before: r.before ?? null, after: r.after ?? null, undo: r.undo ?? null,
      undo_until: r.undo ? new Date(Date.now() + config.copilot.undoDays * 86400_000) : null, executed_at: new Date(),
      ...(r.preview ? { preview: r.preview } : {}),
      contact_ids: [...new Set([...claimed.contact_ids, ...(r.contactIds ?? [])])],
    }))!;
    await note(updated, `Confirmaste: ${claimed.title} → hecho.`);
    await logEvent({ level: 'info', source: 'copilot', message: `Copiloto (${user.email}, confirmado): ${title}`, accountId: action.account_id, details: { copilot_action_id: action.id, tool: action.tool, turn_id: action.turn_id, risk: 'confirm', confirmed: true } }).catch(() => undefined);
    return updated;
  } catch (e) {
    const message = e instanceof ToolError ? e.message : 'La acción falló en el servidor';
    const updated = (await cs.updateAction(action.id, { status: 'failed', error: message }))!;
    await note(updated, `Confirmaste: ${claimed.title} → falló: ${message}.`);
    return updated;
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
