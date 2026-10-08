import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertAccount, conversationFor, HttpError, scopeAccount } from '../access.js';
import { query } from '../db.js';
import { agentStatus } from '../engine/activation.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import { parse } from './util.js';
import { rateLimited } from '../auth.js';
import { deliverReport, ReportSendSchema, reportRecipients } from '../automation/report-delivery.js';
import { buildReport, renderReport, transcriptTail } from '../engine/report-format.js';
import * as astore from '../automation/store.js';
import * as assignment from '../automation/assignment.js';
import { stopEnrollments } from '../automation/store.js';
import { contactDataExport, eraseContact } from '../privacy.js';
import { inboundAbsolutePath, safeFileName } from '../channels/media.js';

/** Conversaciones y contactos: disponible para administradores y agentes de la cuenta. */
export async function conversationRoutes(api: FastifyInstance, service: ChatService) {
  api.get('/api/conversations', async (req: any) => {
    const q = req.query as Record<string, string | undefined>;
    const params: unknown[] = [];
    const where: string[] = [];
    const account = scopeAccount(req.user, q.account_id);
    if (account) {
      params.push(account);
      where.push(`c.account_id = $${params.length}`);
    }
    for (const [key, col] of [['chatbot_id', 'c.chatbot_id'], ['channel_id', 'c.channel_id'], ['status', 'c.status'], ['channel_type', 'ch.type']] as const) {
      if (q[key]) {
        params.push(q[key]);
        where.push(`${col} = $${params.length}`);
      }
    }
    if (q.assigned === 'me') { params.push(req.user.id); where.push(`c.assigned_user_id = $${params.length}`); }
    else if (q.assigned === 'none') where.push(`c.assigned_user_id IS NULL`);
    else if (q.assigned && /^[0-9a-f-]{36}$/i.test(q.assigned)) { params.push(q.assigned); where.push(`c.assigned_user_id = $${params.length}`); }
    if (q.include_playground !== 'true') where.push(`ch.type <> 'playground'`);
    if (q.search) {
      params.push(`%${q.search}%`);
      where.push(`(ct.name ILIKE $${params.length} OR ct.push_name ILIKE $${params.length} OR ct.phone ILIKE $${params.length})`);
    }
    params.push(Math.min(Number(q.limit) || 100, 500));
    return query(
      `SELECT c.id, c.account_id, c.chatbot_id, c.channel_id, c.status, c.handoff_reason, c.last_message_at, c.created_at, c.assigned_user_id, au.name AS assigned_name, au.email AS assigned_email,
              ct.id AS contact_id, ct.name, ct.push_name, ct.phone, ct.external_id,
              ch.type AS channel_type, ch.name AS channel_name, b.name AS chatbot_name, a.name AS account_name,
              (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message,
              (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c
         JOIN contacts ct ON ct.id = c.contact_id
         JOIN channels ch ON ch.id = c.channel_id
         JOIN accounts a ON a.id = c.account_id
         LEFT JOIN chatbots b ON b.id = c.chatbot_id
         LEFT JOIN users au ON au.id = c.assigned_user_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY c.last_message_at DESC LIMIT $${params.length}`,
      params,
    );
  });

  api.get('/api/conversations/:cid', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    const [contact, messages, bot, channel] = await Promise.all([
      store.getContact(conv.contact_id),
      query(
        `SELECT m.*, i.code AS image_code, i.name AS image_name,
                mm.kind AS media_kind, mm.mime AS media_mime, mm.file_name AS media_name, mm.size_bytes AS media_size, mm.complete AS media_complete
         FROM messages m LEFT JOIN images i ON i.id = m.image_id LEFT JOIN message_media mm ON mm.message_id = m.id
         WHERE m.conversation_id = $1 ORDER BY m.id DESC LIMIT 500`,
        [conv.id],
      ),
      conv.chatbot_id ? store.getChatbot(conv.chatbot_id) : null,
      store.getChannel(conv.channel_id),
    ]);
    return {
      conversation: conv,
      contact,
      messages: messages.reverse(),
      chatbot: bot ? { id: bot.id, name: bot.name, data_fields: bot.data_fields, flow: bot.flow } : null,
      /** Asistente en esta conversación: activo, en pausa (motivo) o esperando su palabra de activación. */
      agent: bot ? agentStatus(bot, conv) : null,
      channel: channel ? { id: channel.id, name: channel.name, type: channel.type } : null,
      assignee: conv.assigned_user_id ? await store.getUserBasic(conv.assigned_user_id) : null,
    };
  });

  /** Foto o documento que envió el cliente, tal como llegó. Las imágenes se ven en el panel; el resto se descarga. */
  api.get('/api/messages/:mid/media', async (req: any, reply) => {
    const mid = Number(req.params.mid);
    const [file] = Number.isSafeInteger(mid) && mid > 0
      ? await query<{ conversation_id: string; file_path: string; mime: string; file_name: string }>(
          `SELECT m.conversation_id, mm.file_path, mm.mime, mm.file_name FROM message_media mm JOIN messages m ON m.id = mm.message_id WHERE mm.message_id = $1`,
          [mid],
        )
      : [];
    if (!file) throw new HttpError(404, 'Archivo no encontrado');
    // Quien puede ver la conversación puede ver sus archivos; nadie más, aunque conozca el número del mensaje.
    await conversationFor(req.user, file.conversation_id);
    const abs = inboundAbsolutePath(file.file_path);
    if (!abs || !fs.existsSync(abs)) throw new HttpError(404, 'El archivo ya no está guardado');
    const inline = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mime);
    reply
      .header('content-type', inline ? file.mime : 'application/octet-stream')
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(safeFileName(file.file_name))}`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=300');
    return reply.send(fs.createReadStream(abs));
  });

  const log = (conv: { account_id: string; chatbot_id: string | null; channel_id: string; id: string }, message: string) =>
    logEvent({ level: 'info', source: 'admin', message, accountId: conv.account_id, chatbotId: conv.chatbot_id, channelId: conv.channel_id, conversationId: conv.id });

  api.post('/api/conversations/:cid/takeover', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    // Quien toma una conversación sin dueño se queda con ella (antes de la transferencia, para que no se reparta a otra persona).
    if (!conv.assigned_user_id && req.user.account_id) await assignment.setAssignee(conv.id, req.user.id);
    const updated = await service.takeover(conv.id, `Tomada por ${req.user.name || req.user.email}`, req.user.id);
    await log(conv, `Conversación tomada por ${req.user.email}`);
    return updated;
  });

  /**
   * Asignar la conversación: a una persona concreta, a ti ("me"), al siguiente del turno ("next") o a nadie (null).
   * Cualquiera del equipo puede quedársela; asignar a otras personas o repartir por turnos es de administradores.
   */
  api.put('/api/conversations/:cid/assign', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    const b = parse(z.object({ user_id: z.union([z.string().uuid(), z.literal('me'), z.literal('next'), z.null()]) }), req.body);
    const isAdminUser = req.user.role === 'admin' || req.user.role === 'superadmin';
    let target: assignment.Candidate | null = null;
    if (b.user_id === 'next') {
      if (!isAdminUser) throw new HttpError(403, 'Solo un administrador reparte por turnos');
      const settings = await astore.getSettings(conv.account_id);
      target = await assignment.assignRoundRobin(conv, { scope: 'manual', roles: settings.assignment.roles, userIds: settings.assignment.user_ids, reason: `repartida por ${req.user.email}` });
      if (!target) throw new HttpError(409, 'No hay nadie disponible para recibirla');
    } else if (b.user_id === null) {
      if (!isAdminUser && conv.assigned_user_id !== req.user.id) throw new HttpError(403, 'Solo puedes soltar tus propias conversaciones');
      await assignment.setAssignee(conv.id, null);
    } else {
      const uid = b.user_id === 'me' ? req.user.id : b.user_id;
      if (uid !== req.user.id && !isAdminUser) throw new HttpError(403, 'Solo un administrador asigna a otras personas');
      const user = (await query<assignment.Candidate & { active: boolean; account_id: string }>(`SELECT id, name, email, role, phone, notify_whatsapp, active, account_id FROM users WHERE id = $1`, [uid]))[0];
      if (!user || user.account_id !== conv.account_id || !user.active || user.role === 'superadmin') throw new HttpError(400, 'Esa persona no pertenece a esta cuenta');
      await assignment.setAssignee(conv.id, user.id);
      target = user;
    }
    await log(conv, target ? `Conversación asignada a ${target.email} por ${req.user.email}` : `Conversación sin asignar (${req.user.email})`);
    if (target && target.id !== req.user.id) {
      const contact = await store.getContact(conv.contact_id);
      await service.automator.alertTeam(conv.account_id, {
        title: '📥 Te asignaron una conversación',
        body: `${contact?.name || contact?.push_name || 'Cliente'}${b.user_id === 'next' ? ' (por turnos)' : ` · te la asignó ${req.user.name || req.user.email}`}`,
        link: `#/conversation/${conv.id}`,
        userIds: [target.id],
        kind: 'assignment',
      });
    }
    return { ok: true, assigned_user_id: target?.id ?? null, assigned_name: target ? target.name || target.email : null };
  });

  api.post('/api/conversations/:cid/release', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    // Los mensajes que llegaron mientras atendía una persona no se responden en automático.
    await store.markAllProcessed(conv.id);
    await store.setConversationStatus(conv.id, 'bot', '');
    // También quita la pausa del asistente (y lo cuenta como activado en el modo "solo con palabras").
    const updated = await store.setAgentOn(conv.id);
    await log(conv, `Conversación devuelta al asistente por ${req.user.email}`);
    return updated;
  });

  api.post('/api/conversations/:cid/close', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    return service.closeConversation(conv.id, `Cerrada por ${req.user.name || req.user.email}`);
  });

  api.post('/api/conversations/:cid/summary', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    try { return await service.summarize(conv.id); }
    catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : 'No se pudo generar el resumen');
    }
  });

  /** Reporte consultable: JSON, o texto plano para descargar (?format=txt). ?refresh=1 actualiza el resumen antes. */
  api.get('/api/conversations/:cid/report', async (req: any, reply) => {
    const conv = await conversationFor(req.user, req.params.cid);
    let warning: string | null = null;
    if (req.query?.refresh === '1') {
      try { await service.summarize(conv.id); } catch (e: any) { warning = `No se pudo actualizar el resumen: ${String(e?.message ?? e).slice(0, 120)}`; }
    }
    const report = await buildReport(conv.id);
    if (req.query?.format === 'txt') {
      const text = renderReport(report, { transcript: req.query?.transcript === '1' ? await transcriptTail(conv.id) : '', warning: warning ?? undefined });
      return reply.header('content-type', 'text/plain; charset=utf-8').header('content-disposition', `attachment; filename="reporte-${conv.id.slice(0, 8)}.txt"`).send(text);
    }
    return { ...report, warning };
  });

  /** Personas a las que se puede enviar el reporte (cualquier integrante del equipo puede verlas). */
  api.get('/api/conversations/:cid/report/recipients', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    const team = await reportRecipients(conv.account_id, { roles: ['admin', 'agent'] });
    return team.map((u) => ({ id: u.id, name: u.name || u.email, whatsapp: !!(u.notify_whatsapp && u.phone) }));
  });

  /** Envía el reporte al equipo (cualquier integrante) o a direcciones externas (solo administradores). */
  api.post('/api/conversations/:cid/report/send', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    const b = parse(ReportSendSchema, req.body);
    const external = b.emails.length + b.phones.length > 0;
    if (external && req.user.role !== 'admin' && req.user.role !== 'superadmin') throw new HttpError(403, 'Solo un administrador puede enviar reportes fuera del equipo');
    if (!b.user_ids.length && !external) throw new HttpError(400, 'Elige al menos un destinatario');
    if (rateLimited(`report:${req.user.id}`, 20, 10 * 60_000)) throw new HttpError(429, 'Demasiados reportes enviados: espera unos minutos');
    const users = await reportRecipients(conv.account_id, { userIds: b.user_ids });
    if (users.length !== new Set(b.user_ids).size) throw new HttpError(400, 'Algún destinatario no pertenece a esta cuenta o está inactivo');
    return deliverReport(service, conv.id, { users, emails: b.emails, phones: b.phones, note: b.note, includeTranscript: b.include_transcript, refresh: b.refresh, by: req.user.email });
  });

  api.post('/api/conversations/:cid/send', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    const b = parse(z.object({ text: z.string().trim().min(1, 'Mensaje vacío').max(4000), takeover: z.boolean().default(true) }), req.body);
    if (b.takeover && conv.status === 'bot') {
      await service.takeover(conv.id, `${req.user.name || req.user.email} respondió desde el panel`);
    }
    try {
      return await service.sendManual(conv.id, b.text);
    } catch (e: any) {
      throw new HttpError(400, e?.message ?? String(e));
    }
  });

  api.post('/api/conversations/:cid/send-image', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    const b = parse(z.object({ image_id: z.string().uuid('Elige una foto'), takeover: z.boolean().default(true) }), req.body);
    try {
      // La conversación se toma solo si la foto es válida (justo antes de enviarla).
      return await service.sendManualImage(conv.id, b.image_id, async () => {
        if (b.takeover && conv.status === 'bot') {
          await service.takeover(conv.id, `${req.user.name || req.user.email} respondió desde el panel`);
        }
      });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      throw new HttpError(msg === 'Foto no encontrada' ? 404 : 400, msg);
    }
  });

  api.post('/api/conversations/:cid/reset-memory', async (req: any) => {
    const conv = await conversationFor(req.user, req.params.cid);
    await store.resetConversationMemory(conv.id, conv.contact_id);
    return { ok: true };
  });

  /** Derecho de acceso / portabilidad: todo lo que se guarda de este contacto, en un archivo JSON. */
  api.get('/api/contacts/:id/data', async (req: any, reply) => {
    if (req.user.role === 'agent') throw new HttpError(403, 'Solo un administrador puede descargar los datos de un contacto');
    const contact = assertAccount(req.user, await store.getContact(req.params.id), 'Contacto no encontrado');
    const data = await contactDataExport(contact.id);
    await logEvent({ level: 'info', source: 'admin', message: `Descarga de datos de un contacto por ${req.user.email}`, accountId: contact.account_id });
    return reply.header('content-disposition', 'attachment; filename="datos-del-contacto.json"').header('cache-control', 'no-store').send(data);
  });

  /** Derecho de supresión: borra al contacto y todo su historial (no se puede deshacer). */
  api.delete('/api/contacts/:id', async (req: any) => {
    if (req.user.role === 'agent') throw new HttpError(403, 'Solo un administrador puede borrar los datos de un contacto');
    const contact = assertAccount(req.user, await store.getContact(req.params.id), 'Contacto no encontrado');
    const r = await eraseContact(contact.id);
    await logEvent({ level: 'info', source: 'admin', message: `Datos de un contacto eliminados por ${req.user.email} (${r?.conversations ?? 0} conversaciones, ${r?.messages ?? 0} mensajes)`, accountId: contact.account_id });
    return { ok: true, ...r };
  });

  api.put('/api/contacts/:id', async (req: any) => {
    const contact = assertAccount(req.user, await store.getContact(req.params.id), 'Contacto no encontrado');
    const b = parse(
      z.object({
        name: z.string().max(100).optional(),
        data: z.record(z.string(), z.string().max(500)).optional(),
        notes: z.array(z.string().max(300)).max(50).optional(),
        tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
        opted_out: z.boolean().optional(),
        /** El cliente aceptó (o ya no) recibir promociones. */
        consent: z.boolean().optional(),
        /** Versión de datos que tenía el panel al abrir el formulario (conversación.data_version). */
        base_data_version: z.number().int().min(0).optional(),
      }),
      req.body,
    );
    const { consent, base_data_version, ...patch } = b;
    // Si la IA o el equipo guardó datos después de abrir el formulario, no se sobrescriben: se pide revisar antes.
    const changes = await store.updateContactFromPanel(contact.id, { ...patch, expectedDataVersion: base_data_version }).catch((e) => {
      if (e instanceof store.StaleDataError) throw new HttpError(409, 'Los datos cambiaron mientras los editabas (la IA capturó algo nuevo). Recarga la conversación y revisa antes de guardar.');
      throw e;
    });
    if (consent !== undefined && !!contact.consent_at !== consent) await astore.setConsent(contact.id, consent, 'panel');
    const conv = (await query<{ id: string }>('SELECT id FROM conversations WHERE contact_id = $1', [contact.id]))[0];
    if (conv && changes) {
      if (changes.optedOut) {
        await stopEnrollments(conv.id, 'el cliente se dio de baja desde el panel');
        service.automator.emit({ type: 'opt_out', conversationId: conv.id });
      }
      for (const field of changes.changedFields) service.automator.emit({ type: 'data_captured', conversationId: conv.id, field });
      for (const tag of changes.addedTags) service.automator.emit({ type: 'tag_added', conversationId: conv.id, tag });
      await service.automator.settle(conv.id);
    }
    return (await store.getContact(contact.id)) ?? changes?.contact;
  });
}
