/**
 * El ciclo de un turno del Copiloto: el modelo pide herramientas, cada una se ejecuta (o queda como propuesta) y su
 * resultado vuelve al modelo, hasta que responde con texto. Corre en el mismo proceso que recibió el mensaje; cada
 * paso queda guardado y el panel lo va mostrando. «Detener» se revisa entre paso y paso.
 */
import { config } from '../config.js';
import { queryOne } from '../db.js';
import type { AiProvider, AnyMessage, ToolCall } from '../ai/provider.js';
import { AiError } from '../ai/provider.js';
import { accountAi, AiBudgetBlocked } from '../ai/budget.js';
import { trackSubSpend, type SubSpend } from '../ai/sub-spend.js';
import { insertAiRun } from '../store/index.js';
import { logEvent } from '../logs.js';
import type { User } from '../types.js';
import { makeCaller, ToolError, type Inject } from './executor.js';
import { allowed, packOf, toolSpec, type Ctx, type ToolDef } from './registry.js';
import { assessRisk } from './risk.js';
import { forModel } from './summarize.js';
import { describePage } from './page.js';
import { accountSnapshot, systemMessage, touchesCustomers } from './prompt.js';
import { buildHistory, FULL_TURNS, replayedToolNames } from './history.js';
import { activePacks, packIndex, visibleTools } from './packs.js';
import { threadFiles } from './files.js';
import * as cs from './store.js';

export interface RunnerDeps { ai: AiProvider; inject: Inject; tools: ToolDef[] }
/** `maxUsd`: lo que le queda a la cuenta del tope diario del Copiloto (el pedido no gasta más que eso). */
export interface TurnRequest {
  thread: cs.Thread; turn: cs.Turn; user: User; cookie: string; ip?: string; refs: string[]; maxUsd?: number;
  /** Pedido que sigue solo después de confirmar («Confirmar y seguir»), con lo que el anterior anotó que faltaba. */
  continuation?: { plan: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inflight = new Set<Promise<void>>();

/** Arranca el turno sin esperar a que termine (el panel va pidiendo las novedades). */
export function startTurnInBackground(deps: RunnerDeps, req: TurnRequest): Promise<void> {
  const p = runTurn(deps, req).catch(() => undefined).finally(() => inflight.delete(p));
  inflight.add(p);
  return p;
}

/** Al apagar el proceso: espera a que terminen los turnos en curso (con tope); los que no, quedan interrumpidos. */
export async function settleTurns(ms = 20000) {
  if (!inflight.size) return;
  await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, ms))]);
}

export async function accountInfo(accountId: string) {
  return (await queryOne<{ name: string; timezone: string }>(
    `SELECT name, coalesce(settings->>'timezone', 'America/Mexico_City') AS timezone FROM accounts WHERE id = $1`,
    [accountId],
  )) ?? { name: '', timezone: 'America/Mexico_City' };
}

export function toolsFor(user: User, tools: ToolDef[]): ToolDef[] {
  return tools.filter((t) => allowed(t, user));
}

/** Ids que aparecen en los argumentos de una acción (para el alcance de «Cambiar esto»). */
function idsIn(value: unknown, out: Set<string>) {
  if (typeof value === 'string' && UUID.test(value)) out.add(value);
  else if (Array.isArray(value)) for (const v of value) idsIn(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) idsIn(v, out);
}

