import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, store, waitFor } from './harness.js';
const { summarizeConversation } = await import('../src/engine/report.js');

const available = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !available && 'PostgreSQL no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let conv: Awaited<ReturnType<typeof h.conversationFor>>;
before(async () => {
  if (!available) return;
  h = await createHarness();
  await h.createBot({ data_fields: [], personality: { prompt: 'Pregunta el nombre, la dirección y cuántos tacos quiere. Guarda las respuestas.' } });
});
after(async () => { if (h) await h.app.close(); await pool.end(); });

t('respuestas del prompt: contacto, conversación y mensaje de origen conservan los datos', async () => {
  h.setScript(() => ({ messages: ['¿Cuál es tu dirección?'], save_data: [{ field: 'nombre', value: 'Ana' }] }));
  await h.webhook('Soy Ana');
  await waitFor(() => h.sent.length >= 1);
  await h.idle();
  conv = await h.conversationFor();
  h.setScript(() => ({ messages: ['¿Cuántos tacos quieres?'], save_data: [{ field: 'direccion', value: 'Reforma 25' }] }));
  await h.webhook('Reforma 25');
  await waitFor(() => h.sent.length >= 2);
  await h.idle();
  const detail = (await h.authed('GET', `/api/conversations/${conv.id}`)).json();
  assert.deepEqual(detail.contact.data, { nombre: 'Ana', direccion: 'Reforma 25' });
  assert.deepEqual(detail.conversation.data, detail.contact.data);
  const source = detail.messages.find((m: any) => m.direction === 'in' && m.content === 'Reforma 25');
  assert.deepEqual(source.meta.captured_data, { direccion: 'Reforma 25' });
  const row = (await pool.query('SELECT data FROM conversations WHERE id = $1', [conv.id])).rows[0];
  assert.deepEqual(row.data, detail.contact.data);
});

t('solicitar resumen incluye el historial completo y queda guardado; dos solicitudes reutilizan el resultado', async () => {
  h.setSummary('Ana pidió tacos. Dirección: Reforma 25. Falta confirmar la cantidad.');
  const before = h.summaryCalls.length;
  const results = await Promise.all([h.authed('POST', `/api/conversations/${conv.id}/summary`), h.authed('POST', `/api/conversations/${conv.id}/summary`)]);
  assert.ok(results.every(r => r.statusCode === 200));
  assert.equal(h.summaryCalls.length, before + 1);
  const report = results[0].json();
  assert.match(report.report_summary, /Reforma 25/);
  assert.ok(report.report_at);
  assert.equal(report.report_data_version, report.data_version);
  const request = h.summaryCalls.at(-1)!;
  assert.match(request.messages[1].content, /Soy Ana/);
  assert.match(request.messages[1].content, /¿Cuál es tu dirección/);
  assert.match(request.messages[1].content, /Reforma 25/);
});

t('el resumen recupera respuestas omitidas por el modelo y rechaza valores inventados o del negocio', async () => {
  h.setScript(() => ({ messages: ['Anotado, lo confirmamos.'] }));
  await h.webhook('Quiero 4 tacos'); await waitFor(() => h.sent.length >= 3); await h.idle();
  const inbound = (await store.recentMessages(conv.id, 10)).find(m => m.direction === 'in' && m.content === 'Quiero 4 tacos')!;
  h.setSummaryFields([
    { field: 'cantidad', value: '4', source_message_id: inbound.id },
    { field: 'direccion', value: 'Reforma 99', source_message_id: inbound.id },
    { field: 'inventado', value: 'Tarjeta aprobada', source_message_id: inbound.id },
  ]);
  h.setSummary('Ana quiere 4 tacos. Dirección: Reforma 25. Pendiente confirmar.');
  const result = await h.authed('POST', `/api/conversations/${conv.id}/summary`);
  assert.equal(result.statusCode, 200, result.body);
  const contact = await store.getContact(conv.contact_id);
  assert.equal(contact!.data.cantidad, '4');
  assert.equal(contact!.data.direccion, 'Reforma 25');
  assert.equal(contact!.data.inventado, undefined);
  assert.deepEqual(result.json().data, contact!.data);
  h.setSummaryFields([]);
});

