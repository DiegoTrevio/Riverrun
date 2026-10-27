/**
 * Encabezados de seguridad de todas las respuestas (sin pisar los que ya puso una ruta):
 * - nosniff y Referrer-Policy en todo;
 * - en las páginas: CSP y que no se puedan meter en un iframe de otro sitio (clickjacking), salvo reservar y la ayuda,
 *   que los negocios sí ponen en su sitio;
 * - el panel lleva la CSP estricta: solo código y estilos de la propia plataforma (más Turnstile, el captcha).
 * HSTS lo pone Caddy, que siempre va por HTTPS. El widget, el chat web y los medios no son páginas: los cargan los
 * sitios de los clientes y conservan su CORS.
 */
import type { FastifyInstance } from 'fastify';

const TURNSTILE = 'https://challenges.cloudflare.com';
/** Páginas que un negocio puede incrustar en su sitio con un iframe. */
const EMBEDDABLE = [/^\/reservar\//, /^\/ayuda(\.html)?(\/|$|\?)/];
const PANEL = /^\/(index\.html)?(\?|$)/;

const csp = (o: { inline: boolean; frameAncestors: string }) => [
  "default-src 'self'",
  `script-src 'self'${o.inline ? " 'unsafe-inline'" : ''} ${TURNSTILE}`,
  `style-src 'self'${o.inline ? " 'unsafe-inline'" : ''}`,
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "font-src 'self'",
  `connect-src 'self' ${TURNSTILE}`,
  `frame-src ${TURNSTILE}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  `frame-ancestors ${o.frameAncestors}`,
].join('; ');

export const PANEL_CSP = csp({ inline: false, frameAncestors: "'none'" });

export function registerSecurityHeaders(app: FastifyInstance) {
  app.addHook('onSend', async (req, reply, payload) => {
    if (!reply.hasHeader('x-content-type-options')) reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('referrer-policy')) reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    const type = String(reply.getHeader('content-type') ?? '');
    if (!type.startsWith('text/html') || reply.hasHeader('content-security-policy')) return payload;
    const url = req.url;
    const embeddable = EMBEDDABLE.some((r) => r.test(url));
    if (!embeddable) reply.header('x-frame-options', 'DENY');
    // Las páginas del servidor (precios, estado, reservar, ayuda…) llevan su <style> y algún <script> dentro.
    reply.header('content-security-policy', PANEL.test(url) ? PANEL_CSP : csp({ inline: true, frameAncestors: embeddable ? '*' : "'none'" }));
    return payload;
  });
}
