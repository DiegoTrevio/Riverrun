/**
 * Correos al equipo del negocio en el idioma de quien los recibe (el que eligió para el panel, guardado en users.lang).
 * Los correos se escriben en español y, para quien usa el panel en inglés, se traducen renglón por renglón con el mismo
 * diccionario del panel (public/i18n/en.json, con el traductor de public/js/i18n.js). Un renglón que no está en el
 * diccionario sale como está: nunca se queda un correo sin enviar por la traducción.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { queryOne } from './db.js';
import { logEvent } from './logs.js';
import type { Lang } from './locale.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, '..', 'public');

interface Translator {
  compile(dict: Record<string, string>): unknown;
  translateText(text: string, compiled: unknown): string | null;
}
let loaded: Promise<{ tr: Translator; dict: unknown } | null> | null = null;

/** El traductor y el diccionario, una sola vez. Si faltan (una copia sin el panel), los correos salen en español. */
function translator() {
  loaded ??= (async () => {
    try {
      const tr = (await import(pathToFileURL(path.join(PUBLIC_DIR, 'js', 'i18n.js')).href)) as Translator;
      const dict = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'i18n', 'en.json'), 'utf8')) as Record<string, string>;
      return { tr, dict: tr.compile(dict) };
    } catch (e) {
      // No se guarda la falla: el siguiente correo vuelve a intentarlo (este sale en español).
      loaded = null;
      await logEvent({ level: 'warn', source: 'system', message: `No se pudo cargar el diccionario de inglés para los correos: ${(e as Error)?.message ?? e}` }).catch(() => undefined);
      return null;
    }
  })();
  return loaded;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SPANISH_DATE = new RegExp(`\\b(\\d{1,2}) de (${MESES.join('|')}) de (\\d{4})\\b`, 'g');

/** «17 de noviembre de 2026» (como escriben las fechas los avisos) → «November 17, 2026». */
export const englishDates = (text: string) => text.replace(SPANISH_DATE, (_m, d: string, m: string, y: string) => `${MONTHS[MESES.indexOf(m)]} ${Number(d)}, ${y}`);

/**
 * El texto en inglés: completo si el diccionario lo tiene así (un aviso del panel con su lista), si no renglón por renglón
 * (los renglones vacíos y lo que no está en el diccionario se quedan igual).
 */
export async function toEnglish(text: string): Promise<string> {
  const t = await translator();
  if (!t) return text;
  const whole = text.trim() ? t.tr.translateText(text.trim(), t.dict) : null;
  if (whole !== null) return englishDates(whole);
  return englishDates(text.split('\n').map((line) => {
    const core = line.trim();
    if (!core) return line;
    const done = t.tr.translateText(core, t.dict);
    return done === null ? line : line.replace(core, () => done);
  }).join('\n'));
}

/** El idioma de una persona del equipo por su correo; quien no es usuario (un cliente, un correo externo) recibe español. */
export async function recipientLang(email: string): Promise<Lang> {
  try {
    const row = await queryOne<{ lang: string }>(`SELECT lang FROM users WHERE lower(email) = lower($1)`, [email]);
    return row?.lang === 'en' ? 'en' : 'es';
  } catch {
    return 'es';
  }
}
