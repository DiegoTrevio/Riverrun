/**
 * Baja de los correos de seguimiento del alta (/baja-recordatorios), con el enlace firmado que lleva cada correo.
 * El GET solo pide confirmar: los antivirus de correo abren los enlaces y no deben dar de baja a nadie.
 */
import type { FastifyInstance } from 'fastify';
import { stopNudges, unsubscribeOk } from '../onboarding-checklist.js';
import { logEvent } from '../logs.js';
import { publicPalette } from '../public-colors.js';

const palette = publicPalette();

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${esc(title)}</title>
<style>
  :root { ${palette.light} --text: #101828; --muted: #475467; --bg: #f2f4f7; --panel: #fff; --border: #e4e7ec; }
  @media (prefers-color-scheme: dark) { :root { ${palette.dark} --text: #e4e7ec; --muted: #98a2b3; --bg: #0c111d; --panel: #161b26; --border: #252b37; } }
  body { margin: 0; font: 16px/1.55 Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); background: var(--bg); }
  main { max-width: 520px; margin: 48px auto; padding: 24px 16px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: var(--muted); }
  button { background: var(--accent); color: var(--accent-ink); border: 0; padding: 11px 18px; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer; }
  button:focus-visible { outline: 3px solid var(--link); outline-offset: 2px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export async function nudgesRoutes(root: FastifyInstance) {
  await root.register(async (app) => {
    // El botón manda un formulario vacío: los datos van en el enlace. Solo en este ámbito.
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 }, (_req, _body, done) => done(null, {}));
    const read = (q: any) => ({ c: String(q?.c ?? ''), s: String(q?.s ?? '') });
    const invalid = (reply: any) => reply.code(400).type('text/html; charset=utf-8')
      .send(page('Enlace no válido', '<h1>Enlace no válido</h1><p>Usa el enlace completo del correo, o cambia tus avisos desde el panel.</p>'));

    app.get('/baja-recordatorios', async (req, reply) => {
      const { c, s } = read(req.query);
      if (!unsubscribeOk(c, s)) return invalid(reply);
      return reply.type('text/html; charset=utf-8').send(page('Dejar de recibir recordatorios', `<h1>¿Dejar de recibir recordatorios?</h1>
<p>No te volveremos a escribir para recordarte conectar o probar tu agente. Los avisos de pagos y de seguridad seguirán llegando.</p>
<form method="post" action="/baja-recordatorios?c=${encodeURIComponent(c)}&amp;s=${encodeURIComponent(s)}"><button type="submit">Dejar de recibirlos</button></form>`));
    });

    app.post('/baja-recordatorios', async (req, reply) => {
      const { c, s } = read(req.query);
      if (!unsubscribeOk(c, s)) return invalid(reply);
      await stopNudges(c);
      await logEvent({ level: 'info', source: 'system', message: 'Baja de los correos de seguimiento', accountId: c });
      return reply.type('text/html; charset=utf-8').send(page('Listo', '<h1>Listo</h1><p>Ya no recibirás estos recordatorios.</p>'));
    });
  });
}
