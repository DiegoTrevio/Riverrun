// Fundaciones de Astryx en el panel: astryx.css define los tokens que usan las hojas del panel, se carga antes que
// styles.css, sus letras existen y los pares de color principales cumplen el contraste (texto 4.5:1, bordes de campo 3:1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const pub = path.resolve(import.meta.dirname, '..', 'public');
const read = (f: string) => fs.readFileSync(path.join(pub, f), 'utf8');
const astryx = read('astryx.css');
// Los de Astryx (los propios de Riverrun, --radius-sheet/card/control, viven en styles.css).
const ASTRYX_PREFIX = /^--(color|spacing|radius-(?!sheet|card|control)|size-element|font|duration|ease|focus-outline|shadow)-?/;

test('index.html carga astryx.css antes que styles.css', () => {
  const html = read('index.html');
  const a = html.indexOf('href="/astryx.css"');
  const s = html.indexOf('href="/styles.css"');
  assert.ok(a > 0 && s > a, 'astryx.css va primero para que styles.css lo use');
});

test('cada token de Astryx que usa el panel está definido en astryx.css', () => {
  const defined = new Set([...astryx.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const missing: string[] = [];
  for (const f of ['styles.css', 'stats.css', 'flowboard.css', 'copilot.css']) {
    for (const m of read(f).matchAll(/var\((--[a-z0-9-]+)/g)) if (ASTRYX_PREFIX.test(m[1]) && !defined.has(m[1])) missing.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('las letras que declara astryx.css existen, con su licencia', () => {
  for (const m of astryx.matchAll(/url\(\/fonts\/([^)]+)\)/g)) assert.ok(fs.existsSync(path.join(pub, 'fonts', m[1])), m[1]);
  assert.ok(fs.existsSync(path.join(pub, 'fonts', 'Figtree-OFL.txt')));
});

// Contraste WCAG con los valores del tema Neutral (claro y oscuro) y el acento de Riverrun.
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (hex: string) => {
  const c = rgb(hex).map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const token = (css: string, name: string) => {
  const m = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`));
  assert.ok(m, `${name} con un color fijo`);
  return m[1];
};
const darkBlock = (css: string) => css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));

test('los colores principales cumplen el contraste en claro y en oscuro', () => {
  const styles = read('styles.css');
  for (const [mode, a, s] of [['claro', astryx, styles], ['oscuro', darkBlock(astryx), darkBlock(styles)]] as const) {
    const surface = token(a, '--color-background-surface');
    const body = token(a, '--color-background-body');
    for (const bg of [surface, body]) {
      assert.ok(ratio(token(a, '--color-text-primary'), bg) >= 4.5, `${mode}: texto`);
      assert.ok(ratio(token(a, '--color-text-secondary'), bg) >= 4.5, `${mode}: texto secundario`);
      assert.ok(ratio(token(a, '--color-text-error'), bg) >= 4.5, `${mode}: error`);
      assert.ok(ratio(token(a, '--color-text-success'), bg) >= 4.5, `${mode}: éxito`);
      assert.ok(ratio(token(a, '--color-text-warning'), bg) >= 4.5, `${mode}: aviso`);
      assert.ok(ratio(token(s, '--accent'), bg) >= 4.5, `${mode}: acento`);
      assert.ok(ratio(token(s, '--field-line'), bg) >= 3, `${mode}: borde de campo`);
    }
    assert.ok(ratio(token(s, '--accent-foreground'), token(s, '--accent')) >= 4.5, `${mode}: texto sobre el acento`);
    assert.ok(ratio(token(a, '--color-on-error'), token(a, '--color-error')) >= 4.5, `${mode}: texto sobre rojo`);
  }
});

const mix = (a: string, p: number, b: string) => '#' + [0, 1, 2].map((i) => Math.round(rgb(a)[i] * p + rgb(b)[i] * (1 - p)).toString(16).padStart(2, '0')).join('');

test('el acento se lee sobre su tinte (filas activas e insignias), en claro y en oscuro', () => {
  const styles = read('styles.css');
  for (const [a, s, pct] of [[astryx, styles, 0.08], [darkBlock(astryx), darkBlock(styles), 0.16]] as const) {
    const accent = token(s, '--accent');
    assert.ok(ratio(accent, mix(accent, pct, token(a, '--color-background-surface'))) >= 4.5);
  }
});

test('brand.js revisa la marca blanca contra las mismas superficies que astryx.css', () => {
  const brand = fs.readFileSync(path.join(pub, 'js', 'brand.js'), 'utf8');
  for (const a of [astryx, darkBlock(astryx)]) {
    for (const name of ['--color-background-surface', '--color-background-body']) assert.ok(brand.includes(`'${token(a, name)}'`), `${name} = ${token(a, name)}`);
  }
});

test('componentes del panel con las reglas de Astryx: opción elegida visible, menús concéntricos, velo del diálogo', () => {
  const styles = read('styles.css');
  const rule = (selector: string) => {
    const i = styles.indexOf(`${selector} {`);
    assert.ok(i >= 0, selector);
    return styles.slice(i, styles.indexOf('}', i));
  };
  // La opción elegida de un control segmentado se levanta de la pista; una línea de 1px casi invisible no basta (WCAG 1.4.11).
  for (const sel of ['.wa-tab.active', '.sub-tabs a.active, .sub-tabs a[aria-current="page"]']) {
    assert.match(rule(sel), /box-shadow: var\(--shadow-low\)/, sel);
    assert.doesNotMatch(rule(sel), /outline: 1px/, sel);
  }
  // Las filas de un menú siguen la esquina del menú menos su relleno.
  assert.match(rule('details.menu .menu-items a'), /border-radius: calc\(var\(--radius-card\) - 4px\)/);
  assert.match(rule('.user-menu a'), /border-radius: calc\(var\(--radius-card\) - 6px\)/);
  assert.match(rule('.app-dialog::backdrop'), /var\(--color-overlay\)/);
});

test('las páginas públicas cargan astryx.css y usan sus fondos y el acento de Riverrun', async () => {
  for (const f of ['reservar.html', 'help.html', 'ayuda.html', 'api-docs.html']) {
    const html = read(f);
    assert.ok(html.includes('<link rel="stylesheet" href="/astryx.css" />'), f);
    assert.match(html, /--bg: var\(--color-background-body\)/, f);
    assert.match(html, /--accent: #0f6b7a/, f);
  }
  const { LIGHT, DARK, PUBLIC_HEAD, publicPalette } = await import('../src/public-colors.js');
  assert.ok(PUBLIC_HEAD.includes('/astryx.css'));
  assert.deepEqual([LIGHT.bg, LIGHT.panel], [token(astryx, '--color-background-body'), token(astryx, '--color-background-surface')]);
  assert.deepEqual([DARK.bg, DARK.panel], [token(darkBlock(astryx), '--color-background-body'), token(darkBlock(astryx), '--color-background-surface')]);
  assert.match(publicPalette().light, /--accent: #0f6b7a;/);
  for (const f of ['pricing.ts', 'nudges.ts', 'self-service.ts']) {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'routes', f), 'utf8');
    assert.ok(src.includes('${PUBLIC_HEAD}') && src.includes('${PUBLIC_VARS}'), f);
  }
});
