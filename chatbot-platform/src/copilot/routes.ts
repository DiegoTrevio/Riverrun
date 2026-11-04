/**
 * Rutas del Copiloto (/api/copilot/*). Cada hilo es de una persona en una cuenta; el superadmin trabaja en la cuenta
 * que elija (`account_id`). La cuenta debe tener el Copiloto encendido.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, notFound } from '../access.js';
import { cookieName } from '../auth.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { assertAiAllowed } from '../ai/gate.js';
import { turnAllowance } from './allowance.js';
import { maybeContinue } from './continue.js';
import { tidy } from './prompt.js';
import * as store from '../store/index.js';
import { parse } from '../routes/util.js';
import { confirmAction, declineAction, undoAction, undoTurn } from './actions.js';
import { parsePage } from './page.js';
import { startTurnInBackground, type RunnerDeps } from './runner.js';
import { safeLink } from './summarize.js';
import * as cs from './store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Id = z.string().regex(UUID, 'Id inválido');

/** Cuenta en la que trabaja esta petición, si tiene el Copiloto encendido. */
async function copilotAccount(req: FastifyRequest): Promise<string> {
  if (!config.copilot.enabled) throw new HttpError(404, 'El Copiloto no está disponible');
  const user = req.user;
  const requested = (req.query as any)?.account_id ?? (req.body as any)?.account_id;
  const accountId = user.role === 'superadmin' ? requested : user.account_id;
  if (!accountId || !UUID.test(String(accountId))) throw new HttpError(400, 'Elige la cuenta en la que quieres usar el Copiloto');
  const account = await store.getAccount(String(accountId));
  if (!account || !account.active) throw notFound('Cuenta no encontrada');
  if (!account.copilot_enabled) throw new HttpError(403, 'El Copiloto no está activado en esta cuenta');
  return account.id;
}

function sessionCookie(req: FastifyRequest): string {
  const name = cookieName('cp_session');
  const value = (req as any).cookies?.[name];
  if (!value) throw new HttpError(401, 'Inicia sesión');
  return `${name}=${value}`;
}

// --- Lo que ve el panel ----------------------------------------------------------------------------------------------

function messageOut(m: cs.Message) {
  if (m.role === 'tool' || (m.role === 'assistant' && !m.content)) return null;
  return { id: Number(m.id), role: m.role, content: m.redacted ? '' : m.content, redacted: m.redacted, turn_id: m.turn_id, refs: m.refs, created_at: m.created_at, rev: Number(m.rev) };
}

function actionOut(a: cs.Action) {
  const undoable = a.status === 'done' && !!a.undo && (!a.undo_until || new Date(a.undo_until).getTime() > Date.now());
  return {
    id: a.id, turn_id: a.turn_id, tool: a.tool, risk: a.risk, status: a.status, title: a.title, preview: a.preview ? { ...a.preview, meta: undefined } : null,
    links: (a.links ?? []).filter((l) => l && typeof l.href === 'string' && safeLink(l.href)).slice(0, 4),
    error: a.error, reasons: a.risk_reasons ?? [], can_undo: undoable, undo_label: undoable ? a.undo?.label ?? 'Deshacer' : null,
    ...(a.status === 'proposed' ? { seen_hash: a.args_hash, expires_at: a.expires_at } : {}),
    created_at: a.created_at, rev: Number(a.rev),
  };
}

function turnOut(t: cs.Turn | null) {
  if (!t) return null;
  return {
    id: t.id, status: t.status, step_label: t.step_label, error: t.error, started_at: t.started_at, finished_at: t.finished_at, steps: t.steps, tool_calls: t.tool_calls, rev: Number(t.rev),
    // «Confirmar y seguir»: si sigue solo de otro pedido y lo que anotó que falta (para la tarjeta).
    origin: t.origin, continue_plan: t.continue_plan ? tidy(t.continue_plan, 300) : '',
  };
}

const maxRev = (...lists: { rev: string }[][]) => lists.flat().reduce((n, x) => Math.max(n, Number(x.rev)), 0);

