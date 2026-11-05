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

test('IN-24: cada forma de HTML crudo se rechaza', () => {
  const forms: Record<string, string> = {
    'innerHTML +=': "export function f(el, d) { el.innerHTML += d; }\n",
    'outerHTML =': "export function f(el, d) { el.outerHTML = d; }\n",
    "'html':": "export const x = (d) => h('div', { 'html': d });\n",
    '"html":': 'export const x = (d) => h("div", { "html": d });\n',
    "['html']:": "export const x = (d) => h('div', { ['html']: d });\n",
    'html sin comillas': "export const x = (d) => h('div', { html: d });\n",
    setHTMLUnsafe: "export function f(el, d) { el.setHTMLUnsafe(d); }\n",
    createContextualFragment: "export function f(el, d) { return document.createRange().createContextualFragment(d); }\n",
    DOMParser: "export function f(d) { return new DOMParser().parseFromString(d, 'text/html'); }\n",
    srcdoc: "export function f(el, d) { el.srcdoc = d; }\n",
    'insertAdjacentHTML': "export function f(el, d) { el.insertAdjacentHTML('beforeend', d); }\n",
  };
  for (const [name, body] of Object.entries(forms)) {
    const bad = run({ 'vista.js': body });
    assert.notEqual(bad.status, 0, `debía rechazar: ${name}`);
    assert.match(bad.stderr, /vista\.js:/, name);
  }
});

test('IN-24: un https:// antes del html: no esconde la línea (no es un comentario)', () => {
  const bad = run({ 'vista.js': "export const x = (d) => { const u = 'https://x'; return h('div', { html: d }); };\n" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /vista\.js: usa html:/);
  const tpl = run({ 'vista.js': 'export const x = (d) => { const u = `https://x/${1}`; return h("div", { html: d }); };\n' });
  assert.notEqual(tpl.status, 0, 'tampoco tras una plantilla');
});

test('IN-24: lo que está en un comentario no cuenta', () => {
  const ok = run({ 'vista.js': "// html: no se usa\n/* el.innerHTML = x */\nexport const x = 1; // innerHTML = 'y'\n" });
  assert.equal(ok.status, 0, ok.stderr);
});

test('IN-24: los scripts sueltos de public/ también se revisan (una constante literal sí se permite)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const panel = path.join(dir, 'js');
  fs.mkdirSync(panel);
  fs.writeFileSync(path.join(panel, 'core.js'), 'export const h = () => null;\n');
  const exec = () => spawnSync(process.execPath, ['scripts/check-frontend.mjs'], { env: { ...process.env, CHECK_FRONTEND_DIR: panel }, encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'widget.js'), "el.innerHTML = '<span></span>'; el.insertAdjacentHTML('afterbegin', '<svg/>');\n");
  assert.equal(exec().status, 0, 'constantes literales');
  fs.writeFileSync(path.join(dir, 'widget.js'), "el.innerHTML = '<b>' + nombre + '</b>';\n");
  const bad = exec();
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /widget\.js/);
});

test('IN-24: la excepción de literal solo vale con la sentencia completa', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const panel = path.join(dir, 'js');
  fs.mkdirSync(panel);
  fs.writeFileSync(path.join(panel, 'core.js'), 'export const h = () => null;\n');
  const shapes = [
    "el.innerHTML = 'a'\n+ x;\n",
    "el.innerHTML = '<b>'\n`x`;\n",
    "el.innerHTML = 'a'\n(x);\n",
    "el.insertAdjacentHTML('afterbegin', 'a')\n+ x;\n",
    "el.insertAdjacentHTML('afterbegin', 'a')\n(x);\n",
  ];
  for (const body of shapes) {
    fs.writeFileSync(path.join(dir, 'widget.js'), body);
    const r = spawnSync(process.execPath, ['scripts/check-frontend.mjs'], { env: { ...process.env, CHECK_FRONTEND_DIR: panel }, encoding: 'utf8' });
    assert.notEqual(r.status, 0, `debía rechazar: ${JSON.stringify(body)}`);
  }
});
