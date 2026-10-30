/** «Datos de tus clientes»: campos propios de la cuenta, la ficha, el asistente, exportar e importar contactos por CSV. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
// Después del arnés: los módulos de la app leen la base de pruebas.
const { parseCsv } = await import('../src/contacts/csv.js');
const { cleanFieldValue } = await import('../src/contacts/fields.js');
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let admin: Awaited<ReturnType<Awaited<ReturnType<typeof createHarness>>['loginAs']>>;
let agent: typeof admin;
let contactId = '';
let convId = '';

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  for (const [email, role] of [['duena@palmas.mx', 'admin'], ['agente@palmas.mx', 'agent']]) {
    assert.equal((await h.authed('POST', '/api/users', { account_id: h.accountId, name: role, email, password: 'Pz-144-Qx-344-Kv', role })).statusCode, 200);
  }
  admin = await h.loginAs('duena@palmas.mx', 'Pz-144-Qx-344-Kv');
  agent = await h.loginAs('agente@palmas.mx', 'Pz-144-Qx-344-Kv');
  h.setScript(() => ({ messages: ['¡Hola! ¿En qué te ayudo?'] }));
  await h.webhook('Hola');
  await h.idle();
  const conv = await h.conversationFor();
  contactId = conv.contact_id;
  convId = conv.id;
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('alta, edición, orden y borrado de campos; solo un administrador los cambia', async () => {
  const birthday = await admin('POST', '/api/contact-fields', { label: 'Fecha de cumpleaños', key: 'cumpleanos', type: 'date' });
  assert.equal(birthday.statusCode, 201, birthday.body);
  assert.equal((await admin('POST', '/api/contact-fields', { label: 'Plan', key: 'plan', type: 'option', options: ['Básico', 'Premium'] })).statusCode, 201);
  assert.equal((await admin('POST', '/api/contact-fields', { label: 'Número de cliente', key: 'num_cliente', type: 'number' })).statusCode, 201);
  // Clave repetida, inválida, reservada u opción sin opciones.
  assert.equal((await admin('POST', '/api/contact-fields', { label: 'Otro', key: 'cumpleanos' })).statusCode, 409);
  assert.equal((await admin('POST', '/api/contact-fields', { label: 'Mal', key: 'Con Espacio' })).statusCode, 400);
  assert.equal((await admin('POST', '/api/contact-fields', { label: 'Tel', key: 'telefono' })).statusCode, 400);
  assert.equal((await admin('POST', '/api/contact-fields', { label: 'Talla', key: 'talla', type: 'option' })).statusCode, 400);
  // El agente los ve pero no los cambia.
  const seen = await agent('GET', '/api/contact-fields');
  assert.deepEqual(seen.json().map((f: any) => f.key), ['cumpleanos', 'plan', 'num_cliente']);
  assert.equal((await agent('POST', '/api/contact-fields', { label: 'X', key: 'x' })).statusCode, 403);
  assert.equal((await agent('DELETE', `/api/contact-fields/${birthday.json().id}`)).statusCode, 403);
  // Editar no cambia la clave; reordenar.
  const ids = seen.json().map((f: any) => f.id);
  const edited = await admin('PUT', `/api/contact-fields/${ids[2]}`, { label: 'No. de cliente', key: 'otra' });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().key, 'num_cliente');
  assert.equal(edited.json().label, 'No. de cliente');
  const order = await admin('PUT', '/api/contact-fields/order', { ids: [ids[2], ids[0], ids[1]] });
  assert.deepEqual(order.json().map((f: any) => f.key), ['num_cliente', 'cumpleanos', 'plan']);
  // Un campo temporal: borrarlo no borra lo guardado.
  const tmp = (await admin('POST', '/api/contact-fields', { label: 'Temporal', key: 'temporal' })).json();
  await pool.query(`UPDATE contacts SET data = data || '{"temporal":"sí"}' WHERE id = $1`, [contactId]);
  assert.equal((await admin('DELETE', `/api/contact-fields/${tmp.id}`)).statusCode, 200);
  assert.equal((await pool.query(`SELECT data->>'temporal' AS v FROM contacts WHERE id = $1`, [contactId])).rows[0].v, 'sí');
});

t('la ficha guarda cada dato con su formato y rechaza el que no corresponde a su tipo', async () => {
  const conv = (await admin('GET', `/api/conversations/${convId}`)).json();
  assert.deepEqual(conv.contact_fields.map((f: any) => f.key), ['num_cliente', 'cumpleanos', 'plan']);
  const put = (data: Record<string, string>) => admin('PUT', `/api/contacts/${contactId}`, { data });
  const bad = await put({ cumpleanos: '31/02/1990' });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /Fecha de cumpleaños/);
  assert.equal((await put({ plan: 'Oro' })).statusCode, 400);
  const good = await put({ cumpleanos: '15/05/1990', plan: 'premium', num_cliente: '1,024' });
  assert.equal(good.statusCode, 200, good.body);
  const data = good.json().data;
  assert.equal(data.cumpleanos, '1990-05-15');
  assert.equal(data.plan, 'Premium');
  assert.equal(data.num_cliente, '1024');
});

t('el asistente ve los datos con su etiqueta y guarda uno de la cuenta validando su tipo (sin pedirlo)', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['¡Anotado!'], save_data: [{ field: 'plan', value: 'basico' }, { field: 'num_cliente', value: 'no sé' }] }));
  await h.webhook('Ya me cambié al plan basico');
  await h.idle();
  const prompt = h.calls.map((c) => c.messages.map((m: any) => m.content).join('\n')).join('\n');
  assert.match(prompt, /Fecha de cumpleaños \(`cumpleanos`\): 1990-05-15/);
  assert.doesNotMatch(prompt, /## Datos a recopilar[\s\S]*Fecha de cumpleaños[\s\S]*## Reglas del negocio/, 'no se pide');
  const data = (await pool.query(`SELECT data FROM contacts WHERE id = $1`, [contactId])).rows[0].data;
  assert.equal(data.plan, 'Básico', 'la opción se normaliza a la de su lista');
  assert.equal(data.num_cliente, '1024', 'un número inválido no se guarda');
});

t('exportar trae las columnas de la cuenta con su etiqueta, primero y en su orden', async () => {
  const r = await admin('GET', '/api/export/contacts.csv');
  assert.equal(r.statusCode, 200);
  const [header] = parseCsv(r.body);
  const i = header.indexOf('No. de cliente');
  assert.ok(i > 0, header.join(','));
  assert.deepEqual(header.slice(i, i + 3), ['No. de cliente', 'Fecha de cumpleaños', 'Plan']);
});

t('importar CSV: crea y actualiza por teléfono, reconoce columnas por etiqueta o clave y reporta filas inválidas', async () => {
  const csv = [
    'Teléfono;Nombre;Etiquetas;Fecha de cumpleaños;plan;Color favorito',
    '5215511112222;Ana López;vip;;Básico;azul',
    '5215533334444;Beto;nuevo|feria;03/11/1985;Premium;',
    '5215555556666;Caro;;1985-13-01;;',
    '12345;Nadie;;;;',
    '5215533334444;Beto otra vez;;;;',
  ].join('\r\n');
  const channelId = h.channelId;
  assert.equal((await agent('POST', '/api/contacts/import', { channel_id: channelId, csv })).statusCode, 403);
  const r = await admin('POST', '/api/contacts/import', { channel_id: channelId, csv });
  assert.equal(r.statusCode, 200, r.body);
  const out = r.json();
  assert.equal(out.created, 1);
  assert.equal(out.updated, 1);
  assert.deepEqual(out.errors.map((e: any) => e.row), [4, 5, 6]);
  assert.match(out.errors[0].error, /Fecha de cumpleaños/);
  assert.match(out.errors[1].error, /Teléfono inválido/);
  assert.match(out.errors[2].error, /repetido/);
  assert.deepEqual(out.ignored_columns, ['Color favorito']);
  const ana = (await pool.query(`SELECT name, tags, data FROM contacts WHERE id = $1`, [contactId])).rows[0];
  assert.equal(ana.name, 'Ana López');
  assert.ok(ana.tags.includes('vip'));
  assert.equal(ana.data.cumpleanos, '1990-05-15', 'una celda vacía no borra');
  const beto = (await pool.query(`SELECT c.name, c.tags, c.data, (SELECT count(*)::int FROM conversations v WHERE v.contact_id = c.id) AS convs FROM contacts c WHERE c.phone = '5215533334444'`)).rows[0];
  assert.equal(beto.name, 'Beto');
  assert.deepEqual(beto.tags, ['nuevo', 'feria']);
  assert.equal(beto.data.cumpleanos, '1985-11-03');
  assert.equal(beto.convs, 1, 'aparece en el panel con su conversación');
  // Sin columna de teléfono, o con un canal que no es de WhatsApp.
  assert.equal((await admin('POST', '/api/contacts/import', { channel_id: channelId, csv: 'nombre\nAna' })).statusCode, 400);
});

t('lector de CSV y formato de valores', async () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","con ""comillas""\nen dos líneas"\n\n'), [['a', 'b'], ['x, y', 'con "comillas"\nen dos líneas']]);
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.equal(cleanFieldValue({ type: 'date', options: [] }, '2024-02-29'), '2024-02-29');
  assert.equal(cleanFieldValue({ type: 'date', options: [] }, '29/02/2023'), null);
  assert.equal(cleanFieldValue({ type: 'number', options: [] }, '$1,500.50'), '1500.50');
  assert.equal(cleanFieldValue({ type: 'email', options: [] }, 'ANA@Correo.mx'), 'ana@correo.mx');
  assert.equal(cleanFieldValue({ type: 'phone', options: [] }, '55 1234'), null);
});

t('revisión: un valor antiguo que no cuadra con su tipo no impide guardar la ficha; un campo no se llama como una columna de importar', async () => {
  await pool.query(`UPDATE contacts SET data = data || '{"plan":"Oro"}' WHERE id = $1`, [contactId]);
  const cur = (await pool.query(`SELECT data FROM contacts WHERE id = $1`, [contactId])).rows[0].data;
  // La ficha manda todo de vuelta: el «Oro» de antes se conserva y lo demás se guarda.
  const r = await admin('PUT', `/api/contacts/${contactId}`, { data: { ...cur, num_cliente: '7' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().data.plan, 'Oro');
  assert.equal(r.json().data.num_cliente, '7');
  // Cambiarlo a otro valor fuera de la lista sí se rechaza.
  assert.equal((await admin('PUT', `/api/contacts/${contactId}`, { data: { ...cur, plan: 'Platino' } })).statusCode, 400);
  const clash = await admin('POST', '/api/contact-fields', { label: 'Celular', key: 'cel_secundario' });
  assert.equal(clash.statusCode, 400);
  assert.match(clash.json().error, /importar/);
  const f = (await admin('GET', '/api/contact-fields')).json()[0];
  assert.equal((await admin('PUT', `/api/contact-fields/${f.id}`, { label: 'Cliente' })).statusCode, 400);
});
