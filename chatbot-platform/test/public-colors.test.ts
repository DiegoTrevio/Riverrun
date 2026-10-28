/** Colores de las páginas públicas: contraste AA en claro y oscuro con cualquier color de marca (auditoría A6). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DARK, LIGHT, publicPalette, ratio } from '../src/public-colors.js';

const read = (css: string) => Object.fromEntries([...css.matchAll(/(--[a-z-]+): (#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]));

for (const brand of ['', '#1a73e8', '#7dd3fc', '#fde047', '#0b1f3a', '#ff5a5f', '#128c7e', 'no-es-color']) {
  test(`marca ${brand || '(sin color)'}: botones, enlaces y peligro con 4.5:1 en los dos temas`, () => {
    const p = publicPalette(brand);
    for (const [theme, bg] of [['light', LIGHT], ['dark', DARK]] as const) {
      const v = read(p[theme]);
      assert.ok(ratio(v['--accent-ink'], v['--accent']) >= 4.5, `${theme}: texto del botón ${v['--accent-ink']} sobre ${v['--accent']}`);
      for (const surface of [bg.bg, bg.panel]) assert.ok(ratio(v['--link'], surface) >= 4.5, `${theme}: enlace ${v['--link']} sobre ${surface}`);
      assert.ok(ratio('#ffffff', v['--bad-solid']) >= 4.5, `${theme}: botón de peligro`);
    }
  });
}

test('una marca que ya contrasta se usa tal cual; una que no, se ajusta sin perder su tono', () => {
  assert.match(publicPalette('#1a73e8').light, /--accent: #1a73e8;/);
  const pale = read(publicPalette('#7dd3fc').light);
  assert.notEqual(pale['--link'], '#7dd3fc', 'un celeste pálido no sirve para enlaces sobre blanco');
  assert.equal(pale['--accent-ink'], '#101828', 'y su botón lleva texto oscuro');
});
