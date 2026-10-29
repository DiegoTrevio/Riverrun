/**
 * API pública v1 para integraciones (Zapier, Make, n8n, tu CRM…). Autenticación con llave de la cuenta:
 *   Authorization: Bearer rr_xxxxxxxx
 * Las llaves son "read" (solo GET) o "write". Todo queda limitado a la cuenta de la llave. Documentación: docs/integraciones.md
 *
 * Pensada para conectarse sin adivinar: los canales y los datos del cliente se consultan (/channels, /contact-fields),
 * el teléfono se acepta en cualquier formato, cada error trae un `code` estable y los campos con problema, y un POST/PUT
 * con Idempotency-Key se puede reintentar sin duplicar nada.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../access.js';
import { rateLimited } from '../auth.js';
import { query, queryOne } from '../db.js';
import { deepClean } from '../engine/text.js';
import { cleanFieldValue, listContactFields, type ContactField } from '../contacts/fields.js';
import { normalizePhone, phoneVariants } from '../contacts/phone.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import * as astore from '../automation/store.js';
import * as assignment from '../automation/assignment.js';
import { NoticeBody, sendNotice } from '../automation/notices.js';
import { describeConversation } from '../automation/alert-format.js';
import { hashKey } from './integrations.js';
import { conversationExport, ExportContentSchema } from '../integrations/conversation-export.js';
import { appointmentPayload } from '../integrations/webhooks.js';
import { createPlan, createReceivable, listPlans, PlanBody, planOut, ReceivableBody, receivableOut } from './receivables.js';
import { getPlan } from '../receivables/plans.js';
import { config } from '../config.js';
import { getReceivable, listReceivables, todayIn } from '../receivables/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: { id: string; account_id: string; scope: 'read' | 'write'; name: string };
  }
}

const Limit = z.coerce.number().int().min(1).max(200).default(50);
const Iso = z.string().datetime({ offset: true });
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const dec = (s: string | undefined): any => {
  if (!s) return null;
  try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { throw apiError(400, 'invalid_cursor', 'cursor inválido: usa el next_cursor de la página anterior tal cual', { fields: [{ field: 'cursor', message: 'cursor inválido' }] }); }
};

/* ------------------------------ Errores ------------------------------ */

/**
 * Error de la API: `error` (para personas, en español) e `issues` como siempre, más `code` (estable, para tu programa)
 * y `fields` (qué campo y por qué).
 */
export function apiError(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  const fields = extra.fields as { field: string; message: string }[] | undefined;
  return new HttpError(status, message, fields?.map((f) => `${f.field}: ${f.message}`), { code, ...extra });
}

/** Código según el estado, para los errores que no traen uno propio (los que vienen de partes compartidas con el panel). */
const CODE_BY_STATUS: Record<number, string> = {
  400: 'invalid_request', 401: 'invalid_key', 402: 'account_paused', 403: 'forbidden', 404: 'not_found', 409: 'conflict',
  413: 'payload_too_large', 415: 'unsupported_media_type', 422: 'unprocessable', 429: 'rate_limited',
};

const es = z.locales.es();
/** Valida el cuerpo o la consulta. Los mensajes van en español y cada problema dice su campo. */
function input<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(deepClean(body ?? {}), { error: es.localeError });
  if (r.success) return r.data;
  const fields = r.error.issues.map((i) => ({ field: i.path.join('.') || 'cuerpo', message: i.message }));
  throw apiError(400, 'invalid_request', `Datos inválidos: ${fields.map((f) => `${f.field}: ${f.message}`).join('; ')}`, { fields });
}

/* ------------------------------ Teléfonos y canales ------------------------------ */

/** Canales donde se da de alta por teléfono (WhatsApp), para elegir el de omisión. */
const phoneChannels = (accountId: string) =>
  query<{ id: string; name: string }>(`SELECT id, name FROM channels WHERE account_id = $1 AND type = 'whatsapp' AND active ORDER BY created_at, id`, [accountId]);

/** El canal indicado, o el único WhatsApp de la cuenta si no se indicó. */
async function whatsappChannel(accountId: string, channelId: string | undefined) {
  if (channelId) {
    const channel = await store.getChannel(channelId);
    if (!channel || channel.account_id !== accountId || channel.type !== 'whatsapp') {
      throw apiError(400, 'invalid_channel', 'channel_id debe ser un canal de WhatsApp de tu cuenta (consúltalos en GET /api/v1/channels)', { fields: [{ field: 'channel_id', message: 'no es un canal de WhatsApp de tu cuenta' }] });
    }
    return channel;
  }
  const list = await phoneChannels(accountId);
  if (list.length === 1) return (await store.getChannel(list[0].id))!;
  if (!list.length) throw apiError(400, 'no_whatsapp_channel', 'Tu cuenta no tiene un canal de WhatsApp activo: conéctalo en Canales');
  throw apiError(400, 'channel_required', `Tu cuenta tiene ${list.length} canales de WhatsApp: indica channel_id`, { fields: [{ field: 'channel_id', message: 'indica en qué canal' }], channels: list });
}

