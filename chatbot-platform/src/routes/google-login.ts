/** Iniciar sesión o registrarse con Google (OpenID Connect). Solo funciona en el dominio principal. */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { brandByDomain, hostOf } from '../brands.js';
import { hashPassword, rateLimited, setSessionCookie } from '../auth.js';
import { config } from '../config.js';
import { withTransaction } from '../db.js';
import { googleConfigured, tokenRequest } from '../integrations/google.js';
import { notifySuperadmins } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import { hmac, safeEqual } from '../secret.js';
import * as store from '../store/index.js';
import { newAccountState } from './signup.js';
import { z } from 'zod';
import { HttpError } from '../access.js';
import { BUSINESS_TYPES } from '../templates/business.js';
import { DISPOSABLE_MESSAGE, googleSignupPass, isDisposableEmail, readGoogleSignupPass, recordTermsAcceptance, termsVersion } from '../signup-guard.js';
import { parse } from './util.js';

const HOUR = 3600_000;
const redirectUri = () => `${config.publicBaseUrl}/oauth/google/login/callback`;
const AUTH_URL = () => process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';

/** El "state" va firmado, caduca en 10 minutos y lleva un valor aleatorio que también se guarda en una cookie (evita CSRF). */
const sign = (nonce: string, exp: number) => `${nonce}.${exp}.${hmac(`glogin:${nonce}.${exp}`)}`;
function readState(state: string, nonce: string, now = Date.now()) {
  const [n, exp, sig] = state.split('.');
  return !!n && !!sig && safeEqual(n, nonce) && Number(exp) > now && safeEqual(sig, hmac(`glogin:${n}.${exp}`));
}