/** Contexto de una herramienta: quién, en qué cuenta, con qué sesión y qué página tiene abierta. */
export async function contextFor(o: {
  deps: RunnerDeps; user: User; accountId: string; cookie: string; ip?: string; threadId: string; turnId: string; page: cs.Page; actionId?: string;
  /** Permiso de un uso del código escrito en la tarjeta (solo al confirmar una propuesta `code`). */
  grant?: string;
}): Promise<Ctx> {
  const [{ timezone }, attached] = await Promise.all([accountInfo(o.accountId), threadFiles(o.threadId)]);
  const call = makeCaller({ inject: o.deps.inject, cookie: o.cookie, accountId: o.accountId, superadmin: o.user.role === 'superadmin', ip: o.ip, actionId: o.actionId, grant: o.grant });
  // Los archivos vigentes de esta conversación: las herramientas los leen por su id (`fileForTool`).
  const files = new Map(attached.filter((f) => new Date(f.expires_at).getTime() > Date.now()).map((f) => [f.id, f]));
  return { user: o.user, accountId: o.accountId, timezone, call, page: o.page, threadId: o.threadId, turnId: o.turnId, scope: new Set(), tainted: false, files };
}

function errorText(e: unknown): string {
  if (e instanceof ToolError) return JSON.stringify({ error: e.code, mensaje: e.message, ...(e.issues.length ? { detalles: e.issues } : {}) });
  return JSON.stringify({ error: 'error', mensaje: 'La acción falló en el servidor.' });
}

const err = (code: string, mensaje: string) => JSON.stringify({ error: code, mensaje });

/** Tarjeta de confirmación de una herramienta sin vista previa propia: lo que se pidió, campo por campo. */
/**
 * Tarjeta de una herramienta sin vista propia: todos sus argumentos, completos (AI-6). Recortarlos dejaba que lo que se
 * confirma no fuera todo lo que se ejecuta (una instrucción escondida después del corte). El panel los muestra con
 * desplazamiento.
 */
