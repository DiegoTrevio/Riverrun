/**
 * Flujos con botones: 3 mensajes con un día de separación; cada botón hace lo suyo (seguir ya, terminar, otro flujo,
 * etiqueta, pasar con una persona) y la IA no contesta el toque; "esperar a que elija"; números solo si los botones son
 * lo último que se envió; un toque cuenta una vez; BAJA gana; una persona que toma la conversación detiene el flujo; y
 * los botones nativos de Telegram y del chat web.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, ext, pool, store, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let phoneN = 5215520000000;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['respuesta de la IA'] }));
  // Los flujos son promoción: en estas pruebas no se pide el consentimiento previo.
  const s = (await h.authed('GET', `/api/settings?account_id=${h.accountId}`)).json();
  assert.equal((await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { consent: { ...s.consent, require_for_campaigns: false } })).statusCode, 200);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

const flow = async (steps: unknown[], extra: Record<string, unknown> = {}) => {
  const r = await h.authed('POST', '/api/sequences', { account_id: h.accountId, name: `Flujo ${Math.random()}`, business_hours_only: false, stop_on_reply: true, steps, ...extra });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
/** Un cliente de WhatsApp (QR: botones numerados) que ya escribió, inscrito en el flujo. */
const customer = async (seqId: string) => {
  const phone = String(++phoneN);
  await h.webhook('hola', { phone });
  await waitFor(() => h.sent.some((s) => s.to === phone));
  await h.idle();
  const conv = await h.conversationFor(phone);
  const en = await h.authed('POST', `/api/conversations/${conv.id}/sequences`, { sequence_id: seqId });
  assert.equal(en.statusCode, 200, en.body);
  return { phone, conv, enrollment: en.json() };
};
const textsTo = (phone: string) => h.sent.filter((s) => s.to === phone).map((s) => s.text);
const enrollment = async (id: string) => (await pool.query(`SELECT status, stop_reason, choice, choice_step, current_step FROM sequence_enrollments WHERE id = $1`, [id])).rows[0];
const say = async (phone: string, text: string) => {
  await h.webhook(text, { phone });
  await h.idle();
};
const buttons = [
  { label: 'Sí, me interesa', action: 'next', reply: '¡Genial! Te cuento más 👇' },
  { label: 'No, gracias', action: 'end', reply: 'Entendido, no te molestamos más.' },
  { label: 'Hablar con alguien', action: 'handoff' },
];
const threeDays = (b = buttons, step1: Record<string, unknown> = {}) => flow([
  { delay_value: 0, delay_unit: 'minutes', text: 'Hola {{nombre}}, ¿te interesa nuestra promoción?', buttons: b, ...step1 },
  { delay_value: 1, delay_unit: 'days', text: 'Paso 2: estos son los detalles' },
  { delay_value: 1, delay_unit: 'days', text: 'Paso 3: último recordatorio' },
]);

t('3 mensajes con 1 día de separación; "1" sigue ya con el paso 2, sin IA y sin detener el flujo', async () => {
  const seq = await threeDays();
  const c = await customer(seq.id);
  await h.fastForward();
  const first = textsTo(c.phone).at(-1)!;
  assert.equal(first, 'Hola Ana, ¿te interesa nuestra promoción?\n\n1. Sí, me interesa\n2. No, gracias\n3. Hablar con alguien\n\nResponde con el número de tu opción.\n\nResponde BAJA para dejar de recibir estos mensajes.');
  const aiBefore = h.calls.length;
  await say(c.phone, '1');
  assert.equal(h.calls.length, aiBefore, 'la IA no contesta el toque');
  assert.deepEqual(textsTo(c.phone).slice(-2).map((x) => x.split('\n')[0]), ['¡Genial! Te cuento más 👇', 'Paso 2: estos son los detalles']);
  const e = await enrollment(c.enrollment.id);
  assert.deepEqual([e.status, e.choice, e.choice_step, e.current_step], ['active', 'Sí, me interesa', 0, 2]);
  const inbound = (await pool.query(`SELECT meta FROM messages WHERE conversation_id = $1 AND direction = 'in' ORDER BY id DESC LIMIT 1`, [c.conv.id])).rows[0];
  assert.equal(inbound.meta.choice, 'Sí, me interesa', 'el panel ve qué eligió');
  // El paso 2 programado para mañana ya no sale (salió al tocar); el 3 sale un día después.
  await h.fastForward();
  const all = textsTo(c.phone);
  assert.equal(all.filter((x) => x.startsWith('Paso 2')).length, 1);
  assert.equal(all.filter((x) => x.startsWith('Paso 3')).length, 1);
  assert.equal((await enrollment(c.enrollment.id)).status, 'completed');
});

