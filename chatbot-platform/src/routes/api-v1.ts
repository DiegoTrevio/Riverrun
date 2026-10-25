/**
 * API pública v1 para integraciones (Zapier, Make, n8n, tu CRM…). Autenticación con llave de la cuenta:
 *   Authorization: Bearer rr_xxxxxxxx
 * Las llaves son "read" (solo GET) o "write". Todo queda limitado a la cuenta de la llave. Documentación: docs/integraciones.md
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../access.js';
import { rateLimited } from '../auth.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import * as astore from '../automation/store.js';
import * as assignment from '../automation/assignment.js';
import { NoticeBody, sendNotice } from '../automation/notices.js';
import { describeConversation } from '../automation/alert-format.js';
import { hashKey } from './integrations.js';
import { conversationExport, ExportContentSchema } from '../integrations/conversation-export.js';
import { parse } from './util.js';
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
  try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { throw new HttpError(400, 'cursor inválido'); }
};

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
        if (rateLimited(`apiip:${req.ip}`, 600, 60_000)) return reply.code(429).header('retry-after', '60').send({ error: 'Demasiadas solicitudes desde esta conexión' });
        const m = /^Bearer\s+(rr_[\w-]{20,})$/.exec(String(req.headers.authorization ?? ''));
        if (!m) return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'Falta la llave: Authorization: Bearer rr_…' });
        const k = await queryOne<{ id: string; account_id: string; scope: 'read' | 'write'; name: string; active: boolean; status: string }>(
          `SELECT k.id, k.account_id, k.scope, k.name, a.active, a.status FROM api_keys k JOIN accounts a ON a.id = k.account_id WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
          [hashKey(m[1])],
        );
        if (!k) return reply.code(401).send({ error: 'Llave inválida o revocada' });
        if (!k.active) return reply.code(403).send({ error: 'La cuenta está desactivada' });
        const write = req.method !== 'GET';
        if (rateLimited(`apikey:${k.id}${write ? ':w' : ''}`, write ? 60 : 300, 60_000)) return reply.code(429).header('retry-after', '60').send({ error: 'Demasiadas solicitudes: espera un minuto' });
        if (write && k.scope !== 'write') return reply.code(403).send({ error: 'Esta llave es de solo lectura' });
        if (write && k.status === 'paused') return reply.code(402).send({ error: 'La cuenta está en pausa: regulariza tu plan para escribir por la API' });
        req.apiKey = { id: k.id, account_id: k.account_id, scope: k.scope, name: k.name };
        await query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [k.id]);
      });

      const account = (req: any) => req.apiKey.account_id as string;

      v1.get('/me', async (req: any) => {
        const acc = await store.getAccount(account(req));
        return { account: { id: acc!.id, name: acc!.name, status: acc!.status }, key: { name: req.apiKey.name, scope: req.apiKey.scope } };
      });

      /* ------------------------------ Contactos ------------------------------ */
      v1.get('/contacts', async (req: any) => {
        const q = parse(z.object({ limit: Limit, cursor: z.string().optional(), updated_since: Iso.optional(), tag: z.string().max(60).optional(), phone: z.string().max(30).optional(), channel_id: z.string().uuid().optional() }), req.query);
        const cur = dec(q.cursor);
        const rows = await query<any>(
          `${CONTACT_SELECT} WHERE c.account_id = $1 AND ch.type <> 'playground'
             AND ($2::timestamptz IS NULL OR c.updated_at >= $2) AND ($3::text IS NULL OR c.tags @> to_jsonb($3::text))
             AND ($4::text IS NULL OR c.phone = $4) AND ($5::uuid IS NULL OR c.channel_id = $5)
             AND ($6::timestamptz IS NULL OR (c.updated_at, c.id) > ($6::timestamptz, $7::uuid))
           ORDER BY c.updated_at, c.id LIMIT ${q.limit + 1}`,
          [account(req), q.updated_since ?? null, q.tag ?? null, q.phone ? q.phone.replace(/\D/g, '') : null, q.channel_id ?? null, cur?.at ?? null, cur?.id ?? null],
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
        /** Se combinan con los datos que ya tiene (para borrar uno, envíalo vacío). */
        data: z.record(z.string(), z.string().max(500)).optional(),
        tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
        add_tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
        remove_tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
        notes: z.array(z.string().max(300)).max(50).optional(),
        consent: z.boolean().optional(),
        opted_out: z.boolean().optional(),
      });

      async function applyPatch(contactId: string, b: z.infer<typeof ContactPatch>) {
        const cur = (await store.getContact(contactId))!;
        const data = b.data ? Object.fromEntries(Object.entries({ ...cur.data, ...b.data }).filter(([, v]) => v !== '')) : undefined;
        let tags = b.tags ?? (b.add_tags || b.remove_tags ? [...cur.tags] : undefined);
        if (tags && b.add_tags) tags = [...new Set([...tags, ...b.add_tags])];
        if (tags && b.remove_tags) tags = tags.filter((t) => !b.remove_tags!.some((r) => r.toLowerCase() === t.toLowerCase()));
        if (b.consent !== undefined && !!cur.consent_at !== b.consent) await astore.setConsent(contactId, b.consent, 'api');
        const changes = await store.updateContactFromPanel(contactId, { name: b.name, data, notes: b.notes, tags, opted_out: b.opted_out });
        const conv = (await query<{ id: string }>('SELECT id FROM conversations WHERE contact_id = $1', [contactId]))[0];
        if (conv && changes) {
          if (changes.optedOut) { await astore.stopEnrollments(conv.id, 'baja desde la API'); service.automator.emit({ type: 'opt_out', conversationId: conv.id }); }
          for (const field of changes.changedFields) service.automator.emit({ type: 'data_captured', conversationId: conv.id, field });
          for (const tag of changes.addedTags) service.automator.emit({ type: 'tag_added', conversationId: conv.id, tag });
        }
      }

      v1.put('/contacts/:id', async (req: any) => {
        const c = await contactById(req);
        await applyPatch(c.id, parse(ContactPatch, req.body));
        return contactOut(await contactById(req));
      });

      /** Alta o actualización por teléfono (para pasar clientes de tu CRM). Solo canales de WhatsApp. */
      v1.post('/contacts', async (req: any, reply) => {
        const b = parse(ContactPatch.extend({ channel_id: z.string().uuid(), phone: z.string().min(8).max(20) }), req.body);
        const channel = await store.getChannel(b.channel_id);
        if (!channel || channel.account_id !== account(req) || channel.type !== 'whatsapp') throw new HttpError(400, 'channel_id debe ser un canal de WhatsApp de tu cuenta');
        const phone = b.phone.replace(/\D/g, '');
        if (phone.length < 8) throw new HttpError(400, 'Teléfono inválido (con lada de país, solo números)');
        const existed = await store.findContact(channel.id, `${phone}@s.whatsapp.net`);
        const contact = await store.upsertContact(channel, `${phone}@s.whatsapp.net`, phone, '');
        await store.getOrCreateConversation(channel, contact.id);
        const { channel_id, phone: _p, ...patch } = b;
        void channel_id; void _p;
        await applyPatch(contact.id, patch);
        return reply.code(existed ? 200 : 201).send(contactOut(await queryOne<any>(`${CONTACT_SELECT} WHERE c.id = $1`, [contact.id])));
      });

      /* ------------------------------ Cobros ------------------------------ */
      /** Lo que deben los clientes (para tu ERP o tu caja). */
      v1.get('/receivables', async (req: any) => {
        if (!config.receivables.enabled) throw new HttpError(404, 'Los cobros no están activados');
        const q = parse(z.object({ status: z.enum(['', 'pending', 'overdue', 'paid', 'canceled']).default(''), contact_id: z.string().uuid().optional() }), req.query);
        const st = await astore.getSettings(account(req));
        const { rows, totals } = await listReceivables(account(req), { status: q.status, contactId: q.contact_id, limit: 500 }, todayIn(st.timezone), st.timezone);
        return { data: rows.map(receivableOut), totals };
      });

      /** Registrar un cobro: con contact_id, o con channel_id (WhatsApp) y phone (se da de alta el cliente si no existe). */
      v1.post('/receivables', async (req: any, reply) => {
        if (!config.receivables.enabled) throw new HttpError(404, 'Los cobros no están activados');
        const raw = parse(ReceivableBody.partial({ contact_id: true }).extend({ channel_id: z.string().uuid().optional(), phone: z.string().max(20).optional() })
          .refine((x) => x.contact_id || (x.channel_id && x.phone), 'Indica contact_id, o channel_id y phone'), req.body);
        let contactId = raw.contact_id;
        if (!contactId) {
          const channel = await store.getChannel(raw.channel_id!);
          if (!channel || channel.account_id !== account(req) || channel.type !== 'whatsapp') throw new HttpError(400, 'channel_id debe ser un canal de WhatsApp de tu cuenta');
          const phone = raw.phone!.replace(/\D/g, '');
          if (phone.length < 8) throw new HttpError(400, 'Teléfono inválido (con lada de país, solo números)');
          const contact = await store.upsertContact(channel, `${phone}@s.whatsapp.net`, phone, '');
          await store.getOrCreateConversation(channel, contact.id);
          contactId = contact.id;
        }
        const { channel_id: _c, phone: _p, ...body } = raw;
        void _c; void _p;
        const { receivable, scheduled, existed } = await createReceivable(service, account(req), { ...body, contact_id: contactId }, { userId: null, source: 'api', actor: `la API (${req.apiKey.name})` });
        return reply.code(existed ? 200 : 201).send({ ...receivableOut(receivable), reminders_scheduled: scheduled });
      });

      for (const [path, status] of [['paid', 'paid'], ['cancel', 'canceled']] as const) {
        v1.post(`/receivables/:id/${path}`, async (req: any) => {
          if (!config.receivables.enabled) throw new HttpError(404, 'Los cobros no están activados');
          const r = await getReceivable(req.params.id);
          if (!r || r.account_id !== account(req)) throw new HttpError(404, 'Cobro no encontrado');
          const b = parse(z.object({ note: z.string().trim().max(500).default('') }), req.body ?? {});
          const updated = await service.receivables.settle(r, status, { userId: null, note: b.note || `API (${req.apiKey.name})` });
          if (!updated) throw new HttpError(409, 'El cobro ya no está pendiente');
          return receivableOut(updated);
        });
      }

      /** Pagos recurrentes: cada periodo se crea su cobro (con sus recordatorios) unos días antes de que venza. */
      v1.get('/receivable-plans', async (req: any) => {
        if (!config.receivables.enabled) throw new HttpError(404, 'Los cobros no están activados');
        const q = parse(z.object({ contact_id: z.string().uuid().optional() }), req.query);
        const today = todayIn((await astore.getSettings(account(req))).timezone);
        return { data: (await listPlans(account(req), q.contact_id)).map((p) => planOut(p, today)) };
      });
      v1.post('/receivable-plans', async (req: any, reply) => {
        if (!config.receivables.enabled) throw new HttpError(404, 'Los cobros no están activados');
        const { plan, created } = await createPlan(service, account(req), parse(PlanBody, req.body), { userId: null, actor: `la API (${req.apiKey.name})` });
        return reply.code(201).send({ ...planOut(plan, todayIn((await astore.getSettings(account(req))).timezone)), receivables_created: created });
      });
      v1.post('/receivable-plans/:id/deactivate', async (req: any) => {
        if (!config.receivables.enabled) throw new HttpError(404, 'Los cobros no están activados');
        const p = await getPlan(req.params.id);
        if (!p || p.account_id !== account(req)) throw new HttpError(404, 'Pago recurrente no encontrado');
        await query(`UPDATE receivable_plans SET active = false, updated_at = now() WHERE id = $1`, [p.id]);
        return planOut({ ...p, active: false }, todayIn((await astore.getSettings(account(req))).timezone));
      });

      /* ------------------------------ Conversaciones y mensajes ------------------------------ */
      v1.get('/conversations', async (req: any) => {
        const q = parse(z.object({ limit: Limit, cursor: z.string().optional(), status: z.enum(['bot', 'human', 'closed']).optional(), channel_id: z.string().uuid().optional(), contact_id: z.string().uuid().optional(), updated_since: Iso.optional() }), req.query);
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
        const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), after: z.coerce.number().int().min(0).default(0) }), req.query);
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
        const q = parse(z.object({ content: ExportContentSchema.default('both'), refresh: z.enum(['true', 'false']).default('false') }), req.query);
        const conv = await queryOne<{ id: string }>(`SELECT cv.id FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id WHERE cv.id = $1 AND cv.account_id = $2 AND ch.type <> 'playground'`, [req.params.id, account(req)]);
        if (!conv) throw new HttpError(404, 'Conversación no encontrada');
        return conversationExport(conv.id, { content: q.content, refresh: q.refresh === 'true' ? (id) => service.summarize(id) : undefined, reason: `API (${req.apiKey.name})` });
      });

      /** Enviar un mensaje (a una conversación o por teléfono). Respeta bajas y límites del plan. */
      v1.post('/messages', async (req: any, reply) => {
        const b = parse(z.object({ conversation_id: z.string().uuid().optional(), channel_id: z.string().uuid().optional(), phone: z.string().max(20).optional(), text: z.string().trim().min(1).max(4000) }).refine((x) => x.conversation_id || (x.channel_id && x.phone), 'Indica conversation_id, o channel_id y phone'), req.body);
        let convId = b.conversation_id;
        if (convId) {
          const ok = await queryOne(`SELECT 1 FROM conversations WHERE id = $1 AND account_id = $2`, [convId, account(req)]);
          if (!ok) throw new HttpError(404, 'Conversación no encontrada');
        } else {
          const channel = await store.getChannel(b.channel_id!);
          if (!channel || channel.account_id !== account(req) || channel.type !== 'whatsapp') throw new HttpError(400, 'channel_id debe ser un canal de WhatsApp de tu cuenta');
          const phone = b.phone!.replace(/\D/g, '');
          const contact = await store.upsertContact(channel, `${phone}@s.whatsapp.net`, phone, '');
          convId = (await store.getOrCreateConversation(channel, contact.id)).id;
        }
        const r = await service.outbound.send(convId, { text: b.text, source: 'api', allowWhenHuman: true });
        await logEvent({ level: 'info', source: 'admin', message: `Mensaje enviado por la API (${req.apiKey.name}): ${r.sent ? 'enviado' : r.reason}`, accountId: account(req), conversationId: convId });
        return reply.code(r.sent ? 200 : 422).send({ sent: r.sent, reason: r.sent ? null : r.reason, conversation_id: convId });
      });

      /* ------------------------------ Equipo, asignación y avisos internos ------------------------------ */
      v1.get('/team', async (req: any) => ({
        data: await query(`SELECT id, name, email, role, available FROM users WHERE account_id = $1 AND active AND role IN ('admin', 'agent') ORDER BY name, email`, [account(req)]),
      }));

      /** Avisa dentro del panel (campana y, si la persona lo activó, WhatsApp). A todos, a un rol, a personas o a quien toque por turnos. */
      v1.post('/notifications', async (req: any) => {
        const b = parse(NoticeBody, req.body);
        const r = await sendNotice(service, account(req), b);
        await logEvent({ level: 'info', source: 'admin', message: `Aviso interno enviado por la API (${req.apiKey.name}) a ${r.recipients.length} persona(s)`, accountId: account(req) });
        return { ok: true, sent_to: r.recipients.length, recipients: r.recipients };
      });

      /** Asigna una conversación: user_id de una persona del equipo, "next" (siguiente por turnos) o null (sin asignar). */
      v1.put('/conversations/:id/assign', async (req: any) => {
        const b = parse(z.object({ user_id: z.union([z.string().uuid(), z.literal('next'), z.null()]) }), req.body);
        const conv = await queryOne<{ id: string; account_id: string }>(`SELECT id, account_id FROM conversations WHERE id = $1 AND account_id = $2`, [req.params.id, account(req)]);
        if (!conv) throw new HttpError(404, 'Conversación no encontrada');
        let userId: string | null = null;
        if (b.user_id === 'next') {
          const s = await astore.getSettings(conv.account_id);
          const u = await assignment.assignRoundRobin(conv, { scope: 'api', roles: s.assignment.roles, userIds: s.assignment.user_ids, reason: `API (${req.apiKey.name})` });
          if (!u) throw new HttpError(409, 'No hay nadie disponible para recibirla');
          userId = u.id;
        } else if (b.user_id) {
          const ok = await queryOne(`SELECT 1 FROM users WHERE id = $1 AND account_id = $2 AND active AND role IN ('admin', 'agent')`, [b.user_id, account(req)]);
          if (!ok) throw new HttpError(400, 'Esa persona no pertenece a tu cuenta');
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
        const q = parse(z.object({ from: Iso.optional(), to: Iso.optional(), status: z.string().max(20).optional(), limit: Limit }), req.query);
        const rows = await query<any>(
          `SELECT id, service_name, kind, customer_name, customer_phone, starts_at, ends_at, status, source, notes, contact_id FROM appointments
            WHERE account_id = $1 AND ($2::timestamptz IS NULL OR starts_at >= $2) AND ($3::timestamptz IS NULL OR starts_at < $3) AND ($4::text IS NULL OR status = $4)
            ORDER BY starts_at LIMIT ${q.limit}`,
          [account(req), q.from ?? null, q.to ?? null, q.status ?? null],
        );
        return { data: rows };
      });
    },
    { prefix: '/api/v1' },
  );
}
