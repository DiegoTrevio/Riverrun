import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { assertAccount, HttpError, requireRole, scopeAccount, targetAccount } from '../access.js';
import { accountAi } from '../ai/budget.js';
import type { AiProvider } from '../ai/provider.js';
import { identifyAttachment, newAttachmentId, saveAttachment } from '../attachments.js';
import { checkAiDesignRate, designFlow } from '../automation/flow-ai.js';
import { BoardSchema, boardSummary, compileBoard, type Board, type CompiledFlow } from '../automation/flow-board.js';
import * as astore from '../automation/store.js';
import { AutomationBodySchema, SequenceBodySchema, type Action, type SequenceStep } from '../automation/types.js';
import { safeFileName } from '../channels/media.js';
import { query, queryOne, withTransaction } from '../db.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import type { User } from '../types.js';
import { checkReferences } from './automation.js';
import { parse } from './util.js';

/**
 * Lienzo de flujos: se guarda solo mientras se dibuja (con su número de revisión, para no pisar otra pestaña) y al
 * publicarse se convierte, en una sola transacción, en la regla y los flujos que ejecuta el sistema.
 */

interface PublishedMap { automation_id?: string | null; sequences?: Record<string, string> }
interface FlowBoardRow {
  id: string;
  account_id: string;
  name: string;
  board: unknown;
  revision: number;
  published_revision: number | null;
  published_at: Date | null;
  published_map: PublishedMap;
  published_hash: string | null;
  paused: boolean;
  created_at: Date;
  updated_at: Date;
}

const Name = z.string().trim().min(1, 'Ponle nombre al flujo').max(120);
const CreateBody = z.object({ name: Name, board: z.unknown().optional() });
const UpdateBody = z.object({ revision: z.number().int().nonnegative(), name: Name.optional(), board: z.unknown().optional() });
const Revision = z.object({ revision: z.number().int().nonnegative() });

/** Un id de relleno (válido) mientras se crean los flujos de las ramas: así se revisa todo antes de escribir. */
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';

