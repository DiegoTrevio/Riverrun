/**
 * Baja de las campañas por correo (/email/baja), con el enlace firmado que lleva cada correo y su cabecera
 * List-Unsubscribe. El GET solo pide confirmar (los antivirus de correo abren los enlaces y no deben dar de baja a
 * nadie); el POST da de baja: es el botón de la página y también la baja de un clic de Gmail y Yahoo (RFC 8058), que
 * mandan «List-Unsubscribe=One-Click» sin abrir la página.
 */
import type { FastifyInstance } from 'fastify';
import { queryOne } from '../db.js';
import { unsubscribeContact, unsubscribeOk } from '../channels/email-campaign.js';
import { limited } from '../identity/rate-limit.js';
import { esc, page } from './nudges.js';

const TEXT = {
  es: {
    invalidTitle: 'Enlace no válido', invalid: 'Usa el enlace completo del correo que recibiste.',
    askTitle: 'Dejar de recibir correos', ask: (b: string) => `<h1>¿Dejar de recibir correos de ${b}?</h1><p>Ya no te enviaremos promociones por correo. Si escribes, te seguiremos contestando.</p>`,
    button: 'Darme de baja',
    doneTitle: 'Listo', done: (b: string) => `<h1>Listo</h1><p>Ya no recibirás correos de promociones de ${b}.</p>`,
    busy: 'Demasiados intentos. Intenta de nuevo en un minuto.',
  },
  en: {
    invalidTitle: 'Invalid link', invalid: 'Use the full link from the email you received.',
    askTitle: 'Unsubscribe', ask: (b: string) => `<h1>Stop getting emails from ${b}?</h1><p>We won't send you promotional emails anymore. If you write to us, we'll still reply.</p>`,
    button: 'Unsubscribe',
    doneTitle: 'Done', done: (b: string) => `<h1>Done</h1><p>You won't get promotional emails from ${b} anymore.</p>`,
    busy: 'Too many attempts. Please try again in a minute.',
  },
} as const;

/** Negocio e idioma del contacto, para la página. */
async function whoFor(contactId: string) {
  const row = await queryOne<{ business: string; lang: string | null }>(
    `SELECT coalesce(nullif(b.name, ''), a.name) AS business, a.settings->>'language' AS lang
       FROM contacts ct JOIN accounts a ON a.id = ct.account_id JOIN channels ch ON ch.id = ct.channel_id
       LEFT JOIN chatbots b ON b.id = ch.chatbot_id
      WHERE ct.id = $1`,
    [contactId],
  );
  return { business: row?.business ?? '', lang: (row?.lang === 'en' ? 'en' : 'es') as 'es' | 'en' };
}

export async function emailUnsubscribeRoutes(root: FastifyInstance) {
  await root.register(async (app) => {
    // La baja de un clic manda un formulario («List-Unsubscribe=One-Click»); los datos van en el enlace. (multipart ya lo
    // lee @fastify/multipart para toda la app.)
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 2048 }, (_req, _body, done) => done(null, {}));
    const read = (q: any) => ({ c: String(q?.c ?? ''), s: String(q?.s ?? '') });
    const html = (reply: any, code: number, title: string, body: string, lang: 'es' | 'en') =>
      reply.code(code).type('text/html; charset=utf-8').header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').send(page(title, body, lang));

    app.get('/email/baja', async (req: any, reply) => {
      const { c, s } = read(req.query);
      if (!unsubscribeOk(c, s)) return html(reply, 400, TEXT.es.invalidTitle, `<h1>${TEXT.es.invalidTitle}</h1><p>${TEXT.es.invalid}</p>`, 'es');
      const { business, lang } = await whoFor(c);
      const t = TEXT[lang];
      return html(reply, 200, t.askTitle, `${t.ask(esc(business))}
<form method="post" action="/email/baja?c=${encodeURIComponent(c)}&amp;s=${encodeURIComponent(s)}"><button type="submit">${t.button}</button></form>`, lang);
    });

    app.post('/email/baja', async (req: any, reply) => {
      const { c, s } = read(req.query);
      if (!unsubscribeOk(c, s)) return html(reply, 400, TEXT.es.invalidTitle, `<h1>${TEXT.es.invalidTitle}</h1><p>${TEXT.es.invalid}</p>`, 'es');
      const { business, lang } = await whoFor(c);
      const t = TEXT[lang];
      if (await limited(`email-unsubscribe:${c}`, 20, 60_000)) return html(reply, 429, t.busy, `<p>${t.busy}</p>`, lang);
      // Un contacto que ya no existe (se borró) igual recibe «Listo»: no hay a quién escribirle.
      await unsubscribeContact(c);
      return html(reply, 200, t.doneTitle, t.done(esc(business)), lang);
    });
  });
}
