/**
 * Lo que el dueño de una cuenta resuelve solo, sin escribirle a nadie:
 * - páginas públicas: estado del servicio (/estado), contacto (/contacto), aviso de privacidad con derechos ARCO
 *   (/privacidad) y la confirmación del borrado de la cuenta (/borrar-cuenta, desde el enlace del correo);
 * - en el panel: descargar todos sus datos (ZIP) y pedir o cancelar el borrado de su cuenta.
 * Las páginas son HTML del servidor, sin JavaScript (salvo el captcha opcional del contacto), con la marca del dominio.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireRole, targetAccount } from '../access.js';
import { buildAccountExport, cancelDeletion, isOwner, ownerOf, readDeletionToken, requestDeletion, scheduleDeletion } from '../accounts/self-service.js';
import { rateLimited } from '../auth.js';
import { brandByDomain, hostOf, publicBrand } from '../brands.js';
import { config } from '../config.js';
import { logEvent } from '../logs.js';
import { sendMail } from '../mailer.js';
import { cachedChecks } from '../monitor.js';
import { toComponents } from '../observability/health.js';
import { STATE_LABEL, overallState } from '../observability/status.js';
import { CAPTCHA_MESSAGE, captchaEnabled, verifyCaptcha } from '../signup-guard.js';
import * as store from '../store/index.js';
import { publicPalette } from '../public-colors.js';
import { parse } from './util.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const HEX = /^#[0-9a-f]{3,8}$/i;
const fmt = (d: Date) => d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });

/** Correo al que llegan los mensajes de contacto y las solicitudes ARCO. */
const supportInbox = () => config.signup.superadminEmail || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.signup.supportContact) ? config.signup.supportContact : '');
/** Dónde se ejercen los derechos ARCO. */
const privacyContact = () => config.signup.privacyContact || config.signup.supportContact || config.signup.superadminEmail;
/** Aviso de privacidad: el propio del operador (PRIVACY_URL) o el de la plataforma. */
export const privacyUrl = () => config.signup.privacyUrl || '/privacidad';

async function brandFor(req: any) {
  const host = hostOf(req);
  const own = host && host !== new URL(config.publicBaseUrl).hostname ? await brandByDomain(host) : null;
  return { brand: publicBrand(own), support: own?.support_email || config.signup.supportContact };
}