t('cerrar genera resumen actualizado y conserva mensajes y datos', async () => {
  h.setScript(() => ({ messages: ['Recoges a las 8.'] }));
  await h.webhook('Paso a recoger a las 8'); await waitFor(() => h.sent.length >= 4); await h.idle();
  h.setSummary('Ana quiere 4 tacos para recoger a las 8. Dirección: Reforma 25.');
  const result = await h.authed('POST', `/api/conversations/${conv.id}/close`);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().status, 'closed');
  assert.match(result.json().report_summary, /recoger a las 8/);
  assert.equal(result.json().data.cantidad, '4');
  assert.ok((await store.recentMessages(conv.id, 50)).length >= 8);
});

t('las escrituras concurrentes no pierden respuestas; un origen incorrecto revierte ambas copias', async () => {
  await Promise.all([
    store.saveConversationMemory(conv.id, conv.contact_id, { data: { entrega: 'Recoger' }, remember: [] }),
    store.saveConversationMemory(conv.id, conv.contact_id, { data: { salsa: 'Verde' }, remember: [] }),
  ]);
  const contact = (await store.getContact(conv.contact_id))!;
  const conversation = (await store.getConversation(conv.id))!;
  assert.equal(contact.data.entrega, 'Recoger'); assert.equal(contact.data.salsa, 'Verde');
  assert.deepEqual(conversation.data, contact.data);
  await assert.rejects(store.saveConversationMemory(conv.id, conv.contact_id, { data: { invalido: 'No guardar' }, name: 'Cambio', remember: [] }, 99999999), /origen/);
  assert.deepEqual((await store.getContact(conv.contact_id))!.data, contact.data);
  assert.deepEqual((await store.getConversation(conv.id))!.data, conversation.data);
  const corrected = { ...contact.data, direccion: 'Reforma 30' };
  await store.updateContact(conv.contact_id, { data: corrected });
  const updatedConversation = (await store.getConversation(conv.id))!;
  assert.deepEqual(updatedConversation.data, corrected);
  assert.deepEqual((await store.getContact(conv.contact_id))!.data, corrected);
  assert.ok(updatedConversation.data_version > conversation.data_version);
});

t('la base de datos rechaza mezclar cuentas/canales/contactos y conserva datos existentes', async () => {
  const other = (await h.authed('POST', '/api/accounts', { name: 'Otra cuenta' })).json();
  const channel = (await h.authed('POST', '/api/channels', { account_id: other.id, type: 'webchat', name: 'Otro perfil' })).json();
  await assert.rejects(pool.query('UPDATE channels SET chatbot_id = $1 WHERE id = $2', [h.botId, channel.id]), (e: any) => e.code === '23503');
  await assert.rejects(pool.query('UPDATE contacts SET account_id = $1 WHERE id = $2', [other.id, conv.contact_id]), (e: any) => e.code === '23503');
  await assert.rejects(pool.query('UPDATE conversations SET channel_id = $1 WHERE id = $2', [channel.id, conv.id]), (e: any) => e.code === '23503');
  await assert.rejects(pool.query("UPDATE contacts SET data = '[]' WHERE id = $1", [conv.contact_id]), (e: any) => e.code === '23514');
  await assert.rejects(pool.query("UPDATE contacts SET data = '{\"cantidad\":4}' WHERE id = $1", [conv.contact_id]), (e: any) => e.code === '23514');
  await assert.rejects(pool.query("UPDATE contacts SET notes = '[{}]' WHERE id = $1", [conv.contact_id]), (e: any) => e.code === '23514');
  const outsider = (await h.authed('POST', '/api/users', { email: 'otro@resumen.test', password: 'clave-segura-123', role: 'admin', account_id: other.id })).json();
  const api = await h.loginAs(outsider.email, 'clave-segura-123');
  assert.equal((await api('POST', `/api/conversations/${conv.id}/summary`)).statusCode, 404);
  assert.equal((await store.getConversation(conv.id))!.account_id, h.accountId);
});

