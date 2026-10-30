import { googleConfigured } from '../integrations/google.js';
import { baseFor, brandByDomain, hostOf, linkBase, mailBrand } from '../brands.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword, ipKey, rateLimited } from '../auth.js';
import { beginLogin } from '../identity/mfa.js';
import { forgetTrustedDevices } from '../identity/devices.js';
import { clearHits, countHit, releaseHit } from '../identity/rate-limit.js';
import { notifyPlatform } from '../platform/digest.js';
import { query } from '../db.js';
import { notifyUser } from '../identity/notices.js';
import { billingEnabled, payable } from '../billing/service.js';
import { cardRequired } from '../billing/card-check.js';
import { config } from '../config.js';
import { withTransaction } from '../db.js';
import { notifySuperadmins } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import { sendMail } from '../mailer.js';
import * as store from '../store/index.js';
import { BUSINESS_TYPES } from '../templates/business.js';
import type { User } from '../types.js';
import { HttpError } from '../access.js';
import { assertPasswordAllowed, NewPassword } from '../identity/passwords.js';
import { parse } from './util.js';
import { offeredPlans } from './billing.js';
import { DISPOSABLE_MESSAGE, assertCaptcha, captchaEnabled, isDisposableEmail, recordTermsAcceptance, signupAvailable, termsVersion } from '../signup-guard.js';

const Password = NewPassword;
const Email = z.string().trim().toLowerCase().email('correo inválido').max(200);
const HOUR = 3600_000;

const link = (base: string, route: string, token: string) => `${base}/#/${route}?token=${encodeURIComponent(token)}`;

/**
 * Estado de una cuenta nueva del registro. Con cobro en línea espera la tarjeta: en pausa (motivo `card`), sin días de
 * prueba hasta que el proveedor confirme una tarjeta. Sin cobro, la prueba empieza ya (o, con TRIAL_DAYS=0, en pausa).
 */
export async function newAccountState(now = Date.now()): Promise<{ status: 'trial' | 'paused'; trialEndsAt: Date | null; pauseReason?: 'card'; pausedAt?: Date }> {
  if (await cardRequired()) return { status: 'paused', pauseReason: 'card', pausedAt: new Date(now), trialEndsAt: null };
  const days = config.signup.trialDays;
  return days > 0 ? { status: 'trial', trialEndsAt: new Date(now + days * 24 * HOUR) } : { status: 'paused', trialEndsAt: null };
}

const DAY = 24 * HOUR;
const TOO_MANY = 'Demasiados registros desde esta conexión, intenta más tarde';

/** Intentos de registro por conexión (formulario y Google): 5 por hora, todos, también los que no crean cuenta. */
export async function assertSignupAttempt(ip: string): Promise<void> {
  if ((await countHit(`signup-try:${ipKey(ip)}`, HOUR)) > 5) throw new HttpError(429, TOO_MANY);
}

/**
 * Lugar para una cuenta nueva: 3 por hora y 10 por día por conexión, y SIGNUP_DAILY_MAX por día en toda la plataforma
 * (al 80 %, un aviso al superadministrador). Devuelve con qué soltarlo si la cuenta al final no se crea.
 */
export async function reserveSignup(ip: string): Promise<() => Promise<void>> {
  const keys: [string, number, number][] = [[`signup-ip-h:${ipKey(ip)}`, HOUR, 3], [`signup-ip-d:${ipKey(ip)}`, DAY, 10], ['signup-day', DAY, config.signup.dailyMax]];
  const taken: string[] = [];
  const release = async () => { for (const k of taken) await releaseHit(k); };
  for (const [key, windowMs, max] of keys) {
    const hits = await countHit(key, windowMs);
    taken.push(key);
    if (hits > max) {
      await release();
      throw new HttpError(429, key === 'signup-day' ? 'Intenta más tarde' : TOO_MANY);
    }
    if (key === 'signup-day' && hits === Math.ceil(max * 0.8)) {
      await notifyPlatform('Muchos registros hoy', `Van ${hits} cuentas nuevas hoy de ${max} permitidas (SIGNUP_DAILY_MAX). Al llegar al tope, el registro responde «Intenta más tarde» hasta mañana.`, { urgent: true });
    }
  }
  return release;
}

/** El enlace para restablecer la contraseña (en segundo plano: ver /api/forgot-password). */
async function sendResetLink(email: string) {
  if ((await countHit(`forgot-email:${email.toLowerCase()}`, HOUR)) > 3) return;
  const u = await store.getUserForLogin(email);
  if (!u || !u.active || (u.account_id && !u.account_active)) return;
  const token = await store.createAuthToken(u.id, 'reset_password', 60);
  const mb = await mailBrand(u.account_id);
  await sendMail({
    fromName: mb.fromName,
    to: u.email,
    subject: 'Restablece tu contraseña',
    text: `Hola ${u.name || ''},\n\nPara elegir una contraseña nueva abre este enlace (vence en 1 hora):\n\n${link(linkBase(), 'restablecer', token)}\n\nSi no lo pediste, ignora este mensaje: tu contraseña no cambia.`,
  });
}

