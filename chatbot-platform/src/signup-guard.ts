/**
 * Protecciones del registro: correos desechables, captcha (Cloudflare Turnstile, opcional), constancia de aceptación de
 * términos y el pase firmado con el que quien entra por primera vez con Google termina su registro.
 */
import type { PoolClient } from 'pg';
import { HttpError } from './access.js';
import { config } from './config.js';
import { logEvent } from './logs.js';
import { runtimeEnv } from './config-check.js';
import { countHit } from './identity/rate-limit.js';
import { notifyPlatform } from './platform/digest.js';

const HOUR = 3600_000;
import { hmac, safeEqual } from './secret.js';

/** Servicios de correo temporal más comunes. Se bloquea el dominio y sus subdominios. */
const DISPOSABLE = new Set(`
0-mail.com 10minutemail.com 10minutemail.net 10minutemail.co.uk 10minemail.com 20minutemail.com 33mail.com
anonbox.net anonymbox.com binkmail.com bobmail.info burnermail.io chacuo.net cool.fr.nf correo.blogos.net
crazymailing.com deadaddress.com despam.it discard.email discardmail.com discardmail.de dispostable.com
dropmail.me e4ward.com easytrashmail.com emailondeck.com emailtemporanea.com emailtemporanea.net emailtemporal.org
emltmp.com fakeinbox.com fakemail.net fakemailgenerator.com getairmail.com getnada.com guerrillamail.biz
guerrillamail.com guerrillamail.de guerrillamail.info guerrillamail.net guerrillamail.org guerrillamailblock.com
harakirimail.com hidemail.de incognitomail.com inboxbear.com inboxkitten.com jetable.org kasmail.com
mail-temp.com mail.tm mail7.io mailcatch.com maildrop.cc mailexpire.com mailforspam.com mailinator.com
mailinator.net mailinator2.com mailnesia.com mailnull.com mailpoof.com mailsac.com mailtemp.net mintemail.com
moakt.com mohmal.com mvrht.net mytemp.email mytrashmail.com nada.email no-spam.ws nomail.xl.cx nowmymail.com
oneoffemail.com owlymail.com pokemail.net privy-mail.com proxymail.eu rcpt.at rmqkr.net sharklasers.com
shieldemail.com smashmail.de sneakemail.com sogetthis.com spam4.me spambog.com spambox.us spamex.com
spamfree24.org spamgourmet.com spamherelots.com spamhole.com spaml.com spammotel.com spamobox.com spamspot.com
spamthis.co.uk superrito.com tempail.com tempinbox.com tempmail.com tempmail.de tempmail.io tempmail.net
tempmail.plus tempmailo.com tempmailaddress.com temp-mail.io temp-mail.org temporarymail.com temporaryemail.net
tempr.email tempsky.com throwam.com throwawaymail.com tmail.ws tmailinator.com tmpmail.net tmpmail.org
trash-mail.com trash2009.com trashmail.at trashmail.com trashmail.de trashmail.io trashmail.me trashmail.net
trashmailer.com trbvm.com wegwerfmail.de wegwerfmail.net wegwerfmail.org yepmail.net yopmail.com yopmail.fr
yopmail.net zetmail.com zoemail.org
`.split(/\s+/).filter(Boolean));

/** El correo es de un servicio desechable (o de un dominio bloqueado con SIGNUP_BLOCKED_DOMAINS). */
export function isDisposableEmail(email: string): boolean {
  const domain = email.split('@').pop()?.trim().toLowerCase() ?? '';
  if (!domain) return false;
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const d = parts.slice(i).join('.');
    if (DISPOSABLE.has(d) || config.signup.blockedDomains.includes(d)) return true;
  }
  return false;
}
export const DISPOSABLE_MESSAGE = 'Usa un correo permanente de tu negocio: no aceptamos correos temporales.';

/* ------------------------------ Captcha (Turnstile) ------------------------------ */

const turnstile = () => config.signup.turnstile;
export const captchaEnabled = () => !!(turnstile().siteKey && turnstile().secretKey);
/** En producción el registro público siempre pide captcha; fuera de ella, solo si están las dos claves. */
export const captchaRequired = () => runtimeEnv() === 'production' || captchaEnabled();
/** El registro se puede usar: en producción sin las claves de Turnstile queda cerrado. */
export const signupAvailable = () => config.signup.enabled && (captchaEnabled() || runtimeEnv() !== 'production');

export const SIGNUP_UNAVAILABLE = 'El registro no está disponible por ahora';
export const CAPTCHA_UNAVAILABLE = 'No pudimos comprobar el captcha: intenta en un momento';

