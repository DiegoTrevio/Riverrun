import { brandByDomain, hostOf, mailBrand } from '../brands.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword, rateLimited, setSessionCookie } from '../auth.js';
import { config } from '../config.js';
import { withTransaction } from '../db.js';
import { notifySuperadmins } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import { sendMail } from '../mailer.js';
import * as store from '../store/index.js';
import { BUSINESS_TYPES } from '../templates/business.js';
import type { User } from '../types.js';
import { HttpError } from '../access.js';
import { parse } from './util.js';

const Password = z.string().min(8, 'mínimo 8 caracteres').max(200);
const Email = z.string().trim().toLowerCase().email('correo inválido').max(200);
const HOUR = 3600_000;

const link = (base: string, route: string, token: string) => `${base}/#/${route}?token=${encodeURIComponent(token)}`;

export async function sendVerification(user: Pick<User, 'id' | 'name' | 'email'>) {
  const token = await store.createAuthToken(user.id, 'verify_email', 48 * 60);
  const mb = await mailBrand((user as { account_id?: string | null }).account_id);
  await sendMail({
    fromName: mb.fromName,
    to: user.email,
    subject: 'Confirma tu correo',
    text: `Hola ${user.name || ''},\n\nConfirma tu correo para poder conectar tu WhatsApp y tus demás canales:\n\n${link(mb.base, 'verificar', token)}\n\nEl enlace vence en 48 horas. Si no creaste esta cuenta, ignora este mensaje.`,
  });
}

/** Rutas públicas: registro de empresas, verificación de correo y recuperación de contraseña. */
export async function signupRoutes(app: FastifyInstance) {
  app.get('/api/signup/info', async () => ({
    enabled: config.signup.enabled,
    trial_days: config.signup.trialDays,
    support_contact: config.signup.supportContact,
    terms_url: config.signup.termsUrl,
    privacy_url: config.signup.privacyUrl,
    business_types: BUSINESS_TYPES.map(({ key, label }) => ({ key, label })),
  }));

  app.post('/api/signup', async (req, reply) => {
    if (!config.signup.enabled) throw new HttpError(404, 'El registro está cerrado');
    if (rateLimited(`signup:${req.ip}`, 5, HOUR)) return reply.code(429).send({ error: 'Demasiados registros desde esta conexión, intenta más tarde' });
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
      }),
      req.body,
    );
    if (b.website) throw new HttpError(400, 'No se pudo completar el registro');
    if (await store.getUserForLogin(b.email)) throw new HttpError(409, 'Ya existe una cuenta con ese correo. Inicia sesión o recupera tu contraseña.');
    const businessType = BUSINESS_TYPES.some((t) => t.key === b.business_type) ? b.business_type : 'otro';
    const verified = !config.signup.requireEmail;
    const passwordHash = await hashPassword(b.password);
    const trialEndsAt = new Date(Date.now() + config.signup.trialDays * 24 * HOUR);

    const brand = await brandByDomain(hostOf(req)); // quien se registra desde el dominio de una marca queda con esa marca
    const { account, user } = await withTransaction(async (client) => {
      const account = await store.createAccount(b.company, { status: 'trial', trialEndsAt, businessType, source: 'signup' }, client);
      const user = await store.createUser({ account_id: account.id, role: 'admin', name: b.name, email: b.email, password_hash: passwordHash, verified }, client);
      await client.query(`UPDATE accounts SET owner_user_id = $2, brand_id = $3 WHERE id = $1`, [account.id, user.id, brand?.id ?? null]);
      // Su WhatsApp recibe los avisos de "un cliente quiere hablar con una persona".
      if (b.phone) await client.query(`UPDATE users SET phone = $2, notify_whatsapp = true WHERE id = $1`, [user.id, b.phone.replace(/\D/g, '')]);
      return { account, user };
    });

    await logEvent({ level: 'info', source: 'admin', message: `Registro nuevo: ${account.name} (${user.email})`, accountId: account.id, details: { ip: req.ip, business_type: businessType } });
    if (!verified) await sendVerification(user);
    await notifySuperadmins(
      account.id,
      `Nueva empresa registrada: ${account.name}`,
      `${user.name} <${user.email}> registró "${account.name}" (${BUSINESS_TYPES.find((t) => t.key === businessType)?.label}). Prueba hasta ${trialEndsAt.toISOString().slice(0, 10)}.`,
    );
    setSessionCookie(reply, user.id, passwordHash);
    return { ok: true, user, account: await store.getAccount(account.id), verification_sent: !verified };
  });

  app.post('/api/verify-email', async (req, reply) => {
    if (rateLimited(`verify:${req.ip}`, 20, HOUR)) return reply.code(429).send({ error: 'Demasiados intentos, intenta más tarde' });
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
    const userId = await store.consumeAuthToken(token, 'verify_email');
    if (!userId) throw new HttpError(400, 'El enlace no es válido o ya venció. Pide uno nuevo desde tu panel.');
    await store.markEmailVerified(userId);
    return { ok: true };
  });

  /** Siempre responde lo mismo para no revelar qué correos están registrados. */
  app.post('/api/forgot-password', async (req, reply) => {
    if (rateLimited(`forgot:${req.ip}`, 5, HOUR)) return reply.code(429).send({ error: 'Demasiados intentos, intenta más tarde' });
    const { email } = parse(z.object({ email: Email }), req.body);
    const u = await store.getUserForLogin(email);
    if (u && u.active && (!u.account_id || u.account_active) && !rateLimited(`forgot-user:${u.id}`, 3, HOUR)) {
      const token = await store.createAuthToken(u.id, 'reset_password', 60);
      const mb = await mailBrand(u.account_id);
      await sendMail({
        fromName: mb.fromName,
        to: u.email,
        subject: 'Restablece tu contraseña',
        text: `Hola ${u.name || ''},\n\nPara elegir una contraseña nueva abre este enlace (vence en 1 hora):\n\n${link(mb.base, 'restablecer', token)}\n\nSi no lo pediste, ignora este mensaje: tu contraseña no cambia.`,
      });
    }
    return { ok: true };
  });

  app.post('/api/reset-password', async (req, reply) => {
    if (rateLimited(`reset:${req.ip}`, 10, HOUR)) return reply.code(429).send({ error: 'Demasiados intentos, intenta más tarde' });
    const b = parse(z.object({ token: z.string().min(10).max(200), password: Password }), req.body);
    const userId = await store.consumeAuthToken(b.token, 'reset_password');
    if (!userId) throw new HttpError(400, 'El enlace no es válido o ya venció. Pide uno nuevo.');
    // La contraseña nueva invalida todas las sesiones abiertas. Abrir el enlace también confirma el correo.
    await store.updateUser(userId, { password_hash: await hashPassword(b.password) });
    await store.markEmailVerified(userId);
    await logEvent({ level: 'info', source: 'admin', message: 'Contraseña restablecida por correo', details: { user_id: userId } });
    return { ok: true };
  });
}
