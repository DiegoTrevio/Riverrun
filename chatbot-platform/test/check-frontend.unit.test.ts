/** El chequeo del panel rechaza HTML crudo fuera de los módulos de dibujos fijos (IN-20). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  for (const [name, body] of Object.entries({ 'core.js': 'export const h = () => null;\n', ...files })) fs.writeFileSync(path.join(dir, name), body);
  return spawnSync(process.execPath, ['scripts/check-frontend.mjs'], { env: { ...process.env, CHECK_FRONTEND_DIR: dir }, encoding: 'utf8' });
};

test('html: fuera de icons.js, brand.js y whatsapp.js hace fallar el chequeo', () => {
  const bad = run({ 'vista.js': "export const x = { html: '<b>hola</b>' };\n" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /vista\.js: usa html:/);
  assert.equal(run({ 'icons.js': "export const x = { html: '<svg/>' };\n" }).status, 0, 'en icons.js sí');
});

test('innerHTML directo fuera de core.js también', () => {
  const bad = run({ 'vista.js': "export function f(el) { el.innerHTML = 'x'; }\n" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /vista\.js: escribe HTML crudo/);
});