export async function copilotRoutes(api: FastifyInstance, deps: RunnerDeps) {
  const ownThread = async (req: any) => {
    const accountId = await copilotAccount(req);
    const thread = await cs.ownThread(parse(Id, req.params.id), req.user.id, accountId);
    if (!thread) throw notFound('Conversación no encontrada');
    return thread;
  };
  const ownAction = async (req: any) => {
    const accountId = await copilotAccount(req);
    const action = await cs.ownAction(parse(Id, req.params.id), req.user.id, accountId);
    if (!action) throw notFound('Acción no encontrada');
    return action;
  };

  api.get('/api/copilot/threads', async (req: any) => {
    const accountId = await copilotAccount(req);
    return (await cs.listThreads(req.user.id, accountId)).map((t) => ({ id: t.id, title: t.title || 'Conversación sin título', updated_at: t.updated_at, status: t.status }));
  });

  api.post('/api/copilot/threads', async (req: any) => {
    const accountId = await copilotAccount(req);
    const b = parse(z.object({ title: z.string().trim().max(120).default('') }), req.body ?? {});
    const t = await cs.createThread(accountId, req.user.id, b.title);
    return { id: t.id, title: t.title };
  });

  api.patch('/api/copilot/threads/:id', async (req: any) => {
    const thread = await ownThread(req);
    const b = parse(z.object({ title: z.string().trim().min(1).max(120) }), req.body);
    await cs.renameThread(thread.id, b.title);
    return { ok: true };
  });

  api.delete('/api/copilot/threads/:id', async (req: any) => {
    const thread = await ownThread(req);
    if ((await cs.currentTurn(thread.id))?.status === 'running') throw new HttpError(409, 'Espera a que termine o detenlo antes de borrar la conversación');
    await cs.deleteThread(thread.id);
    return { ok: true };
  });

  api.get('/api/copilot/threads/:id', async (req: any) => {
    const thread = await ownThread(req);
    await cs.sweepStale(thread.id);
    const [messages, actions, turn] = await Promise.all([cs.threadMessages(thread.id, 300), cs.threadActions(thread.id), cs.currentTurn(thread.id)]);
    return {
      thread: { id: thread.id, title: thread.title },
      messages: messages.map(messageOut).filter(Boolean),
      actions: actions.map(actionOut),
      turn: turnOut(turn),
      rev: Math.max(maxRev(messages, actions), turn ? Number(turn.rev) : 0),
    };
  });

  api.get('/api/copilot/threads/:id/updates', async (req: any) => {
    const thread = await ownThread(req);
    const after = parse(z.coerce.number().int().min(0).default(0), req.query?.after_rev ?? 0);
    await cs.sweepStale(thread.id);
    const u = await cs.updatesSince(thread.id, after);
    return {
      messages: u.messages.map(messageOut).filter(Boolean),
      actions: u.actions.map(actionOut),
      turns: u.turns.map(turnOut),
      rev: Math.max(after, maxRev(u.messages, u.actions, u.turns)),
    };
  });

  api.post('/api/copilot/threads/:id/messages', async (req: any, reply) => {
    const thread = await ownThread(req);
    await assertAiAllowed(thread.account_id);
    const b = parse(z.object({
      text: z.string().trim().min(1, 'Escribe qué necesitas').max(4000),
      page: z.object({ hash: z.string().max(300).default('') }).default({ hash: '' }),
      refs: z.array(Id).max(5).default([]),
    }), req.body);
    await cs.sweepStale(thread.id);
    await cs.sweepStaleUser(req.user.id);
    const { maxUsd } = await turnAllowance(req.user.id, thread.account_id);
    const refs = (await cs.actionsByIds(b.refs, thread.id)).map((a) => a.id);
    const cookie = sessionCookie(req);
    const turn = await cs.startTurn(thread, parsePage(b.page.hash), config.copilot.model);
    if (!turn) throw new HttpError(409, 'Todavía estoy trabajando en tu pedido anterior');
    const message = await cs.addMessage({ thread_id: thread.id, turn_id: turn.id, role: 'user', content: b.text, refs });
    await cs.touchThread(thread.id, b.text.slice(0, 60));
    void startTurnInBackground(deps, { thread, turn, user: req.user, cookie, ip: req.ip, refs, maxUsd });
    return reply.code(202).send({ turn: turnOut(turn), message: messageOut(message) });
  });

  api.post('/api/copilot/turns/:id/stop', async (req: any) => {
    const accountId = await copilotAccount(req);
    const turn = await cs.getTurn(parse(Id, req.params.id));
    if (!turn || turn.user_id !== req.user.id || turn.account_id !== accountId) throw notFound('Pedido no encontrado');
    await cs.requestStop(turn.id);
    return { ok: true };
  });

  api.post('/api/copilot/turns/:id/undo-all', async (req: any) => {
    const accountId = await copilotAccount(req);
    const turn = await cs.getTurn(parse(Id, req.params.id));
    if (!turn || turn.user_id !== req.user.id || turn.account_id !== accountId) throw notFound('Pedido no encontrado');
    if (turn.status === 'running') throw new HttpError(409, 'Espera a que termine el pedido');
    return undoTurn(deps, { turnId: turn.id, user: req.user, cookie: sessionCookie(req), ip: req.ip });
  });

  api.post('/api/copilot/actions/:id/confirm', async (req: any) => {
    const action = await ownAction(req);
    const b = parse(z.object({ seen_hash: z.string().min(1).max(64), seguir: z.boolean().default(false) }), req.body);
    const cookie = sessionCookie(req);
    const done = await confirmAction(deps, { action, user: req.user, cookie, ip: req.ip, seenHash: b.seen_hash });
    // «Confirmar y seguir»: si el pedido anotó lo que faltaba, el Copiloto sigue solo (con los mismos límites).
    const continued = b.seguir && done.status === 'done' ? await maybeContinue(deps, { action: done, user: req.user, cookie, ip: req.ip }) : null;
    return { ...actionOut(done), continued_turn: turnOut(continued) };
  });

  api.post('/api/copilot/actions/:id/decline', async (req: any) => {
    const action = await ownAction(req);
    return actionOut(await declineAction({ action, user: req.user }));
  });

  api.post('/api/copilot/actions/:id/undo', async (req: any) => {
    const action = await ownAction(req);
    return actionOut(await undoAction(deps, { action, user: req.user, cookie: sessionCookie(req), ip: req.ip }));
  });

  /** Etiquetas de la cuenta con cuántos contactos tiene cada una (un agente, solo de sus contactos). */
  api.get('/api/copilot/data/tags', async (req: any) => {
    const accountId = await copilotAccount(req);
    return query<{ tag: string; contacts: number }>(
      `SELECT t AS tag, count(DISTINCT ct.id)::int AS contacts FROM contacts ct CROSS JOIN LATERAL jsonb_array_elements_text(ct.tags) t
        WHERE ct.account_id = $1 AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id = ct.id AND c.assigned_user_id = $2))
        GROUP BY t ORDER BY contacts DESC, t LIMIT 100`,
      [accountId, req.user.role === 'agent' ? req.user.id : null],
    );
  });
}