export function genericPreview(def: ToolDef, args: unknown): cs.Preview {
  const fmt = (v: unknown): string => (typeof v === 'string' ? `«${v}»`
    : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ')
    : v && typeof v === 'object' ? JSON.stringify(v) : String(v));
  const lines = Object.entries((args ?? {}) as Record<string, unknown>).filter(([, v]) => v !== undefined).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${fmt(v)}`);
  return { title: def.label(args).replace(/…$/, ''), lines };
}

export async function runTurn(deps: RunnerDeps, req: TurnRequest): Promise<void> {
  const { thread, turn, user } = req;
  const started = Date.now();
  const limits = config.copilot;
  const heartbeat = setInterval(() => { void cs.heartbeat(turn.id).catch(() => undefined); }, 5000);
  const say = (content: string) => cs.addMessage({ thread_id: thread.id, turn_id: turn.id, role: 'assistant', content });
  try {
    const account = await accountInfo(thread.account_id);
    const ctx = await contextFor({ deps, user, accountId: thread.account_id, cookie: req.cookie, ip: req.ip, threadId: thread.id, turnId: turn.id, page: turn.page });
    await cs.heartbeat(turn.id, 'Revisando la página abierta…');
    const page = await describePage(turn.page, ctx.call);
    ctx.page = page;
    for (const id of [page.id, page.contactId]) if (id) ctx.scope.add(id);
    // La página de un cliente lleva su nombre al prompt, y ese nombre lo escribe el cliente: el turno cuenta como si
    // hubiera leído sus mensajes (lo de esa ficha sigue sin confirmación; la configuración se confirma).
    if (page.contactId) {
      ctx.tainted = true;
      // Queda en el turno: la respuesta (que puede citar el nombre) cuenta como contaminada en los turnos siguientes.
      await cs.markTurn(turn.id, { tainted: true, contactIds: [page.contactId] });
    }
    // Las acciones señaladas con «Cambiar esto» se pueden cambiar sin pedir confirmación aunque el turno lea mensajes de clientes.
    for (const a of await cs.actionsByIds(req.refs, thread.id)) {
      a.contact_ids.forEach((id) => ctx.scope.add(id));
      idsIn(a.args, ctx.scope);
      idsIn(a.result, ctx.scope);
    }
    // Lo que se leyó de clientes en los turnos que el modelo vuelve a ver completos sigue en el historial.
    if (await cs.recentlyTainted(thread.id, turn.id, FULL_TURNS)) ctx.tainted = true;

    // Todas las que puede usar su rol; al modelo solo van las de los paquetes cargados (núcleo + los que hacen falta).
    const all = toolsFor(user, deps.tools);
    const snapshot = await accountSnapshot(ctx.call);
    const [stored, actions] = await Promise.all([cs.threadMessages(thread.id), cs.threadActions(thread.id)]);
    const packs = activePacks({ all, page, replayed: replayedToolNames(stored), previous: await cs.previousPacks(thread.id, turn.id) });
    let visible = visibleTools(all, packs);
    let specs = visible.map(toolSpec);
    let packsChanged = false;
    ctx.packs = packs;
    ctx.loadPacks = (more) => {
      for (const p of more) packs.add(p);
      packsChanged = true;
      return all.filter((d) => more.includes(packOf(d))).map((d) => d.name);
    };
    await cs.markTurn(turn.id, { packs: [...packs] });
    // AI-5: los títulos de las acciones sobre clientes (con sus nombres) entran al prompt; el turno cuenta como contaminado.
    const listed = [...actions.filter((a) => a.risk !== 'read').slice(-12), ...(await cs.actionsByIds(req.refs, thread.id))];
    if (listed.some(touchesCustomers)) ctx.tainted = true;
    const system = systemMessage({
      model: limits.model, user, accountName: account.name, timezone: ctx.timezone, snapshot, page, actions,
      index: limits.toolPacks ? packIndex(all) : '', continuing: req.continuation?.plan,
    });
    const history: AnyMessage[] = buildHistory(stored, actions, await threadFiles(thread.id), await cs.taintedTurnIds(thread.id));
    const ai = accountAi(deps.ai, thread.account_id, null, 'copilot');
    const fallback = limits.fallbackModels.length ? limits.fallbackModels : 'none' as const;

    let cost = 0, toolCalls = 0, changes = 0, proposals = 0;
    const maxCost = Math.min(limits.turnMaxUsd, req.maxUsd ?? Infinity);
    let limitHit = '';
    // Costo al llegar la respuesta del modelo: lo que suben sus herramientas (su IA por dentro) se mide contra el tope.
    let batchCost = 0;
    // Cambios y propuestas ya hechos en este pedido (no se repiten); las consultas se olvidan al cambiar algo.
    const done = new Map<string, string>();
    const reads = new Map<string, string>();
    // «Confirmar y seguir»: solo si este pedido dejó algo por confirmar.
    ctx.planContinuation = async (faltan) => {
      if (!proposals) return false;
      await cs.setContinuePlan(turn.id, faltan);
      return true;
    };

    const ask = async (toolChoice: 'auto' | 'none') => {
      const res = await ai.complete({
        model: limits.model, fallback_models: fallback, messages: [system, ...history], tools: specs, tool_choice: toolChoice,
        temperature: 0.2, max_tokens: 4096, timeout_ms: 90_000, max_attempts: 2, prompt_cache: true,
      });
      const usage = { input: res.usage.input_tokens, cached: res.usage.cached_tokens, output: res.usage.output_tokens, cost: res.cost_usd ?? 0 };
      cost += usage.cost;
      await cs.addUsage(turn.id, usage);
      await insertAiRun({ account_id: thread.account_id, chatbot_id: null, conversation_id: null, kind: 'copilot', model: res.model, input_tokens: usage.input, cached_tokens: usage.cached, output_tokens: usage.output, latency_ms: res.latency_ms, cost_usd: res.cost_usd });
      return res;
    };

    // AI-9: la IA que gastan las herramientas por dentro (editar instrucciones, diseñar un flujo, importar…) cuenta para el
    // tope del pedido y para el del día de la cuenta, igual que la del propio Copiloto.
    const sub: SubSpend = { usd: 0, calls: 0 };
    let subCounted = 0;
    const runTool = async (call: ToolCall): Promise<string> => {
      try {
        return await trackSubSpend(sub, () => runToolInner(call));
      } finally {
        const delta = sub.usd - subCounted;
        if (delta > 0) {
          subCounted = sub.usd;
          cost += delta;
          await cs.addSubCost(turn.id, delta).catch(() => undefined);
        }
      }
    };
    const runToolInner = async (call: ToolCall): Promise<string> => {
      toolCalls++;
      await cs.countToolCall(turn.id);
      if (toolCalls > limits.maxToolCalls) { limitHit = 'herramientas'; return err('limite', 'Llegué al máximo de acciones por pedido.'); }
      // AI-12: el tope de costo y de tiempo también entre herramientas de una misma respuesta (varias en paralelo, cada
      // una con su propia IA por dentro, podían pasarse muchas veces del tope antes de volver a revisarlo).
      if ((cost >= maxCost && cost > batchCost) || Date.now() - started > limits.turnSeconds * 1000) {
        limitHit = 'costo';
        return err('limite', 'Llegué al tope de costo o de tiempo de este pedido; pide el resto en otro mensaje.');
      }
      const def = all.find((d) => d.name === call.name);
      if (!def) return err('no_disponible', `«${call.name}» no existe o tu usuario no la puede usar.`);
      // Una herramienta de su rol cuyo paquete no estaba cargado: se carga (el siguiente paso ya trae su esquema).
      const loadedNow = !visible.includes(def);
      if (loadedNow) ctx.loadPacks!([packOf(def)]);
      let raw: unknown;
      try { raw = JSON.parse(call.arguments || '{}'); } catch { return err('datos_invalidos', 'Los argumentos no son un JSON válido.'); }
      const parsed = def.schema.safeParse(raw);
      if (!parsed.success) {
        return JSON.stringify({
          error: 'datos_invalidos', mensaje: loadedNow ? 'Argumentos inválidos. Ya cargué su esquema: vuelve a intentarlo con los argumentos correctos.' : 'Argumentos inválidos',
          detalles: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || 'argumentos'}: ${i.message}`),
        });
      }
      const args = parsed.data;
      const key = `${def.name}:${cs.stableJson(args)}`;
      const prior = done.get(key) ?? reads.get(key);
      if (prior !== undefined) return JSON.stringify({ estado: 'ya_hecho', nota: 'Esta misma acción ya se hizo en este pedido.', resultado_anterior: prior });
      await cs.heartbeat(turn.id, def.label(args));

      let risk;
      try { risk = await assessRisk(def, args, ctx); } catch (e) { return errorText(e); }

      if (risk.level === 'read') {
        try {
          const r = await def.execute(args, ctx);
          // Lo que se lee después de haber leído texto de clientes ya no amplía lo que se puede cambiar sin confirmar. La
          // lectura que trae ese texto, solo si es de un único cliente (lo que la persona buscó): en una lista, lo que
          // escribió uno de los clientes podría pedir cambios sobre los demás.
          if (!ctx.tainted && (!r.untrusted || (r.contactIds?.length ?? 0) <= 1)) {
            r.read?.forEach((t) => ctx.scope.add(t.id));
            r.contactIds?.forEach((id) => ctx.scope.add(id));
          }
          if (r.untrusted) ctx.tainted = true;
          if (r.untrusted || r.contactIds?.length) await cs.markTurn(turn.id, { tainted: !!r.untrusted || (r.contactIds?.length ?? 0) > 1, contactIds: r.contactIds });
          // Las del propio Copiloto (cargar herramientas) no son acciones sobre la cuenta: no dejan tarjeta.
          if (!def.meta) await cs.insertAction({ thread_id: thread.id, turn_id: turn.id, account_id: thread.account_id, user_id: user.id, tool_call_id: call.id, tool: def.name, args: args as Record<string, unknown>, risk: 'read', status: 'done', title: r.title ?? def.label(args), links: r.links ?? [], contact_ids: r.contactIds ?? [], executed_at: new Date() });
          const text = forModel(r.data);
          reads.set(key, text);
          return text;
        } catch (e) {
          if (e instanceof ToolError && e.code === 'sesion') throw e;
          return errorText(e);
        }
      }

      if (risk.level === 'reversible') {
        if (changes >= limits.maxChanges) { limitHit = 'cambios'; return err('limite', 'Llegué al máximo de cambios por pedido; pide el resto en otro mensaje.'); }
        changes++;
        const action = await cs.insertAction({ thread_id: thread.id, turn_id: turn.id, account_id: thread.account_id, user_id: user.id, tool_call_id: call.id, tool: def.name, args: args as Record<string, unknown>, risk: 'reversible', risk_reasons: risk.reasons, status: 'executing', title: def.label(args) });
        try {
          const r = await cs.withLease(action.id, () => def.execute(args, { ...ctx, call: makeCaller({ inject: deps.inject, cookie: req.cookie, accountId: thread.account_id, superadmin: user.role === 'superadmin', ip: req.ip, actionId: action.id }) }));
          const title = r.title ?? def.label(args);
          if (!ctx.tainted) r.contactIds?.forEach((id) => ctx.scope.add(id));
          if (r.untrusted) ctx.tainted = true;
          if (r.untrusted || r.contactIds?.length) await cs.markTurn(turn.id, { tainted: !!r.untrusted || (r.contactIds?.length ?? 0) > 1, contactIds: r.contactIds });
          await cs.updateAction(action.id, {
            status: 'done', title, result: r.data ?? null, links: r.links ?? [], before: r.before ?? null, after: r.after ?? null, undo: r.undo ?? null,
            undo_until: r.undo ? new Date(Date.now() + limits.undoDays * 86400_000) : null, contact_ids: r.contactIds ?? [], executed_at: new Date(),
            ...(r.preview ? { preview: r.preview } : {}),
          });
          await logEvent({ level: 'info', source: 'copilot', message: `Copiloto (${user.email}): ${title}`, accountId: thread.account_id, details: { copilot_action_id: action.id, tool: def.name, turn_id: turn.id, risk: 'reversible' } }).catch(() => undefined);
          const text = forModel({ estado: 'hecho', accion: `A${action.id.slice(0, 8)}`, resumen: title, resultado: r.data });
          done.set(key, text);
          reads.clear(); // lo que se consultó antes puede haber cambiado
          return text;
        } catch (e) {
          await cs.updateAction(action.id, { status: 'failed', error: e instanceof ToolError ? e.message : 'La acción falló en el servidor.' });
          if (e instanceof ToolError && e.code === 'sesion') throw e;
          return errorText(e);
        }
      }

      // Confirmar (o confirmar con código): no se ejecuta; queda una propuesta con su vista previa.
      const withCode = risk.level === 'code';
      if (withCode && !limits.codeActions) return err('sin_permiso', 'Esta acción la tienes que hacer tú desde el panel.');
      if (proposals >= limits.maxProposals) { limitHit = 'propuestas'; return err('limite', 'Ya dejé varias propuestas por confirmar; pide el resto cuando las revises.'); }
      let preview: cs.Preview;
      let contactIds: string[] = [];
      try {
        preview = def.preview ? await def.preview(args, ctx) : genericPreview(def, args);
        contactIds = def.targets ? (await def.targets(args, ctx)).filter((t) => t.kind === 'contact').map((t) => t.id) : [];
      } catch (e) {
        return errorText(e);
      }
      proposals++;
      const action = await cs.insertAction({
        thread_id: thread.id, turn_id: turn.id, account_id: thread.account_id, user_id: user.id, tool_call_id: call.id, tool: def.name,
        args: args as Record<string, unknown>, args_hash: cs.argsHash(def.name, args, preview), risk: withCode ? 'code' : 'confirm', risk_reasons: risk.reasons,
        status: 'proposed', title: preview.title, preview, contact_ids: contactIds, expires_at: new Date(Date.now() + limits.proposalMinutes * 60_000),
      });
      if (contactIds.length) await cs.markTurn(turn.id, { contactIds });
      const text = JSON.stringify({
        estado: 'pendiente_de_confirmacion', accion: `A${action.id.slice(0, 8)}`, resumen: preview.title, ...(risk.reasons.length ? { motivo: risk.reasons } : {}),
        ...(withCode
          ? { con_codigo: true, nota: 'Todavía no se hace: la persona lo confirma escribiendo su código de verificación en la tarjeta. Nunca le pidas el código en el chat.' }
          : { nota: 'Todavía no se hace: la persona debe confirmarlo en la tarjeta.' }),
      });
      done.set(key, text);
      return text;
    };

    for (let step = 0; ; step++) {
      if (await cs.stopRequested(turn.id)) {
        await say('Me detuve como pediste. Lo que ya hice queda en las tarjetas, con su opción de deshacer.');
        await cs.finishTurn(turn.id, 'stopped');
        return;
      }
      const overTime = Date.now() - started > limits.turnSeconds * 1000;
      const overCost = cost >= maxCost;
      const last = step >= limits.maxSteps || overTime || overCost || !!limitHit;
      await cs.heartbeat(turn.id, last ? 'Escribiendo el resumen…' : 'Pensando…');
      const res = await ask(last ? 'none' : 'auto');
      if (last || !res.tool_calls?.length) {
        await say(res.content || (last ? 'Llegué al límite de este pedido; lo que hice está en las tarjetas.' : 'Listo.'));
        await cs.finishTurn(turn.id, 'done');
        await cs.touchThread(thread.id);
        return;
      }
      const calls = res.tool_calls;
      history.push({ role: 'assistant', content: res.content || null, tool_calls: calls });
      await cs.addMessage({ thread_id: thread.id, turn_id: turn.id, role: 'assistant', content: res.content, tool_calls: calls });
      batchCost = cost;
      for (const c of calls) {
        const stopped = await cs.stopRequested(turn.id);
        const content = stopped ? err('detenido', 'No se ejecutó: la persona pidió detener.')
          // La respuesta se cortó por largo: los argumentos pueden venir incompletos.
          : res.finish_reason === 'length' ? err('respuesta_cortada', 'Tu respuesta se cortó por largo; haz el cambio en partes más chicas.')
          : await runTool(c);
        history.push({ role: 'tool', tool_call_id: c.id, content });
        await cs.addMessage({ thread_id: thread.id, turn_id: turn.id, role: 'tool', tool_call_id: c.id, content });
      }
      // Paquetes nuevos: el siguiente paso ya manda sus herramientas (y el siguiente pedido los conserva).
      if (packsChanged) {
        packsChanged = false;
        visible = visibleTools(all, packs);
        specs = visible.map(toolSpec);
        await cs.markTurn(turn.id, { packs: [...packs] });
      }
    }
  } catch (e: any) {
    const message = e instanceof AiBudgetBlocked
      ? 'Esta cuenta llegó a su presupuesto de IA, así que no puedo seguir. Lo puedes revisar en Consumo de IA.'
      : e instanceof ToolError && e.code === 'sesion'
        ? 'Tu sesión terminó. Vuelve a entrar al panel y pídemelo de nuevo.'
        : e instanceof AiError
          ? `No pude comunicarme con la IA: ${e.message}`
          : 'Algo falló y no pude terminar. Lo que alcancé a hacer queda en las tarjetas.';
    if (!(e instanceof AiBudgetBlocked || e instanceof ToolError || e instanceof AiError)) {
      await logEvent({ level: 'error', source: 'copilot', message: `Copiloto: el turno falló: ${e?.message ?? e}`, accountId: thread.account_id, details: { turn_id: turn.id } }).catch(() => undefined);
    }
    await say(message).catch(() => undefined);
    await cs.finishTurn(turn.id, 'failed', message).catch(() => undefined);
  } finally {
    clearInterval(heartbeat);
  }
}
