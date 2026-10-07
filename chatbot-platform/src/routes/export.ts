/** Exportar contactos, conversaciones y mensajes a CSV (solo administradores; cada exportación queda en el registro). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireRole, targetAccount } from '../access.js';
import { rateLimited } from '../auth.js';
import { query } from '../db.js';
import { csvStream, exportFilename } from '../export.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import { parse } from './util.js';

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');
const BATCH = 1000;

export async function exportRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };

  /** Prepara la respuesta de descarga y registra quién exportó qué. */
  const download = async (req: any, reply: any, kind: string, accountId: string, stream: ReturnType<typeof csvStream>) => {
    if (rateLimited(`export:${req.user.id}`, 20, 3600_000)) throw new HttpError(429, 'Demasiadas exportaciones seguidas; intenta en un rato.');
    await logEvent({ level: 'info', source: 'admin', message: `Exportación CSV de ${kind} por ${req.user.email}`, accountId });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${exportFilename(kind)}"`)
      .header('cache-control', 'no-store')
      .send(stream);
  };

  /* ------------------------------ Contactos ------------------------------ */
  api.get('/api/export/contacts.csv', admins, async (req: any, reply) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const q = parse(z.object({ channel_id: z.string().uuid().optional(), tag: z.string().max(60).optional(), opted_out: z.enum(['true', 'false']).optional(), since: Day.optional() }), req.query);
    // Columnas de datos: los campos que piden los asistentes de la cuenta; lo demás va junto en "otros_datos".
    const bots = await store.listChatbots(accountId);
    const fields = [...new Map(bots.flatMap((b) => b.data_fields).map((f) => [f.key, f.label])).entries()];
    const header = ['id', 'nombre', 'nombre_en_el_canal', 'telefono', 'canal', 'tipo_de_canal', 'etiquetas', 'dado_de_baja', 'fecha_de_baja', 'conversaciones', 'ultimo_mensaje', 'creado', ...fields.map(([, label]) => label), 'otros_datos', 'notas'];
    const stream = csvStream<{ at: string; id: string }>(header, async (cursor) => {
      const rows = await query<any>(
        `SELECT c.*, c.created_at::text AS cursor_at, ch.name AS channel_name, ch.type AS channel_type,
                (SELECT count(*)::int FROM conversations cv WHERE cv.contact_id = c.id) AS conversations,
                (SELECT max(cv.last_message_at) FROM conversations cv WHERE cv.contact_id = c.id) AS last_message_at
           FROM contacts c JOIN channels ch ON ch.id = c.channel_id
          WHERE c.account_id = $1 AND ch.type <> 'playground'
            AND ($2::uuid IS NULL OR c.channel_id = $2) AND ($3::text IS NULL OR c.tags @> to_jsonb($3::text))
            AND ($4::boolean IS NULL OR c.opted_out = $4) AND ($5::date IS NULL OR c.created_at >= $5::date)
            AND ($6::timestamptz IS NULL OR (c.created_at, c.id) > ($6::timestamptz, $7::uuid))
          ORDER BY c.created_at, c.id LIMIT ${BATCH}`,
        [accountId, q.channel_id ?? null, q.tag ?? null, q.opted_out === undefined ? null : q.opted_out === 'true', q.since ?? null, cursor?.at ?? null, cursor?.id ?? null],
      );
      const known = new Set(fields.map(([k]) => k));
      return {
        rows: rows.map((c) => [
          c.id, c.name, c.push_name, c.phone, c.channel_name, c.channel_type, (c.tags ?? []).join('; '), c.opted_out ? 'sí' : 'no', c.opted_out_at, c.conversations, c.last_message_at, c.created_at,
          ...fields.map(([k]) => c.data?.[k] ?? ''),
          Object.fromEntries(Object.entries(c.data ?? {}).filter(([k]) => !known.has(k))), (c.notes ?? []).join(' | '),
        ]),
        // El cursor usa el texto exacto de PostgreSQL (microsegundos): un Date de JavaScript los recorta y repetiría filas.
        cursor: rows.length === BATCH ? { at: rows[rows.length - 1].cursor_at, id: rows[rows.length - 1].id } : null,
      };
    });
    return download(req, reply, 'contactos', accountId, stream);
  });

  /* ------------------------------ Conversaciones ------------------------------ */
  api.get('/api/export/conversations.csv', admins, async (req: any, reply) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const q = parse(z.object({ channel_id: z.string().uuid().optional(), chatbot_id: z.string().uuid().optional(), status: z.enum(['bot', 'human', 'closed']).optional(), from: Day.optional(), to: Day.optional() }), req.query);
    const header = ['id', 'contacto', 'telefono', 'canal', 'tipo_de_canal', 'asistente', 'estado', 'motivo_de_transferencia', 'mensajes', 'primer_mensaje', 'ultimo_mensaje', 'objetivo_cumplido', 'etapa', 'datos_de_la_conversacion', 'resumen'];
    const stream = csvStream<{ at: string; id: string }>(header, async (cursor) => {
      const rows = await query<any>(
        `SELECT cv.*, cv.created_at::text AS cursor_at, ct.name AS contact_name, ct.push_name, ct.phone, ch.name AS channel_name, ch.type AS channel_type, b.name AS bot_name,
                (SELECT count(*)::int FROM messages m WHERE m.conversation_id = cv.id) AS messages,
                (SELECT min(m.created_at) FROM messages m WHERE m.conversation_id = cv.id) AS first_message_at
           FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id JOIN channels ch ON ch.id = cv.channel_id LEFT JOIN chatbots b ON b.id = cv.chatbot_id
          WHERE cv.account_id = $1 AND ch.type <> 'playground'
            AND ($2::uuid IS NULL OR cv.channel_id = $2) AND ($3::uuid IS NULL OR cv.chatbot_id = $3) AND ($4::text IS NULL OR cv.status = $4)
            AND ($5::date IS NULL OR cv.created_at >= $5::date) AND ($6::date IS NULL OR cv.created_at < $6::date + 1)
            AND ($7::timestamptz IS NULL OR (cv.created_at, cv.id) > ($7::timestamptz, $8::uuid))
          ORDER BY cv.created_at, cv.id LIMIT ${BATCH}`,
        [accountId, q.channel_id ?? null, q.chatbot_id ?? null, q.status ?? null, q.from ?? null, q.to ?? null, cursor?.at ?? null, cursor?.id ?? null],
      );
      return {
        rows: rows.map((c) => [c.id, c.contact_name || c.push_name, c.phone, c.channel_name, c.channel_type, c.bot_name, c.status, c.handoff_reason, c.messages, c.first_message_at, c.last_message_at, c.goal_completed_at, c.flow_step, c.data, c.summary]),
        // El cursor usa el texto exacto de PostgreSQL (microsegundos): un Date de JavaScript los recorta y repetiría filas.
        cursor: rows.length === BATCH ? { at: rows[rows.length - 1].cursor_at, id: rows[rows.length - 1].id } : null,
      };
    });
    return download(req, reply, 'conversaciones', accountId, stream);
  });

  /* ------------------------------ Mensajes (transcripciones) ------------------------------ */
  api.get('/api/export/messages.csv', admins, async (req: any, reply) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const q = parse(z.object({ conversation_id: z.string().uuid().optional(), channel_id: z.string().uuid().optional(), from: Day.optional(), to: Day.optional() }), req.query);
    const header = ['id', 'fecha', 'conversacion', 'contacto', 'telefono', 'canal', 'direccion', 'remitente', 'tipo', 'texto', 'imagen', 'estado_de_envio'];
    const stream = csvStream<number>(header, async (cursor) => {
      const rows = await query<any>(
        `SELECT m.*, cv.id AS conv_id, ct.name AS contact_name, ct.push_name, ct.phone, ch.name AS channel_name, i.code AS image_code
           FROM messages m JOIN conversations cv ON cv.id = m.conversation_id JOIN contacts ct ON ct.id = cv.contact_id JOIN channels ch ON ch.id = cv.channel_id
           LEFT JOIN images i ON i.id = m.image_id
          WHERE cv.account_id = $1 AND ch.type <> 'playground'
            AND ($2::uuid IS NULL OR cv.id = $2) AND ($3::uuid IS NULL OR cv.channel_id = $3)
            AND ($4::date IS NULL OR m.created_at >= $4::date) AND ($5::date IS NULL OR m.created_at < $5::date + 1) AND m.id > $6
          ORDER BY m.id LIMIT ${BATCH}`,
        [accountId, q.conversation_id ?? null, q.channel_id ?? null, q.from ?? null, q.to ?? null, cursor ?? 0],
      );
      return {
        rows: rows.map((m) => [m.id, m.created_at, m.conv_id, m.contact_name || m.push_name, m.phone, m.channel_name, m.direction === 'in' ? 'recibido' : 'enviado', m.sender, m.type, m.content, m.image_code, m.status]),
        cursor: rows.length === BATCH ? Number(rows[rows.length - 1].id) : null,
      };
    });
    return download(req, reply, 'mensajes', accountId, stream);
  });
}
