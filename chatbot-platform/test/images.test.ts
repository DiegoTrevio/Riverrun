/** Fotos en el momento que decide el negocio: por palabra, bienvenida, etapa, objetivo; envío manual y fallas. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
// El arnés va primero: define las variables de entorno antes de que se cargue la configuración.
import { createHarness, dbAvailable, pool, sleep } from './harness.js';
const { imagesAfterReply } = await import('../src/engine/images.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const IDS: Record<string, string> = {};

const PNG = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C6360000002000154A24F5D0000000049454E44AE426082', 'hex');
async function upload(code: string, name: string, sendWhen: Record<string, unknown>, extra: Record<string, string> = {}) {
  const b = '----x';
  const part = (n: string, v: string) => `--${b}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const fields = { code, name, caption: '', send_when: JSON.stringify(sendWhen), ...extra };
  const body = Buffer.concat([
    Buffer.from(Object.entries(fields).map(([k, v]) => part(k, v)).join('')),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${code}.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  const r = await h.app.inject({ method: 'POST', url: `/api/chatbots/${h.botId}/images`, payload: body, headers: { cookie: h.cookie, 'content-type': `multipart/form-data; boundary=${b}` } });
  assert.equal(r.statusCode, 200, r.body);
  IDS[code] = r.json().id;
  return r.json();
}
const say = async (text: string, phone: string) => {
  const r = await h.webhook(text, { phone });
  assert.equal(r.statusCode, 200, r.body);
  await sleep(350);
  await h.idle();
};
const photosTo = (phone: string) => h.sent.filter((s) => s.kind === 'image' && s.to === phone).map((s) => s.image);
const prompt = () => String(h.calls[h.calls.length - 1].messages[0].content);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ flow: { goal: 'Que el cliente reserve', steps: [{ title: 'Saludo' }, { title: 'Pedir fechas' }] } });
  await upload('menu', 'Menú del día', { mode: 'rules', keywords: ['menú', 'carta'] });
  await upload('bienvenida', 'Bienvenida', { mode: 'rules', first_message: true });
  await upload('mapa', 'Mapa', { mode: 'both', flow_steps: [2] });
  await upload('gracias', 'Gracias', { mode: 'rules', on_goal: true });
  await upload('suite', 'Suite', {}, { usage_rule: 'Cuando pregunten por la suite' });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

test('después de responder: etapa, objetivo y cita; "una sola vez" no repite (función pura)', () => {
  const img = (id: string, send_when: unknown) => ({ id, code: id, name: id, send_when } as any);
  const imgs = [img('a', { mode: 'rules', flow_steps: [2] }), img('b', { mode: 'rules', on_goal: true }), img('c', { mode: 'both', on_booking: true }), img('d', { mode: 'ai', on_booking: true })];
  const pick = (o: Partial<Parameters<typeof imagesAfterReply>[1]>) => imagesAfterReply(imgs, { stepReached: 0, goalReached: false, booked: false, sentIds: [], skip: [], ...o }).map((x) => x.image.id);
  assert.deepEqual(pick({ stepReached: 2 }), ['a']);
  assert.deepEqual(pick({ goalReached: true }), ['b']);
  assert.deepEqual(pick({ booked: true }), ['c'], 'en modo "La IA decide" el sistema no la envía solo');
  assert.deepEqual(pick({ booked: true, sentIds: ['c'] }), [], 'ya enviada');
});

t('bienvenida: sale con la primera respuesta; la IA sabe cuáles se envían solas y no puede elegirlas', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola! Bienvenida.'] }));
  const phone = '5215540000001';
  await say('hola', phone);
  assert.deepEqual(h.sent.filter((s) => s.to === phone).map((s) => s.kind), ['text', 'image'], 'primero el texto y luego la foto');
  assert.deepEqual(photosTo(phone), ['bienvenida']);
  const p = prompt();
  assert.match(p, /El sistema envía estas fotos automáticamente[\s\S]*Menú del día: el cliente escribe "menú" o "carta"/);
  assert.match(p, /Mapa: al llegar a la etapa 2 \(Pedir fechas\)/);
  assert.match(p, /En ESTA respuesta el sistema enviará: Bienvenida/);
  assert.ok(!p.includes('ID: `menu`'), 'las de "solo en estos momentos" no están en el catálogo de la IA');
  assert.ok(p.includes('ID: `suite`') && p.includes('ID: `mapa`'));
  await say('¿qué tal?', phone);
  assert.deepEqual(photosTo(phone), ['bienvenida'], 'solo en la primera respuesta');
});

t('por palabra: "menú" envía la foto aunque la IA no la incluya; se reenvía si la vuelve a pedir', async () => {
  h.reset();
  const phone = '5215540000002';
  await say('hola', phone); // bienvenida
  h.setScript(() => ({ messages: ['Claro, te comparto el menú.'] }));
  await say('¿Me pasas el menú?', phone);
  assert.equal(h.sent.filter((s) => s.kind === 'text').at(-1)!.text, 'Claro, te comparto el menú.', 'no se bloquea como "promesa de foto"');
  assert.deepEqual(photosTo(phone), ['bienvenida', 'menu']);
  h.setScript(() => ({ messages: ['¡Con gusto!'] }));
  await say('gracias', phone);
  assert.deepEqual(photosTo(phone), ['bienvenida', 'menu']);
  await say('mándame otra vez la carta', phone);
  assert.deepEqual(photosTo(phone), ['bienvenida', 'menu', 'menu']);
  const logs = (await pool.query(`SELECT message FROM event_logs WHERE conversation_id = $1`, [(await h.conversationFor(phone)).id])).rows.map((r) => r.message).join('\n');
  assert.match(logs, /Foto enviada por regla: menu \(el cliente escribió "menú"\)/);
});

t('la IA no puede enviar por su cuenta una foto de "solo en estos momentos"', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola!'] }));
  const phone = '5215540000003';
  await say('hola', phone);
  h.setScript(() => ({ action: 'reply_with_image', messages: ['Aquí está.'], image_ids: ['menu', 'suite'] }));
  await say('¿cómo es la suite?', phone);
  assert.deepEqual(photosTo(phone), ['bienvenida', 'suite']);
});

t('etapa del recorrido y objetivo: cada foto sale una sola vez al llegar', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola!'] }));
  const phone = '5215540000004';
  await say('hola', phone);
  h.setScript(() => ({ messages: ['¿Para qué fechas?'], flow_step: 2 }));
  await say('quiero reservar', phone);
  assert.deepEqual(photosTo(phone), ['bienvenida', 'mapa']);
  await say('aún no sé', phone);
  assert.deepEqual(photosTo(phone), ['bienvenida', 'mapa'], 'sigue en la etapa 2: no se repite');
  h.setScript(() => ({ messages: ['¡Listo, reservado!'], flow_step: 2, goal_completed: true }));
  await say('del 3 al 5', phone);
  assert.deepEqual(photosTo(phone), ['bienvenida', 'mapa', 'gracias']);
});

t('si la IA decide no responder, la foto pedida sale igual; en una transferencia no', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola!'] }));
  const phone = '5215540000005';
  await say('hola', phone);
  h.setScript(() => ({ action: 'no_reply', messages: [] }));
  await say('menú', phone);
  assert.deepEqual(photosTo(phone), ['bienvenida', 'menu']);
  h.setScript(() => ({ action: 'handoff', messages: ['Te paso con alguien.'], handoff_reason: 'quiere pagar' }));
  await say('quiero pagar, y mándame el menú', phone);
  assert.deepEqual(photosTo(phone), ['bienvenida', 'menu'], 'al transferir no se envía');
});

t('envío manual desde la conversación: el agente manda una foto; otra cuenta o desactivada no', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola!'] }));
  const phone = '5215540000006';
  await say('hola', phone);
  const conv = await h.conversationFor(phone);
  assert.equal((await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'agente@hotel.mx', name: 'Agente', password: 'clave-segura-1', role: 'agent' })).statusCode, 200);
  const agent = await h.loginAs('agente@hotel.mx', 'clave-segura-1');
  assert.equal((await agent('GET', `/api/chatbots/${h.botId}/images`)).statusCode, 200, 'el agente ve el catálogo');
  const r = await agent('POST', `/api/conversations/${conv.id}/send-image`, { image_id: IDS.suite });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().sender, 'human');
  assert.equal(r.json().image_id, IDS.suite);
  assert.deepEqual(photosTo(phone), ['bienvenida', 'suite']);
  assert.equal((await h.authed('GET', `/api/conversations/${conv.id}`)).json().conversation.status, 'human', 'como el texto manual: toma la conversación');

  // Foto de otra cuenta → 404; desactivada → 400 (y no toma la conversación).
  const acc = (await h.authed('POST', '/api/accounts', { name: 'Otra' })).json();
  const bot = (await h.authed('POST', '/api/chatbots', { account_id: acc.id, name: 'Otro' })).json();
  const foreign = (await pool.query(`INSERT INTO images (chatbot_id, code, name, file_path, mime_type) VALUES ($1,'x','X','x.png','image/png') RETURNING id`, [bot.id])).rows[0].id;
  assert.equal((await agent('POST', `/api/conversations/${conv.id}/send-image`, { image_id: foreign })).statusCode, 404);
  await pool.query(`UPDATE images SET active = false WHERE id = $1`, [IDS.mapa]);
  const off = await agent('POST', `/api/conversations/${conv.id}/send-image`, { image_id: IDS.mapa });
  assert.equal(off.statusCode, 400);
  assert.match(off.json().error, /desactivada/);
  await pool.query(`UPDATE images SET active = true WHERE id = $1`, [IDS.mapa]);
});

t('si WhatsApp rechaza la foto: queda como fallida, en Registros, y el panel muestra el error', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola!'] }));
  const phone = '5215540000007';
  await say('hola', phone);
  const conv = await h.conversationFor(phone);
  h.failNext.image = 1;
  const r = await h.authed('POST', `/api/conversations/${conv.id}/send-image`, { image_id: IDS.suite, takeover: false });
  assert.equal(r.statusCode, 400);
  const msg = (await pool.query(`SELECT status FROM messages WHERE conversation_id = $1 AND image_id = $2`, [conv.id, IDS.suite])).rows[0];
  assert.equal(msg.status, 'failed');
  const logs = (await pool.query(`SELECT message FROM event_logs WHERE conversation_id = $1`, [conv.id])).rows.map((x) => x.message).join('\n');
  assert.match(logs, /No se pudo enviar la imagen suite \(whatsapp\): Evolution sendMedia → HTTP 400/);
  // Una foto fallida no cuenta como enviada: la siguiente vez sí sale.
  assert.equal((await h.authed('POST', `/api/conversations/${conv.id}/send-image`, { image_id: IDS.suite, takeover: false })).statusCode, 200);
});

t('probador de palabras: dice qué foto se enviaría', async () => {
  const r = (await h.authed('POST', `/api/chatbots/${h.botId}/test-message`, { text: '¿tienen carta?', first_message: false })).json();
  assert.ok(r.steps.some((s: any) => s.kind === 'images' && /"Menú del día" \(el cliente escribió "carta"\)/.test(s.detail)), JSON.stringify(r.steps));
});