t('"no, gracias" escrito termina el flujo; un segundo toque no repite nada', async () => {
  const seq = await threeDays();
  const c = await customer(seq.id);
  await h.fastForward();
  const aiBefore = h.calls.length;
  await say(c.phone, 'no gracias');
  await say(c.phone, 'No, gracias');
  assert.equal(h.calls.length, aiBefore);
  assert.equal(textsTo(c.phone).filter((x) => x === 'Entendido, no te molestamos más.').length, 1);
  const e = await enrollment(c.enrollment.id);
  assert.deepEqual([e.status, e.stop_reason], ['stopped', 'el cliente eligió "No, gracias"']);
  await h.fastForward();
  assert.ok(!textsTo(c.phone).some((x) => x.startsWith('Paso 2')));
});

t('después de otro mensaje un número ya no es una opción (la IA lo contesta); el texto del botón sí', async () => {
  const seq = await flow([
    { delay_value: 0, delay_unit: 'minutes', text: '¿Te interesa?', buttons },
    { delay_value: 1, delay_unit: 'days', text: 'Paso 2: estos son los detalles' },
  ], { stop_on_reply: false });
  const c = await customer(seq.id);
  await h.fastForward();
  const aiBefore = h.calls.length;
  await say(c.phone, '¿cuánto cuesta?');
  await say(c.phone, '2');
  assert.equal(h.calls.length, aiBefore + 2, 'los dos los contesta la IA');
  assert.deepEqual([(await enrollment(c.enrollment.id)).status, (await enrollment(c.enrollment.id)).choice], ['active', '']);
  await say(c.phone, 'Sí, me interesa');
  assert.equal(h.calls.length, aiBefore + 2);
  assert.equal((await enrollment(c.enrollment.id)).choice, 'Sí, me interesa');
});

t('una persona que escribe desde el panel toma la conversación: el flujo se detiene al momento', async () => {
  const seq = await threeDays();
  const c = await customer(seq.id);
  await h.fastForward();
  const sent = await h.authed('POST', `/api/conversations/${c.conv.id}/send`, { text: 'Te escribe Lucía del hotel' });
  assert.equal(sent.statusCode, 200, sent.body);
  const e = await enrollment(c.enrollment.id);
  assert.deepEqual([e.status, e.stop_reason], ['stopped', 'una persona tomó la conversación']);
  await h.fastForward();
  assert.ok(!textsTo(c.phone).some((x) => x.startsWith('Paso 2')));
});

t('pasar con una persona: la conversación queda con el equipo y el flujo se detiene al momento', async () => {
  const seq = await threeDays();
  const c = await customer(seq.id);
  await h.fastForward();
  await say(c.phone, 'Hablar con alguien');
  assert.equal((await store.getConversation(c.conv.id))!.status, 'human');
  const e = await enrollment(c.enrollment.id);
  assert.deepEqual([e.status, e.stop_reason], ['stopped', 'una persona tomó la conversación']);
  assert.equal((await pool.query(`SELECT pending_buttons FROM conversations WHERE id = $1`, [c.conv.id])).rows[0].pending_buttons, null);
});

t('etiqueta y otro flujo; BAJA gana a los botones', async () => {
  const other = await flow([{ delay_value: 0, delay_unit: 'minutes', text: 'Flujo VIP: bienvenido' }]);
  const seq = await threeDays([
    { label: 'Soy VIP', action: 'tag', tag: 'vip' },
    { label: 'Ver opciones VIP', action: 'start_sequence', sequence_id: other.id },
  ] as any);
  const c = await customer(seq.id);
  await h.fastForward();
  await say(c.phone, 'soy vip');
  const contact = (await h.authed('GET', `/api/conversations/${c.conv.id}`)).json().contact;
  assert.deepEqual(contact.tags, ['vip']);
  assert.equal((await enrollment(c.enrollment.id)).status, 'active', 'una etiqueta no termina el flujo');
  // El juego ya se usó: lo demás es un mensaje normal. Uno nuevo con botones: "otro flujo".
  const c2 = await customer(seq.id);
  await h.fastForward();
  await say(c2.phone, '2');
  assert.equal((await enrollment(c2.enrollment.id)).status, 'stopped');
  await h.fastForward();
  assert.ok(textsTo(c2.phone).includes('Flujo VIP: bienvenido\n\nResponde BAJA para dejar de recibir estos mensajes.'));
  // BAJA: el cliente se da de baja aunque haya botones.
  const c3 = await customer(seq.id);
  await h.fastForward();
  await say(c3.phone, 'BAJA');
  const e3 = await enrollment(c3.enrollment.id);
  assert.deepEqual([e3.status, e3.stop_reason], ['stopped', 'el cliente se dio de baja']);
});