const readBoard = (raw: unknown): Board => {
  const r = BoardSchema.safeParse(raw ?? {});
  if (!r.success) throw new HttpError(400, 'El lienzo tiene datos inválidos', r.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'lienzo'}: ${i.message}`));
  return r.data;
};

/** Huella de lo que se publicaría: cambia con los mensajes, botones, esperas o el inicio; no al mover tarjetas. */
function flowHash(board: Board, name: string) {
  const f = compileBoard(board, name);
  const sequences = f.sequences.map((s) => ({ key: s.key, name: s.name, steps: s.steps.map(({ node: _node, ...st }) => st) }));
  return createHash('sha256').update(JSON.stringify({ rule: f.rule, main: f.main, sequences, settings: board.settings })).digest('hex');
}
/** ¿Lo dibujado ya no es lo publicado? (solo si se publicó alguna vez). */
const pendingOf = (row: Pick<FlowBoardRow, 'published_hash'>, board: Board, name: string) => !!row.published_hash && flowHash(board, name) !== row.published_hash;

/** Palabras que un botón no puede decir (darse de baja, volver a recibir, aceptar promociones): se avisan en el lienzo. */
async function reservedWords(accountId: string) {
  const st = await astore.getSettings(accountId);
  return [...st.opt_out.keywords, ...st.opt_out.resume_keywords, ...st.consent.opt_in_keywords];
}

const boardFor = async (user: User, id: string) => assertAccount(user, await queryOne<FlowBoardRow>('SELECT * FROM flow_boards WHERE id = $1', [id]), 'Flujo no encontrado');

/** Los flujos del lienzo, listos para guardarse (las ramas apuntan a `ids`, o al relleno si aún no existen). */
function sequenceBodies(flow: CompiledFlow, board: Board, active: boolean, ids: Record<string, string>) {
  return flow.sequences.map((s) => ({
    key: s.key,
    body: SequenceBodySchema.parse({
      name: s.name,
      active,
      stop_on_reply: board.settings.stop_on_reply,
      business_hours_only: board.settings.business_hours_only,
      steps: s.steps.map(({ node: _node, ...st }) => ({
        ...st,
        buttons: st.buttons.map(({ target, ...b }) => (target ? { ...b, sequence_id: ids[target] ?? PLACEHOLDER } : b)),
      })),
    }),
  }));
}

function ruleBody(flow: CompiledFlow, name: string, active: boolean, mainId: string | null) {
  if (!flow.rule) return null;
  const actions: Action[] = [...flow.rule.actions, ...(mainId ? [{ type: 'start_sequence' as const, sequence_id: mainId }] : [])];
  return AutomationBodySchema.parse({ ...flow.rule, name, active, actions, priority: 0 });
}

/** Revisa el lienzo completo: lo que dibuja y lo que depende de la cuenta (fotos, archivos, flujos, palabras). */
async function validate(row: FlowBoardRow, board: Board) {
  const flow = compileBoard(board, row.name, { reserved: await reservedWords(row.account_id) });
  const errors = flow.problems.filter((p) => !p.warning);
  if (errors.length) throw new HttpError(400, 'Antes de publicar, resuelve los pendientes del lienzo', errors.map((p) => p.message), { problems: flow.problems });
  let bodies;
  let rule;
  try {
    bodies = sequenceBodies(flow, board, true, {});
    rule = ruleBody(flow, row.name, true, flow.main ? PLACEHOLDER : null);
  } catch (e) {
    const issues = e instanceof z.ZodError ? e.issues.map((i) => i.message) : [String((e as Error).message ?? e)];
    throw new HttpError(400, 'Antes de publicar, resuelve los pendientes del lienzo', issues, { problems: flow.problems });
  }
  // Los botones que llevan a otra rama de este lienzo todavía no tienen flujo: para revisarlos cuentan como «terminar».
  const steps: SequenceStep[] = bodies.flatMap((b) => b.body.steps).map((st) => ({ ...st, buttons: st.buttons.map((b) => (b.sequence_id === PLACEHOLDER ? { ...b, action: 'end' as const, sequence_id: null } : b)) }));
  const actions = (rule?.actions ?? []).filter((a) => !(a.type === 'start_sequence' && a.sequence_id === PLACEHOLDER));
  await checkReferences(row.account_id, { chatbot_id: rule?.chatbot_id ?? null, actions, steps });
  for (const st of steps) {
    if (!st.attachment_id) continue;
    const file = await astore.getAttachment(st.attachment_id);
    if (!file || file.account_id !== row.account_id) throw new HttpError(400, 'Un archivo de un mensaje ya no existe: vuelve a elegirlo.', undefined, { problems: flow.problems });
  }
  return { flow, problems: flow.problems };
}

/** Miniatura del dibujo para la lista: dónde está cada elemento, de qué tipo es y qué líneas los unen. */
function thumbOf(board: Board) {
  const index = new Map(board.nodes.map((n, i) => [n.id, i]));
  return {
    nodes: board.nodes.map((n) => [Math.round(n.x), Math.round(n.y), n.type]),
    edges: board.edges.flatMap((e) => (index.has(e.from) && index.has(e.to) ? [[index.get(e.from)!, index.get(e.to)!]] : [])),
  };
}

/** Detiene a quienes van en un flujo y lo borra (sus tareas programadas se cancelan). */
async function dropSequence(c: pg.PoolClient, id: string) {
  const active = await c.query<{ id: string }>(`SELECT id FROM sequence_enrollments WHERE sequence_id = $1 AND status = 'active'`, [id]);
  for (const e of active.rows) await astore.cancelJobs('enrollment_id', e.id, c);
  await c.query('DELETE FROM sequences WHERE id = $1', [id]);
}

async function dropAutomation(c: pg.PoolClient, id: string) {
  await astore.cancelJobs('automation_id', id, c);
  await c.query('DELETE FROM automations WHERE id = $1', [id]);
}

/** Lo que la IA lee del negocio para escribir mensajes con datos reales: su nombre y la información de su agente. */
export async function businessContext(accountId: string, limit = 6000) {
  const account = await store.getAccount(accountId);
  const lines = [`Nombre del negocio: ${account?.name ?? ''}`];
  const bots = await store.listChatbots(accountId);
  const bot = bots.find((b) => b.active) ?? bots[0];
  if (bot) {
    const items = (await store.listKnowledge(bot.id, true)).sort((a, b) => Number(b.always_include) - Number(a.always_include));
    let used = lines[0].length;
    for (const i of items) {
      const block = `${i.title}:\n${i.content.trim()}`;
      if (used + block.length > limit) { lines.push(block.slice(0, Math.max(0, limit - used))); break; }
      lines.push(block);
      used += block.length + 2;
    }
  }
  return lines.filter(Boolean).join('\n\n');
}

const DESIGN_IMAGE_MAX = 8_000_000;

/** La idea (texto), la foto opcional y el lienzo actual (si se pide un cambio), en un formulario o en JSON. */
async function readDesignInput(req: any) {
  let idea = '';
  let name = '';
  let board: unknown;
  let image: { buffer: Buffer; filename: string } | null = null;
  if (req.isMultipart?.()) {
    for await (const part of req.parts({ limits: { fileSize: DESIGN_IMAGE_MAX, files: 1, fieldSize: 2_000_000 } })) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        if (part.file.truncated) throw new HttpError(400, 'La imagen pesa más de 8 MB.');
        if (buffer.length) image = { buffer, filename: part.filename || 'imagen' };
      } else if (part.fieldname === 'idea') idea = String(part.value);
      else if (part.fieldname === 'name') name = String(part.value);
      else if (part.fieldname === 'board' && String(part.value)) {
        try { board = JSON.parse(String(part.value)); } catch { throw new HttpError(400, 'El lienzo actual llegó incompleto. Recarga la página.'); }
      }
    }
  } else {
    const b = req.body ?? {};
    idea = typeof b.idea === 'string' ? b.idea : '';
    name = typeof b.name === 'string' ? b.name : '';
    board = b.board ?? undefined;
  }
  if (idea.length > 4000) throw new HttpError(400, 'Tu idea es muy larga: resúmela en menos de 4000 caracteres.');
  const type = image ? identifyAttachment(image.buffer, image.filename) : null;
  if (image && type?.kind !== 'image') throw new HttpError(400, 'Sube una foto JPG, PNG o WEBP (por ejemplo, una foto de tu dibujo o una captura).');
  return { idea, name: name.trim().slice(0, 120), board, image: image && type ? { ...image, type } : null };
}

export async function flowBoardRoutes(api: FastifyInstance, ai: AiProvider) {
  const admins = { preHandler: requireRole('admin') };

  /**
   * Crear o cambiar un flujo describiéndolo (o con una foto). No guarda el lienzo: devuelve la propuesta para que el
   * panel la muestre (en un lienzo nuevo, o aplicada al abierto, con deshacer). Si un mensaje usa la foto adjunta, la
   * foto se guarda en los archivos de la cuenta.
   */
  api.post('/api/flow-boards/ai', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const input = await readDesignInput(req);
    if (!input.idea.trim() && !input.image) throw new HttpError(400, 'Escribe tu idea o sube una imagen del flujo.');
    checkAiDesignRate(accountId);
    const current = input.board === undefined ? null : readBoard(input.board);
    const uploadId = input.image ? newAttachmentId() : null;
    let result;
    try {
      result = await designFlow(accountAi(ai, accountId, null, 'flow_ai'), {
        idea: input.idea,
        image: input.image ? { mime: input.image.type.mime, data: input.image.buffer } : null,
        current,
        name: input.name,
        business: await businessContext(accountId),
        reserved: await reservedWords(accountId),
        uploadId,
      });
    } catch (e: any) {
      await logEvent({ level: 'warn', source: 'ai', message: `No se pudo armar el flujo con IA: ${e?.message ?? e}`, accountId });
      throw e;
    }
    for (const run of result.runs) {
      await store.insertAiRun({ account_id: accountId, chatbot_id: null, conversation_id: null, kind: 'flow_ai', model: run.model, input_tokens: run.usage.input_tokens, cached_tokens: run.usage.cached_tokens, output_tokens: run.usage.output_tokens, cost_usd: run.cost_usd, latency_ms: run.latency_ms });
    }
    let photo = null;
    if (result.usedUpload && input.image && uploadId) {
      const rel = await saveAttachment(accountId, uploadId, input.image.buffer, input.image.type);
      photo = await astore.insertAttachment({ id: uploadId, account_id: accountId, name: safeFileName(input.image.filename), mime: input.image.type.mime, kind: 'image', size_bytes: input.image.buffer.length, file_path: rel });
    }
    const messages = result.board.nodes.filter((n) => n.type === 'message').length;
    await logEvent({ level: 'info', source: 'admin', message: `${current ? 'Flujo cambiado' : 'Flujo armado'} con IA por ${req.user.email}: «${result.name}» (${messages} mensaje(s)${input.image ? ', desde una imagen' : ''})`, accountId });
    return { name: result.name, summary: result.summary, review: result.review, board: result.board, problems: result.problems, photo };
  });

  api.get('/api/flow-boards', admins, async (req: any) => {
    const accountId = scopeAccount(req.user, req.query.account_id);
    const rows = await query<FlowBoardRow>(
      accountId ? 'SELECT * FROM flow_boards WHERE account_id = $1 ORDER BY updated_at DESC' : 'SELECT * FROM flow_boards ORDER BY account_id, updated_at DESC',
      accountId ? [accountId] : [],
    );
    const seqIds = rows.flatMap((r) => Object.values(r.published_map.sequences ?? {}));
    const ruleIds = rows.map((r) => r.published_map.automation_id).filter((x): x is string => !!x);
    const [counts, rules] = await Promise.all([
      seqIds.length ? query<{ sequence_id: string; status: string; n: number }>(`SELECT sequence_id, status, count(*)::int AS n FROM sequence_enrollments WHERE sequence_id = ANY($1::uuid[]) GROUP BY 1, 2`, [seqIds]) : [],
      ruleIds.length ? query<{ id: string; active: boolean; run_count: number; last_run_at: Date | null }>(`SELECT id, active, run_count, last_run_at FROM automations WHERE id = ANY($1::uuid[])`, [ruleIds]) : [],
    ]);
    return rows.map((r) => {
      const parsed = BoardSchema.safeParse(r.board);
      const mine = new Set(Object.values(r.published_map.sequences ?? {}));
      const people = (status: string) => counts.filter((c) => mine.has(c.sequence_id) && c.status === status).reduce((n, c) => n + c.n, 0);
      const rule = rules.find((x) => x.id === r.published_map.automation_id) ?? null;
      return {
        id: r.id, account_id: r.account_id, name: r.name, revision: r.revision, published_revision: r.published_revision,
        published_at: r.published_at, paused: r.paused, created_at: r.created_at, updated_at: r.updated_at,
        pending: parsed.success ? pendingOf(r, parsed.data, r.name) : false,
        summary: parsed.success ? boardSummary(parsed.data) : null,
        thumb: parsed.success ? thumbOf(parsed.data) : null,
        runs: rule?.run_count ?? 0, last_run_at: rule?.last_run_at ?? null,
        people: { active: people('active'), completed: people('completed'), stopped: people('stopped') },
      };
    });
  });

  api.post('/api/flow-boards', admins, async (req: any) => {
    const body = parse(CreateBody, req.body);
    const accountId = await targetAccount(req.user, req.body?.account_id);
    const board = readBoard(body.board ?? {});
    const row = await queryOne<FlowBoardRow>(
      `INSERT INTO flow_boards (account_id, name, board, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
      [accountId, body.name, JSON.stringify(board), req.user.id],
    );
    return { ...row, problems: compileBoard(board, body.name, { reserved: await reservedWords(accountId) }).problems };
  });

  api.get('/api/flow-boards/:id', admins, async (req: any) => {
    const row = await boardFor(req.user, req.params.id);
    const board = BoardSchema.safeParse(row.board);
    return { ...row, board: board.success ? board.data : BoardSchema.parse({}), pending: board.success ? pendingOf(row, board.data, row.name) : false, problems: board.success ? compileBoard(board.data, row.name, { reserved: await reservedWords(row.account_id) }).problems : [] };
  });

  /** Guardado automático: solo si nadie más lo cambió desde la revisión que se tiene abierta. */
  api.put('/api/flow-boards/:id', admins, async (req: any) => {
    const row = await boardFor(req.user, req.params.id);
    const body = parse(UpdateBody, req.body);
    const board = body.board === undefined ? readBoard(row.board) : readBoard(body.board);
    const name = body.name ?? row.name;
    const saved = await queryOne<FlowBoardRow>(
      `UPDATE flow_boards SET name = $3, board = $4, revision = revision + 1, updated_at = now() WHERE id = $1 AND revision = $2 RETURNING *`,
      [row.id, body.revision, name, JSON.stringify(board)],
    );
    if (!saved) throw new HttpError(409, 'Este flujo cambió en otra pestaña o en otro equipo. Recarga para ver la versión más reciente.', undefined, { revision: row.revision });
    return { id: saved.id, name: saved.name, revision: saved.revision, updated_at: saved.updated_at, published_revision: saved.published_revision, pending: pendingOf(saved, board, name), problems: compileBoard(board, name, { reserved: await reservedWords(row.account_id) }).problems };
  });

  /** Revisión sin publicar: qué falta, y en qué se convertiría. */
  api.post('/api/flow-boards/:id/check', admins, async (req: any) => {
    const row = await boardFor(req.user, req.params.id);
    const board = readBoard(row.board);
    const flow = compileBoard(board, row.name, { reserved: await reservedWords(row.account_id) });
    return { problems: flow.problems, rule: !!flow.rule, sequences: flow.sequences.map((s) => ({ name: s.name, messages: s.steps.length })) };
  });

  api.post('/api/flow-boards/:id/publish', admins, async (req: any) => {
    const row = await boardFor(req.user, req.params.id);
    const { revision } = parse(Revision, req.body);
    if (revision !== row.revision) throw new HttpError(409, 'Este flujo cambió en otra pestaña o en otro equipo. Recarga antes de publicar.', undefined, { revision: row.revision });
    const board = readBoard(row.board);
    const { flow, problems } = await validate(row, board);
    const result = await withTransaction(async (c) => {
      const locked = (await c.query<FlowBoardRow>('SELECT * FROM flow_boards WHERE id = $1 FOR UPDATE', [row.id])).rows[0];
      if (!locked || locked.revision !== revision) throw new HttpError(409, 'Este flujo cambió mientras se publicaba. Recarga y vuelve a publicar.');
      const active = !locked.paused;
      const owned = new Set((await c.query<{ id: string }>('SELECT id FROM sequences WHERE board_id = $1', [row.id])).rows.map((r) => r.id));
      const prev = locked.published_map.sequences ?? {};
      // Primero cada flujo tiene su id (el de la publicación anterior, si sigue), luego se escriben con las ramas resueltas.
      const ids: Record<string, string> = {};
      for (const s of flow.sequences) {
        const known = prev[s.key];
        ids[s.key] = known && owned.has(known) ? known
          : (await c.query<{ id: string }>(`INSERT INTO sequences (account_id, name, active, steps, board_id) VALUES ($1, $2, false, '[]', $3) RETURNING id`, [row.account_id, s.name, row.id])).rows[0].id;
      }
      for (const { key, body } of sequenceBodies(flow, board, active, ids)) {
        await c.query(
          `UPDATE sequences SET name = $2, active = $3, steps = $4, stop_on_reply = $5, business_hours_only = $6, board_id = $7, updated_at = now() WHERE id = $1`,
          [ids[key], body.name, body.active, JSON.stringify(body.steps), body.stop_on_reply, body.business_hours_only, row.id],
        );
      }
      const kept = new Set(Object.values(ids));
      for (const id of owned) if (!kept.has(id)) await dropSequence(c, id);

      const knownRule = locked.published_map.automation_id
        ? (await c.query<{ id: string }>('SELECT id FROM automations WHERE id = $1 AND board_id = $2', [locked.published_map.automation_id, row.id])).rows[0]?.id ?? null
        : null;
      const rule = ruleBody(flow, locked.name, active, flow.main ? ids[flow.main] : null);
      let automationId: string | null = null;
      if (rule) {
        const params = [rule.name, rule.active, rule.chatbot_id, JSON.stringify(rule.trigger), JSON.stringify(rule.conditions), JSON.stringify(rule.actions), rule.stop_ai, rule.priority, rule.once_per_conversation];
        automationId = knownRule
          ? (await c.query<{ id: string }>(`UPDATE automations SET name=$1, active=$2, chatbot_id=$3, trigger=$4, conditions=$5, actions=$6, stop_ai=$7, priority=$8, once_per_conversation=$9, updated_at=now() WHERE id = $10 RETURNING id`, [...params, knownRule])).rows[0].id
          : (await c.query<{ id: string }>(`INSERT INTO automations (name, active, chatbot_id, trigger, conditions, actions, stop_ai, priority, once_per_conversation, account_id, board_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [...params, row.account_id, row.id])).rows[0].id;
      } else if (knownRule) await dropAutomation(c, knownRule);
      // Otras reglas que quedaron de este lienzo no se quedan sueltas.
      const strays = await c.query<{ id: string }>('SELECT id FROM automations WHERE board_id = $1 AND id <> ALL($2::uuid[])', [row.id, automationId ? [automationId] : []]);
      for (const s of strays.rows) await dropAutomation(c, s.id);

      const map: PublishedMap = { automation_id: automationId, sequences: ids };
      const saved = (await c.query<FlowBoardRow>(`UPDATE flow_boards SET published_map = $2, published_hash = $3, published_revision = revision, published_at = now() WHERE id = $1 RETURNING *`, [row.id, JSON.stringify(map), flowHash(board, locked.name)])).rows[0];
      return { saved, automationId, ids };
    });
    const messages = flow.sequences.reduce((n, s) => n + s.steps.length, 0);
    await logEvent({ level: 'info', source: 'admin', message: `Flujo del lienzo publicado: «${row.name}» (${messages} mensaje(s) en ${flow.sequences.length} flujo(s)${result.automationId ? ', con su regla' : ''})`, accountId: row.account_id });
    return {
      id: row.id, revision: result.saved.revision, published_revision: result.saved.published_revision, published_at: result.saved.published_at, paused: result.saved.paused, pending: false,
      automation_id: result.automationId, sequences: flow.sequences.map((s) => ({ id: result.ids[s.key], name: s.name, messages: s.steps.length })), problems,
    };
  });

  /** Pausar (o reanudar) lo publicado: la regla deja de iniciar el flujo y quienes van en él se detienen en su siguiente mensaje. */
  api.post('/api/flow-boards/:id/pause', admins, async (req: any) => {
    const row = await boardFor(req.user, req.params.id);
    const { paused } = parse(z.object({ paused: z.boolean() }), req.body);
    await withTransaction(async (c) => {
      await c.query('UPDATE flow_boards SET paused = $2 WHERE id = $1', [row.id, paused]);
      await c.query('UPDATE automations SET active = $2, updated_at = now() WHERE board_id = $1', [row.id, !paused]);
      await c.query('UPDATE sequences SET active = $2, updated_at = now() WHERE board_id = $1', [row.id, !paused]);
    });
    await logEvent({ level: 'info', source: 'admin', message: `Flujo del lienzo ${paused ? 'en pausa' : 'reanudado'}: «${row.name}»`, accountId: row.account_id });
    return { id: row.id, paused };
  });

  api.post('/api/flow-boards/:id/duplicate', admins, async (req: any) => {
    const row = await boardFor(req.user, req.params.id);
    const name = `${row.name} (copia)`.slice(0, 120);
    return queryOne<FlowBoardRow>(`INSERT INTO flow_boards (account_id, name, board, created_by) VALUES ($1, $2, $3, $4) RETURNING *`, [row.account_id, name, JSON.stringify(row.board), req.user.id]);
  });

  /** Borrar el lienzo borra lo que publicó: su regla y sus flujos (quienes iban en ellos se detienen). */
  api.delete('/api/flow-boards/:id', admins, async (req: any) => {
    const row = await boardFor(req.user, req.params.id);
    await withTransaction(async (c) => {
      for (const r of (await c.query<{ id: string }>('SELECT id FROM automations WHERE board_id = $1', [row.id])).rows) await dropAutomation(c, r.id);
      for (const s of (await c.query<{ id: string }>('SELECT id FROM sequences WHERE board_id = $1', [row.id])).rows) await dropSequence(c, s.id);
      await c.query('DELETE FROM flow_boards WHERE id = $1', [row.id]);
    });
    await logEvent({ level: 'info', source: 'admin', message: `Flujo del lienzo eliminado: «${row.name}»`, accountId: row.account_id });
    return { ok: true };
  });
}
