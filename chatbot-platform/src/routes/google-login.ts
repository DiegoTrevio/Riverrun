/** Iniciar sesión o registrarse con Google (OpenID Connect). Solo funciona en el dominio principal. */
import { clearHits, ipLimitKey, limited } from '../identity/rate-limit.js';
import crypto from 'node:crypto';
import { pendingInviteFor } from './invitations.js';
import type { FastifyInstance } from 'fastify';
import { brandByDomain, hostOf } from '../brands.js';
import { hashPassword } from '../auth.js';
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
import { parse } from './util.js';
import { recordSecurity, recordSecurityOnce } from '../security-log.js';

const HOUR = 3600_000;
const redirectUri = () => `${config.publicBaseUrl}/oauth/google/login/callback`;
/** Emisores válidos del id_token de Google. */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
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
    if (await limited(ipLimitKey('glogin', req.ip), 30, HOUR)) return reply.redirect('/#/login?google=demasiados');
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
    // Bitácora de seguridad: por qué no entró (y quién, si ya se sabe).
    // `reason` queda en la bitácora; `shown` es lo que ve la pantalla de entrada (por omisión, el mismo código).
    const rejected = async (reason: string, who?: { id?: string; email?: string; account_id?: string | null } | null, shown = reason) => {
      const e = { kind: 'login.google_rejected' as const, userId: who?.id ?? null, accountId: who?.account_id ?? null, email: who?.email, ip: req.ip, userAgent: String(req.headers['user-agent'] ?? ''), details: { reason } };
      // Sin cuenta detrás (un enlace de regreso inventado), una fila por IP cada 15 minutos: no se llena la bitácora.
      if (who) await recordSecurity(e);
      else await recordSecurityOnce(ipLimitKey(`google:${reason}`, req.ip), 15, e);
      return fail(shown);
    };
    const nonce = String(req.cookies?.g_nonce ?? '');
    reply.clearCookie('g_nonce', { path: '/oauth/google' });
    if (!nonce || !readState(String(req.query.state ?? ''), nonce)) return rejected('estado', null, 'error');
    if (req.query.error || !req.query.code) return fail('cancelado');
    try {
      const t = await tokenRequest({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirectUri() });
      // El id_token llega directo del servidor de Google por TLS (no por el navegador), así que sus datos son confiables.
      const claims = JSON.parse(Buffer.from((t.id_token ?? '').split('.')[1] ?? '', 'base64url').toString());
      // Emitido por Google para esta aplicación (bajos de la 2c): otro emisor u otro cliente no entran.
      if (!GOOGLE_ISSUERS.includes(String(claims.iss ?? '')) || claims.aud !== process.env.GOOGLE_CLIENT_ID) {
        await logEvent({ level: 'warn', source: 'system', message: `Inicio de sesión con Google rechazado: el id_token no es de Google para esta aplicación (iss ${String(claims.iss ?? '—').slice(0, 80)})` });
        return rejected('token-ajeno', null, 'error');
      }
      const sub = String(claims.sub ?? '');
      const email = String(claims.email ?? '').toLowerCase();
      if (!sub) return fail('error');
      if (!email || claims.email_verified !== true) return fail('sin-correo');

      // Primero por su identificador de Google (sigue aunque cambie su correo aquí); si no, por correo (Google ya lo
      // verificó), aunque aquí no esté confirmado: no pide confirmar el correo para entrar.
      let user = await store.getUserForGoogle(sub);
      if (!user) {
        const byEmail = await store.getUserForLogin(email);
        if (byEmail) {
          if (byEmail.role === 'superadmin') return rejected('solo-contrasena', byEmail);
          if (byEmail.google_sub) return rejected('otra-cuenta', byEmail);
          // Correo sin confirmar aquí: quien puso esa contraseña no probó que el correo fuera suyo (pudo registrarse
          // con el correo de otra persona antes que ella). Google sí lo probó, así que la cuenta queda de quien entra.
          const linked = await linkByEmail(byEmail.id, sub, !byEmail.email_verified_at);
          if (linked === 'otra-cuenta') return rejected('otra-cuenta', byEmail);
          if (linked === 'reclamada') await logEvent({ level: 'warn', source: 'admin', message: `Acceso con Google a una cuenta con el correo sin confirmar (${email}): la contraseña anterior dejó de servir y se cerraron sus sesiones`, accountId: byEmail.account_id, details: { ip: req.ip } });
          // Recargada: con la contraseña vigente (la sesión va ligada a ella) y sin el segundo paso de antes.
          const fresh = await store.getUserForGoogle(sub);
          if (!fresh) return fail('error');
          user = fresh;
        }
      }
      if (user) {
        if (!user.active || (user.account_id && !user.account_active)) return rejected('desactivada', user);
        // El superadministrador solo entra con su contraseña.
        if (user.role === 'superadmin') return rejected('solo-contrasena', user);
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

/**
 * Liga la cuenta de Google por correo, todo o nada: si algo falla no queda ligada a medias (y la próxima vez no se
 * salta el reclamo). Con el correo sin confirmar aquí, la cuenta pasa a quien entró con Google: contraseña nueva al
 * azar (la anterior ya no entra; si era suya, la recupera con «Olvidé mi contraseña»), correo verificado, sin la
 * verificación en dos pasos ni los dispositivos recordados de antes, sesiones cerradas, enlaces pendientes (cambio de
 * correo, restablecer) anulados, y las llaves de la API y webhooks que esa persona creó, apagados.
 */
async function linkByEmail(userId: string, sub: string, unverified: boolean): Promise<'ligada' | 'reclamada' | 'otra-cuenta'> {
  const randomHash = unverified ? await hashPassword(crypto.randomBytes(24).toString('base64url')) : null;
  const result = await withTransaction(async (c) => {
    const row = (await c.query(`SELECT google_sub, email_verified_at FROM users WHERE id = $1 FOR UPDATE`, [userId])).rows[0];
    if (!row || row.google_sub) return 'otra-cuenta' as const;
    await c.query(`UPDATE users SET google_sub = $2, updated_at = now() WHERE id = $1`, [userId, sub]);
    if (row.email_verified_at || !randomHash) return 'ligada' as const;
    await c.query(
      `UPDATE users SET password_hash = $2, email_verified_at = now(), totp_secret = NULL, totp_pending = NULL, totp_pending_at = NULL,
              totp_enabled_at = NULL, totp_last_step = 0, mfa_locked_until = NULL, updated_at = now() WHERE id = $1`,
      [userId, randomHash],
    );
    await c.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [userId]);
    await c.query(`UPDATE user_devices SET trust_hash = NULL, trusted_until = NULL WHERE user_id = $1 AND trust_hash IS NOT NULL`, [userId]);
    await c.query(`UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    await store.invalidateAuthTokens(userId, c);
    await c.query(`UPDATE api_keys SET revoked_at = now() WHERE created_by = $1 AND revoked_at IS NULL`, [userId]);
    await c.query(`UPDATE webhook_endpoints SET active = false, disabled_reason = 'Se apagó al confirmar el correo de la cuenta con Google' WHERE created_by = $1 AND active`, [userId]);
    return 'reclamada' as const;
  });
  if (result === 'reclamada') await clearHits(`mfa-user:${userId}`);
  return result;
}