t('historial largo: todos los mensajes entran en lotes sin perder el tramo intermedio', async () => {
  for (let i = 0; i < 85; i++) await store.insertMessage({ conversation_id: conv.id, direction: 'in', sender: 'customer', content: `Dato cronológico ${i}` });
  const before = h.summaryCalls.length;
  h.setSummary('Resumen acumulado de los 85 mensajes nuevos.');
  const result = await h.authed('POST', `/api/conversations/${conv.id}/summary`);
  assert.equal(result.statusCode, 200, result.body);
  const requests = h.summaryCalls.slice(before);
  assert.equal(requests.length, 3);
  const all = requests.map(r => r.messages[1].content).join('\n');
  for (let i = 0; i < 85; i++) assert.match(all, new RegExp(`Dato cronológico ${i}\\b`));
});

t('un envío pendiente no deja un hueco en el resumen cuando después se entrega', async () => {
  const pending = (await store.insertMessage({ conversation_id: conv.id, direction: 'out', sender: 'human', status: 'pending', content: 'Confirmación que se entrega después' }))!;
  await store.insertMessage({ conversation_id: conv.id, direction: 'in', sender: 'customer', content: 'Mensaje posterior al envío pendiente' });
  const first = await h.authed('POST', `/api/conversations/${conv.id}/summary`);
  assert.equal(first.statusCode, 200, first.body);
  assert.ok(first.json().report_until_id < pending.id);
  await store.updateMessage(pending.id, { status: 'ok' });
  const before = h.summaryCalls.length;
  const second = await h.authed('POST', `/api/conversations/${conv.id}/summary`);
  assert.equal(second.statusCode, 200, second.body);
  const content = h.summaryCalls.slice(before).map(r => r.messages[1].content).join('\n');
  assert.match(content, /Confirmación que se entrega después/);
  assert.match(content, /Mensaje posterior al envío pendiente/);
  assert.ok(second.json().report_until_id > pending.id);
});

t('borrar memoria evita que un resumen en curso restaure los datos anteriores', async () => {
  await store.insertMessage({ conversation_id: conv.id, direction: 'in', sender: 'customer', content: 'Mensaje para resumen pendiente' });
  let release!: () => void;
  const started = { value: false };
  const ai = { complete: async () => { started.value = true; await new Promise<void>(r => release = r); return { content: JSON.stringify({ summary: 'Resumen anterior', save_data: [] }), model: 'test', latency_ms: 1, usage: { input_tokens: 1, cached_tokens: 0, output_tokens: 1 } }; }, transcribe: async () => '' };
  const task = summarizeConversation(ai, conv.id);
  await waitFor(() => started.value);
  await h.authed('POST', `/api/conversations/${conv.id}/reset-memory`);
  const rejection = assert.rejects(task, /cambió/);
  release(); await rejection;
  const cleared = (await store.getConversation(conv.id))!;
  assert.equal(cleared.report_summary, ''); assert.equal(cleared.summary, '');
  assert.deepEqual(cleared.data, {}); assert.deepEqual((await store.getContact(conv.contact_id))!.data, {});
});


t('respuestas agrupadas conservan el origen correcto de cada dato', async () => {
  const phone = '5215599990003';
  h.setScript(() => ({ messages: ['Listo, anoté tus datos.'], save_data: [{ field: 'correo', value: 'ana@ejemplo.com' }, { field: 'direccion', value: 'Reforma 70' }] }));
  const before = h.sent.length;
  await Promise.all([h.webhook('ana@ejemplo.com', { phone }), h.webhook('Reforma 70', { phone })]);
  await waitFor(() => h.sent.length > before); await h.idle();
  const item = await h.conversationFor(phone);
  const messages = await store.recentMessages(item.id, 20);
  assert.deepEqual(messages.find(m => m.content === 'ana@ejemplo.com')!.meta.captured_data, { correo: 'ana@ejemplo.com' });
  assert.deepEqual(messages.find(m => m.content === 'Reforma 70')!.meta.captured_data, { direccion: 'Reforma 70' });
  assert.deepEqual((await store.getConversation(item.id))!.data, { correo: 'ana@ejemplo.com', direccion: 'Reforma 70' });
});

