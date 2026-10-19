import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireRole, targetAccount } from '../access.js';
import { rateLimited } from '../auth.js';
import { freeSlots } from '../automation/agenda.js';
import { activeStaff, staffNames } from '../automation/staff.js';
import * as astore from '../automation/store.js';
import { spanishDate, spanishTime } from '../automation/time.js';
import type { Service } from '../automation/types.js';
import { brandOfAccount, publicBrand } from '../brands.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import { parse } from './util.js';

/**
 * Página pública para reservar (como Calendly): el negocio crea enlaces (de todo el negocio o de una persona) y el cliente
 * elige servicio, persona (si se permite), día y hora, y deja sus datos. La reserva entra a la agenda con el mismo reparto
 * y avisos que las demás; la confirmación y los recordatorios le llegan por correo.
 */

interface BookingLink {
  id: string;
  account_id: string;
  token: string;
  name: string;
  service_ids: string[];
  user_id: string | null;
  active: boolean;
  created_at: string;
}

const linkUrl = (token: string) => `${config.publicBaseUrl}/reservar/${token}`;
/** Un mismo correo no acapara la agenda ni recibe correos sin fin: reservas próximas por negocio. */
const MAX_UPCOMING_PER_EMAIL = 3;
/** Reservas por enlace y hora (además del límite por IP). */
const MAX_PER_LINK_HOUR = 60;
/** Horarios que devuelve la página (alcanza para 30 días de un servicio corto). */
const MAX_SLOTS = 1500;

const LinkBody = z.object({
  name: z.string().trim().min(1).max(120),
  /** Servicios que se ofrecen (vacío = todos los activos). */
  service_ids: z.array(z.string().uuid()).max(50).default([]),
  /** Enlace de una persona: solo sus servicios y siempre con ella. */
  user_id: z.string().uuid().nullable().default(null),
  active: z.boolean().default(true),
});

/** Los servicios y la persona del enlace deben ser del negocio. */
async function checkLink(accountId: string, b: z.infer<typeof LinkBody>) {
  if (b.service_ids.length) {
    const own = await query<{ id: string }>(`SELECT id FROM services WHERE id = ANY($1::uuid[]) AND account_id = $2`, [b.service_ids, accountId]);
    if (own.length !== new Set(b.service_ids).size) throw new HttpError(400, 'Un servicio no pertenece a la cuenta');
  }
  if (b.user_id) {
    const user = await queryOne(`SELECT 1 FROM users WHERE id = $1 AND account_id = $2`, [b.user_id, accountId]);
    if (!user) throw new HttpError(400, 'La persona no pertenece a la cuenta');
  }
}

const publicLink = (l: BookingLink, services: Service[], names: Map<string, string>) => ({
  id: l.id, name: l.name, url: linkUrl(l.token), active: l.active, created_at: l.created_at,
  service_ids: l.service_ids, services: services.filter((s) => l.service_ids.includes(s.id)).map((s) => s.name),
  user_id: l.user_id, person: l.user_id ? names.get(l.user_id) ?? null : null,
});

