/**
 * Encabezados de seguridad de todas las respuestas (sin pisar los que ya puso una ruta):
 * - nosniff y Referrer-Policy en todo;
 * - en las páginas: CSP y que no se puedan meter en un iframe de otro sitio (clickjacking), salvo reservar y la ayuda,
 *   que los negocios sí ponen en su sitio;
 * - la CSP estricta (solo código y estilos de la propia plataforma, más Turnstile) es la de por omisión; solo las páginas
 *   del servidor de `SERVER_PAGES` (con su <style> y <script> dentro) llevan 'unsafe-inline' (IN-20).
 * HSTS lo pone Caddy, que siempre va por HTTPS. El widget, el chat web y los medios no son páginas: los cargan los
 * sitios de los clientes y conservan su CORS.
 */
import type { FastifyInstance } from 'fastify';

const TURNSTILE = 'https://challenges.cloudflare.com';
/** Páginas que un negocio puede incrustar en su sitio con un iframe. */
const EMBEDDABLE = [/^\/reservar\//, /^\/ayuda(\.html)?(\/|$)/];
/**
 * Páginas del servidor que llevan su <style> y algún <script> dentro (IN-20): solo ellas reciben 'unsafe-inline'. Todo lo
 * demás (el panel, sus variantes de URL y cualquier página nueva) recibe la CSP estricta: el error seguro es el de por
 * omisión. Se compara contra la ruta ya decodificada y normalizada, como la ve @fastify/static.
 */
const SERVER_PAGES = [
  /^\/precios$/, /^\/estado$/, /^\/privacidad$/, /^\/contacto$/, /^\/borrar-cuenta$/, /^\/baja-recordatorios$/,
  /^\/reservar\/[^/]+$/, /^\/ayuda(\.html)?$/, /^\/api-docs\.html$/, /^\/api\/v1\/docs$/, /^\/webchat-demo\.html$/,
  /^\/wa\/[^/]+$/, /^\/conectar-red\/[^/]+$/, /^\/zernio\/(return|callback)\//, /^\/meta\/callback$/, /^\/oauth\//, /^\/pago\//,
];

/** La ruta como la sirve el servidor: decodificada, sin la consulta y sin diagonales repetidas. null si no se puede leer. */
export function servedPath(url: string): string | null {
  try {
    const path = decodeURIComponent(new URL(url.replace(/^\/{2,}/, '/'), 'http://x').pathname);
    return path.replace(/\/{2,}/g, '/');
  } catch {
    return null;
  }
}

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
    const path = servedPath(req.url);
    const embeddable = !!path && EMBEDDABLE.some((r) => r.test(path));
    if (!embeddable) reply.header('x-frame-options', 'DENY');
    const serverPage = !!path && SERVER_PAGES.some((r) => r.test(path));
    reply.header('content-security-policy', serverPage ? csp({ inline: true, frameAncestors: embeddable ? '*' : "'none'" }) : PANEL_CSP);
    return payload;
  });
}
