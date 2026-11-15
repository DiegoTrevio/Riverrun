/**
 * Cuánto guarda el navegador cada archivo del panel (public/).
 *
 * - Fuentes: nunca cambian bajo el mismo nombre (una versión nueva trae otro nombre), así que se guardan un año sin
 *   volver a preguntar.
 * - Imágenes de la ayuda: una semana; si cambian, a lo más una semana con la anterior.
 * - Lo demás (HTML, JS y CSS): se queda como viene (`max-age=0` con ETag). Los módulos se importan entre sí sin versión
 *   en el nombre, así que guardarlos sin preguntar mezclaría archivos de dos versiones tras una actualización; con ETag
 *   el navegador pregunta y recibe «sin cambios» (304) sin descargarlos.
 */
import path from 'node:path';
import type { FastifyStaticOptions } from '@fastify/static';

const YEAR_S = 365 * 24 * 60 * 60;
const WEEK_S = 7 * 24 * 60 * 60;

/** `relative` es la ruta dentro de public/ (fonts/x.woff2, img/ayuda/x.webp). */
export function staticCacheControl(relative: string): string | null {
  // Con `preCompressed` llega la ruta de la copia comprimida (img/a.svg.br): cuenta la del archivo original.
  const p = relative.split(path.sep).join('/').replace(/^\/+/, '').replace(/\.(br|gz)$/, '');
  if (/^fonts\/[^/]+\.woff2$/.test(p)) return `public, max-age=${YEAR_S}, immutable`;
  if (/^img\/.+\.(avif|webp|jpe?g|png|svg)$/.test(p)) return `public, max-age=${WEEK_S}`;
  return null;
}

/**
 * Opciones con que se sirve public/. `preCompressed`: en la imagen cada archivo de texto trae su copia .br/.gz
 * (scripts/minify-public.mjs) y se entrega esa según lo que acepte el navegador; en desarrollo no existen y se sirve el
 * original.
 */
export function staticOptions(root: string): FastifyStaticOptions {
  return {
    root,
    prefix: '/',
    preCompressed: true,
    setHeaders: (reply, filePath) => {
      const value = staticCacheControl(path.relative(root, filePath));
      if (value) reply.header('cache-control', value);
    },
  };
}
