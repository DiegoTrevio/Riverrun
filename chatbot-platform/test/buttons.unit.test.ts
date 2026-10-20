/**
 * Botones de los flujos sin base de datos: cómo sale el mensaje en cada canal, cómo se reconoce la opción elegida y qué
 * acepta el editor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buttonPayload, composeButtons, matchChoice, parsePayload } from '../src/automation/buttons.js';
import { SequenceStepSchema } from '../src/automation/types.js';

const step = (buttons: unknown[]) => SequenceStepSchema.safeParse({ text: 'Hola', buttons });
const reply = (label: string, extra: Record<string, unknown> = {}) => ({ label, kind: 'reply', action: 'next', ...extra });
const url = (label: string, href = 'https://hotel.test/menu') => ({ label, kind: 'url', url: href });
const parsed = (list: unknown[]) => SequenceStepSchema.parse({ text: 'x', buttons: list }).buttons;

test('el editor: 3 de respuesta y 2 de enlace como máximo, enlaces https, acciones completas, sin repetidos ni solo números', () => {
  assert.ok(step([reply('Sí'), reply('No'), reply('Luego'), url('Menú'), url('Mapa', 'https://maps.test')]).success);
  assert.ok(!step([reply('A'), reply('B'), reply('C'), reply('D')]).success, 'cuarto botón de respuesta');
  assert.ok(!step([url('A'), url('B'), url('C')]).success, 'tercer enlace');
  assert.ok(!step([url('Menú', 'http://hotel.test')]).success, 'enlace sin https');
  assert.ok(!step([url('Menú', 'javascript:alert(1)')]).success);
  assert.ok(!step([reply('Sí'), reply('si ✅')]).success, 'dos botones que dicen lo mismo');
  assert.ok(!step([reply('2')]).success, 'solo un número');
  assert.ok(!step([reply('Este texto es demasiado largo')]).success, 'más de 20 caracteres');
  assert.ok(!step([reply('Otro flujo', { action: 'start_sequence' })]).success, 'sin flujo destino');
  assert.ok(!step([reply('VIP', { action: 'tag' })]).success, 'sin etiqueta');
  // Los pasos que ya existían (sin botones) se leen igual.
  const old = SequenceStepSchema.parse({ text: 'Hola' });
  assert.deepEqual([old.buttons, old.wait_for_choice, old.if_no_choice], [[], false, 'end']);
});

test('identificador del toque: solo el formato propio', () => {
  assert.deepEqual(parsePayload(buttonPayload('abcdef0123', 2)), { set: 'abcdef0123', n: 2 });
  for (const bad of ['rr:abc:1', 'rr:abcdef0123:0', 'rr:abcdef0123:12', 'otro', '', null]) assert.equal(parsePayload(bad as any), null, String(bad));
});

test('cómo sale en cada canal: nativo, burbuja de Meta, WhatsApp oficial o numerado', () => {
  const buttons = parsed([reply('Sí, quiero'), reply('No, gracias'), url('Ver menú')]);
  const set = 'abcdef0123';
  // Telegram, chat web y simulador: todos los botones, el texto tal cual.
  for (const type of ['telegram', 'webchat', 'playground']) {
    const r = composeButtons({ type, config: {} } as any, 'Hola', buttons, set);
    assert.equal(r.text, 'Hola');
    assert.deepEqual(r.buttons.map((b) => [b.kind, b.label, b.payload ?? b.url]), [['reply', 'Sí, quiero', 'rr:abcdef0123:1'], ['reply', 'No, gracias', 'rr:abcdef0123:2'], ['url', 'Ver menú', 'https://hotel.test/menu']]);
  }
  // Messenger/Instagram: 3 botones caben en la burbuja; con un texto largo, respuestas rápidas y el enlace en el texto.
  assert.equal(composeButtons({ type: 'messenger', config: {} } as any, 'Hola', buttons, set).buttons.length, 3);
  const long = composeButtons({ type: 'zernio', config: { platform: 'instagram' } } as any, 'x'.repeat(700), buttons, set);
  assert.deepEqual(long.buttons.map((b) => b.kind), ['reply', 'reply']);
  assert.match(long.text, /🔗 Ver menú: https:\/\/hotel\.test\/menu$/);
  // WhatsApp oficial: botones de respuesta; el enlace va en el texto.
  const wa = composeButtons({ type: 'zernio', config: { platform: 'whatsapp' } } as any, 'Hola', buttons, set);
  assert.deepEqual([wa.text, wa.buttons.length], ['Hola\n\n🔗 Ver menú: https://hotel.test/menu', 2]);
  // WhatsApp por QR, correo y redes sin botones: numerados.
  for (const ch of [{ type: 'whatsapp', config: {} }, { type: 'email', config: {} }, { type: 'zernio', config: { platform: 'twitter' } }]) {
    const r = composeButtons(ch as any, 'Hola', buttons, set);
    assert.deepEqual(r.buttons, []);
    assert.equal(r.text, 'Hola\n\n1. Sí, quiero\n2. No, gracias\n\n🔗 Ver menú: https://hotel.test/menu\n\nResponde con el número de tu opción.');
  }
});

test('reconocer la opción: etiqueta siempre; número solo si el mensaje con botones es el último', () => {
  const labels = ['Sí, quiero', 'No, gracias', 'Más tarde ⏰'];
  for (const [text, n] of [['si quiero', 1], ['SÍ, QUIERO!', 1], ['mas tarde', 3], ['1', 1], ['2.', 2], ['#3', 3], ['opción 2', 2], ['la segunda', 2], ['el primero', 1], ['uno', 1], ['3️⃣', 3], ['1. Sí, quiero', 1]] as const) {
    assert.equal(matchChoice(text, labels, true), n, text);
  }
  for (const text of ['4', '0', 'sí', 'quiero saber el precio', '2 personas', '2. Sí, quiero', '', 'x'.repeat(80)]) assert.equal(matchChoice(text, labels, true), null, text);
  // Después de otro mensaje, un "1" ya no se refiere a los botones; el texto del botón sí.
  assert.equal(matchChoice('1', labels, false), null);
  assert.equal(matchChoice('3️⃣', labels, false), null);
  assert.equal(matchChoice('No, gracias', labels, false), 2);
});

test('el toque llega de cada plataforma con su identificador (y nunca en un eco)', async () => {
  const { parseZernioEvent } = await import('../src/channels/zernio.js');
  const { adapterFor } = await import('../src/channels/index.js');
  const zernio = (metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) => parseZernioEvent({
    event: 'message.received', message: { id: 'z1', conversationId: 'c1', platformMessageId: 'p1', direction: 'incoming', text: 'Sí, quiero', ...extra }, metadata,
  }).messages[0];
  assert.equal(zernio({ interactiveType: 'button_reply', interactiveId: 'rr:abcdef0123:1' }).payload, 'rr:abcdef0123:1', 'WhatsApp oficial');
  assert.equal(zernio({ quickReplyPayload: 'rr:abcdef0123:2' }).payload, 'rr:abcdef0123:2', 'respuesta rápida');
  assert.equal(zernio({ callbackData: 'rr:abcdef0123:3' }).payload, 'rr:abcdef0123:3', 'Telegram');
  assert.deepEqual([zernio({ postbackPayload: 'rr:abcdef0123:1', postbackTitle: 'Sí, quiero' }, { text: '' }).text], ['Sí, quiero'], 'el texto del botón cuando no viene texto');
  assert.equal(parseZernioEvent({ event: 'message.sent', message: { id: 'z2', conversationId: 'c1', platformMessageId: 'p2', text: 'x' }, metadata: { quickReplyPayload: 'rr:abcdef0123:1' } }).messages[0].payload, undefined);

  const meta = adapterFor('messenger').parse({ channel: { config: { page_id: 'PG' } } as any, headers: {}, query: {}, body: {
    object: 'page', entry: [{ id: 'PG', messaging: [
      { sender: { id: 'u1' }, recipient: { id: 'PG' }, timestamp: Date.now(), message: { mid: 'm1', text: 'No, gracias', quick_reply: { payload: 'rr:abcdef0123:2' } } },
      { sender: { id: 'u1' }, recipient: { id: 'PG' }, timestamp: Date.now(), postback: { mid: 'm2', title: 'Sí, quiero', payload: 'rr:abcdef0123:1' } },
    ] }],
  } }).messages;
  assert.deepEqual(meta.map((m) => [m.text, m.payload]), [['No, gracias', 'rr:abcdef0123:2'], ['Sí, quiero', 'rr:abcdef0123:1']]);

  const tg = adapterFor('telegram').parse({ channel: { config: {} } as any, headers: {}, query: {}, body: {
    callback_query: { id: 'q1', from: { id: 7, first_name: 'Luis' }, data: 'rr:abcdef0123:1', message: { message_id: 3, chat: { id: 7, type: 'private' }, reply_markup: { inline_keyboard: [[{ text: 'Sí, quiero', callback_data: 'rr:abcdef0123:1' }]] } } },
  } }).messages[0];
  assert.deepEqual([tg.text, tg.payload, tg.externalId], ['Sí, quiero', 'rr:abcdef0123:1', '7']);
});

test('modo de pruebas: los botones también pasan por el control de destino', async () => {
  const { guardTransport, OutboundBlockedError } = await import('../src/outbound-guard.js');
  const { config } = await import('../src/config.js');
  const prev = { mode: config.outbound.mode, allow: config.outbound.allow };
  let sent = 0;
  const t = guardTransport({ kind: 'telegram', sendText: async () => 'x', sendImage: async () => 'x', notify: async () => {}, sendButtons: async () => { sent++; return 'b'; } } as any, '5215500000000');
  try {
    Object.assign(config.outbound, { mode: 'sandbox', allow: [] });
    await assert.rejects(() => t.sendButtons!('Hola', [{ kind: 'reply', label: 'Sí', payload: 'rr:abcdef0123:1' }], 0), OutboundBlockedError);
    assert.equal(sent, 0);
  } finally {
    Object.assign(config.outbound, prev);
  }
});