export async function sendVerification(user: Pick<User, 'id' | 'name' | 'email'>) {
  const token = await store.createAuthToken(user.id, 'verify_email', 48 * 60);
  const mb = await mailBrand((user as { account_id?: string | null }).account_id);
  await sendMail({
    fromName: mb.fromName,
    to: user.email,
    subject: 'Confirma tu correo',
    text: `Hola ${user.name || ''},\n\nConfirma tu correo para poder conectar tu WhatsApp y tus demás canales:\n\n${link(linkBase(), 'verificar', token)}\n\nEl enlace vence en 48 horas. Si no creaste esta cuenta, ignora este mensaje.`,
  });
}

/** Rutas públicas: registro de empresas, verificación de correo y recuperación de contraseña. */
export async function signupRoutes(app: FastifyInstance) {
  app.get('/api/signup/info', async (req) => ({
    enabled: config.signup.enabled,
    // En producción sin las claves de Turnstile el registro público queda cerrado.
    signup_available: signupAvailable(),
    // Solo en el dominio principal: Google exige registrar la dirección de regreso.
    google_login: googleConfigured() && hostOf(req) === new URL(config.publicBaseUrl).hostname,
    trial_days: Math.max(0, config.signup.trialDays),
    // La prueba pide tarjeta (con cobro en línea): el registro lo dice antes de crear la cuenta.
    card_required: await cardRequired(),
    support_contact: config.signup.supportContact,
    terms_url: config.signup.termsUrl,
    privacy_url: config.signup.privacyUrl,
    terms_version: termsVersion(),
    // Clave pública del captcha (vacía si no está activo).
    turnstile_site_key: captchaEnabled() ? config.signup.turnstile.siteKey : '',
    business_types: BUSINESS_TYPES.map(({ key, label }) => ({ key, label })),
    // Planes que se pueden pagar al registrarse (vacío si el cobro en línea no está configurado).
    plans: config.signup.enabled && (await billingEnabled()) ? (await offeredPlans()).filter((p) => p.providers.length) : [],
  }));

  app.post('/api/signup', async (req, reply) => {
    if (!config.signup.enabled) throw new HttpError(404, 'El registro está cerrado');
    await assertSignupAttempt(req.ip);
    const b = parse(
      z.object({
        name: z.string().trim().min(1, 'escribe tu nombre').max(120),
        company: z.string().trim().min(2, 'escribe el nombre de tu empresa').max(120),
        business_type: z.string().max(40).default('otro'),
        email: Email,
        password: Password,
        phone: z.string().max(30).default(''),
        accept_terms: z.literal(true, { message: 'Debes aceptar los términos' }),
        website: z.string().max(200).default(''), // campo trampa: los humanos no lo ven
        // Plan que quiere pagar ya (opcional): al crear la cuenta se abre la página de pago.
        plan: z.string().max(40).default(''),
        provider: z.enum(['stripe', 'mercadopago']).optional(),
        turnstile_token: z.string().max(4000).optional(),
      }),
      req.body,
    );
    if (b.website) throw new HttpError(400, 'No se pudo completar el registro');
    if (isDisposableEmail(b.email)) throw new HttpError(400, DISPOSABLE_MESSAGE);
    await assertCaptcha(b.turnstile_token, req.ip);
    if (await store.getUserForLogin(b.email)) throw new HttpError(409, 'Ya existe una cuenta con ese correo. Inicia sesión o recupera tu contraseña.');
    await assertPasswordAllowed(b.password, { email: b.email, businessName: b.company });
    // El plan se revisa antes de crear la cuenta: un plan o forma de pago que no existe no deja una cuenta a medias.
    const purchase = b.plan ? await payable(b.plan, b.provider) : null;
    const businessType = BUSINESS_TYPES.some((t) => t.key === b.business_type) ? b.business_type : 'otro';
    const verified = !config.signup.requireEmail;
    const passwordHash = await hashPassword(b.password);
    const state = await newAccountState();
    const { trialEndsAt } = state;

    const brand = await brandByDomain(hostOf(req)); // quien se registra desde el dominio de una marca queda con esa marca
    const release = await reserveSignup(req.ip);
    const { account, user } = await withTransaction(async (client) => {
      const account = await store.createAccount(b.company, { ...state, businessType, source: 'signup', signupPlan: purchase?.plan.key }, client);
      const user = await store.createUser({ account_id: account.id, role: 'admin', name: b.name, email: b.email, password_hash: passwordHash, verified }, client);
      await client.query(`UPDATE accounts SET owner_user_id = $2, brand_id = $3 WHERE id = $1`, [account.id, user.id, brand?.id ?? null]);
      // Su WhatsApp recibe los avisos de "un cliente quiere hablar con una persona".
      if (b.phone) await client.query(`UPDATE users SET phone = $2, notify_whatsapp = true WHERE id = $1`, [user.id, b.phone.replace(/\D/g, '')]);
      await recordTermsAcceptance(client, { userId: user.id, accountId: account.id, email: user.email, ip: req.ip, userAgent: String(req.headers['user-agent'] ?? ''), source: 'signup' });
      return { account, user };
    }).catch(async (e) => {
      await release(); // no se creó: no cuenta para los topes de cuentas
      throw e;
    });

    await logEvent({ level: 'info', source: 'admin', message: `Registro nuevo: ${account.name} (${user.email})`, accountId: account.id, details: { ip: req.ip, business_type: businessType, plan: purchase?.plan.key } });
    if (!verified) await sendVerification(user);
    await notifySuperadmins(
      account.id,
      `Nueva empresa registrada: ${account.name}`,
      `${user.name} <${user.email}> registró "${account.name}" (${BUSINESS_TYPES.find((t) => t.key === businessType)?.label}). ${state.pauseReason === 'card' ? 'Esperando tarjeta.' : trialEndsAt ? `Prueba hasta ${trialEndsAt.toISOString().slice(0, 10)}.` : 'Sin prueba: se activa al pagar.'}${purchase ? ` Eligió el plan ${purchase.plan.name}.` : ''}`,
    );
    // Antes de ver el panel configura su verificación en dos pasos (la sesión se abre al terminar).
    const begin = await beginLogin(reply, { ...user, password_hash: passwordHash }, 'signup');
    // El plan elegido queda recordado (signup_plan): el pago se abre desde Mi plan, con el correo verificado y el 2FA.
    return { ok: true, user, account: store.publicAccount((await store.getAccount(account.id))!), verification_sent: !verified, ...begin };
  });

  app.post('/api/verify-email', async (req, reply) => {
    if (rateLimited(`verify:${req.ip}`, 20, HOUR)) return reply.code(429).send({ error: 'Demasiados intentos, intenta más tarde' });
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
    const userId = await store.consumeAuthToken(token, 'verify_email');
    if (!userId) throw new HttpError(400, 'El enlace no es válido o ya venció. Pide uno nuevo desde tu panel.');
    await store.markEmailVerified(userId);
    return { ok: true };
  });

  /**
   * Siempre responde lo mismo y al momento, exista o no el correo: buscarlo, crear el enlace y mandarlo va en segundo
   * plano (ni la respuesta ni lo que tarda delatan qué correos están registrados). Topes en la base: 5 pedidos por hora
   * desde una conexión y 3 por hora al mismo correo (exista o no; los de más no mandan nada).
   */
  app.post('/api/forgot-password', async (req, reply) => {
    if ((await countHit(`forgot-ip:${ipKey(req.ip)}`, HOUR)) > 5) return reply.code(429).send({ error: 'Demasiados intentos, intenta más tarde' });
    const { email } = parse(z.object({ email: Email }), req.body);
    setImmediate(() => {
      sendResetLink(email).catch((e) => logEvent({ level: 'error', source: 'admin', message: `No se pudo mandar el enlace para restablecer la contraseña: ${e?.message ?? e}` }).catch(() => undefined));
    });
    return { ok: true };
  });

  app.post('/api/reset-password', async (req, reply) => {
    if (rateLimited(`reset:${req.ip}`, 10, HOUR)) return reply.code(429).send({ error: 'Demasiados intentos, intenta más tarde' });
    const b = parse(z.object({ token: z.string().min(10).max(200), password: Password }), req.body);
    // La contraseña se revisa antes de gastar el enlace: si no sirve, puede elegir otra con el mismo.
    const owner = await store.peekAuthToken(b.token, 'reset_password');
    if (owner) await assertPasswordAllowed(b.password, { email: owner.email, businessName: owner.account_name ?? undefined });
    // Recuperar el acceso por correo levanta el tope de intentos de esa cuenta.
    if (owner) await clearHits(`login-acct:${owner.email.toLowerCase()}`);
    const userId = await store.consumeAuthToken(b.token, 'reset_password');
    if (!userId) throw new HttpError(400, 'El enlace no es válido o ya venció. Pide uno nuevo.');
    // La contraseña nueva invalida todas las sesiones abiertas y los demás enlaces. Abrir el enlace también confirma
    // el correo, y quita el bloqueo del 2FA por intentos (quien lo abre probó que el correo es suyo).
    await store.updateUser(userId, { password_hash: await hashPassword(b.password) });
    await store.revokeUserSessions(userId);
    await store.invalidateAuthTokens(userId);
    await forgetTrustedDevices(userId);
    await store.markEmailVerified(userId);
    await query(`UPDATE users SET mfa_locked_until = NULL WHERE id = $1`, [userId]);
    await clearHits(`mfa-user:${userId}`);
    await logEvent({ level: 'info', source: 'admin', message: 'Contraseña restablecida por correo', details: { user_id: userId } });
    // No abre sesión: después entra con su contraseña nueva y su código.
    const user = await store.getUser(userId);
    if (user) void notifyUser(user, 'password_reset');
    return { ok: true };
  });
}