t('esperar a que elija: sin elección se termina (o sigue, si así se configuró)', async () => {
  const ends = await threeDays(buttons, { wait_for_choice: true, if_no_choice: 'end' });
  const c = await customer(ends.id);
  await h.fastForward();
  await h.fastForward();
  const e = await enrollment(c.enrollment.id);
  assert.deepEqual([e.status, e.stop_reason], ['stopped', 'el cliente no eligió una opción']);
  assert.ok(!textsTo(c.phone).some((x) => x.startsWith('Paso 2')));
  const goes = await threeDays(buttons, { wait_for_choice: true, if_no_choice: 'continue' });
  const c2 = await customer(goes.id);
  await h.fastForward();
  await h.fastForward();
  assert.ok(textsTo(c2.phone).some((x) => x.startsWith('Paso 2')));
});

t('el editor valida: flujo de otro negocio, botones que se confunden con BAJA', async () => {
  const otherAcc = (await h.authed('POST', '/api/accounts', { name: 'Otro negocio' })).json();
  const foreign = (await h.authed('POST', '/api/sequences', { account_id: otherAcc.id, name: 'Ajeno', steps: [{ text: 'x' }] })).json();
  const bad = await h.authed('POST', '/api/sequences', { account_id: h.accountId, name: 'x', steps: [{ text: 'Hola', buttons: [{ label: 'Ir', action: 'start_sequence', sequence_id: foreign.id }] }] });
  assert.equal(bad.statusCode, 400);
  const baja = await h.authed('POST', '/api/sequences', { account_id: h.accountId, name: 'x', steps: [{ text: 'Hola', buttons: [{ label: 'Baja', action: 'end' }] }] });
  assert.equal(baja.statusCode, 400);
  assert.match(baja.json().error, /darse de baja/);
});

t('Telegram: botones debajo del mensaje; el toque llega por callback y se confirma', async () => {
  const tg = (await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'telegram', name: 'Telegram', chatbot_id: h.botId, config: { bot_token: '555:TG' } })).json();
  const secret = (await store.getChannel(tg.id))!.config.secret;
  const post = (payload: unknown) => h.app.inject({ method: 'POST', url: `/webhook/${tg.webhook_token}`, headers: { 'x-telegram-bot-api-secret-token': secret }, payload: payload as any });
  await post({ update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 4242, type: 'private' }, from: { id: 4242, first_name: 'Luis' }, text: 'hola' } });
  await h.idle();
  const conv = (await pool.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = '4242'`)).rows[0];
  const seq = await threeDays([...buttons.slice(0, 2), { label: 'Ver menú', kind: 'url', url: 'https://hotel.test/menu' }] as any);
  ext.requests.length = 0;
  assert.equal((await h.authed('POST', `/api/conversations/${conv.id}/sequences`, { sequence_id: seq.id })).statusCode, 200);
  await h.fastForward();
  const sent = ext.requests.filter((r) => r.path.endsWith('/sendMessage')).at(-1)!;
  const keyboard = sent.body.reply_markup.inline_keyboard.flat();
  assert.equal(sent.body.text, 'Hola Luis, ¿te interesa nuestra promoción?\n\nResponde BAJA para dejar de recibir estos mensajes.');
  assert.deepEqual(keyboard.map((b: any) => b.text), ['Sí, me interesa', 'No, gracias', 'Ver menú']);
  assert.equal(keyboard[2].url, 'https://hotel.test/menu');
  assert.match(keyboard[0].callback_data, /^rr:[a-f0-9]{10}:1$/);
  const aiBefore = h.calls.length;
  await post({ update_id: 2, callback_query: { id: 'cbq1', from: { id: 4242, first_name: 'Luis' }, data: keyboard[0].callback_data, message: { message_id: 9, chat: { id: 4242, type: 'private' }, reply_markup: sent.body.reply_markup } } });
  await h.idle();
  await waitFor(() => ext.requests.some((r) => r.path.endsWith('/answerCallbackQuery')));
  assert.equal(h.calls.length, aiBefore);
  const texts = ext.requests.filter((r) => r.path.endsWith('/sendMessage')).map((r) => r.body.text);
  assert.ok(texts.some((x) => x.startsWith('Paso 2')), JSON.stringify(texts));
  const last = (await pool.query(`SELECT content, meta FROM messages WHERE conversation_id = $1 AND direction = 'in' ORDER BY id DESC LIMIT 1`, [conv.id])).rows[0];
  assert.deepEqual([last.content, last.meta.choice], ['Sí, me interesa', 'Sí, me interesa']);
});

t('chat web: el widget recibe los botones y el toque sigue el flujo', async () => {
  const web = (await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'webchat', name: 'Web', chatbot_id: h.botId, config: {} })).json();
  const base = `/webchat/${web.webhook_token}`;
  const { session } = (await h.app.inject({ method: 'POST', url: `${base}/session` })).json();
  await h.app.inject({ method: 'POST', url: `${base}/messages`, payload: { session, text: 'hola' } });
  await h.idle();
  const conv = (await pool.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = $1`, [session])).rows[0];
  const seq = await threeDays();
  await h.authed('POST', `/api/conversations/${conv.id}/sequences`, { sequence_id: seq.id });
  await h.fastForward();
  const msgs = (await h.app.inject({ method: 'GET', url: `${base}/messages?session=${session}` })).json().messages;
  const withButtons = msgs.at(-1);
  assert.deepEqual(withButtons.buttons.map((b: any) => b.label), ['Sí, me interesa', 'No, gracias', 'Hablar con alguien']);
  // Un identificador inventado no cuenta como toque.
  await h.app.inject({ method: 'POST', url: `${base}/messages`, payload: { session, text: 'Sí, me interesa', button: 'rr:0000000000:1' } });
  await h.idle();
  assert.notEqual((await pool.query(`SELECT choice FROM sequence_enrollments WHERE conversation_id = $1`, [conv.id])).rows[0].choice, 'Sí, me interesa');
});

