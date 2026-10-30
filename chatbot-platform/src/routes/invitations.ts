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
import { hostOf, linkBase, mailBrand } from '../brands.js';
import { assertWithinLimit, effectiveLimits, LIMIT_LABELS, limitDetail, offerText, usageOf } from '../billing/limits.js';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db.js';
import { googleConfigured } from '../integrations/google.js';
import { assertPasswordAllowed, NewPassword } from '../identity/passwords.js';
import { accountOwner, assertOwner, ensureOwner } from '../identity/ownership.js';
import { inviteMail } from '../identity/invite-text.js';
import { countHit, releaseHit } from '../identity/rate-limit.js';
import { assertRecentMfa } from '../identity/step-up.js';
import { logEvent } from '../logs.js';
import { deliverMail } from '../mailer.js';
import { DISPOSABLE_MESSAGE, GOOGLE_PASS_COOKIE, googlePassCookie, isDisposableEmail, readGoogleSignupPass, recordTermsAcceptance, termsVersion } from '../signup-guard.js';
import * as store from '../store/index.js';
import type { User } from '../types.js';
import { parse } from './util.js';

const HOUR = 3600_000;
const DAYS_VALID = 7;
const DAY = 24 * HOUR;
const MAX_PER_ACCOUNT = 20;
const MAX_PER_EMAIL = 3;
const MAX_PENDING = 50;
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

/** Manda la invitación (texto fijo; el enlace va al dominio principal, con el token en la ruta). Dice si salió. */
async function sendInvite(inv: Invitation, token: string, inviterName: string): Promise<boolean> {
  const acc = await store.getAccount(inv.account_id);
  const { fromName } = await mailBrand(inv.account_id);
  const link = `${linkBase()}/#/invitacion/${encodeURIComponent(token)}`;
  const mail = inviteMail({ inviter: inviterName, invitee: inv.name, account: acc?.name ?? '', role: ROLE_LABEL[inv.role], link, google: googleConfigured() });
  return (await deliverMail({ fromName, to: inv.email, ...mail })) === 'sent';
}

/** Quien invita tiene su correo verificado, y el dueño de la cuenta también (el superadministrador queda exento). */
async function assertCanInvite(actor: Pick<User, 'role' | 'email_verified_at'>, accountId: string): Promise<void> {
  if (actor.role === 'superadmin') return;
  if (!actor.email_verified_at) throw new HttpError(403, 'Verifica tu correo antes de invitar a alguien');
  if (!(await accountOwner(accountId))?.email_verified_at) throw new HttpError(403, 'El dueño de la cuenta tiene que verificar su correo antes de invitar a alguien');
}

/** Topes guardados en la base: 20 invitaciones por día por cuenta y 3 por día al mismo correo (se cuentan al mandar). */
async function countInvite(accountId: string, email: string): Promise<void> {
  const acct = `invite-acct:${accountId}`;
  if ((await countHit(acct, DAY)) > MAX_PER_ACCOUNT) throw new HttpError(429, `Llegaste al límite de ${MAX_PER_ACCOUNT} invitaciones por día`);
  if ((await countHit(`invite-email:${email.toLowerCase()}`, DAY)) > MAX_PER_EMAIL) {
    await releaseHit(acct); // esta no salió: no cuenta para la cuenta
    throw new HttpError(429, `Ya invitaste a ese correo ${MAX_PER_EMAIL} veces hoy`);
  }
}

/** Se puede invitar a ese correo: no es desechable y no tiene usuario (cada correo es de una sola cuenta). */
export async function assertInvitable(email: string): Promise<void> {
  if (isDisposableEmail(email)) throw new HttpError(400, DISPOSABLE_MESSAGE);
  if (await store.getUserForLogin(email)) throw new HttpError(409, 'Ese correo ya tiene cuenta en la plataforma: invita otro correo.');
}

