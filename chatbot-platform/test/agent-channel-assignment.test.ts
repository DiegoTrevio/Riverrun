import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const available = await dbAvailable();
after(async () => { await pool.end(); });

test('reasignar una conexión conserva contactos e historial y usa el nuevo agente sin cambiar los otros teléfonos', { skip: !available && 'PostgreSQL no disponible' }, async () => {
  const h = await createHarness();
  try {
    await h.createBot({ data_fields: [], personality: { prompt: 'AGENTE_ORIGINAL: pregunta el nombre y la dirección para entregar.' } });
    h.setScript(() => ({ messages: ['¿Cuál es tu dirección?'], save_data: [{ field: 'nombre', value: 'Ana' }] }));
    await h.webhook('Soy Ana');
    await waitFor(() => h.sent.length === 1);
    await h.idle();
    const conv = await h.conversationFor();
    const detail = async () => {
      const response = await h.authed('GET', `/api/conversations/${conv.id}`);
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const before = await detail();
    assert.deepEqual(before.contact.data, { nombre: 'Ana' });

    const otherChannel = await h.authed('POST', '/api/channels', { account_id: h.accountId, chatbot_id: h.botId, type: 'whatsapp', name: 'Otro teléfono' });
    assert.equal(otherChannel.statusCode, 200, otherChannel.body);
    const nextBot = await h.authed('POST', '/api/chatbots', {
      account_id: h.accountId, name: 'Entregas', active: true, data_fields: [],
      personality: { prompt: 'AGENTE_ENTREGAS: ayuda a confirmar la dirección de entrega.' }, ai: { debounce_seconds: 0.2 },
    });
    assert.equal(nextBot.statusCode, 200, nextBot.body);
    const updated = await h.authed('PUT', `/api/channels/${h.channelId}`, { chatbot_id: nextBot.json().id });
    assert.equal(updated.statusCode, 200, updated.body);
    const afterAssignment = await detail();
    assert.deepEqual(afterAssignment.contact, before.contact);
    assert.deepEqual(afterAssignment.messages, before.messages);
    assert.deepEqual(afterAssignment.conversation.data, before.conversation.data);

    h.setScript((request) => {
      assert.match(request.messages[0].content, /AGENTE_ENTREGAS/);
      assert.doesNotMatch(request.messages[0].content, /AGENTE_ORIGINAL/);
      assert.match(request.messages[0].content, /nombre: Ana/);
      assert.ok(request.messages.some(m => m.content.includes('¿Cuál es tu dirección?')));
      return { messages: ['Gracias, Ana. Anoté la dirección.'], save_data: [{ field: 'direccion', value: 'Reforma 25' }] };
    });
    await h.webhook('Reforma 25');
    await waitFor(() => h.sent.length === 2);
    await h.idle();
    const afterReply = await detail();
    assert.equal(afterReply.conversation.id, conv.id);
    assert.equal(afterReply.conversation.chatbot_id, nextBot.json().id);
    assert.equal(afterReply.contact.id, before.contact.id);
    assert.deepEqual(afterReply.contact.data, { nombre: 'Ana', direccion: 'Reforma 25' });
    assert.deepEqual(afterReply.conversation.data, afterReply.contact.data);
    for (const message of before.messages) assert.ok(afterReply.messages.some((m: any) => m.id === message.id && m.content === message.content));
    const untouched = await h.authed('GET', `/api/channels/${otherChannel.json().id}`);
    assert.equal(untouched.json().chatbot_id, h.botId);
  } finally { await h.app.close(); }
});