t('objetivo cumplido y transferencia generan resúmenes finales automáticamente', async () => {
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { flow: { goal: 'Recopilar el pedido', on_goal_action: 'none' } });
  h.setSummary('El cliente quiere tacos; el equipo debe confirmar el pedido.');
  h.setScript(() => ({ messages: ['Anoté tu pedido. El equipo lo confirmará.'], goal_completed: true }));
  const before = h.sent.length;
  await h.webhook('Quiero tacos', { phone: '5215599990001' });
  await waitFor(() => h.sent.length > before); await h.idle();
  const goal = await h.conversationFor('5215599990001');
  const savedGoal = (await store.getConversation(goal.id))!;
  assert.ok(savedGoal.goal_completed_at);
  assert.match(savedGoal.report_summary, /equipo debe confirmar/);
  h.setSummary('El cliente pidió atención de un asesor.');
  await h.webhook('Quiero un asesor', { phone: '5215599990002' });
  await waitFor(async () => !!(await h.conversationFor('5215599990002')));
  await h.idle();
  await waitFor(async () => !!(await store.getConversation((await h.conversationFor('5215599990002')).id))!.report_summary);
  const handoff = (await store.getConversation((await h.conversationFor('5215599990002')).id))!;
  assert.equal(handoff.status, 'human');
  assert.match(handoff.report_summary, /pidió atención/);
});

t('el cliente puede pedir un resumen durante la conversación sin terminar el objetivo', async () => {
  h.setScript(req => {
    assert.match(req.messages[0].content, /Si el cliente pide un resumen/);
    assert.ok(req.messages.some(m => m.content.includes('Quiero tacos')));
    return { messages: ['Pediste tacos y el equipo debe confirmar tu pedido.'] };
  });
  const before = h.sent.length;
  await h.webhook('Dame un resumen de lo que hablamos', { phone: '5215599990001' });
  await waitFor(() => h.sent.length > before); await h.idle();
  assert.match(h.sent.at(-1)!.text, /Pediste tacos/);
});

t('si falla la IA al cerrar, mantiene los datos y permite generar el resumen después', async () => {
  await store.insertMessage({ conversation_id: conv.id, direction: 'in', sender: 'customer', content: 'Nueva información tras el reinicio' });
  h.setSummaryError(new Error('Servicio de IA temporalmente no disponible'));
  const closed = await h.authed('POST', `/api/conversations/${conv.id}/close`);
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal(closed.json().status, 'closed');
  const retry = await h.authed('POST', `/api/conversations/${conv.id}/summary`);
  assert.equal(retry.statusCode, 400);
  assert.match(retry.json().error, /temporalmente no disponible/);
  h.setSummaryError(null);
  h.setSummary('Resumen recuperado tras el fallo.');
  const recovered = await h.authed('POST', `/api/conversations/${conv.id}/summary`);
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().report_summary, 'Resumen recuperado tras el fallo.');
  assert.ok((await store.recentMessages(conv.id, 100)).some(m => m.content === 'Nueva información tras el reinicio'));
});


t('eliminar el asistente conserva contacto, conversación y mensajes y permite generar resumen', async () => {
  const before = await store.recentMessages(conv.id, 200);
  const removed = await h.authed('DELETE', `/api/chatbots/${h.botId}`);
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal((await store.getConversation(conv.id))!.chatbot_id, null);
  assert.ok(await store.getContact(conv.contact_id));
  assert.equal((await store.recentMessages(conv.id, 200)).length, before.length);
  await store.insertMessage({ conversation_id: conv.id, direction: 'in', sender: 'customer', content: 'Resumen sin asistente asignado' });
  const report = await h.authed('POST', `/api/conversations/${conv.id}/summary`);
  assert.equal(report.statusCode, 200, report.body);
  assert.equal(report.json().chatbot_id, null);
});
