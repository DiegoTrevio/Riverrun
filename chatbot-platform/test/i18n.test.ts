/** Panel en inglés: el traductor (public/js/i18n.js) y que cada texto del panel tenga su traducción. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error módulo del panel en JavaScript sin tipos
import { compile, pickLang, translateSpaced, translateText } from '../public/js/i18n.js';
// @ts-expect-error script en JavaScript sin tipos
import { checkTranslations, extractStrings } from '../scripts/i18n-strings.mjs';

const dict = compile({
  Guardar: 'Save',
  Operador: 'Operator',
  'Te invitaron como {0}.': 'You were invited as {0}.',
  '{0} días': '{0} days',
  'Mensaje {0} de {1}': 'Message {0} of {1}',
  'Desde {1} hasta {0}': 'To {0} from {1}',
  '{0} {1}': 'no se usa',
});

test('el idioma guardado gana; si no hay, el del navegador; si no es español ni inglés, español', () => {
  assert.equal(pickLang('en', ['es-MX']), 'en');
  assert.equal(pickLang(null, ['en-US', 'es']), 'en');
  assert.equal(pickLang(null, ['fr-FR', 'es-MX']), 'es');
  assert.equal(pickLang('xx', ['de']), 'es');
  assert.equal(pickLang(undefined, []), 'es');
});

test('traduce textos fijos y conserva los espacios de los lados', () => {
  assert.equal(translateText('Guardar', dict), 'Save');
  assert.equal(translateSpaced('  Guardar ', dict), '  Save ');
  assert.equal(translateText('Algo que no está', dict), null, 'lo desconocido se queda como está');
  assert.equal(translateSpaced('   ', dict), null);
});

test('las partes que cambian ({0}) se conservan y, si son textos conocidos, también se traducen', () => {
  assert.equal(translateText('12 días', dict), '12 days');
  assert.equal(translateText('Te invitaron como Operador.', dict), 'You were invited as Operator.');
  assert.equal(translateText('Te invitaron como Ana.', dict), 'You were invited as Ana.');
  assert.equal(translateText('Mensaje 2 de 5', dict), 'Message 2 of 5');
  assert.equal(translateText('Desde lunes hasta martes', dict), 'To martes from lunes', 'el orden de las partes puede cambiar');
  assert.equal(translateText('a b', dict), null, 'una llave sin palabras ({0} {1}) no traduce todo');
});

test('los saltos de línea y espacios repetidos del texto no impiden encontrar la traducción', () => {
  assert.equal(translateText('Te invitaron  como\nOperador.', dict), 'You were invited as Operator.');
});

test('el extractor junta textos fijos y plantillas, y deja fuera clases, rutas y comparaciones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-'));
  const file = path.join(dir, 'vista.js');
  fs.writeFileSync(file, [
    "const a = h('button', { class: 'btn primary', onclick: go }, 'Guardar cambios');",
    'const b = `${n} conversaciones abiertas`;',
    "const c = 'Hola ' + nombre + ', bienvenido';",
    "if (estado === 'pendiente de pago') {}",
    "api('GET', '/api/cuentas');",
  ].join('\n'));
  const found = [...extractStrings([file]).keys()];
  assert.ok(found.includes('Guardar cambios'));
  assert.ok(found.includes('{0} conversaciones abiertas'));
  assert.ok(found.includes('Hola {0}, bienvenido'));
  assert.ok(!found.includes('btn primary'));
  assert.ok(!found.includes('pendiente de pago'), 'una comparación no es texto de la pantalla');
  assert.ok(!found.some((s: string) => s.includes('/api/')));
});

test('cada texto del panel tiene su traducción al inglés, sin partes {0} que el original no tenga', () => {
  const { missing, broken } = checkTranslations();
  assert.deepEqual(broken, [], 'traducciones vacías o con partes distintas');
  assert.equal(missing.length, 0, `Faltan traducciones (node scripts/i18n-strings.mjs las lista):\n${missing.slice(0, 20).map((m: { s: string }) => m.s).join('\n')}`);
});

test('textos armados con piezas: un símbolo delante o piezas unidas con «·» o «:» se traducen pieza por pieza', () => {
  const pieces = compile({ 'Te asignaron una conversación': 'A conversation was assigned to you', 'no llegó': 'not delivered', entregado: 'delivered', Correo: 'Email' });
  assert.equal(translateText('📥 Te asignaron una conversación', pieces), '📥 A conversation was assigned to you');
  assert.equal(translateText('WhatsApp: no llegó · Correo: entregado', pieces), 'WhatsApp: not delivered · Email: delivered');
  assert.equal(translateText('Nada: conocido', pieces), null, 'si ninguna pieza es conocida, se queda igual');
});