export async function bookingRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };
  const own = async (user: any, id: string, accountQuery?: string) => {
    const accountId = await targetAccount(user, accountQuery);
    const link = await queryOne<BookingLink>(`SELECT * FROM booking_links WHERE id = $1 AND account_id = $2`, [parse(z.string().uuid(), id), accountId]);
    if (!link) throw new HttpError(404, 'Enlace no encontrado');
    return link;
  };

  api.get('/api/booking-links', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query?.account_id);
    const [links, services] = await Promise.all([
      query<BookingLink>(`SELECT * FROM booking_links WHERE account_id = $1 ORDER BY created_at`, [accountId]),
      astore.listServices(accountId),
    ]);
    const names = await staffNames(links.map((l) => l.user_id).filter((x): x is string => !!x));
    return links.map((l) => publicLink(l, services, names));
  });

  api.post('/api/booking-links', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.body?.account_id ?? req.query?.account_id);
    const b = parse(LinkBody, req.body ?? {});
    await checkLink(accountId, b);
    const row = await queryOne<BookingLink>(
      `INSERT INTO booking_links (account_id, token, name, service_ids, user_id, active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [accountId, crypto.randomBytes(12).toString('base64url'), b.name, b.service_ids, b.user_id, b.active]);
    await logEvent({ level: 'info', source: 'admin', message: `Enlace para reservar creado: ${b.name}`, accountId });
    return publicLink(row!, await astore.listServices(accountId), await staffNames(b.user_id ? [b.user_id] : []));
  });

  api.put('/api/booking-links/:id', admins, async (req: any) => {
    const link = await own(req.user, req.params.id, req.query?.account_id);
    const b = parse(LinkBody, { ...link, ...(req.body ?? {}) });
    await checkLink(link.account_id, b);
    const row = await queryOne<BookingLink>(
      `UPDATE booking_links SET name = $2, service_ids = $3, user_id = $4, active = $5 WHERE id = $1 RETURNING *`, [link.id, b.name, b.service_ids, b.user_id, b.active]);
    return publicLink(row!, await astore.listServices(link.account_id), await staffNames(b.user_id ? [b.user_id] : []));
  });

  api.delete('/api/booking-links/:id', admins, async (req: any) => {
    const link = await own(req.user, req.params.id, req.query?.account_id);
    await query(`DELETE FROM booking_links WHERE id = $1`, [link.id]);
    return { ok: true };
  });
}

/* ------------------------------ Página pública ------------------------------ */

const here = path.dirname(fileURLToPath(import.meta.url));
let pageHtml: string | null = null;
const page = () => (pageHtml ??= fs.readFileSync(path.resolve(here, '..', '..', 'public', 'reservar.html'), 'utf8'));

/** Enlace activo de un negocio activo, con sus servicios (solo activos; los de la persona, si es su enlace). */
async function linkFor(token: string) {
  if (!/^[\w-]{8,40}$/.test(token)) return null;
  const link = await queryOne<BookingLink & { account_active: boolean; account_status: string; account_name: string }>(
    `SELECT l.*, a.active AS account_active, a.status AS account_status, a.name AS account_name FROM booking_links l JOIN accounts a ON a.id = l.account_id WHERE l.token = $1`, [token]);
  if (!link || !link.active || !link.account_active || link.account_status === 'paused') return null;
  let services = (await astore.listServices(link.account_id, true)).filter((s) => !link.service_ids.length || link.service_ids.includes(s.id));
  if (link.user_id) {
    const active = await queryOne(`SELECT 1 FROM users WHERE id = $1 AND active`, [link.user_id]);
    services = active ? services.filter((s) => s.assigned_user_ids.includes(link.user_id!)) : [];
  }
  return { link, services };
}

/** Personas que el cliente puede elegir en un servicio (si el servicio lo permite y el enlace no es de una persona). */
async function choosable(service: Service, link: BookingLink) {
  if (link.user_id || !service.customer_choice || !service.assigned_user_ids.length) return [];
  const active = await activeStaff(service);
  const names = await staffNames(active.assigned_user_ids);
  return active.assigned_user_ids.map((id) => ({ id, name: names.get(id) ?? 'Persona' }));
}

const BookBody = z.object({
  service_id: z.string().uuid(),
  slot: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Elige un horario'),
  person_id: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(2, 'Escribe tu nombre').max(120),
  email: z.string().trim().email('Escribe un correo válido').max(200),
  phone: z.string().trim().max(30).default(''),
  notes: z.string().trim().max(1000).default(''),
  /** Campo trampa: las personas no lo ven; los robots lo llenan. */
  website: z.string().max(200).default(''),
});

export async function bookingPublicRoutes(app: FastifyInstance, service: ChatService) {
  app.get('/reservar/:token', async (req: any, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').type('text/html');
    return page();
  });

  /** Lo que muestra la página: el negocio, la persona del enlace (si es suyo) y los servicios. */
  app.get('/api/public/booking/:token', async (req: any, reply) => {
    if (rateLimited(`booking-info:${req.ip}`, 120, 60_000)) return reply.code(429).send({ error: 'Demasiadas visitas; intenta en un minuto.' });
    const found = await linkFor(String(req.params.token));
    if (!found) return reply.code(404).send({ error: 'Este enlace para reservar ya no está disponible.' });
    const { link, services } = found;
    const brand = publicBrand(await brandOfAccount(link.account_id));
    const settings = await astore.getSettings(link.account_id);
    const person = link.user_id ? (await staffNames([link.user_id])).get(link.user_id) ?? null : null;
    return {
      business: { name: brand.brand_id ? brand.name : link.account_name, color: brand.color, logo: brand.logo },
      title: link.name,
      person,
      timezone: settings.timezone,
      services: await Promise.all(services.map(async (s) => ({
        id: s.id, name: s.name, kind: s.kind, call_mode: s.kind === 'call' ? s.call_mode : null, duration: s.duration_minutes,
        description: s.description, location: s.kind === 'appointment' ? s.location : '', people: await choosable(s, link),
      }))),
    };
  });

  /** Horarios libres del servicio (con la persona del enlace o la que eligió el cliente). */
  app.get('/api/public/booking/:token/slots', async (req: any, reply) => {
    if (rateLimited(`booking-slots:${req.ip}`, 120, 60_000)) return reply.code(429).send({ error: 'Demasiadas visitas; intenta en un minuto.' });
    const found = await linkFor(String(req.params.token));
    if (!found) return reply.code(404).send({ error: 'Este enlace para reservar ya no está disponible.' });
    const svc = found.services.find((s) => s.id === String(req.query?.service_id ?? ''));
    if (!svc) return reply.code(404).send({ error: 'Servicio no disponible' });
    const person = found.link.user_id ?? (req.query?.person_id ? String(req.query.person_id) : null);
    if (person && !found.link.user_id && !(await choosable(svc, found.link)).some((p) => p.id === person)) return reply.code(400).send({ error: 'Esa persona no atiende este servicio' });
    const settings = await astore.getSettings(found.link.account_id);
    const all = await freeSlots(svc, settings, new Date(), { days: Math.min(svc.max_days_ahead, 30) });
    const tz = settings.timezone;
    return all.filter((s) => !person || s.users.includes(person)).slice(0, MAX_SLOTS).map((s) => ({
      key: s.key, date: s.key.slice(0, 10), time: s.key.slice(11), day: spanishDate(s.start, tz), label: spanishTime(s.start, tz),
    }));
  });

  /** Reserva: se vuelve a revisar el horario (como en el chat) y se confirma por correo. */
  app.post('/api/public/booking/:token', async (req: any, reply) => {
    if (rateLimited(`booking-book:${req.ip}`, 10, 60 * 60_000)) return reply.code(429).send({ error: 'Hiciste demasiadas reservas seguidas; intenta más tarde.' });
    const found = await linkFor(String(req.params.token));
    if (!found) return reply.code(404).send({ error: 'Este enlace para reservar ya no está disponible.' });
    const b = parse(BookBody, req.body ?? {});
    // Un robot llenó el campo trampa: se responde como si nada, sin reservar.
    if (b.website) return { ok: true };
    const svc = found.services.find((s) => s.id === b.service_id);
    if (!svc) throw new HttpError(404, 'Servicio no disponible');
    const phone = b.phone.replace(/\D/g, '');
    if (svc.kind === 'call' && svc.call_mode !== 'video' && phone.length < 8) throw new HttpError(400, 'Escribe tu teléfono: te llamaremos a ese número');
    const person = found.link.user_id ?? b.person_id;
    if (person && !found.link.user_id && !(await choosable(svc, found.link)).some((p) => p.id === person)) throw new HttpError(400, 'Esa persona no atiende este servicio');
    if (rateLimited(`booking-link:${found.link.id}`, MAX_PER_LINK_HOUR, 60 * 60_000)) return reply.code(429).send({ error: 'Este enlace recibió muchas reservas seguidas; intenta más tarde.' });
    const upcoming = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM appointments WHERE account_id = $1 AND customer_email = $2 AND status = 'confirmed' AND starts_at > now()`,
      [found.link.account_id, b.email.toLowerCase()]);
    if (upcoming!.n >= MAX_UPCOMING_PER_EMAIL) return reply.code(429).send({ error: 'Ya tienes varias reservas próximas con este negocio. Si necesitas otra, escríbeles directamente.' });
    const r = await service.agenda.book({
      accountId: found.link.account_id, serviceId: svc.id, slotKey: b.slot, customerName: b.name, customerPhone: phone || undefined,
      customerEmail: b.email, notes: b.notes ? `${b.notes}\n(Reservó en la página: ${found.link.name})` : `Reservó en la página: ${found.link.name}`,
      source: 'pagina', assignedUserId: person,
    });
    if (!r.ok) return reply.code(409).send({ error: r.alternatives.length ? `Ese horario ya se ocupó. Elige otro: ${r.alternatives.join('; ')}` : 'Ese horario ya se ocupó. Elige otro.' });
    const a = r.appointment;
    const emailSent = await service.agenda.mailCustomer(a, 'booked').catch(() => false);
    const tz = (await astore.getSettings(a.account_id)).timezone;
    return {
      ok: true, service: a.service_name, kind: a.kind, when: `${spanishDate(new Date(a.starts_at), tz)} a las ${spanishTime(new Date(a.starts_at), tz)}`,
      person: a.assigned_user_name ?? null, meeting_url: a.meeting_url || null, email: a.customer_email, email_sent: emailSent,
    };
  });
}
