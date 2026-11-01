/**
 * Registro HTTP (HTTP_LOG=true) sin tokens. Los enlaces públicos llevan el secreto en la ruta (webhook de WhatsApp,
 * calendario .ics, reservas, cotizaciones, chat web) o en la query (borrar la cuenta, OAuth), y la bitácora la leen más
 * personas que quien tiene el enlace. Se registra el método, la ruta sin query y con esos segmentos ocultos, el host y la IP.
 */

import type { FastifyServerOptions } from 'fastify';

const HIDDEN = '[oculto]';
/** Prefijos públicos cuyo resto de la ruta es un token (o lo lleva). */
const TOKEN_PREFIXES = ['/webhook/', '/calendar/', '/reservar/', '/q/', '/wa/', '/webchat/', '/conectar-red/', '/zernio/callback/', '/api/public/booking/'];
/**
 * Un segmento que parece un token: 24+ caracteres de base64url, o 16+ con algún dígito (las rutas fijas son palabras),
 * que no son un UUID (los ids se conservan para poder seguir un error).
 */
const TOKENISH = /^[A-Za-z0-9_\-.~%]{24,}$/;
const SHORT_TOKEN = /^(?=.*\d)[A-Za-z0-9_\-.~%]{16,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function safeUrl(url: string): string {
  // Sin query; con las barras repetidas juntas y sin distinguir mayúsculas para reconocer los prefijos (/Webhook/, //webhook/).
  const path = String(url ?? '').split(/[?#]/, 1)[0].replace(/\/{2,}/g, '/');
  const lower = path.toLowerCase();
  const prefix = TOKEN_PREFIXES.find((p) => lower.startsWith(p));
  if (prefix) {
    const rest = path.slice(prefix.length).split('/').filter(Boolean);
    return prefix + rest.map(() => HIDDEN).join('/');
  }
  return path.split('/').map((seg) => ((TOKENISH.test(seg) || SHORT_TOKEN.test(seg)) && !UUID.test(seg) ? HIDDEN : seg)).join('/');
}

/** Serializador de la petición para el logger de Fastify (pino): sin query, sin tokens y sin cabeceras. */
export function reqSerializer(req: { method?: string; url?: string; ip?: string; headers?: Record<string, unknown>; hostname?: string }) {
  return { method: req.method, url: safeUrl(req.url ?? ''), host: req.hostname ?? req.headers?.host, remoteAddress: req.ip };
}

/** Rutas dentro del texto de un mensaje (p. ej. «Route GET:/webhook/… not found» de Fastify), sin tokens. */
export function safeMessage(msg: string): string {
  return msg.replace(/(^|[\s:=])(\/[^\s"']*)/g, (_m, before: string, url: string) => before + safeUrl(url));
}

/** Opciones del logger de Fastify cuando HTTP_LOG=true. */
/** Un error en la bitácora: su mensaje y su pila sin tokens (Fastify y nuestras validaciones citan la ruta). */
export function errSerializer(e: any) {
  if (!e || typeof e !== 'object') return e;
  return { type: e.constructor?.name ?? 'Error', message: safeMessage(String(e.message ?? '')), stack: safeMessage(String(e.stack ?? '')), code: e.code, statusCode: e.statusCode };
}

export const httpLoggerOptions: FastifyServerOptions['logger'] & object = {
  serializers: { req: reqSerializer as any, err: errSerializer },
  hooks: {
    logMethod(args: unknown[], method: (...a: any[]) => void) {
      method.apply(this, args.map((a) => (typeof a === 'string' ? safeMessage(a) : a)));
    },
  },
};