/** Crea la invitación (reemplaza la pendiente al mismo correo, vencida o no), la manda y la deja en la bitácora. */
export async function createInvitation(
  actor: Pick<User, 'id' | 'role' | 'name' | 'email_verified_at'>,
  accountId: string,
  b: { email: string; name: string; role: 'admin' | 'agent' },
): Promise<{ inv: Invitation; mail_sent: boolean }> {
  await assertCanInvite(actor, accountId);
  await assertInvitable(b.email);
  // La pendiente al mismo correo se reemplaza: no cuenta para el tope de pendientes.
  const pending = (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM account_invitations WHERE account_id = $1 AND ${PENDING} AND expires_at > now() AND lower(email) <> $2`, [accountId, b.email]))!.n;
  if (pending >= MAX_PENDING) throw new HttpError(409, `Hay ${MAX_PENDING} invitaciones pendientes: cancela alguna antes de invitar a más`);
  await countInvite(accountId, b.email);
  await query(`UPDATE account_invitations SET revoked_at = now() WHERE account_id = $1 AND lower(email) = $2 AND ${PENDING}`, [accountId, b.email]);
  await assertRoomForInvite(accountId);
  const token = newToken();
  const inv = (await queryOne<Invitation>(
    `INSERT INTO account_invitations (account_id, email, name, role, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(days => $7)) RETURNING ${COLS}`,
    [accountId, b.email, b.name, b.role, tokenHash(token), actor.role === 'superadmin' ? null : actor.id, DAYS_VALID],
  ))!;
  const mail_sent = await sendInvite(inv, token, inviterName(actor));
  await logEvent({ level: 'info', source: 'admin', message: `Invitación ${mail_sent ? 'enviada' : 'guardada (el correo no salió)'} a ${b.email} (${ROLE_LABEL[b.role]})`, accountId });
  return { inv, mail_sent };
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
    const { inv, mail_sent } = await createInvitation(req.user, accountId, b);
    return { ...out(inv), mail_sent };
  });

  /** Reenvía con un enlace nuevo (el anterior deja de servir) y otros 7 días. */
  api.post('/api/invitations/:id/resend', admins, async (req: any) => {
    const inv = await mine(req);
    await assertCanInvite(req.user, inv.account_id);
    await countInvite(inv.account_id, inv.email);
    const token = newToken();
    const upd = (await queryOne<Invitation>(
      `UPDATE account_invitations SET token_hash = $2, expires_at = now() + make_interval(days => $3) WHERE id = $1 RETURNING ${COLS}`,
      [inv.id, tokenHash(token), DAYS_VALID],
    ))!;
    const mail_sent = await sendInvite(upd, token, inviterName(req.user));
    return { ...out(upd), mail_sent };
  });

  api.delete('/api/invitations/:id', admins, async (req: any) => {
    const inv = await mine(req);
    await query(`UPDATE account_invitations SET revoked_at = now() WHERE id = $1`, [inv.id]);
    await logEvent({ level: 'info', source: 'admin', message: `Invitación a ${inv.email} cancelada`, accountId: inv.account_id });
    return { ok: true };
  });
}

/** La invitación de un enlace (token) o de quien entró con Google (pase firmado con su correo). */
async function invitationFrom(q: { token?: unknown; google?: unknown }, req: { cookies?: Record<string, string | undefined> }) {
  if (q.google) {
    // El pase solo sirve en el navegador que entró con Google (401 en otro).
    const p = readGoogleSignupPass(String(q.google), req);
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
  /** Ver la invitación antes de aceptarla. El token (o el pase de Google) va en el cuerpo, no en la URL. */
  app.post('/api/invitation/peek', async (req: any, reply) => {
    if (rateLimited(`invite-view:${req.ip}`, 60, HOUR)) return reply.code(429).send({ error: 'Demasiados intentos, espera un momento' });
    const q = parse(z.object({ token: z.string().max(200).optional(), google: z.string().max(2000).optional() }), req.body ?? {});
    const { inv, google } = await invitationFrom(q, req);
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
    const { inv, google } = await invitationFrom(b, req);
    if (google && (await store.getUserForGoogle(google.sub))) throw new HttpError(409, 'Esa cuenta de Google ya entra a la plataforma: inicia sesión con Google.');
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
      if (google) await client.query(`UPDATE users SET google_sub = $2 WHERE id = $1`, [created.id, google.sub]);
      await client.query(`UPDATE account_invitations SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1`, [inv.id, created.id]);
      await recordTermsAcceptance(client, { userId: created.id, accountId: inv.account_id, email: inv.email, ip: req.ip, userAgent: String(req.headers['user-agent'] ?? ''), source: 'invite' });
      return created;
    });
    // El primer administrador de una cuenta sin dueño queda como dueño (ya con su usuario guardado).
    if (inv.role === 'admin') await ensureOwner(inv.account_id, user.id);
    await logEvent({ level: 'info', source: 'admin', message: `${inv.email} se unió al equipo (${ROLE_LABEL[inv.role]})${google ? ' con Google' : ''}`, accountId: inv.account_id, details: { ip: req.ip } });
    // Antes de entrar al panel configura su verificación en dos pasos.
    if (google) reply.clearCookie(GOOGLE_PASS_COOKIE, { path: googlePassCookie.path });
    return { ok: true, user, ...(await beginLogin(reply, { ...user, password_hash: hash }, 'invite')) };
  });
}
