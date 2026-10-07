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
      if (rateLimited(`signup:${req.ip}`, 5, HOUR)) return fail('demasiados');
      const name = String(claims.name ?? email.split('@')[0]).slice(0, 120);
      const hash = await hashPassword(crypto.randomBytes(24).toString('base64url')); // sin contraseña: puede crear una con "Olvidé mi contraseña"
      const brand = await brandByDomain(hostOf(req));
      const { account, created } = await withTransaction(async (client) => {
        const account = await store.createAccount(`Negocio de ${name}`.slice(0, 120), { status: 'trial', trialEndsAt: new Date(Date.now() + config.signup.trialDays * 24 * HOUR), businessType: 'otro', source: 'signup' }, client);
        const created = await store.createUser({ account_id: account.id, role: 'admin', name, email, password_hash: hash, verified: true }, client);
        await client.query(`UPDATE accounts SET owner_user_id = $2, brand_id = $3 WHERE id = $1`, [account.id, created.id, brand?.id ?? null]);
        return { account, created };
      });
      await logEvent({ level: 'info', source: 'admin', message: `Registro nuevo con Google: ${account.name} (${email})`, accountId: account.id, details: { ip: req.ip } });
      await notifySuperadmins(account.id, `Nueva empresa registrada: ${account.name}`, `${name} <${email}> se registró con Google.`);
      setSessionCookie(reply, created.id, hash);
      return reply.redirect('/#/');
    } catch (e: any) {
      await logEvent({ level: 'error', source: 'admin', message: `Acceso con Google: ${e?.message ?? e}`, details: { ip: req.ip } });
      return fail('error');
    }
  });
}
