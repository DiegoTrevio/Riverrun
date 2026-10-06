import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
after(async () => { await pool.end(); });

test('pregunta, guarda la respuesta automáticamente y reutiliza los datos sin crear campos', { skip: !ok && 'PostgreSQL de pruebas no disponible' }, async () => {
  const h = await createHarness();
  try {
    await h.createBot({ data_fields: [], personality: { prompt: 'Ayuda a tomar pedidos. Pregunta la dirección para entregar.' } });
    h.setScript((req) => {
      assert.match(req.messages[0].content, /Guardado automático de datos/);
      return { action: 'ask', messages: ['¿A qué dirección te lo enviamos?'] };
    });
    await h.webhook('Quiero hacer un pedido');
    await waitFor(() => h.sent.length >= 1);
    await h.idle();
    h.setScript(() => ({ messages: ['Gracias. ¿A nombre de quién?'], save_data: [{ field: 'direccion', value: 'Av. Reforma 25' }] }));
    await h.webhook('Av. Reforma 25');
    await waitFor(() => h.sent.length >= 2);
    await h.idle();
    let conv = await h.conversationFor();
    let detail = (await h.authed('GET', `/api/conversations/${conv.id}`)).json();
    assert.deepEqual(detail.contact.data, { direccion: 'Av. Reforma 25' });
    assert.deepEqual(detail.chatbot.data_fields, []);
    h.setScript((req) => {
      assert.match(req.messages[0].content, /direccion: Av\. Reforma 25/);
      return { messages: ['Gracias, Ana.'], save_data: [{ field: 'nombre', value: 'Ana' }] };
    });
    await h.webhook('Ana');
    await waitFor(() => h.sent.length >= 3);
    await h.idle();
    detail = (await h.authed('GET', `/api/conversations/${conv.id}`)).json();
    assert.equal(detail.contact.name, 'Ana');
    assert.deepEqual(detail.contact.data, { direccion: 'Av. Reforma 25', nombre: 'Ana' });
    h.setScript(() => ({ messages: ['Listo.'], save_data: [{ field: 'direccion', value: 'Av. Reforma 30' }] }));
    await h.webhook('Corrijo la dirección: Av. Reforma 30');
    await waitFor(() => h.sent.length >= 4);
    await h.idle();
    detail = (await h.authed('GET', `/api/conversations/${conv.id}`)).json();
    assert.deepEqual(detail.contact.data, { direccion: 'Av. Reforma 30', nombre: 'Ana' });
  } finally {
    await h.app.close();
  }
});