/** Valida el captcha: `ok` (o no se pide), `invalid` (sin token o rechazado) o `unavailable` (Cloudflare no respondió). */
export async function verifyCaptcha(token: string | undefined, ip: string): Promise<'ok' | 'invalid' | 'unavailable'> {
  if (!captchaEnabled()) return 'ok';
  if (!token) return 'invalid';
  try {
    const res = await fetch(turnstile().verifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: turnstile().secretKey, response: token, remoteip: ip }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return data.success === true ? 'ok' : 'invalid';
  } catch (e: any) {
    await logEvent({ level: 'warn', source: 'system', message: `Captcha sin respuesta de Cloudflare: ${e?.message ?? e}`, details: { ip } });
    return 'unavailable';
  }
}

/**
 * El captcha del registro, cerrado ante fallas: sin claves en producción no se abre el registro, un token inválido es
 * 400 y si Cloudflare no responde el registro espera (503), con un solo aviso por hora al superadministrador.
 */
export async function assertCaptcha(token: string | undefined, ip: string): Promise<void> {
  if (!captchaEnabled()) {
    if (captchaRequired()) throw new HttpError(503, SIGNUP_UNAVAILABLE);
    return;
  }
  const result = await verifyCaptcha(token, ip);
  if (result === 'invalid') throw new HttpError(400, CAPTCHA_MESSAGE);
  if (result === 'unavailable') {
    if ((await countHit('captcha-down-alert', HOUR)) === 1) {
      await notifyPlatform('El captcha del registro no responde', 'Cloudflare Turnstile no respondió: los registros nuevos esperan hasta que vuelva («intenta en un momento»).', { urgent: true });
    }
    throw new HttpError(503, CAPTCHA_UNAVAILABLE);
  }
}
export const CAPTCHA_MESSAGE = 'Confirma que no eres un robot e intenta de nuevo.';

/* ------------------------------ Términos ------------------------------ */

/** Versión de los términos vigente: TERMS_VERSION o, sin ella, la dirección de los términos. */
export const termsVersion = () => config.signup.termsVersion || config.signup.termsUrl;

/** Guarda la constancia de aceptación de términos (dentro de la transacción que crea la cuenta). */
export async function recordTermsAcceptance(client: PoolClient, o: { userId: string; accountId: string; email: string; ip: string; userAgent: string; source: 'signup' | 'google' | 'reaccept' | 'invite' }) {
  await client.query(
    `INSERT INTO terms_acceptances (user_id, account_id, email, terms_version, terms_url, privacy_url, ip, user_agent, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [o.userId, o.accountId, o.email, termsVersion(), config.signup.termsUrl, config.signup.privacyUrl, o.ip, o.userAgent.slice(0, 300), o.source],
  );
}

/* ------------------------------ Registro con Google ------------------------------ */

const GOOGLE_PASS_MS = 15 * 60_000;
/** Cookie del navegador que entró con Google: el pase solo sirve con ella (no se puede usar desde otro navegador). */
export const GOOGLE_PASS_COOKIE = 'cp_gpass';
export const googlePassCookie = { httpOnly: true, sameSite: 'strict' as const, secure: config.secureCookies, path: '/api', maxAge: GOOGLE_PASS_MS / 1000 };
export type GooglePass = { email: string; name: string; sub: string };

/**
 * Pase firmado (15 minutos) con lo que Google ya verificó (correo, nombre y su identificador `sub`), para terminar el
 * registro o aceptar una invitación. Lleva el número que va en la cookie cp_gpass de ese navegador.
 */
export function googleSignupPass(who: GooglePass, nonce: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ email: who.email, name: who.name, sub: who.sub, n: nonce, exp: now + GOOGLE_PASS_MS })).toString('base64url');
  return `${payload}.${hmac(`gsignup:${payload}`)}`;
}

/**
 * Datos del pase si es auténtico y vigente; null si no. Si es auténtico pero el navegador no trae su cookie (lo abrieron
 * en otro), 401.
 */
export function readGoogleSignupPass(token: string, req: { cookies?: Record<string, string | undefined> }, now = Date.now()): GooglePass | null {
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig || !safeEqual(sig, hmac(`gsignup:${payload}`))) return null;
  let d: any;
  try {
    d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof d.email !== 'string' || !d.email || typeof d.sub !== 'string' || !d.sub || typeof d.n !== 'string' || typeof d.exp !== 'number' || d.exp <= now) return null;
  const cookie = String(req.cookies?.[GOOGLE_PASS_COOKIE] ?? '');
  if (!cookie || !safeEqual(cookie, d.n)) throw new HttpError(401, 'Abre este paso en el mismo navegador donde entraste con Google.');
  return { email: d.email, name: String(d.name ?? ''), sub: d.sub };
}