function page(o: { title: string; brand: ReturnType<typeof publicBrand>; body: string; head?: string; noindex?: boolean }) {
  // Colores con contraste AA en los dos temas, también con el color de una marca blanca.
  const palette = publicPalette(HEX.test(o.brand.color) ? o.brand.color : '');
  return `<!doctype html>
<html lang="es">
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
  <a href="/ayuda.html">Ayuda</a>
  <a href="/estado">Estado del servicio</a>
  <a href="/contacto">Contacto</a>
  <a href="${esc(privacyUrl())}">Aviso de privacidad</a>
  <a href="/#/login">Entrar a mi panel</a>
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
      const components = toComponents(await cachedChecks(60_000)).filter((c) => c.state !== 'no_configurado');
      const overall = overallState(components);
      const headline = overall === 'operativo' ? 'Todo funciona con normalidad' : overall === 'degradado' ? 'Algunas funciones van lentas o con fallas' : 'Hay un problema y ya lo estamos atendiendo';
      const body = `<h1>Estado del servicio</h1>
  <p class="state-${overall}" role="status">${esc(headline)}</p>
  <div class="card"><ul class="status">${components.map((c) => `<li><span>${esc(c.label)}</span><span class="state-${c.state}">${esc(STATE_LABEL[c.state])}</span></li>`).join('')}</ul></div>
  <p class="muted">Actualizado el ${esc(new Date().toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Mexico_City' }))} (hora del centro de México). Si algo no te funciona y aquí todo aparece bien, <a href="/contacto">escríbenos</a>.</p>`;
      return reply.code(200).type('text/html; charset=utf-8').header('cache-control', 'public, max-age=60').header('vary', 'Host').send(page({ title: 'Estado del servicio', brand, body }));
    });

    /* Contacto: el mensaje llega al correo de soporte con "responder a" la persona. */
    // Cada campo que falla lleva aria-invalid y su mensaje en aria-describedby; arriba queda el resumen.
    const FIELD_ERROR: Record<string, string> = { name: 'Escribe tu nombre.', email: 'Escribe un correo válido, por ejemplo tu@correo.com.', message: 'El mensaje debe tener al menos 10 caracteres.' };
    const contactForm = (o: { brand: any; error?: string; values?: Record<string, string>; fields?: string[] }) => {
      const v = o.values ?? {};
      const bad = new Set(o.fields ?? []);
      const attrs = (k: string) => (bad.has(k) ? ` aria-invalid="true" aria-describedby="c-${k}-error"` : '');
      const note = (k: string) => (bad.has(k) ? `<small class="field-error" id="c-${k}-error">${esc(FIELD_ERROR[k])}</small>` : '');
      const siteKey = captchaEnabled() ? config.signup.turnstile.siteKey : '';
      return page({
        title: 'Contacto',
        brand: o.brand,
        head: siteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : '',
        body: `<h1>Contacto</h1>
  <p class="muted">¿Tienes una duda, un problema o una sugerencia? Escríbenos y te respondemos por correo. También revisa la <a href="/ayuda.html">ayuda</a> y el <a href="/estado">estado del servicio</a>.</p>
  ${o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : ''}
  <form class="card" method="post" action="/contacto">
    <label for="c-name">Tu nombre</label><input id="c-name" name="name" maxlength="120" required value="${esc(v.name)}" autocomplete="name"${attrs('name')} />${note('name')}
    <label for="c-email">Tu correo</label><input id="c-email" name="email" type="email" maxlength="200" required value="${esc(v.email)}" autocomplete="email"${attrs('email')} />${note('email')}
    <label for="c-message">Mensaje</label><textarea id="c-message" name="message" minlength="10" maxlength="5000" required${attrs('message')}>${esc(v.message)}</textarea>${note('message')}
    <div class="hp" aria-hidden="true"><label for="c-web">No llenes este campo</label><input id="c-web" name="web" tabindex="-1" autocomplete="off" /></div>
    ${siteKey ? `<div class="cf-turnstile" data-sitekey="${esc(siteKey)}"></div>` : ''}
    <button type="submit">Enviar mensaje</button>
  </form>`,
      });
    };
    app.get('/contacto', async (req, reply) => html(reply, 200, contactForm({ brand: (await brandFor(req)).brand })));

    const ContactBody = z.object({
      name: z.string().trim().min(1).max(120),
      email: z.string().trim().email().max(200),
      message: z.string().trim().min(10).max(5000),
      web: z.string().optional(),
      'cf-turnstile-response': z.string().optional(),
    });
    app.post('/contacto', async (req: any, reply) => {
      const { brand } = await brandFor(req);
      const values = (req.body ?? {}) as Record<string, string>;
      if (rateLimited(`contact:${req.ip}`, 5, 3600_000)) return html(reply, 429, contactForm({ brand, values, error: 'Ya recibimos varios mensajes desde tu conexión. Intenta más tarde.' }));
      const b = ContactBody.safeParse(values);
      if (!b.success) {
        const fields = [...new Set(b.error.issues.map((i) => String(i.path[0])).filter((k) => k in FIELD_ERROR))];
        return html(reply, 400, contactForm({ brand, values, fields, error: fields.length === 1 ? FIELD_ERROR[fields[0]] : 'Revisa los campos marcados.' }));
      }
      // Campo trampa: solo un robot lo llena. Se le contesta igual para no darle pistas.
      if (!b.data.web) {
        if (!(await verifyCaptcha(b.data['cf-turnstile-response'], req.ip))) return html(reply, 400, contactForm({ brand, values, error: CAPTCHA_MESSAGE }));
        const to = supportInbox();
        if (to) await sendMail({ to, replyTo: b.data.email, subject: `Contacto: ${b.data.name}`, text: `${b.data.name} <${b.data.email}> escribió desde ${brand.name} (/contacto):\n\n${b.data.message}` });
        await logEvent({ level: to ? 'info' : 'warn', source: 'system', message: to ? `Mensaje de contacto de ${b.data.email}` : `Mensaje de contacto de ${b.data.email} sin buzón de soporte (define SUPERADMIN_EMAIL)`, details: to ? undefined : { message: b.data.message.slice(0, 2000) } });
      }
      return html(reply, 200, page({ title: 'Mensaje enviado', brand, body: '<h1>¡Gracias!</h1><p>Recibimos tu mensaje y te responderemos a tu correo lo antes posible.</p>' }));
    });

    /* Aviso de privacidad de la plataforma, con el procedimiento para los derechos ARCO. */
    app.get('/privacidad', async (req, reply) => {
      const { brand } = await brandFor(req);
      const company = config.signup.privacyCompany || brand.name;
      const contact = privacyContact();
      const body = `<h1>Aviso de privacidad</h1>
  <p><strong>Responsable:</strong> ${esc(company)}${config.signup.privacyAddress ? `, con domicilio en ${esc(config.signup.privacyAddress)}` : ''}.${contact ? ` Contacto para privacidad: <strong>${esc(contact)}</strong>.` : ''}</p>
  <h2>Qué datos tratamos</h2>
  <ul>
    <li><strong>De tu cuenta:</strong> nombre, correo, teléfono para avisos, datos de tu negocio y la información que cargas (productos, precios, horarios).</li>
    <li><strong>De los clientes de tu negocio:</strong> nombre, número o identificador en el canal y el contenido de los mensajes. Respecto de ellos, tu negocio es el responsable y nosotros los tratamos por su cuenta (encargados).</li>
    <li><strong>De pago:</strong> la tarjeta la procesan Stripe o Mercado Pago; nosotros no la vemos ni la guardamos. Guardamos tus pagos, tus datos fiscales y tus facturas.</li>
    <li><strong>Técnicos:</strong> registros de actividad y de errores, y el consumo de inteligencia artificial.</li>
  </ul>
  <h2>Para qué los usamos</h2>
  <p>Para prestar el servicio (responder mensajes, agendar, avisarte), cobrar y facturar, dar soporte y mantener la seguridad. No vendemos datos personales.</p>
  <h2>Con quién los compartimos</h2>
  <p>Con los proveedores necesarios para el servicio: inteligencia artificial (recibe el texto necesario para responder), canales de mensajería, correo, pagos, facturación electrónica y alojamiento. Y con autoridades, cuando la ley lo exija.</p>
  <h2>Tus derechos (ARCO)</h2>
  <p>Puedes <strong>acceder</strong> a tus datos, <strong>rectificarlos</strong>, <strong>cancelarlos</strong> u <strong>oponerte</strong> a su uso, así como revocar tu consentimiento o limitar su uso. Hay dos formas:</p>
  <ul>
    <li><strong>Desde tu panel, al momento:</strong> en <em>Mi plan y pagos → Tus datos</em> descargas todos tus datos o borras tu cuenta; tus datos de perfil los corriges en <em>Mi perfil</em>.</li>
    <li><strong>Por escrito:</strong> manda un correo a ${contact ? `<strong>${esc(contact)}</strong>` : 'nuestro contacto de soporte'} con tu nombre, el correo de tu cuenta, el derecho que quieres ejercer y qué datos, y una copia de tu identificación (o la de tu representante, con su poder). Te respondemos en un máximo de 20 días hábiles y, si procede, lo hacemos efectivo en los 15 días hábiles siguientes.</li>
  </ul>
  <p>Si eres cliente de un negocio que usa este servicio, dirige tu solicitud a ese negocio; nosotros le ayudamos a atenderla.</p>
  <h2>Conservación</h2>
  <p>Conservamos los datos mientras tu cuenta esté activa. Una cuenta en pausa se borra sola después de un tiempo, con aviso previo, y puedes borrarla tú cuando quieras. Los pagos y las facturas se conservan el tiempo que exige la ley fiscal.</p>
  <h2>Cambios</h2>
  <p>Publicaremos aquí cualquier cambio a este aviso y, si es importante, te avisaremos por correo.</p>`;
      return reply.code(200).type('text/html; charset=utf-8').header('cache-control', 'public, max-age=300').header('vary', 'Host').send(page({ title: 'Aviso de privacidad', brand, body }));
    });

    /* Confirmación del borrado desde el correo. El GET solo pregunta: los antivirus de correo abren los enlaces. */
    const invalid = (reply: any, brand: any) => html(reply, 400, page({ title: 'Enlace no válido', brand, noindex: true, body: '<h1>Enlace no válido o vencido</h1><p>Vuelve a pedir el borrado desde tu panel (Mi plan y pagos → Tus datos): el enlace dura 24 horas.</p>' }));
    app.get('/borrar-cuenta', async (req: any, reply) => {
      const { brand } = await brandFor(req);
      const id = readDeletionToken(req.query?.t);
      const acc = id ? await store.getAccount(id) : null;
      if (!acc) return invalid(reply, brand);
      if (acc.deletion_scheduled_for) return html(reply, 200, page({ title: 'Borrado programado', brand, noindex: true, body: `<h1>Tu cuenta ya se va a borrar</h1><p>"${esc(acc.name)}" se borrará el ${esc(fmt(new Date(acc.deletion_scheduled_for)))}. Para cancelarlo entra a tu panel.</p><a class="btn" href="/#/plan">Ir a mi panel</a>` }));
      return html(reply, 200, page({
        title: 'Borrar mi cuenta', brand, noindex: true,
        body: `<h1>¿Borrar "${esc(acc.name)}"?</h1>
  <p>Tu plan dejará de renovarse y en 7 días se borrarán tu agente, sus conexiones, tus contactos y tus conversaciones. Hasta entonces puedes cancelarlo desde tu panel.</p>
  <p class="muted">Si todavía no los descargas, guarda antes tus datos en Mi plan y pagos → Tus datos.</p>
  <form method="post" action="/borrar-cuenta?t=${encodeURIComponent(String(req.query.t))}"><button class="danger" type="submit">Sí, borrar mi cuenta en 7 días</button></form>`,
      }));
    });
    app.post('/borrar-cuenta', async (req: any, reply) => {
      const { brand } = await brandFor(req);
      const id = readDeletionToken(req.query?.t);
      const when = id ? await scheduleDeletion(id) : null;
      if (!when) return invalid(reply, brand);
      return html(reply, 200, page({ title: 'Borrado programado', brand, noindex: true, body: `<h1>Listo</h1><p>Tu cuenta se borrará el ${esc(fmt(when))}. Te lo confirmamos por correo. Si cambias de opinión, entra a tu panel y pulsa «Cancelar el borrado».</p><a class="btn" href="/#/plan">Ir a mi panel</a>` }));
    });
  });
}