/** Dígitos con lada de país. Con la zona horaria de México, a 10 dígitos se le pone el 52. */
async function phoneOf(accountId: string, raw: unknown, field = 'phone') {
  const phone = normalizePhone(raw, (await astore.getSettings(accountId)).timezone);
  if (!phone) throw apiError(400, 'invalid_phone', 'Teléfono inválido: con lada de país, por ejemplo +52 55 1234 5678', { fields: [{ field, message: 'teléfono inválido (con lada de país)' }] });
  return phone;
}

/** El contacto de ese teléfono en el canal, en cualquier forma del número (lo da de alta si no existe), con su conversación. */
async function contactByPhone(accountId: string, channelId: string | undefined, raw: unknown) {
  const phone = await phoneOf(accountId, raw);
  const channel = await whatsappChannel(accountId, channelId);
  const existing = await store.findContactByPhone(channel, phone);
  const contact = existing ?? (await store.upsertContact(channel, `${phone}@s.whatsapp.net`, phone, ''));
  const conversation = await store.getOrCreateConversation(channel, contact.id);
  return { channel, contact, conversation, created: !existing };
}

/* ------------------------------ Datos del cliente ------------------------------ */

const DataValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);
const DataPatch = z.record(z.string().trim().min(1).max(64), DataValue);

const FIELD_RULE: Record<ContactField['type'], string> = {
  text: 'texto', number: 'un número', date: 'una fecha (AAAA-MM-DD o DD/MM/AAAA)', option: '', email: 'un correo válido', phone: 'un teléfono (8 a 15 dígitos)',
};

/**
 * Los datos como texto: los números y sí/no se aceptan, null o "" borran el dato y los campos definidos en «Datos de tus
 * clientes» se validan y se guardan normalizados, igual que al importar (fechas AAAA-MM-DD, opciones con su escritura).
 */
async function cleanData(accountId: string, data: z.infer<typeof DataPatch>) {
  const defined = new Map((await listContactFields(accountId)).map((f) => [f.key, f]));
  const out: Record<string, string> = {};
  const bad: { field: string; message: string }[] = [];
  for (const [key, raw] of Object.entries(data)) {
    const text = raw === null ? '' : typeof raw === 'boolean' ? (raw ? 'sí' : 'no') : String(raw).trim();
    const f = defined.get(key);
    if (!text || !f) { out[key] = text; continue; }
    const clean = cleanFieldValue(f, text);
    if (clean === null) bad.push({ field: `data.${key}`, message: `«${f.label}» debe ser ${f.type === 'option' ? `una de: ${f.options.join(', ')}` : FIELD_RULE[f.type]}` });
    else out[key] = clean;
  }
  if (bad.length) throw apiError(400, 'invalid_request', `Datos inválidos: ${bad.map((b) => `${b.field}: ${b.message}`).join('; ')}`, { fields: bad });
  return out;
}

/* ------------------------------ Reintentos seguros (Idempotency-Key) ------------------------------ */

const IDEMPOTENCY_HOURS = 24;
/**
 * Una petición «en curso» de hace más que esto se dio por perdida (el proceso se reinició): se puede repetir. Con margen
 * de sobra sobre la más lenta (un envío que espera al canal), para no repetir una que sigue corriendo.
 */
const IDEMPOTENCY_STALE_MS = 10 * 60_000;

const contactOut = (c: any) => ({
  id: c.id, name: c.name || null, profile_name: c.push_name || null, phone: c.phone || null,
  channel: { id: c.channel_id, type: c.channel_type, name: c.channel_name },
  tags: c.tags ?? [], data: c.data ?? {}, notes: c.notes ?? [],
  consent: { given: !!c.consent_at, at: c.consent_at ?? null, source: c.consent_source || null },
  opted_out: !!c.opted_out, created_at: c.created_at, updated_at: c.updated_at,
});

const CONTACT_SELECT = `SELECT c.*, ch.type AS channel_type, ch.name AS channel_name FROM contacts c JOIN channels ch ON ch.id = c.channel_id`;

