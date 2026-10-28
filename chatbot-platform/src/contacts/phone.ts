/**
 * Teléfonos que llegan de otros sistemas (API, importación) en cualquier formato: «+52 1 (55) 1234-5678», «0052…»,
 * «55 1234 5678». Se guardan como dígitos con lada de país, que es como WhatsApp los identifica.
 *
 * WhatsApp guarda los celulares de México con o sin el 1 después de la lada (521… o 52…): son el mismo número, así que
 * al buscar se prueban las dos formas.
 */

/** Zonas horarias de México: ahí un número de 10 dígitos es local y le falta la lada 52. */
const MX_ZONES = new Set([
  'America/Mexico_City', 'America/Monterrey', 'America/Merida', 'America/Cancun', 'America/Chihuahua', 'America/Ciudad_Juarez',
  'America/Hermosillo', 'America/Mazatlan', 'America/Tijuana', 'America/Matamoros', 'America/Ojinaga', 'America/Bahia_Banderas',
]);

export const isMexicanZone = (tz: string) => MX_ZONES.has(tz);

/** Dígitos con lada de país, o null si no parece un teléfono. `timezone`: la de la cuenta (decide la lada de 10 dígitos). */
export function normalizePhone(raw: unknown, timezone = ''): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).trim();
  // Letras (una extensión, un correo pegado por error) no son parte de un teléfono.
  if (!s || /[a-z@]/i.test(s)) return null;
  const plus = s.startsWith('+');
  let d = s.replace(/\D/g, '');
  if (!plus && d.startsWith('00')) d = d.slice(2);
  if (!plus && isMexicanZone(timezone)) {
    // Prefijos de celular que ya no se usan (044/045) y número local de 10 dígitos.
    if (/^04[45]\d{10}$/.test(d)) d = d.slice(3);
    if (d.length === 10) d = `52${d}`;
  }
  return d.length >= 8 && d.length <= 15 ? d : null;
}

/** Las formas en que puede estar guardado el mismo número (México: con y sin el 1). */
export function phoneVariants(digits: string): string[] {
  const mx = /^52(1?)(\d{10})$/.exec(digits);
  if (!mx) return [digits];
  return mx[1] ? [digits, `52${mx[2]}`] : [digits, `521${mx[2]}`];
}
