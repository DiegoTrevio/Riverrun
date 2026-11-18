/**
 * Lo que el dueño de una cuenta resuelve solo, sin escribirle a nadie:
 * - páginas públicas: estado del servicio (/estado), contacto (/contacto), aviso de privacidad con derechos ARCO
 *   (/privacidad, en legal-pages.ts) y la confirmación del borrado de la cuenta (/borrar-cuenta, desde el enlace del correo);
 * - en el panel: descargar todos sus datos (ZIP) y pedir o cancelar el borrado de su cuenta.
 * Las páginas son HTML del servidor, sin JavaScript (salvo el captcha opcional del contacto), con la marca del dominio.
 */
import { actor, recordSecurity } from '../security-log.js';
import { ipLimitKey, limited } from '../identity/rate-limit.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireRole, targetAccount } from '../access.js';
import { buildAccountExport, cancelDeletion, readDeletionToken, deletionLinkOpen, consumeDeletionLink, requestDeletion, scheduleDeletion } from '../accounts/self-service.js';
import { accountOwner, ownerStepUp } from '../identity/ownership.js';
import { brandByDomain, hostOf, publicBrand } from '../brands.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { logEvent } from '../logs.js';
import { sendMail } from '../mailer.js';
import { cachedChecks } from '../monitor.js';
import { toComponents } from '../observability/health.js';
import { STATE_LABEL, overallState } from '../observability/status.js';
import { CAPTCHA_MESSAGE, captchaEnabled, captchaRequired, privacyUrl, verifyCaptcha } from '../signup-guard.js';
import { registerLegalPages } from './legal-pages.js';
import * as store from '../store/index.js';
import { publicPalette } from '../public-colors.js';
import { esc, parse } from './util.js';
import { visitorLang, type Lang } from '../locale.js';

const HEX = /^#[0-9a-f]{3,8}$/i;
const fmt = (d: Date, lang: Lang = 'es') => d.toLocaleDateString(lang === 'en' ? 'en-US' : 'es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });
/** El texto en el idioma de quien visita (estas páginas las ve el negocio: su panel o su navegador). */
const tx = (lang: Lang, es: string, en: string) => (lang === 'en' ? en : es);
/** Nombres en inglés de lo que se revisa en el estado del servicio (los de español están en observability). */
const COMPONENT_EN: Record<string, string> = {
  database: 'Database', whatsapp: 'WhatsApp service (Evolution)', whatsapp_sessions: 'WhatsApp: sessions and delivery', scheduler: 'Scheduled tasks',
  ai: 'AI (OpenRouter)', models: 'AI models', backup: 'Backups', disk: 'Disk space', queue: 'Message and job queue', resources: 'Process resources',
};
const STATE_EN: Record<string, string> = { operativo: 'Operational', degradado: 'Degraded', no_disponible: 'Unavailable', no_configurado: 'Not set up', no_verificado: 'Not checked' };

/** Correo al que llegan los mensajes de contacto y las solicitudes ARCO. */
const supportInbox = () => config.signup.superadminEmail || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.signup.supportContact) ? config.signup.supportContact : '');
/** Dónde se ejercen los derechos ARCO. */
const privacyContact = () => config.signup.privacyContact || config.signup.supportContact || config.signup.superadminEmail;
/** Aviso de privacidad: el propio del operador (PRIVACY_URL) o el de la plataforma. */
export { privacyUrl };

async function brandFor(req: any) {
  const host = hostOf(req);
  const own = host && host !== new URL(config.publicBaseUrl).hostname ? await brandByDomain(host) : null;
  return { brand: publicBrand(own), support: own?.support_email || config.signup.supportContact };
}

