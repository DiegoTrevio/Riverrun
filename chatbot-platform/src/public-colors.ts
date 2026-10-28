/**
 * Colores de las páginas públicas del servidor con contraste suficiente (WCAG AA) en claro y oscuro, también con el
 * color de una marca blanca. Es la misma cuenta que hace el panel en public/js/brand.js.
 */

const HEX = /^#[0-9a-f]{6}$/i;

export function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

export function ratio(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Mezcla `color` con `toward` (negro o blanco) en pasos hasta que contraste `min` con todos los fondos. */
function until(color: string, toward: string, backgrounds: string[], min: number) {
  const mix = (t: number) => '#' + [1, 3, 5].map((i) => {
    const a = parseInt(color.slice(i, i + 2), 16);
    const b = parseInt(toward.slice(i, i + 2), 16);
    return Math.round(a + (b - a) * t).toString(16).padStart(2, '0');
  }).join('');
  for (let t = 0; t <= 1; t += 0.05) {
    const c = mix(t);
    if (backgrounds.every((bg) => ratio(c, bg) >= min)) return c;
  }
  return toward;
}

/** Negro o blanco, lo que más contraste con el fondo (texto de un botón). */
export const inkFor = (bg: string) => (ratio('#ffffff', bg) >= ratio('#101828', bg) ? '#ffffff' : '#101828');

export const LIGHT = { bg: '#f2f4f7', panel: '#ffffff' };
export const DARK = { bg: '#0c111d', panel: '#161b26' };

/**
 * Variables CSS para un tema: `--accent` (fondo de botones, el color de marca), `--accent-ink` (su texto), `--link`
 * (enlaces y foco: el color de marca oscurecido o aclarado hasta 4.5:1 con el fondo) y `--bad-solid` (botón de peligro
 * con texto blanco).
 */
export function publicPalette(brandColor = '') {
  const brand = HEX.test(brandColor) ? brandColor.toLowerCase() : '';
  // Un color de botón donde ni el texto blanco ni el negro llegan a 4.5:1 se oscurece hasta que el blanco llegue.
  const solid = (c: string) => (ratio(inkFor(c), c) >= 4.5 ? c : until(c, '#000000', ['#ffffff'], 4.5));
  const light = solid(brand || '#155eef');
  const dark = solid(brand || '#84adff');
  const vars = (accent: string, link: string, bad: string) => `--accent: ${accent}; --accent-ink: ${inkFor(accent)}; --link: ${link}; --bad-solid: ${bad};`;
  return {
    light: vars(light, until(light, '#000000', [LIGHT.bg, LIGHT.panel], 4.5), '#b42318'),
    dark: vars(dark, until(dark, '#ffffff', [DARK.bg, DARK.panel], 4.5), '#d92d20'),
  };
}
