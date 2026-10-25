/** «Datos de tus clientes»: los campos propios de la cuenta, y la importación de contactos desde CSV. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertAccount, HttpError, requireRole, scopeAccount, targetAccount } from '../access.js';
import { rateLimited } from '../auth.js';
import {
  ContactFieldBody, ContactFieldPatch, createContactField, deleteContactField, getContactField, listContactFields, reorderContactFields, updateContactField,
} from '../contacts/fields.js';
import { ImportError, importContacts, isImportColumn } from '../contacts/import.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import { parse } from './util.js';

const MAX_FIELDS = 60;
const noImportClash = (...names: (string | undefined)[]) => {
  const clash = names.find((n) => n && isImportColumn(n));
  if (clash) throw new HttpError(400, `«${clash}» se confunde con el teléfono, el nombre o las etiquetas del contacto al importar: usa otro nombre`);
};

export async function contactFieldRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };
  const owned = async (user: any, id: string) => {
    if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'Campo no encontrado');
    return assertAccount(user, await getContactField(id), 'Campo no encontrado');
  };

  // Todo el equipo los ve: la ficha del cliente y la ayuda de variables los usan.
  api.get('/api/contact-fields', async (req: any) => {
    const accountId = scopeAccount(req.user, req.query.account_id);
    return accountId ? listContactFields(accountId) : [];
  });

  api.post('/api/contact-fields', admins, async (req: any, reply) => {
    const accountId = await targetAccount(req.user, req.query.account_id ?? req.body?.account_id);
    const b = parse(ContactFieldBody, req.body);
    noImportClash(b.key, b.label);
    if ((await listContactFields(accountId)).length >= MAX_FIELDS) throw new HttpError(400, `Hasta ${MAX_FIELDS} campos por cuenta`);
    const f = await createContactField(accountId, b);
    if (!f) throw new HttpError(409, `Ya hay un campo con la clave «${b.key}»`);
    await logEvent({ level: 'info', source: 'admin', message: `Campo de cliente creado por ${req.user.email}: ${f.label} (${f.key})`, accountId });
    return reply.code(201).send(f);
  });

  api.put('/api/contact-fields/order', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id ?? req.body?.account_id);
    const b = parse(z.object({ ids: z.array(z.string().uuid()).max(MAX_FIELDS) }), req.body);
    await reorderContactFields(accountId, b.ids);
    return listContactFields(accountId);
  });

  api.put('/api/contact-fields/:id', admins, async (req: any) => {
    const f = await owned(req.user, req.params.id);
    const b = parse(ContactFieldPatch, req.body);
    noImportClash(b.label);
    if ((b.type ?? f.type) === 'option' && !(b.options ?? f.options).length) throw new HttpError(400, 'Una lista de opciones necesita al menos una opción');
    return updateContactField(f, b);
  });

  api.delete('/api/contact-fields/:id', admins, async (req: any) => {
    const f = await owned(req.user, req.params.id);
    // Lo que ya tienen guardado los contactos se queda (sigue en «otros datos» de la ficha y en la exportación).
    await deleteContactField(f.id);
    await logEvent({ level: 'warn', source: 'admin', message: `Campo de cliente borrado por ${req.user.email}: ${f.label} (${f.key})`, accountId: f.account_id });
    return { ok: true };
  });

  /** Importar contactos desde CSV: alta o actualización por teléfono en un canal de WhatsApp. */
  api.post('/api/contacts/import', admins, async (req: any) => {
    const b = parse(z.object({ channel_id: z.string().uuid(), csv: z.string().min(1).max(5 * 1024 * 1024) }), req.body);
    const channel = assertAccount(req.user, await store.getChannel(b.channel_id), 'Canal no encontrado');
    if (channel.type !== 'whatsapp') throw new HttpError(400, 'Elige un canal de WhatsApp: los contactos se identifican por su teléfono');
    if (rateLimited(`contacts-import:${channel.account_id}`, 20, 3600_000)) throw new HttpError(429, 'Demasiadas importaciones seguidas; intenta en un rato.');
    try {
      const r = await importContacts(channel, b.csv, await listContactFields(channel.account_id));
      await logEvent({ level: 'info', source: 'admin', message: `Importación de contactos por ${req.user.email}: ${r.created} nuevos, ${r.updated} actualizados, ${r.errors.length} con error`, accountId: channel.account_id });
      return r;
    } catch (e) {
      if (e instanceof ImportError) throw new HttpError(400, e.message);
      throw e;
    }
  });
}