export async function googleLoginRoutes(app: FastifyInstance) {
  app.get('/oauth/google/login', async (req, reply) => {
    if (!googleConfigured()) return reply.redirect('/#/login?google=off');
    if (rateLimited(`glogin:${req.ip}`, 30, HOUR)) return reply.redirect('/#/login?google=demasiados');
    const nonce = crypto.randomBytes(16).toString('hex');
    reply.setCookie('g_nonce', nonce, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/oauth/google', maxAge: 600 });
    const p = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: 'openid email profile',
      state: sign(nonce, Date.now() + 10 * 60_000),
      prompt: 'select_account',
    });
    return reply.redirect(`${AUTH_URL()}?${p}`);
  });

  app.get('/oauth/google/login/callback', async (req: any, reply) => {
    const fail = (code: string) => reply.redirect(`/#/login?google=${code}`);
    const nonce = String(req.cookies?.g_nonce ?? '');
    reply.clearCookie('g_nonce', { path: '/oauth/google' });
    if (!nonce || !readState(String(req.query.state ?? ''), nonce)) return fail('error');
    if (req.query.error || !req.query.code) return fail('cancelado');
    try {
      const t = await tokenRequest({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirectUri() });
      // El id_token llega directo del servidor de Google por TLS (no por el navegador), así que sus datos son confiables.
      const claims = JSON.parse(Buffer.from((t.id_token ?? '').split('.')[1] ?? '', 'base64url').toString());
      const email = String(claims.email ?? '').toLowerCase();
      if (!email || claims.email_verified !== true) return fail('sin-correo');

      const user = await store.getUserForLogin(email);
      if (user) {
        if (!user.active || (user.account_id && !user.account_active)) return fail('desactivada');
        // El superadministrador solo entra con su contraseña.
        if (user.role === 'superadmin') return fail('solo-contrasena');
        let hash = user.password_hash;
        if (!user.email_verified_at) {
          // Alguien pudo registrar este correo con una contraseña que solo él conoce (sin demostrar que es suyo):
          // al probar con Google que el correo es de quien entra, esa contraseña se invalida.
          hash = await hashPassword(crypto.randomBytes(24).toString('base64url'));
          await store.updateUser(user.id, { password_hash: hash });
          await store.markEmailVerified(user.id);
        }
        setSessionCookie(reply, user.id, hash);
        await logEvent({ level: 'info', source: 'admin', message: `Acceso con Google: ${email}`, accountId: user.account_id, details: { ip: req.ip } });
        return reply.redirect('/#/');
      }
      if (!config.signup.enabled) return fail('sin-cuenta');
      if (isDisposableEmail(email)) return fail('correo-temporal');
      // Primera vez: la cuenta se crea hasta que acepte los términos (con un pase firmado que lleva el correo verificado).
      const name = String(claims.name ?? email.split('@')[0]).slice(0, 120);
      return reply.redirect(`/#/registro-google?token=${encodeURIComponent(googleSignupPass(email, name))}`);
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'admin', message: `Acceso con Google: ${e?.message ?? e}`, details: { ip: req.ip } });
      return fail('error');
    }
  });

  const pass = (token: unknown) => {
    const p = readGoogleSignupPass(String(token ?? ''));
    if (!p) throw new HttpError(400, 'El enlace de registro con Google venció. Vuelve a entrar con Google.');
    return p;
  };

  /** Datos para terminar el registro con Google: el correo verificado, el nombre y los términos. */
  app.get('/api/signup/google', async (req: any) => {
    if (!config.signup.enabled) throw new HttpError(404, 'El registro está cerrado');
    const p = pass(req.query.token);
    return {
      email: p.email,
      name: p.name,
      terms_url: config.signup.termsUrl,
      privacy_url: config.signup.privacyUrl,
      terms_version: termsVersion(),
      business_types: BUSINESS_TYPES.map(({ key, label }) => ({ key, label })),
    };
  });

  /** Crea la cuenta de quien entró por primera vez con Google, ya con los términos aceptados. */
  app.post('/api/signup/google', async (req, reply) => {
    if (!config.signup.enabled) throw new HttpError(404, 'El registro está cerrado');
    if (rateLimited(`signup:${req.ip}`, 5, HOUR)) return reply.code(429).send({ error: 'Demasiados registros desde esta conexión, intenta más tarde' });
    const b = parse(
      z.object({
        token: z.string().max(2000),
        company: z.string().trim().min(2, 'escribe el nombre de tu empresa').max(120),
        business_type: z.string().max(40).default('otro'),
        accept_terms: z.literal(true, { message: 'Debes aceptar los términos' }),
      }),
      req.body,
    );
    const { email, name } = pass(b.token);
    if (isDisposableEmail(email)) throw new HttpError(400, DISPOSABLE_MESSAGE);
    if (await store.getUserForLogin(email)) throw new HttpError(409, 'Ya existe una cuenta con ese correo. Inicia sesión con Google.');
    const businessType = BUSINESS_TYPES.some((t) => t.key === b.business_type) ? b.business_type : 'otro';
    const hash = await hashPassword(crypto.randomBytes(24).toString('base64url')); // sin contraseña: puede crear una con "Olvidé mi contraseña"
    const brand = await brandByDomain(hostOf(req));
    const { account, created } = await withTransaction(async (client) => {
      const account = await store.createAccount(b.company, { ...newAccountState(), businessType, source: 'signup' }, client);
      const created = await store.createUser({ account_id: account.id, role: 'admin', name: name || email.split('@')[0], email, password_hash: hash, verified: true }, client);
      await client.query(`UPDATE accounts SET owner_user_id = $2, brand_id = $3 WHERE id = $1`, [account.id, created.id, brand?.id ?? null]);
      await recordTermsAcceptance(client, { userId: created.id, accountId: account.id, email, ip: req.ip, userAgent: String(req.headers['user-agent'] ?? ''), source: 'google' });
      return { account, created };
    });
    await logEvent({ level: 'info', source: 'admin', message: `Registro nuevo con Google: ${account.name} (${email})`, accountId: account.id, details: { ip: req.ip, business_type: businessType } });
    await notifySuperadmins(account.id, `Nueva empresa registrada: ${account.name}`, `${created.name} <${email}> se registró con Google.`);
    setSessionCookie(reply, created.id, hash);
    return { ok: true, user: created, account: await store.getAccount(account.id) };
  });
}