/* ------------------------------ En el panel ------------------------------ */

export async function accountSelfServiceRoutes(api: FastifyInstance) {
  const admins = { preHandler: requireRole('admin') };

  /** Todos los datos de la cuenta en un ZIP. Del dueño (o del superadmin), unas pocas veces al día. */
  api.get('/api/account/export.zip', admins, async (req: any, reply) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const acc = await store.getAccount(accountId);
    if (!acc) throw new HttpError(404, 'No encontrado');
    if (req.user.role !== 'superadmin' && !(await isOwner(req.user, acc))) throw new HttpError(403, 'Solo el dueño de la cuenta puede descargar todos sus datos.');
    if (rateLimited(`account-export:${accountId}`, 5, 86400_000)) throw new HttpError(429, 'Ya descargaste tus datos varias veces hoy; intenta mañana.');
    const zip = await buildAccountExport(accountId);
    await logEvent({ level: 'info', source: 'admin', message: `Descarga de todos los datos de la cuenta por ${req.user.email}`, accountId });
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="mis-datos-${new Date().toISOString().slice(0, 10)}.zip"`)
      .header('cache-control', 'no-store')
      .send(zip);
  });

  /** Pedir el borrado: solo el dueño, escribiendo el nombre de la cuenta. Llega un correo para confirmarlo. */
  api.post('/api/account/deletion', admins, async (req: any) => {
    const acc = req.user.account_id ? await store.getAccount(req.user.account_id) : null;
    if (!acc || !(await isOwner(req.user, acc))) throw new HttpError(403, 'Solo el dueño de la cuenta puede borrarla.');
    const { confirm } = parse(z.object({ confirm: z.string().max(200) }), req.body);
    if (confirm.trim().toLowerCase() !== acc.name.trim().toLowerCase()) throw new HttpError(400, `Para confirmar, escribe exactamente el nombre de tu cuenta: ${acc.name}`);
    if (acc.deletion_scheduled_for) throw new HttpError(409, 'Tu cuenta ya tiene un borrado programado.');
    if (rateLimited(`account-delete:${acc.id}`, 5, 3600_000)) throw new HttpError(429, 'Ya te enviamos el correo varias veces; revisa tu bandeja (y spam).');
    const owner = (await ownerOf(acc))!;
    await requestDeletion(acc, owner);
    return { ok: true, email: owner.email };
  });

  /** Cancelar el borrado: cualquier administrador de la cuenta (por si el dueño se equivocó o ya no está). */
  api.delete('/api/account/deletion', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const r = await cancelDeletion(accountId);
    if (!r.canceled) throw new HttpError(409, 'Tu cuenta no tiene un borrado programado.');
    return { ok: true, resubscribe: r.resubscribe };
  });
}