export async function apiV1Routes(app: FastifyInstance, service: ChatService) {
  await app.register(
    async (v1) => {
      v1.addHook('preHandler', async (req, reply) => {
        if (rateLimited(`apiip:${req.ip}`, 600, 60_000)) return reply.code(429).header('retry-after', '60').send({ error: 'Demasiadas solicitudes desde esta conexión', code: 'rate_limited' });
        const m = /^Bearer\s+(rr_[\w-]{20,})$/.exec(String(req.headers.authorization ?? ''));
        if (!m) return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'Falta la llave: Authorization: Bearer rr_…', code: 'missing_key' });
        const k = await queryOne<{ id: string; account_id: string; scope: 'read' | 'write'; name: string; active: boolean; status: string }>(
          `SELECT k.id, k.account_id, k.scope, k.name, a.active, a.status FROM api_keys k JOIN accounts a ON a.id = k.account_id WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
          [hashKey(m[1])],
        );
        if (!k) return reply.code(401).send({ error: 'Llave inválida o revocada', code: 'invalid_key' });
        if (!k.active) return reply.code(403).send({ error: 'La cuenta está desactivada', code: 'account_inactive' });
        const write = req.method !== 'GET';
        if (rateLimited(`apikey:${k.id}${write ? ':w' : ''}`, write ? 60 : 300, 60_000)) return reply.code(429).header('retry-after', '60').send({ error: 'Demasiadas solicitudes: espera un minuto', code: 'rate_limited' });
        if (write && k.scope !== 'write') return reply.code(403).send({ error: 'Esta llave es de solo lectura: crea una de lectura y escritura en Integraciones', code: 'read_only_key' });
        if (write && k.status === 'paused') return reply.code(402).send({ error: 'La cuenta está en pausa: regulariza tu plan para escribir por la API', code: 'account_paused' });
        req.apiKey = { id: k.id, account_id: k.account_id, scope: k.scope, name: k.name };
        await query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [k.id]);
      });

      // Un id mal formado en la ruta no existe (en vez de un error de la base).
      v1.addHook('preHandler', async (req: any, reply) => {
        const id = req.params?.id;
        if (id !== undefined && !z.string().uuid().safeParse(id).success) return reply.code(404).send({ error: 'No encontrado: el id no tiene el formato correcto (uuid)', code: 'not_found' });
      });

      // Idempotency-Key: el mismo POST/PUT repetido (la red se cortó, tu sistema reintentó) devuelve la misma respuesta
      // sin volver a crear ni enviar nada. Se guarda por llave de API durante 24 h.
      v1.addHook('preHandler', async (req: any, reply) => {
        const raw = req.headers['idempotency-key'];
        if (req.method === 'GET' || raw === undefined || !req.apiKey) return;
        const key = String(raw).trim();
        if (!key || key.length > 200) return reply.code(400).send({ error: 'Idempotency-Key debe tener de 1 a 200 caracteres', code: 'invalid_idempotency_key' });
        const hash = crypto.createHash('sha256').update(`${req.method} ${req.url}\n`).update(req.rawBody ?? Buffer.alloc(0)).digest('hex');
        // Toma la llave si es nueva, si ya venció o si la petición anterior se quedó a medias.
        const claimed = await queryOne(
          `INSERT INTO api_idempotency (api_key_id, idem_key, request_hash) VALUES ($1, $2, $3)
           ON CONFLICT (api_key_id, idem_key) DO UPDATE SET request_hash = EXCLUDED.request_hash, status_code = NULL, response = NULL, created_at = now()
             WHERE api_idempotency.created_at < now() - make_interval(hours => $4)
                OR (api_idempotency.status_code IS NULL AND api_idempotency.created_at < now() - make_interval(secs => $5) AND api_idempotency.request_hash = EXCLUDED.request_hash)
           RETURNING 1`,
          [req.apiKey.id, key, hash, IDEMPOTENCY_HOURS, IDEMPOTENCY_STALE_MS / 1000],
        );
        if (claimed) { req.idempotency = key; return; }
        const prev = await queryOne<{ request_hash: string; status_code: number | null; response: string | null }>(`SELECT request_hash, status_code, response FROM api_idempotency WHERE api_key_id = $1 AND idem_key = $2`, [req.apiKey.id, key]);
        if (prev && prev.request_hash !== hash) return reply.code(409).send({ error: 'Esa Idempotency-Key ya se usó con otra petición: usa una llave nueva para cada operación', code: 'idempotency_conflict' });
        if (!prev || prev.status_code === null) return reply.code(409).header('retry-after', '1').send({ error: 'La primera petición con esa Idempotency-Key sigue en curso: reintenta en un momento', code: 'idempotency_in_progress' });
        return reply.code(prev.status_code).header('idempotent-replayed', 'true').type('application/json; charset=utf-8').send(prev.response ?? '');
      });
      v1.addHook('onSend', async (req: any, reply, payload) => {
        if (!req.idempotency) return payload;
        try {
          // Solo se guarda lo que salió bien. Un error (datos inválidos, no se pudo enviar, el servidor falló) no hizo
          // nada: el reintento con la misma llave lo vuelve a intentar, también ya corregido.
          if (reply.statusCode >= 200 && reply.statusCode < 300) await query(`UPDATE api_idempotency SET status_code = $3, response = $4 WHERE api_key_id = $1 AND idem_key = $2`, [req.apiKey.id, req.idempotency, reply.statusCode, typeof payload === 'string' ? payload : String(payload ?? '')]);
          else await query(`DELETE FROM api_idempotency WHERE api_key_id = $1 AND idem_key = $2`, [req.apiKey.id, req.idempotency]);
        } catch (e: any) {
          // La operación ya se hizo: la respuesta sale igual. Sin la respuesta guardada, la llave queda «en curso» unos
          // minutos y después se libera.
          await logEvent({ level: 'error', source: 'system', message: `API: no se pudo guardar la respuesta de Idempotency-Key: ${e?.message ?? e}`, accountId: req.apiKey.account_id }).catch(() => undefined);
        }
        return payload;
      });

      v1.setErrorHandler(async (err: any, req: any, reply) => {
        const status = err instanceof HttpError ? err.statusCode : err?.code === '23505' ? 409 : err?.statusCode && err.statusCode < 500 ? err.statusCode : 500;
        if (status >= 500) {
          await logEvent({ level: 'error', source: 'system', message: `Error en ${req.method} ${req.url.split('?')[0]} (API): ${err?.message ?? err}`, details: err, accountId: req.apiKey?.account_id });
          return reply.code(500).send({ error: 'Error interno del servidor: vuelve a intentarlo en unos minutos', code: 'internal_error' });
        }
        if (err instanceof HttpError) return reply.code(status).send({ code: CODE_BY_STATUS[status] ?? 'error', ...err.data, error: err.message, issues: err.issues });
        const badJson = err?.message === 'JSON inválido';
        return reply.code(status).send({ error: badJson ? 'El cuerpo no es JSON válido' : status === 409 ? 'Ya existe (valor duplicado)' : String(err?.message ?? 'Petición inválida'), code: badJson ? 'invalid_json' : CODE_BY_STATUS[status] ?? 'invalid_request' });
      });
      // Una ruta que no existe dentro de /api/v1 (los GET desconocidos los tomaría la ruta comodín de los archivos del panel).
      v1.all('/*', async (req, reply) => reply.code(404).send({ error: `No existe ${req.method} ${req.url.split('?')[0]}: revisa la ruta en ${config.publicBaseUrl}/api/v1/docs`, code: 'route_not_found' }));

      const account = (req: any) => req.apiKey.account_id as string;

      v1.get('/me', async (req: any) => {
        const acc = await store.getAccount(account(req));
        const phone = await phoneChannels(account(req));
        return {
          account: { id: acc!.id, name: acc!.name, status: acc!.status },
          key: { name: req.apiKey.name, scope: req.apiKey.scope },
          timezone: (await astore.getSettings(account(req))).timezone,
          // El canal que se usa cuando no indicas channel_id (solo si tienes un único WhatsApp).
          default_channel_id: phone.length === 1 ? phone[0].id : null,
          docs_url: `${config.publicBaseUrl}/api/v1/docs`,
        };
      });

      /** Tus canales: el id que piden channel_id y los filtros. */
      v1.get('/channels', async (req: any) => {
        const rows = await query<{ id: string; type: string; name: string; active: boolean; chatbot_id: string | null; platform: string | null; created_at: Date }>(
          `SELECT id, type, name, active, chatbot_id, config->>'platform' AS platform, created_at FROM channels WHERE account_id = $1 AND type <> 'playground' ORDER BY created_at, id`,
          [account(req)],
        );
        const phone = rows.filter((c) => c.type === 'whatsapp' && c.active);
        return {
          data: rows.map((c) => ({
            id: c.id, type: c.type, name: c.name, platform: c.platform || null, active: c.active, has_assistant: !!c.chatbot_id,
            // Alta de contactos, cobros y mensajes por teléfono.
            contacts_by_phone: c.type === 'whatsapp',
            default: phone.length === 1 && phone[0].id === c.id,
            created_at: c.created_at,
          })),
        };
      });

      /** Los datos de tus clientes («Datos de tus clientes» en el panel): la clave que va en `data` y qué valor acepta. */
      v1.get('/contact-fields', async (req: any) => ({
        data: (await listContactFields(account(req))).map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.type === 'option' ? f.options : [] })),
      }));

      /* ------------------------------ Contactos ------------------------------ */
      v1.get('/contacts', async (req: any) => {
        const q = input(z.object({ limit: Limit, cursor: z.string().optional(), updated_since: Iso.optional(), tag: z.string().max(60).optional(), phone: z.string().max(30).optional(), channel_id: z.string().uuid().optional() }), req.query);
        const cur = dec(q.cursor);
        // El teléfono en cualquier formato y en cualquiera de sus formas (México: 52… y 521…).
        const v = q.phone ? phoneVariants(normalizePhone(q.phone, (await astore.getSettings(account(req))).timezone) ?? q.phone.replace(/\D/g, '')) : null;
        // Una igualdad por forma: así usa el índice por teléfono (con `= ANY` revisaría cada contacto de la cuenta).
        const byPhone = (p: string) => `SELECT id FROM contacts WHERE account_id = $1 AND phone <> '' AND regexp_replace(phone, '[^0-9]', '', 'g') = ${p}`;
        const rows = await query<any>(
          `${CONTACT_SELECT} WHERE c.account_id = $1 AND ch.type <> 'playground'
             AND ($2::timestamptz IS NULL OR c.updated_at >= $2) AND ($3::text IS NULL OR c.tags @> to_jsonb($3::text))
             AND ($4::uuid IS NULL OR c.channel_id = $4)
             AND ($5::timestamptz IS NULL OR (c.updated_at, c.id) > ($5::timestamptz, $6::uuid))
             ${v ? `AND c.id IN (${byPhone('$7')} UNION ALL ${byPhone('$8')})` : ''}
           ORDER BY c.updated_at, c.id LIMIT ${q.limit + 1}`,
          [account(req), q.updated_since ?? null, q.tag ?? null, q.channel_id ?? null, cur?.at ?? null, cur?.id ?? null, ...(v ? [v[0], v[1] ?? v[0]] : [])],
        );
        const page = rows.slice(0, q.limit);
        // El cursor lleva el texto exacto de PostgreSQL (microsegundos).
        const last = page.at(-1);
        const exact = last ? (await queryOne<{ t: string }>(`SELECT updated_at::text AS t FROM contacts WHERE id = $1`, [last.id]))!.t : null;
        return { data: page.map(contactOut), next_cursor: rows.length > q.limit && last ? enc({ at: exact, id: last.id }) : null };
      });

      const contactById = async (req: any) => {
        const c = await queryOne<any>(`${CONTACT_SELECT} WHERE c.id = $1 AND c.account_id = $2 AND ch.type <> 'playground'`, [req.params.id, account(req)]);
        if (!c) throw new HttpError(404, 'Contacto no encontrado');
        return c;
      };

      v1.get('/contacts/:id', async (req: any) => contactOut(await contactById(req)));

      const ContactPatch = z.object({
        name: z.string().max(100).optional(),
        /** Se combinan con los datos que ya tiene (para borrar uno, envíalo vacío o null). Texto, número o sí/no. */
        data: DataPatch.optional(),
        tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
        add_tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
        remove_tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
        notes: z.array(z.string().max(300)).max(50).optional(),
        consent: z.boolean().optional(),
        opted_out: z.boolean().optional(),
      });

      type Patch = Omit<z.infer<typeof ContactPatch>, 'data'> & { data?: Record<string, string> };
      /** Valida todo antes de escribir nada: un dato mal escrito no deja el contacto a medias. */
      const validPatch = async (accountId: string, b: z.infer<typeof ContactPatch>): Promise<Patch> => ({ ...b, data: b.data ? await cleanData(accountId, b.data) : undefined });

      async function applyPatch(contactId: string, b: Patch) {
        const cur = (await store.getContact(contactId))!;
        const data = b.data ? Object.fromEntries(Object.entries({ ...cur.data, ...b.data }).filter(([, v]) => v !== '')) : undefined;
        let tags = b.tags ?? (b.add_tags || b.remove_tags ? [...cur.tags] : undefined);
        if (tags && b.add_tags) tags = [...new Set([...tags, ...b.add_tags])];
        if (tags && b.remove_tags) tags = tags.filter((t) => !b.remove_tags!.some((r) => r.toLowerCase() === t.toLowerCase()));
        if (b.consent !== undefined && !!cur.consent_at !== b.consent) await astore.setConsent(contactId, b.consent, 'api');
        const changes = await store.updateContactFromPanel(contactId, { name: b.name, data, notes: b.notes, tags, opted_out: b.opted_out });
        const conv = (await query<{ id: string }>('SELECT id FROM conversations WHERE contact_id = $1', [contactId]))[0];
        if (conv && changes) {
          // origin: el webhook dice que lo cambió tu sistema, para que no le responda a su propio cambio.
          if (changes.optedOut) { await astore.stopEnrollments(conv.id, 'baja desde la API'); service.automator.emit({ type: 'opt_out', conversationId: conv.id, origin: 'api' }); }
          for (const field of changes.changedFields) service.automator.emit({ type: 'data_captured', conversationId: conv.id, field, origin: 'api' });
          for (const tag of changes.addedTags) service.automator.emit({ type: 'tag_added', conversationId: conv.id, tag, origin: 'api' });
        }
      }

      v1.put('/contacts/:id', async (req: any) => {
        const c = await contactById(req);
        await applyPatch(c.id, await validPatch(account(req), input(ContactPatch, req.body)));
        return contactOut(await contactById(req));
      });

      /**
       * Alta o actualización por teléfono (para pasar clientes de tu CRM). Solo canales de WhatsApp; sin channel_id, el
       * único WhatsApp de la cuenta. El teléfono en cualquier formato: si ya existe en cualquiera de sus formas, lo actualiza.
       */
      v1.post('/contacts', async (req: any, reply) => {
        const { channel_id, phone, ...rest } = input(ContactPatch.extend({ channel_id: z.string().uuid().optional(), phone: z.union([z.string().max(30), z.number()]) }), req.body);
        const patch = await validPatch(account(req), rest);
        const { contact, created } = await contactByPhone(account(req), channel_id, phone);
        await applyPatch(contact.id, patch);
        return reply.code(created ? 201 : 200).send(contactOut(await queryOne<any>(`${CONTACT_SELECT} WHERE c.id = $1`, [contact.id])));
      });

      /* ------------------------------ Cobros ------------------------------ */
      /** Lo que deben los clientes (para tu ERP o tu caja). */
      v1.get('/receivables', async (req: any) => {
        if (!config.receivables.enabled) throw apiError(404, 'receivables_disabled', 'Los cobros no están activados');
        const q = input(z.object({ status: z.enum(['', 'pending', 'overdue', 'paid', 'canceled']).default(''), contact_id: z.string().uuid().optional() }), req.query);
        const st = await astore.getSettings(account(req));
        const { rows, totals } = await listReceivables(account(req), { status: q.status, contactId: q.contact_id, limit: 500 }, todayIn(st.timezone), st.timezone);
        return { data: rows.map(receivableOut), totals };
      });

      /** Registrar un cobro: con contact_id, o con phone (y channel_id si tienes varios WhatsApp; se da de alta el cliente si no existe). */
      v1.post('/receivables', async (req: any, reply) => {
        if (!config.receivables.enabled) throw apiError(404, 'receivables_disabled', 'Los cobros no están activados');
        const raw = input(ReceivableBody.partial({ contact_id: true }).extend({ channel_id: z.string().uuid().optional(), phone: z.union([z.string().max(30), z.number()]).optional() })
          .refine((x) => x.contact_id || x.phone !== undefined, { message: 'Indica contact_id o phone', path: ['contact_id'] }), req.body);
        const { channel_id, phone, ...body } = raw;
        const contactId = body.contact_id ?? (await contactByPhone(account(req), channel_id, phone)).contact.id;
        const { receivable, scheduled, existed } = await createReceivable(service, account(req), { ...body, contact_id: contactId }, { userId: null, source: 'api', actor: `la API (${req.apiKey.name})` });
        return reply.code(existed ? 200 : 201).send({ ...receivableOut(receivable), reminders_scheduled: scheduled });
      });

      for (const [path, status] of [['paid', 'paid'], ['cancel', 'canceled']] as const) {
        v1.post(`/receivables/:id/${path}`, async (req: any) => {
          if (!config.receivables.enabled) throw apiError(404, 'receivables_disabled', 'Los cobros no están activados');
          const r = await getReceivable(req.params.id);
          if (!r || r.account_id !== account(req)) throw new HttpError(404, 'Cobro no encontrado');
          const b = input(z.object({ note: z.string().trim().max(500).default('') }), req.body ?? {});
          const updated = await service.receivables.settle(r, status, { userId: null, note: b.note || `API (${req.apiKey.name})`, origin: 'api' });
          if (!updated) throw apiError(409, 'not_pending', 'El cobro ya no está pendiente');
          return receivableOut(updated);
        });
      }

      /** Pagos recurrentes: cada periodo se crea su cobro (con sus recordatorios) unos días antes de que venza. */
      v1.get('/receivable-plans', async (req: any) => {
        if (!config.receivables.enabled) throw apiError(404, 'receivables_disabled', 'Los cobros no están activados');
        const q = input(z.object({ contact_id: z.string().uuid().optional() }), req.query);
        const today = todayIn((await astore.getSettings(account(req))).timezone);
        return { data: (await listPlans(account(req), q.contact_id)).map((p) => planOut(p, today)) };
      });
      v1.post('/receivable-plans', async (req: any, reply) => {
        if (!config.receivables.enabled) throw apiError(404, 'receivables_disabled', 'Los cobros no están activados');
        const { plan, created } = await createPlan(service, account(req), input(PlanBody, req.body), { userId: null, actor: `la API (${req.apiKey.name})` });
        return reply.code(201).send({ ...planOut(plan, todayIn((await astore.getSettings(account(req))).timezone)), receivables_created: created });
      });
      v1.post('/receivable-plans/:id/deactivate', async (req: any) => {
        if (!config.receivables.enabled) throw apiError(404, 'receivables_disabled', 'Los cobros no están activados');
        const p = await getPlan(req.params.id);
        if (!p || p.account_id !== account(req)) throw new HttpError(404, 'Pago recurrente no encontrado');
        await query(`UPDATE receivable_plans SET active = false, updated_at = now() WHERE id = $1`, [p.id]);
        return planOut({ ...p, active: false }, todayIn((await astore.getSettings(account(req))).timezone));
      });

      /* ------------------------------ Conversaciones y mensajes ------------------------------ */
      v1.get('/conversations', async (req: any) => {
        const q = input(z.object({ limit: Limit, cursor: z.string().optional(), status: z.enum(['bot', 'human', 'closed']).optional(), channel_id: z.string().uuid().optional(), contact_id: z.string().uuid().optional(), updated_since: Iso.optional() }), req.query);
        const cur = dec(q.cursor);
        const rows = await query<any>(
          `SELECT cv.id, cv.status, cv.handoff_reason, cv.summary, cv.data, cv.created_at, cv.last_message_at, cv.last_message_at::text AS cursor_at, cv.assigned_user_id, cv.contact_id, cv.channel_id, ch.type AS channel_type, ch.name AS channel_name
             FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id
            WHERE cv.account_id = $1 AND ch.type <> 'playground' AND ($2::text IS NULL OR cv.status = $2) AND ($3::uuid IS NULL OR cv.channel_id = $3) AND ($4::uuid IS NULL OR cv.contact_id = $4)
              AND ($5::timestamptz IS NULL OR cv.last_message_at >= $5) AND ($6::timestamptz IS NULL OR (cv.last_message_at, cv.id) > ($6::timestamptz, $7::uuid))
            ORDER BY cv.last_message_at, cv.id LIMIT ${q.limit + 1}`,
          [account(req), q.status ?? null, q.channel_id ?? null, q.contact_id ?? null, q.updated_since ?? null, cur?.at ?? null, cur?.id ?? null],
        );
        const page = rows.slice(0, q.limit);
        const last = page.at(-1);
        return {
          data: page.map((c) => ({ id: c.id, status: c.status, assigned_user_id: c.assigned_user_id ?? null, handoff_reason: c.handoff_reason || null, summary: c.summary || null, data: c.data, contact_id: c.contact_id, channel: { id: c.channel_id, type: c.channel_type, name: c.channel_name }, created_at: c.created_at, last_message_at: c.last_message_at })),
          next_cursor: rows.length > q.limit && last ? enc({ at: last.cursor_at, id: last.id }) : null,
        };
      });

      v1.get('/conversations/:id/messages', async (req: any) => {
        const q = input(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), after: z.coerce.number().int().min(0).default(0) }), req.query);
        const conv = await queryOne<{ id: string }>(`SELECT cv.id FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id WHERE cv.id = $1 AND cv.account_id = $2 AND ch.type <> 'playground'`, [req.params.id, account(req)]);
        if (!conv) throw new HttpError(404, 'Conversación no encontrada');
        const rows = await query<any>(`SELECT id, created_at, direction, sender, type, content FROM messages WHERE conversation_id = $1 AND id > $2 ORDER BY id LIMIT ${q.limit}`, [conv.id, q.after]);
        return { data: rows.map((m) => ({ id: Number(m.id), at: m.created_at, direction: m.direction === 'in' ? 'inbound' : 'outbound', sender: m.sender, type: m.type, text: m.content })), next_after: rows.length === q.limit ? Number(rows.at(-1).id) : null };
      });

      /**
       * La conversación tal como la recibe la app en el evento `conversation.sent`: resumen, completa o ambos.
       * refresh=true actualiza antes el resumen si hay información nueva (usa IA).
       */
      v1.get('/conversations/:id/export', async (req: any) => {
        const q = input(z.object({ content: ExportContentSchema.default('both'), refresh: z.enum(['true', 'false']).default('false') }), req.query);
        const conv = await queryOne<{ id: string }>(`SELECT cv.id FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id WHERE cv.id = $1 AND cv.account_id = $2 AND ch.type <> 'playground'`, [req.params.id, account(req)]);
        if (!conv) throw new HttpError(404, 'Conversación no encontrada');
        return conversationExport(conv.id, { content: q.content, refresh: q.refresh === 'true' ? (id) => service.summarize(id) : undefined, reason: `API (${req.apiKey.name})` });
      });

      /**
       * Enviar un mensaje: a una conversación, a un contacto (su conversación) o por teléfono (con channel_id si tienes
       * varios WhatsApp). Respeta bajas y límites del plan.
       */
      v1.post('/messages', async (req: any, reply) => {
        const b = input(z.object({
          conversation_id: z.string().uuid().optional(), contact_id: z.string().uuid().optional(), channel_id: z.string().uuid().optional(),
          phone: z.union([z.string().max(30), z.number()]).optional(), text: z.string().trim().min(1).max(4000),
        }).refine((x) => x.conversation_id || x.contact_id || x.phone !== undefined, { message: 'Indica conversation_id, contact_id o phone', path: ['phone'] }), req.body);
        let convId = b.conversation_id;
        if (convId) {
          const ok = await queryOne(`SELECT 1 FROM conversations WHERE id = $1 AND account_id = $2`, [convId, account(req)]);
          if (!ok) throw apiError(404, 'not_found', 'Conversación no encontrada', { fields: [{ field: 'conversation_id', message: 'no existe en tu cuenta' }] });
        } else if (b.contact_id) {
          const c = await queryOne<{ id: string; channel_id: string }>(`SELECT c.id, c.channel_id FROM contacts c JOIN channels ch ON ch.id = c.channel_id WHERE c.id = $1 AND c.account_id = $2 AND ch.type <> 'playground'`, [b.contact_id, account(req)]);
          if (!c) throw apiError(404, 'not_found', 'Contacto no encontrado', { fields: [{ field: 'contact_id', message: 'no existe en tu cuenta' }] });
          convId = (await store.getOrCreateConversation((await store.getChannel(c.channel_id))!, c.id)).id;
        } else {
          convId = (await contactByPhone(account(req), b.channel_id, b.phone)).conversation.id;
        }
        const r = await service.outbound.send(convId, { text: b.text, source: 'api', allowWhenHuman: true });
        await logEvent({ level: 'info', source: 'admin', message: `Mensaje enviado por la API (${req.apiKey.name}): ${r.sent ? 'enviado' : r.reason}`, accountId: account(req), conversationId: convId });
        return reply.code(r.sent ? 200 : 422).send({ sent: r.sent, reason: r.sent ? null : r.reason, ...(r.sent ? {} : { code: 'not_sent' }), conversation_id: convId });
      });

      /* ------------------------------ Equipo, asignación y avisos internos ------------------------------ */
      v1.get('/team', async (req: any) => ({
        data: await query(`SELECT id, name, email, role, available FROM users WHERE account_id = $1 AND active AND role IN ('admin', 'agent') ORDER BY name, email`, [account(req)]),
      }));

      /** Avisa dentro del panel (campana y, si la persona lo activó, WhatsApp). A todos, a un rol, a personas o a quien toque por turnos. */
      v1.post('/notifications', async (req: any) => {
        const b = input(NoticeBody, req.body);
        const r = await sendNotice(service, account(req), b);
        await logEvent({ level: 'info', source: 'admin', message: `Aviso interno enviado por la API (${req.apiKey.name}) a ${r.recipients.length} persona(s)`, accountId: account(req) });
        return { ok: true, sent_to: r.recipients.length, recipients: r.recipients };
      });

      /** Asigna una conversación: user_id de una persona del equipo, "next" (siguiente por turnos) o null (sin asignar). */
      v1.put('/conversations/:id/assign', async (req: any) => {
        const b = input(z.object({ user_id: z.union([z.string().uuid(), z.literal('next'), z.null()]) }), req.body);
        const conv = await queryOne<{ id: string; account_id: string }>(`SELECT id, account_id FROM conversations WHERE id = $1 AND account_id = $2`, [req.params.id, account(req)]);
        if (!conv) throw new HttpError(404, 'Conversación no encontrada');
        let userId: string | null = null;
        if (b.user_id === 'next') {
          const s = await astore.getSettings(conv.account_id);
          const u = await assignment.assignRoundRobin(conv, { scope: 'api', roles: s.assignment.roles, userIds: s.assignment.user_ids, reason: `API (${req.apiKey.name})` });
          if (!u) throw apiError(409, 'nobody_available', 'No hay nadie disponible para recibirla');
          userId = u.id;
        } else if (b.user_id) {
          const ok = await queryOne(`SELECT 1 FROM users WHERE id = $1 AND account_id = $2 AND active AND role IN ('admin', 'agent')`, [b.user_id, account(req)]);
          if (!ok) throw apiError(400, 'invalid_user', 'Esa persona no pertenece a tu cuenta (consulta GET /api/v1/team)', { fields: [{ field: 'user_id', message: 'no es una persona de tu equipo' }] });
          await assignment.setAssignee(conv.id, b.user_id, 'api', 'asignada desde la API');
          userId = b.user_id;
        } else {
          await assignment.setAssignee(conv.id, null);
        }
        if (userId) await service.automator.alertTeam(account(req), { title: '📥 Te asignaron una conversación', body: await describeConversation(conv.id, 'asignada desde un sistema externo', { brief: true }), link: `#/conversation/${conv.id}`, userIds: [userId], kind: 'assignment' });
        return { ok: true, assigned_user_id: userId };
      });

      /* ------------------------------ Citas ------------------------------ */
      v1.get('/appointments', async (req: any) => {
        const q = input(z.object({ from: Iso.optional(), to: Iso.optional(), status: z.string().max(20).optional(), limit: Limit }), req.query);
        const rows = await query<any>(
          `SELECT a.*, coalesce(nullif(u.name, ''), split_part(u.email, '@', 1)) AS assigned_user_name FROM appointments a LEFT JOIN users u ON u.id = a.assigned_user_id
            WHERE a.account_id = $1 AND a.source <> 'simulador' AND ($2::timestamptz IS NULL OR a.starts_at >= $2) AND ($3::timestamptz IS NULL OR a.starts_at < $3) AND ($4::text IS NULL OR a.status = $4)
            ORDER BY a.starts_at LIMIT ${q.limit}`,
          [account(req), q.from ?? null, q.to ?? null, q.status ?? null],
        );
        // La misma forma que en los webhooks de citas.
        return { data: rows.map(appointmentPayload) };
      });
    },
    { prefix: '/api/v1' },
  );
}