t('enviar un flujo a un grupo: cada persona entra al flujo, el primer paso sale con la campaña y los siguientes espaciados; cancelar lo detiene', async () => {
  const seq = await flow([
    { delay_value: 0, delay_unit: 'minutes', text: 'Promo grupo: ¿te interesa?', buttons: buttons.slice(0, 2) },
    { delay_value: 1, delay_unit: 'days', text: 'Promo grupo: paso 2' },
  ], { stop_on_reply: false });
  const phones = [String(++phoneN), String(++phoneN), String(++phoneN)];
  for (const phone of phones) {
    await h.webhook('hola', { phone });
    await waitFor(() => h.sent.some((s) => s.to === phone));
  }
  await h.idle();
  const tag = `grupo${Date.now()}`;
  for (const phone of phones) {
    const conv = await h.conversationFor(phone);
    const contact = (await h.authed('GET', `/api/conversations/${conv.id}`)).json().contact;
    await h.authed('PUT', `/api/contacts/${contact.id}`, { tags: [tag] });
  }
  const camp = await h.authed('POST', '/api/campaigns', { account_id: h.accountId, channel_id: h.channelId, name: 'Flujo al grupo', kind: 'sequence', sequence_id: seq.id, audience: { tags_any: [tag] }, rate_per_minute: 6, business_hours_only: false });
  assert.equal(camp.statusCode, 200, camp.body);
  const preview = (await h.authed('POST', `/api/campaigns/${camp.json().id}/preview`, {})).json();
  assert.deepEqual([preview.count, preview.messages_per_person, preview.total_messages], [3, 2, 6]);
  assert.equal((await h.authed('POST', `/api/campaigns/${camp.json().id}/launch`, {})).statusCode, 200);
  await h.fastForward();
  for (const phone of phones) assert.ok(textsTo(phone).some((x) => x.startsWith('Promo grupo: ¿te interesa?\n\n1. Sí, me interesa')), phone);
  const ens = (await pool.query(`SELECT id, status, pace_ms FROM sequence_enrollments WHERE campaign_id = $1`, [camp.json().id])).rows;
  assert.deepEqual(ens.map((e) => [e.status, e.pace_ms]), [['active', 10000], ['active', 10000], ['active', 10000]]);
  const recipients = (await h.authed('GET', `/api/campaigns/${camp.json().id}/recipients`)).json();
  assert.ok(recipients.every((r: any) => r.status === 'sent'), JSON.stringify(recipients));
  // Un día después: el paso 2 no sale de golpe para todos (uno ya; los demás, en su turno).
  await h.fastForward();
  const step2 = () => phones.filter((p) => textsTo(p).some((x) => x.startsWith('Promo grupo: paso 2'))).length;
  assert.equal(step2(), 1);
  const waiting = (await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE type = 'sequence_step' AND status = 'pending' AND (payload->>'paced')::boolean AND payload->>'enrollment_id' = ANY($1::text[])`, [ens.map((e) => e.id)])).rows[0].n;
  assert.equal(waiting, 2);
  // Cancelar la campaña detiene los flujos que faltan.
  assert.equal((await h.authed('POST', `/api/campaigns/${camp.json().id}/cancel`, {})).statusCode, 200);
  const after = (await pool.query(`SELECT status, stop_reason FROM sequence_enrollments WHERE campaign_id = $1 AND status <> 'completed'`, [camp.json().id])).rows;
  assert.ok(after.length === 2 && after.every((e) => e.status === 'stopped' && e.stop_reason === 'campaña cancelada'), JSON.stringify(after));
  await h.fastForward();
  assert.equal(step2(), 1);
});
