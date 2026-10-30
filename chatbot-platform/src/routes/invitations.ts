/**
 * Invitaciones de equipo: el administrador invita por correo y la persona se une sola a la cuenta, eligiendo su
 * contraseña o entrando con Google (que ya probó que el correo es suyo). Nadie tiene que compartir contraseñas.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireRole, targetAccount } from '../access.js';
import { hashPassword, rateLimited } from '../auth.js';
import { beginLogin } from '../identity/mfa.js';
import { hostOf, mailBrand } from '../brands.js';
import { assertWithinLimit, effectiveLimits, LIMIT_LABELS, limitDetail, offerText, usageOf } from '../billing/limits.js';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db.js';
import { googleConfigured } from '../integrations/google.js';
import { assertPasswordAllowed, NewPassword } from '../identity/passwords.js';
import { assertOwner, ensureOwner } from '../identity/ownership.js';
import { assertRecentMfa } from '../identity/step-up.js';
import { logEvent } from '../logs.js';
import { sendMail } from '../mailer.js';
import { DISPOSABLE_MESSAGE, isDisposableEmail, readGoogleSignupPass, recordTermsAcceptance, termsVersion } from '../signup-guard.js';
import * as store from '../store/index.js';
import type { User } from '../types.js';
import { parse } from './util.js';

const HOUR = 3600_000;
const DAYS_VALID = 7;
const ROLE_LABEL: Record<string, string> = { admin: 'administrador', agent: 'agente' };

export interface Invitation {
  id: string;
  account_id: string;
  email: string;
  name: string;
  role: 'admin' | 'agent';
  invited_by: string | null;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}
const COLS = 'id, account_id, email, name, role, invited_by, expires_at, accepted_at, revoked_at, created_at';
const PENDING = 'accepted_at IS NULL AND revoked_at IS NULL';

const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

/** Invitación pendiente más reciente para un correo (para quien entra con Google por primera vez). */
export const pendingInviteFor = (email: string) =>
  queryOne<Invitation>(`SELECT ${COLS} FROM account_invitations WHERE lower(email) = lower($1) AND ${PENDING} AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [email]);

/** Al invitar cuentan también las invitaciones que aún no se aceptan: si todas se aceptan, la cuenta no pasa su límite. */
async function assertRoomForInvite(accountId: string) {
  const { limits, source } = await effectiveLimits(accountId);
  const max = limits.users;
  if (!max) return;
  const used = (await usageOf(accountId)).users;
  const pending = (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM account_invitations WHERE account_id = $1 AND ${PENDING} AND expires_at > now()`, [accountId]))!.n;
  if (used + pending + 1 > max) {
    const l = LIMIT_LABELS.users;
    const extra = pending ? ` más ${pending} ${pending === 1 ? 'invitación pendiente' : 'invitaciones pendientes'}` : '';
    const detail = await limitDetail(accountId, 'users', used + pending, max);
    throw new HttpError(
      403,
      `${source === 'trial' ? 'Tu periodo de prueba permite' : 'Tu plan permite'} hasta ${max} ${max === 1 ? l.singular : l.plural} y ya tienes ${used}${extra}.${detail.next_plan ? ` ${offerText(detail.next_plan, 'users')}` : ''} Para invitar a más personas, cambia de plan en Ajustes → Mi plan y pagos o cancela una invitación.`,
      ['limit_reached'],
      { limit: detail },
    );
  }
}

async function sendInvite(inv: Invitation, token: string, inviterName: string) {
  const acc = await store.getAccount(inv.account_id);
  const mb = await mailBrand(inv.account_id);
  const link = `${mb.base}/#/invitacion?token=${encodeURIComponent(token)}`;
  const google = googleConfigured() && mb.base === config.publicBaseUrl ? ' Si tu correo es de Google, también puedes entrar con Google.' : '';
  await sendMail({
    fromName: mb.fromName,
    to: inv.email,
    subject: `${inviterName || 'Tu equipo'} te invitó a ${acc?.name ?? 'su equipo'}`,
    text: `Hola ${inv.name || ''},\n\n${inviterName || 'Un administrador'} te invitó a unirte a "${acc?.name ?? ''}" como ${ROLE_LABEL[inv.role]}. Para aceptar, abre este enlace y elige tu contraseña:\n\n${link}\n\nEl enlace vence en ${DAYS_VALID} días.${google}\n\nSi no esperabas esta invitación, ignora este mensaje.`,
  });
}

/** Se puede invitar a ese correo: no es desechable y no tiene usuario (cada correo es de una sola cuenta). */
export async function assertInvitable(email: string): Promise<void> {
  if (isDisposableEmail(email)) throw new HttpError(400, DISPOSABLE_MESSAGE);
  if (await store.getUserForLogin(email)) throw new HttpError(409, 'Ese correo ya tiene cuenta en la plataforma: invita otro correo.');
}

