/** Iniciar sesión o registrarse con Google (OpenID Connect). Solo funciona en el dominio principal. */
import crypto from 'node:crypto';
import { pendingInviteFor } from './invitations.js';
import type { FastifyInstance } from 'fastify';
import { brandByDomain, hostOf } from '../brands.js';
import { hashPassword, rateLimited } from '../auth.js';
import { beginLogin } from '../identity/mfa.js';
import { config } from '../config.js';
import { withTransaction } from '../db.js';
import { googleConfigured, tokenRequest } from '../integrations/google.js';
import { notifySuperadmins } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import { hmac, safeEqual } from '../secret.js';
import * as store from '../store/index.js';
import { newAccountState, assertSignupAttempt, reserveSignup } from './signup.js';
import { z } from 'zod';
import { HttpError } from '../access.js';
import { BUSINESS_TYPES } from '../templates/business.js';
import { assertCaptcha, captchaEnabled, DISPOSABLE_MESSAGE, GOOGLE_PASS_COOKIE, googlePassCookie, googleSignupPass, isDisposableEmail, readGoogleSignupPass, recordTermsAcceptance, termsVersion } from '../signup-guard.js';
import { query } from '../db.js';
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
      const sub = String(claims.sub ?? '');
      const email = String(claims.email ?? '').toLowerCase();
      if (!sub) return fail('error');
      if (!email || claims.email_verified !== true) return fail('sin-correo');

      // Primero por su identificador de Google (sigue aunque cambie su correo aquí). Por correo solo se liga si los dos
      // lados lo tienen verificado; un correo sin verificar aquí no entra con Google (lo verifica con su contraseña).
      let user = await store.getUserForGoogle(sub);
      if (!user) {
        const byEmail = await store.getUserForLogin(email);
        if (byEmail) {
          if (byEmail.role === 'superadmin') return fail('solo-contrasena');
          if (byEmail.google_sub) return fail('otra-cuenta');
          if (!byEmail.email_verified_at) return fail('sin-verificar');
          await query(`UPDATE users SET google_sub = $2 WHERE id = $1 AND google_sub IS NULL`, [byEmail.id, sub]);
          user = { ...byEmail, google_sub: sub };
        }
      }
      if (user) {
        if (!user.active || (user.account_id && !user.account_active)) return fail('desactivada');
        // El superadministrador solo entra con su contraseña.
        if (user.role === 'superadmin') return fail('solo-contrasena');
        // Google es otro primer paso: falta el código de la app (o configurarla).
        const begin = await beginLogin(reply, user, 'google');
        await logEvent({ level: 'info', source: 'admin', message: `Acceso con Google: ${email}`, accountId: user.account_id, details: { ip: req.ip } });
        return reply.redirect('mfa' in begin ? `/#/login/${begin.mfa === 'verify' ? 'codigo' : 'configurar'}` : '/#/');
      }
      // El pase para el siguiente paso solo sirve en este navegador (su número va también en la cookie cp_gpass).
      const passForNext = (name: string) => {
        const nonce = crypto.randomBytes(16).toString('base64url');
        reply.setCookie(GOOGLE_PASS_COOKIE, nonce, googlePassCookie);
        return encodeURIComponent(googleSignupPass({ email, name, sub }, nonce));
      };
      // La invitaron a un equipo: se une a esa cuenta (aunque el registro público esté cerrado).
      const invite = await pendingInviteFor(email);
      if (invite) return reply.redirect(`/#/invitacion/google/${passForNext(String(claims.name ?? '').slice(0, 120))}`);
      if (!config.signup.enabled) return fail('sin-cuenta');
      if (isDisposableEmail(email)) return fail('correo-temporal');
      // Primera vez: la cuenta se crea hasta que acepte los términos (con el pase firmado que lleva el correo verificado).
      return reply.redirect(`/#/registro-google/${passForNext(String(claims.name ?? email.split('@')[0]).slice(0, 120))}`);
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'admin', message: `Acceso con Google: ${e?.message ?? e}`, details: { ip: req.ip } });
      return fail('error');
    }
  });

  const pass = (token: unknown, req: any) => {
    const p = readGoogleSignupPass(String(token ?? ''), req);
    if (!p) throw new HttpError(400, 'El enlace de registro con Google venció. Vuelve a entrar con Google.');
    return p;
  };

  /** Datos para terminar el registro con Google: el correo verificado, el nombre y los términos (el pase va en el cuerpo, no en la URL). */
  app.post('/api/signup/google/peek', async (req: any) => {
    if (!config.signup.enabled) throw new HttpError(404, 'El registro está cerrado');
    const p = pass(parse(z.object({ token: z.string().max(2000) }), req.body).token, req);
    return {
      email: p.email,
      name: p.name,
      terms_url: config.signup.termsUrl,
      privacy_url: config.signup.privacyUrl,
      terms_version: termsVersion(),
      // El captcha va también antes de crear la cuenta con Google (clave vacía si no está activo).
      turnstile_site_key: captchaEnabled() ? config.signup.turnstile.siteKey : '',
      business_types: BUSINESS_TYPES.map(({ key, label }) => ({ key, label })),
    };
  });

  /** Crea la cuenta de quien entró por primera vez con Google, ya con los términos aceptados. */
  app.post('/api/signup/google', async (req, reply) => {
    if (!config.signup.enabled) throw new HttpError(404, 'El registro está cerrado');
    await assertSignupAttempt(req.ip);
    const b = parse(
      z.object({
        token: z.string().max(2000),
        company: z.string().trim().min(2, 'escribe el nombre de tu empresa').max(120),
        business_type: z.string().max(40).default('otro'),
        accept_terms: z.literal(true, { message: 'Debes aceptar los términos' }),
        turnstile_token: z.string().max(4000).optional(),
      }),
      req.body,
    );
    // La cuenta se crea aquí: el captcha va en este paso (entrar con Google a una cuenta que ya existe no lo pide).
    await assertCaptcha(b.turnstile_token, req.ip);
    const { email, name, sub } = pass(b.token, req);
    if (isDisposableEmail(email)) throw new HttpError(400, DISPOSABLE_MESSAGE);
    if ((await store.getUserForLogin(email)) || (await store.getUserForGoogle(sub))) throw new HttpError(409, 'Ya existe una cuenta con ese correo. Inicia sesión con Google.');
    const businessType = BUSINESS_TYPES.some((t) => t.key === b.business_type) ? b.business_type : 'otro';
    const hash = await hashPassword(crypto.randomBytes(24).toString('base64url')); // sin contraseña: puede crear una con "Olvidé mi contraseña"
    const brand = await brandByDomain(hostOf(req));
    const state = await newAccountState();
    const release = await reserveSignup(req.ip);
    const { account, created } = await withTransaction(async (client) => {
      const account = await store.createAccount(b.company, { ...state, businessType, source: 'signup' }, client);
      const created = await store.createUser({ account_id: account.id, role: 'admin', name: name || email.split('@')[0], email, password_hash: hash, verified: true }, client);
      await client.query(`UPDATE users SET google_sub = $2 WHERE id = $1`, [created.id, sub]);
      await client.query(`UPDATE accounts SET owner_user_id = $2, brand_id = $3 WHERE id = $1`, [account.id, created.id, brand?.id ?? null]);
      await recordTermsAcceptance(client, { userId: created.id, accountId: account.id, email, ip: req.ip, userAgent: String(req.headers['user-agent'] ?? ''), source: 'google' });
      return { account, created };
    }).catch(async (e) => {
      await release();
      throw e;
    });
    await logEvent({ level: 'info', source: 'admin', message: `Registro nuevo con Google: ${account.name} (${email})`, accountId: account.id, details: { ip: req.ip, business_type: businessType } });
    await notifySuperadmins(account.id, `Nueva empresa registrada: ${account.name}`, `${created.name} <${email}> se registró con Google.`);
    reply.clearCookie(GOOGLE_PASS_COOKIE, { path: googlePassCookie.path });
    const begin = await beginLogin(reply, { ...created, password_hash: hash }, 'google');
    return { ok: true, user: created, account: store.publicAccount((await store.getAccount(account.id))!), ...begin };
  });
}
