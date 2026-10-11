/**
 * Diario de incidencias pendientes, sin base de datos: que cada componente guarde solo su último estado y que el
 * archivo no crezca mientras dura una caída.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendJournal, type JournalEntry } from '../src/observability/journal.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-diario-'));
const file = path.join(dir, 'incidencias-pendientes.jsonl');
const lines = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as JournalEntry) : []);
const open = (component: string, detail: string, status: 'fail' | 'warn' = 'fail'): JournalEntry => ({ op: 'open', component, title: component, detail, status, at: new Date().toISOString() });

test('el mismo estado repetido reemplaza la última entrada del componente (el archivo no crece cada minuto)', () => {
  fs.rmSync(file, { force: true });
  for (let i = 0; i < 50; i++) appendJournal(open('database', `intento ${i}`), file);
  const l = lines();
  assert.equal(l.length, 1);
  assert.equal((l[0] as any).detail, 'intento 49', 'queda el último detalle');
});

test('cambios de estado de un componente se conservan en orden', () => {
  fs.rmSync(file, { force: true });
  appendJournal(open('whatsapp', 'caído'), file);
  appendJournal({ op: 'resolve', component: 'whatsapp', at: new Date().toISOString() }, file);
  appendJournal(open('whatsapp', 'otra vez caído'), file);
  assert.deepEqual(lines().map((e) => e.op), ['open', 'resolve', 'open']);
});

test('un degradado y un fallo del mismo componente son estados distintos', () => {
  fs.rmSync(file, { force: true });
  appendJournal(open('ai', 'errores', 'warn'), file);
  appendJournal(open('ai', 'sin respuestas', 'fail'), file);
  assert.equal(lines().length, 2);
});

test('componentes distintos no se pisan entre sí', () => {
  fs.rmSync(file, { force: true });
  appendJournal(open('database', 'a'), file);
  appendJournal(open('whatsapp', 'b'), file);
  appendJournal(open('database', 'c'), file);
  assert.deepEqual(lines().map((e) => (e as any).component), ['database', 'whatsapp'], 'database se reemplaza en su sitio, sin duplicarse');
});

test('el diario nunca pasa de 500 entradas: conserva las más recientes', () => {
  fs.rmSync(file, { force: true });
  for (let i = 0; i < 600; i++) appendJournal({ op: 'resolve', component: `c${i}`, at: new Date().toISOString() }, file);
  const l = lines();
  assert.equal(l.length, 500);
  assert.equal((l[l.length - 1] as any).component, 'c599');
});