/** Crea la invitación (reemplaza la pendiente al mismo correo, vencida o no), la manda y la deja en la bitácora. */
export async function createInvitation(actor: Pick<User, 'id' | 'role' | 'name'>, accountId: string, b: { email: string; name: string; role: 'admin' | 'agent' }): Promise<Invitation> {
  await assertInvitable(b.email);
  await query(`UPDATE account_invitations SET revoked_at = now() WHERE account_id = $1 AND lower(email) = $2 AND ${PENDING}`, [accountId, b.email]);
  await assertRoomForInvite(accountId);
  const token = newToken();
  const inv = (await queryOne<Invitation>(
    `INSERT INTO account_invitations (account_id, email, name, role, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(days => $7)) RETURNING ${COLS}`,
    [accountId, b.email, b.name, b.role, tokenHash(token), actor.role === 'superadmin' ? null : actor.id, DAYS_VALID],
  ))!;
  await sendInvite(inv, token, inviterName(actor));
  await logEvent({ level: 'info', source: 'admin', message: `Invitación enviada a ${b.email} (${ROLE_LABEL[b.role]})`, accountId });
  return inv;
}

const out = (i: Invitation) => ({ id: i.id, email: i.email, name: i.name, role: i.role, expires_at: i.expires_at, created_at: i.created_at, expired: new Date(i.expires_at) <= new Date() });
const inviterName = (user: { role: string; name: string }) => (user.role === 'superadmin' ? '' : user.name);

/** Rutas del panel (administradores; el superadmin, con ?account_id). */
export async function invitationRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };

  const mine = async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const inv = await queryOne<Invitation>(`SELECT ${COLS} FROM account_invitations WHERE id = $1 AND account_id = $2 AND ${PENDING}`, [req.params.id, accountId]);
    if (!inv) throw new HttpError(404, 'Invitación no encontrada');
    return inv;
  };

  api.get('/api/invitations', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    return (await query<Invitation>(`SELECT ${COLS} FROM account_invitations WHERE account_id = $1 AND ${PENDING} ORDER BY created_at DESC`, [accountId])).map(out);
  });

  api.post('/api/invitations', admins, async (req: any, reply) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const b = parse(
      z.object({
        email: z.string().trim().toLowerCase().email('correo inválido').max(200),
        name: z.string().trim().max(120).default(''),
        role: z.enum(['admin', 'agent']).default('agent'),
      }),
      req.body,
    );
    // Invitar a un administrador es del dueño y pide verificación reciente (un agente no).
    if (b.role === 'admin') {
      await assertOwner(req, accountId);
      assertRecentMfa(req);
    }
    if (rateLimited(`invite:${accountId}`, 30, 24 * HOUR)) return reply.code(429).send({ error: 'Llegaste al máximo de invitaciones por hoy. Intenta mañana.' });
    return out(await createInvitation(req.user, accountId, b));
  });

  /** Reenvía con un enlace nuevo (el anterior deja de servir) y otros 7 días. */
  api.post('/api/invitations/:id/resend', admins, async (req: any, reply) => {
    const inv = await mine(req);
    if (rateLimited(`invite:${inv.account_id}`, 30, 24 * HOUR)) return reply.code(429).send({ error: 'Llegaste al máximo de invitaciones por hoy. Intenta mañana.' });
    const token = newToken();
    const upd = (await queryOne<Invitation>(
      `UPDATE account_invitations SET token_hash = $2, expires_at = now() + make_interval(days => $3) WHERE id = $1 RETURNING ${COLS}`,
      [inv.id, tokenHash(token), DAYS_VALID],
    ))!;
    await sendInvite(upd, token, inviterName(req.user));
    return out(upd);
  });

  api.delete('/api/invitations/:id', admins, async (req: any) => {
    const inv = await mine(req);
    await query(`UPDATE account_invitations SET revoked_at = now() WHERE id = $1`, [inv.id]);
    await logEvent({ level: 'info', source: 'admin', message: `Invitación a ${inv.email} cancelada`, accountId: inv.account_id });
    return { ok: true };
  });
}

/** La invitación de un enlace (token) o de quien entró con Google (pase firmado con su correo). */
async function invitationFrom(q: { token?: unknown; google?: unknown }) {
  if (q.google) {
    const p = readGoogleSignupPass(String(q.google));
    const inv = p ? await pendingInviteFor(p.email) : null;
    if (!p || !inv) throw new HttpError(400, 'El enlace venció. Vuelve a abrir la invitación que te llegó por correo.');
    return { inv, google: p };
  }
  const token = String(q.token ?? '');
  const inv = token ? await queryOne<Invitation>(`SELECT ${COLS} FROM account_invitations WHERE token_hash = $1`, [tokenHash(token)]) : null;
  if (!inv) throw new HttpError(400, 'Esta invitación no es válida. Pide a tu equipo que te envíe una nueva.');
  if (inv.accepted_at) throw new HttpError(400, 'Esta invitación ya se usó: inicia sesión con tu correo.');
  if (inv.revoked_at) throw new HttpError(400, 'Esta invitación se canceló. Pide a tu equipo que te envíe una nueva.');
  if (new Date(inv.expires_at) <= new Date()) throw new HttpError(400, 'Esta invitación venció. Pide a tu equipo que te envíe una nueva.');
  return { inv, google: null };
}