function page(o: { title: string; brand: ReturnType<typeof publicBrand>; body: string; head?: string; noindex?: boolean; lang?: Lang }) {
  const lang: Lang = o.lang ?? 'es';
  // Colores con contraste AA en los dos temas, también con el color de una marca blanca.
  const palette = publicPalette(HEX.test(o.brand.color) ? o.brand.color : '');
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${o.noindex ? '<meta name="robots" content="noindex" />' : ''}
<title>${esc(o.title)} — ${esc(o.brand.name)}</title>
<style>
  :root { ${palette.light} --text: #101828; --muted: #475467; --border: #e4e7ec; --bg: #f2f4f7; --panel: #fff; --ok: #067647; --warn: #b54708; --bad: #b42318; }
  @media (prefers-color-scheme: dark) { :root { ${palette.dark} --text: #e4e7ec; --muted: #98a2b3; --border: #252b37; --bg: #0c111d; --panel: #161b26; --ok: #47cd89; --warn: #fdb022; --bad: #f97066; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.6 Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); background: var(--bg); }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 24px; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; margin-bottom: 24px; }
  .brand img { height: 32px; width: auto; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  h2 { font-size: 20px; margin: 28px 0 8px; }
  .muted { color: var(--muted); }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 18px; margin: 16px 0; }
  ul.status { list-style: none; padding: 0; margin: 0; }
  ul.status li { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
  ul.status li:last-child { border-bottom: 0; }
  .state-operativo { color: var(--ok); font-weight: 600; }
  .state-degradado { color: var(--warn); font-weight: 600; }
  .state-no_disponible { color: var(--bad); font-weight: 600; }
  .state-no_verificado { color: var(--muted); }
  label { display: block; font-weight: 600; margin: 14px 0 4px; }
  input, textarea { width: 100%; font: inherit; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--text); }
  textarea { min-height: 140px; }
  button, .btn { display: inline-block; background: var(--accent); color: var(--accent-ink); border: 0; padding: 11px 18px; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; margin-top: 16px; }
  button.danger { background: var(--bad-solid); color: #fff; }
  :focus-visible { outline: 3px solid var(--link); outline-offset: 2px; }
  .hp { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
  .error { color: var(--bad); font-weight: 600; }
  footer { max-width: 760px; margin: 16px auto 0; padding: 0 16px 48px; color: var(--muted); font-size: 14px; display: flex; gap: 16px; flex-wrap: wrap; }
  main a { color: var(--link); }
  footer a { color: inherit; }
  input[aria-invalid="true"], textarea[aria-invalid="true"] { border-color: var(--bad); }
  .field-error { display: block; color: var(--bad); font-weight: 600; margin-top: 4px; }
</style>
${o.head ?? ''}
</head>
<body>
<main>
  <div class="brand">${o.brand.logo ? `<img src="${esc(o.brand.logo)}" alt="" />` : ''}<span>${esc(o.brand.name)}</span></div>
  ${o.body}
</main>
<footer>
  <a href="/ayuda.html">${tx(lang, 'Ayuda', 'Help')}</a>
  <a href="/estado">${tx(lang, 'Estado del servicio', 'Service status')}</a>
  <a href="/contacto">${tx(lang, 'Contacto', 'Contact')}</a>
  <a href="${esc(privacyUrl())}">${tx(lang, 'Aviso de privacidad', 'Privacy notice')}</a>
  <a href="/proteccion-de-datos">${tx(lang, 'Protección de datos', 'Data protection')}</a>
  <a href="/#/login">${tx(lang, 'Entrar a mi panel', 'Log in to my dashboard')}</a>
</footer>
</body>
</html>`;
}

const html = (reply: any, code: number, body: string) => reply.code(code).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(body);

/* ------------------------------ Páginas públicas ------------------------------ */

export async function selfServicePages(root: FastifyInstance) {
  await root.register(async (app) => {
    // Los formularios de estas páginas se mandan como application/x-www-form-urlencoded. Solo en este ámbito.
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });

    /* Estado del servicio: lo que ve el cliente, sin detalles internos (ni mensajes de error, ni direcciones). */
    app.get('/estado', async (req, reply) => {
      const { brand } = await brandFor(req);
      const lang = visitorLang(req);
      const en = lang === 'en';
      const components = toComponents(await cachedChecks(60_000)).filter((c) => c.state !== 'no_configurado');
      const overall = overallState(components);
      const headline = overall === 'operativo' ? tx(lang, 'Todo funciona con normalidad', 'Everything is working normally')
        : overall === 'degradado' ? tx(lang, 'Algunas funciones van lentas o con fallas', 'Some features are slow or failing')
          : tx(lang, 'Hay un problema y ya lo estamos atendiendo', "There's a problem and we're already working on it");
      const now = esc(new Date().toLocaleString(en ? 'en-US' : 'es-MX', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Mexico_City' }));
      const body = `<h1>${tx(lang, 'Estado del servicio', 'Service status')}</h1>
  <p class="state-${overall}" role="status">${esc(headline)}</p>
  <div class="card"><ul class="status">${components.map((c) => `<li><span>${esc(en ? COMPONENT_EN[c.id] ?? c.label : c.label)}</span><span class="state-${c.state}">${esc(en ? STATE_EN[c.state] : STATE_LABEL[c.state])}</span></li>`).join('')}</ul></div>
  <p class="muted">${en
    ? `Updated ${now} (Mexico City time). If something isn't working for you and everything looks fine here, <a href="/contacto">contact us</a>.`
    : `Actualizado el ${now} (hora del centro de México). Si algo no te funciona y aquí todo aparece bien, <a href="/contacto">escríbenos</a>.`}</p>`;
      return reply.code(200).type('text/html; charset=utf-8').header('cache-control', 'public, max-age=60').header('vary', 'Host, Cookie, Accept-Language')
        .send(page({ title: tx(lang, 'Estado del servicio', 'Service status'), brand, body, lang }));
    });

    /* Contacto: el mensaje llega al correo de soporte con "responder a" la persona. */
    // Cada campo que falla lleva aria-invalid y su mensaje en aria-describedby; arriba queda el resumen.
    const FIELD_ERRORS: Record<Lang, Record<string, string>> = {
      es: { name: 'Escribe tu nombre.', email: 'Escribe un correo válido, por ejemplo tu@correo.com.', message: 'El mensaje debe tener al menos 10 caracteres.' },
      en: { name: 'Enter your name.', email: 'Enter a valid email, for example you@email.com.', message: 'The message must be at least 10 characters long.' },
    };
    const FIELD_ERROR = FIELD_ERRORS.es;
    const contactForm = (o: { brand: any; error?: string; values?: Record<string, string>; fields?: string[]; lang?: Lang }) => {
      const lang: Lang = o.lang ?? 'es';
      const v = o.values ?? {};
      const bad = new Set(o.fields ?? []);
      const attrs = (k: string) => (bad.has(k) ? ` aria-invalid="true" aria-describedby="c-${k}-error"` : '');
      const note = (k: string) => (bad.has(k) ? `<small class="field-error" id="c-${k}-error">${esc(FIELD_ERRORS[lang][k])}</small>` : '');
      const siteKey = captchaEnabled() ? config.signup.turnstile.siteKey : '';
      return page({
        title: tx(lang, 'Contacto', 'Contact'),
        brand: o.brand,
        lang,
        head: siteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : '',
        body: `<h1>${tx(lang, 'Contacto', 'Contact')}</h1>
  <p class="muted">${tx(lang, '¿Tienes una duda, un problema o una sugerencia? Escríbenos y te respondemos por correo. También revisa la <a href="/ayuda.html">ayuda</a> y el <a href="/estado">estado del servicio</a>.',
    'Have a question, a problem or a suggestion? Write to us and we\'ll reply by email. You can also check the <a href="/ayuda.html">help</a> and the <a href="/estado">service status</a>.')}</p>
  ${o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : ''}
  <form class="card" method="post" action="/contacto">
    <label for="c-name">${tx(lang, 'Tu nombre', 'Your name')}</label><input id="c-name" name="name" maxlength="120" required value="${esc(v.name)}" autocomplete="name"${attrs('name')} />${note('name')}
    <label for="c-email">${tx(lang, 'Tu correo', 'Your email')}</label><input id="c-email" name="email" type="email" maxlength="200" required value="${esc(v.email)}" autocomplete="email"${attrs('email')} />${note('email')}
    <label for="c-message">${tx(lang, 'Mensaje', 'Message')}</label><textarea id="c-message" name="message" minlength="10" maxlength="5000" required${attrs('message')}>${esc(v.message)}</textarea>${note('message')}
    <div class="hp" aria-hidden="true"><label for="c-web">${tx(lang, 'No llenes este campo', 'Leave this field empty')}</label><input id="c-web" name="web" tabindex="-1" autocomplete="off" /></div>
    ${siteKey ? `<div class="cf-turnstile" data-sitekey="${esc(siteKey)}"></div>` : ''}
    <button type="submit">${tx(lang, 'Enviar mensaje', 'Send message')}</button>
  </form>`,
      });
    };
    app.get('/contacto', async (req, reply) => html(reply, 200, contactForm({ brand: (await brandFor(req)).brand, lang: visitorLang(req) })));

    const ContactBody = z.object({
      name: z.string().trim().min(1).max(120),
      email: z.string().trim().email().max(200),
      message: z.string().trim().min(10).max(5000),
      web: z.string().optional(),
      'cf-turnstile-response': z.string().optional(),
    });
    /** Mensajes de contacto que llegan a soporte al día, de todas las conexiones juntas. */
    const CONTACT_MAX_PER_DAY = 200;
    app.post('/contacto', async (req: any, reply) => {
      const { brand } = await brandFor(req);
      const lang = visitorLang(req);
      const values = (req.body ?? {}) as Record<string, string>;
      const again = (code: number, error: string, fields?: string[]) => html(reply, code, contactForm({ brand, values, error, fields, lang }));
      if (await limited(ipLimitKey('contact', req.ip), 5, 3600_000)) return again(429, tx(lang, 'Ya recibimos varios mensajes desde tu conexión. Intenta más tarde.', 'We already got several messages from your connection. Please try again later.'));
      const b = ContactBody.safeParse(values);
      if (!b.success) {
        const fields = [...new Set(b.error.issues.map((i) => String(i.path[0])).filter((k) => k in FIELD_ERROR))];
        return again(400, fields.length === 1 ? FIELD_ERRORS[lang][fields[0]] : tx(lang, 'Revisa los campos marcados.', 'Please check the highlighted fields.'), fields);
      }
      // Campo trampa: solo un robot lo llena. Se le contesta igual para no darle pistas.
      if (!b.data.web) {
        // En producción sin las claves del captcha el formulario queda cerrado, como el registro y las reservas: sin
        // captcha, cualquiera puede llenar el buzón de soporte desde muchas conexiones.
        if (!captchaEnabled() && captchaRequired()) return again(503, tx(lang, 'El formulario no está disponible por ahora. Intenta más tarde.', 'The form is not available right now. Please try again later.'));
        // Cerrado ante fallas: si Cloudflare no responde, el mensaje espera (no sale sin comprobar).
        const captcha = await verifyCaptcha(b.data['cf-turnstile-response'], req.ip);
        if (captcha === 'invalid') return again(400, tx(lang, CAPTCHA_MESSAGE, "Confirm you're not a robot and try again."));
        if (captcha === 'unavailable') return again(503, tx(lang, 'No pudimos comprobar el captcha: intenta en un momento.', "We couldn't check the captcha: please try again in a moment."));
        // Tope del día para toda la plataforma (muchas conexiones distintas no inundan el buzón de soporte). Cuenta solo lo
        // que pasó el captcha: si no, un robot agotaba el tope y cerraba el formulario a los clientes reales.
        if (await limited('contact:global', CONTACT_MAX_PER_DAY, 86400_000)) return again(429, tx(lang, 'Hoy recibimos muchos mensajes. Intenta mañana.', 'We got a lot of messages today. Please try again tomorrow.'));
        const to = supportInbox();
        if (to) await sendMail({ to, replyTo: b.data.email, subject: `Mensaje desde /contacto de ${brand.name}`, text: `${b.data.name} <${b.data.email}> escribió desde ${brand.name} (/contacto):\n\n${b.data.message}`, lang: 'as-is' });
        await logEvent({ level: to ? 'info' : 'warn', source: 'system', message: to ? `Mensaje de contacto de ${b.data.email}` : `Mensaje de contacto de ${b.data.email} sin buzón de soporte (define SUPERADMIN_EMAIL)`, details: to ? undefined : { message: b.data.message.slice(0, 2000) } });
      }
      return html(reply, 200, page({ title: tx(lang, 'Mensaje enviado', 'Message sent'), brand, lang,
        body: tx(lang, '<h1>¡Gracias!</h1><p>Recibimos tu mensaje y te responderemos a tu correo lo antes posible.</p>', "<h1>Thank you!</h1><p>We got your message and we'll reply to your email as soon as we can.</p>") }));
    });

    /* Avisos de privacidad (integral y simplificado) y protección de datos, con el procedimiento para los derechos ARCO. */
    registerLegalPages(app, { page, brandFor, privacyContact });

    /* Confirmación del borrado desde el correo. El GET solo pregunta: los antivirus de correo abren los enlaces. */
    const invalid = (reply: any, brand: any, lang: Lang) => html(reply, 400, page({ title: tx(lang, 'Enlace no válido', 'Invalid link'), brand, noindex: true, lang,
      body: tx(lang, '<h1>Enlace no válido o vencido</h1><p>Vuelve a pedir el borrado desde tu panel (Mi plan y pagos → Tus datos): el enlace dura 24 horas.</p>',
        '<h1>Invalid or expired link</h1><p>Request the deletion again from your dashboard (My plan and payments → Your details): the link lasts 24 hours.</p>') }));
    // Un enlace que ya se usó (o que reemplazó otro, o que se invalidó al cancelar o transferir): 410.
    const used = (reply: any, brand: any, lang: Lang) => html(reply, 410, page({ title: tx(lang, 'Enlace ya usado', 'Link already used'), brand, noindex: true, lang,
      body: tx(lang, '<h1>Este enlace ya no sirve</h1><p>Ya se usó, o pediste otro después. Si quieres borrar tu cuenta, vuelve a pedirlo desde tu panel (Mi plan y pagos → Tus datos).</p>',
        '<h1>This link no longer works</h1><p>It was already used, or you requested another one later. If you want to delete your account, request it again from your dashboard (My plan and payments → Your details).</p>') }));
    app.get('/borrar-cuenta', async (req: any, reply) => {
      const { brand } = await brandFor(req);
      const lang = visitorLang(req);
      const t = readDeletionToken(req.query?.t);
      const acc = t ? await store.getAccount(t.accountId) : null;
      if (!t || !acc) return invalid(reply, brand, lang);
      if (!(await deletionLinkOpen(t))) return used(reply, brand, lang);
      const name = esc(acc.name);
      if (acc.deletion_scheduled_for) {
        const when = esc(fmt(new Date(acc.deletion_scheduled_for), lang));
        return html(reply, 200, page({ title: tx(lang, 'Borrado programado', 'Deletion scheduled'), brand, noindex: true, lang,
          body: tx(lang, `<h1>Tu cuenta ya se va a borrar</h1><p>"${name}" se borrará el ${when}. Para cancelarlo entra a tu panel.</p><a class="btn" href="/#/plan">Ir a mi panel</a>`,
            `<h1>Your account is already set to be deleted</h1><p>"${name}" will be deleted on ${when}. To cancel, log in to your dashboard.</p><a class="btn" href="/#/plan">Go to my dashboard</a>`) }));
      }
      const action = `/borrar-cuenta?t=${encodeURIComponent(String(req.query.t))}`;
      return html(reply, 200, page({
        title: tx(lang, 'Borrar mi cuenta', 'Delete my account'), brand, noindex: true, lang,
        body: tx(lang, `<h1>¿Borrar "${name}"?</h1>
  <p>Tu plan dejará de renovarse y en 7 días se borrarán tu agente, sus conexiones, tus contactos y tus conversaciones. Hasta entonces puedes cancelarlo desde tu panel.</p>
  <p class="muted">Si todavía no los descargas, guarda antes tus datos en Mi plan y pagos → Tus datos.</p>
  <form method="post" action="${action}"><button class="danger" type="submit">Sí, borrar mi cuenta en 7 días</button></form>`,
          `<h1>Delete "${name}"?</h1>
  <p>Your plan will stop renewing, and in 7 days your assistant, its connections, your contacts and your conversations will be deleted. Until then you can cancel from your dashboard.</p>
  <p class="muted">If you haven't downloaded it yet, save your data first in My plan and payments → Your details.</p>
  <form method="post" action="${action}"><button class="danger" type="submit">Yes, delete my account in 7 days</button></form>`),
      }));
    });
    app.post('/borrar-cuenta', async (req: any, reply) => {
      const { brand } = await brandFor(req);
      const lang = visitorLang(req);
      const t = readDeletionToken(req.query?.t);
      if (!t) return invalid(reply, brand, lang);
      if (!(await consumeDeletionLink(t))) return used(reply, brand, lang);
      // Si programar falla, el enlace vuelve a servir (se consumió antes para que dos clics no lo usen dos veces).
      const when = await scheduleDeletion(t.accountId).catch(async (e) => {
        await query(`UPDATE accounts SET deletion_nonce = $2 WHERE id = $1 AND deletion_nonce IS NULL`, [t.accountId, t.nonce]);
        throw e;
      });
      if (!when) return invalid(reply, brand, lang);
      const date = esc(fmt(when, lang));
      return html(reply, 200, page({ title: tx(lang, 'Borrado programado', 'Deletion scheduled'), brand, noindex: true, lang,
        body: tx(lang, `<h1>Listo</h1><p>Tu cuenta se borrará el ${date}. Te lo confirmamos por correo. Si cambias de opinión, entra a tu panel y pulsa «Cancelar el borrado».</p><a class="btn" href="/#/plan">Ir a mi panel</a>`,
          `<h1>Done</h1><p>Your account will be deleted on ${date}. We'll confirm it by email. If you change your mind, log in to your dashboard and press "Cancel the deletion".</p><a class="btn" href="/#/plan">Go to my dashboard</a>`) }));
    });
  });
}

/* ------------------------------ En el panel ------------------------------ */

export async function accountSelfServiceRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };

  /** Todos los datos de la cuenta en un ZIP. Del dueño (o del superadmin), unas pocas veces al día. */
  api.get('/api/account/export.zip', { ...admins, ...ownerStepUp }, async (req: any, reply) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const acc = await store.getAccount(accountId);
    if (!acc) throw new HttpError(404, 'No encontrado');
    if (await limited(`account-export:${accountId}`, 5, 86400_000)) throw new HttpError(429, 'Ya descargaste tus datos varias veces hoy; intenta mañana.');
    const zip = await buildAccountExport(accountId);
    await logEvent({ level: 'info', source: 'admin', message: `Descarga de todos los datos de la cuenta por ${req.user.email}`, accountId });
    await recordSecurity({ kind: 'export.account', accountId, ...actor(req) });
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="mis-datos-${new Date().toISOString().slice(0, 10)}.zip"`)
      .header('cache-control', 'no-store')
      .send(zip);
  });

  /** Pedir el borrado: el dueño (o el superadmin), escribiendo el nombre de la cuenta. Llega un correo al dueño para confirmarlo. */
  api.post('/api/account/deletion', { ...admins, ...ownerStepUp }, async (req: any) => {
    const acc = await store.getAccount(await targetAccount(req.user, req.query.account_id));
    if (!acc) throw new HttpError(404, 'No encontrado');
    const { confirm } = parse(z.object({ confirm: z.string().max(200) }), req.body);
    if (confirm.trim().toLowerCase() !== acc.name.trim().toLowerCase()) throw new HttpError(400, `Para confirmar, escribe exactamente el nombre de tu cuenta: ${acc.name}`);
    if (acc.deletion_scheduled_for) throw new HttpError(409, 'Tu cuenta ya tiene un borrado programado.');
    if (await limited(`account-delete:${acc.id}`, 5, 3600_000)) throw new HttpError(429, 'Ya te enviamos el correo varias veces; revisa tu bandeja (y spam).');
    const owner = await accountOwner(acc.id);
    if (!owner) throw new HttpError(409, 'La cuenta no tiene dueño a quien mandar la confirmación.');
    await requestDeletion(acc, owner);
    return { ok: true, email: owner.email };
  });

  /** Cancelar el borrado: también del dueño (o del superadmin). */
  api.delete('/api/account/deletion', { ...admins, ...ownerStepUp }, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const r = await cancelDeletion(accountId);
    if (!r.canceled) throw new HttpError(409, 'Tu cuenta no tiene un borrado programado.');
    return { ok: true, resubscribe: r.resubscribe };
  });
}