/** Rutas públicas: ver la invitación y unirse. */
export async function invitationPublicRoutes(app: FastifyInstance) {
  app.get('/api/invitation', async (req: any, reply) => {
    if (rateLimited(`invite-view:${req.ip}`, 60, HOUR)) return reply.code(429).send({ error: 'Demasiados intentos, espera un momento' });
    const { inv, google } = await invitationFrom(req.query);
    const acc = await store.getAccount(inv.account_id);
    const inviter = inv.invited_by ? await store.getUserBasic(inv.invited_by) : null;
    return {
      account: acc?.name ?? '',
      email: inv.email,
      name: google?.name || inv.name,
      role: inv.role,
      invited_by: inviter?.name ?? '',
      via_google: !!google,
      // Solo en el dominio principal: Google exige registrar la dirección de regreso.
      google_login: !google && googleConfigured() && hostOf(req) === new URL(config.publicBaseUrl).hostname,
      terms_url: config.signup.termsUrl,
      privacy_url: config.signup.privacyUrl,
      terms_version: termsVersion(),
    };
  });

  app.post('/api/invitation/accept', async (req, reply) => {
    if (rateLimited(`invite-accept:${req.ip}`, 10, HOUR)) return reply.code(429).send({ error: 'Demasiados intentos desde esta conexión, intenta más tarde' });
    const b = parse(
      z.object({
        token: z.string().max(200).optional(),
        google: z.string().max(2000).optional(),
        name: z.string().trim().min(1, 'escribe tu nombre').max(120),
        password: NewPassword.optional(),
        accept_terms: z.literal(true, { message: 'Debes aceptar los términos' }),
      }),
      req.body,
    );
    const { inv, google } = await invitationFrom(b);
    if (!google && !b.password) throw new HttpError(400, 'Elige una contraseña de al menos 12 caracteres');
    if (!google) {
      const account = await queryOne<{ name: string }>(`SELECT name FROM accounts WHERE id = $1`, [inv.account_id]);
      await assertPasswordAllowed(b.password!, { email: inv.email, businessName: account?.name });
    }
    // Con Google no hay contraseña: puede crear una con «Olvidé mi contraseña».
    const hash = await hashPassword(google ? crypto.randomBytes(24).toString('base64url') : b.password!);
    const user = await withTransaction(async (client) => {
      // Se bloquea la invitación: dos clics simultáneos no crean dos usuarios.
      const locked = (await client.query(`SELECT id FROM account_invitations WHERE id = $1 AND ${PENDING} AND expires_at > now() FOR UPDATE`, [inv.id])).rows[0];
      if (!locked) throw new HttpError(400, 'Esta invitación ya se usó o venció.');
      if ((await client.query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [inv.email])).rows.length) throw new HttpError(409, 'Ese correo ya tiene cuenta: inicia sesión.');
      if (!(await client.query(`SELECT active FROM accounts WHERE id = $1`, [inv.account_id])).rows[0]?.active) throw new HttpError(400, 'Esta cuenta ya no está disponible.');
      // El plan pudo bajar desde que se invitó.
      await assertWithinLimit(inv.account_id, 'users');
      const created = await store.createUser({ account_id: inv.account_id, role: inv.role, name: b.name, email: inv.email, password_hash: hash, verified: true }, client);
      await client.query(`UPDATE account_invitations SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1`, [inv.id, created.id]);
      await recordTermsAcceptance(client, { userId: created.id, accountId: inv.account_id, email: inv.email, ip: req.ip, userAgent: String(req.headers['user-agent'] ?? ''), source: 'invite' });
      return created;
    });
    // El primer administrador de una cuenta sin dueño queda como dueño (ya con su usuario guardado).
    if (inv.role === 'admin') await ensureOwner(inv.account_id, user.id);
    await logEvent({ level: 'info', source: 'admin', message: `${inv.email} se unió al equipo (${ROLE_LABEL[inv.role]})${google ? ' con Google' : ''}`, accountId: inv.account_id, details: { ip: req.ip } });
    // Antes de entrar al panel configura su verificación en dos pasos.
    return { ok: true, user, ...(await beginLogin(reply, { ...user, password_hash: hash }, 'invite')) };
  });
}
