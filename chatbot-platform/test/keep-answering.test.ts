/**
 * «Avisar al equipo y seguir atendiendo» (modo por omisión): cuando el asistente no puede ayudar, le dice al cliente que
 * alguien del equipo lo contactará, avisa al equipo y SIGUE respondiendo. Nunca se queda callado.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let n = 0;
const nextPhone = () => `52155111${String(++n).padStart(5, '0')}`;
const statusOf = async (phone: string) => (await h.conversationFor(phone))?.status;
const textsTo = (phone: string) => h.sent.filter((s) => s.to === phone).map((s) => s.text);
const notices = async (phone: string) => (await pool.query(`SELECT message FROM event_logs WHERE conversation_id = (SELECT c.id FROM conversations c JOIN contacts k ON k.id = c.contact_id WHERE k.phone = $1 LIMIT 1) AND message LIKE '%el asistente sigue atendiendo%' ORDER BY id`, [phone])).rows.map((r) => r.message as string);
async function customer(text: string, phone: string) {
  await h.webhook(text, { phone });
  await waitFor(async () => !!(await h.conversationFor(phone)), 8000);
  await h.idle();
  await h.service.automator.settleAll();
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ personality: { formality: 'usted' }, rules: { handoff_mode: 'keep_answering' } });
});
after(async () => { if (h) await h.app.close(); await pool.end(); });

t('la IA pasa con una persona: el cliente recibe el aviso, el equipo también, y el asistente sigue respondiendo', async () => {
  const phone = nextPhone();
  h.setScript(() => ({ action: 'handoff', messages: [], handoff_reason: 'Pide un precio que no está cargado' }));
  await customer('¿Cuánto cuesta la reja de 3 metros?', phone);
  assert.deepEqual(textsTo(phone), ['En este momento no le puedo ayudar con eso, pero alguien del equipo le ayudará cuando se ponga en contacto con usted.']);
  assert.equal(await statusOf(phone), 'bot', 'la conversación sigue con el asistente');
  assert.equal((await notices(phone)).length, 1);
  assert.match((await notices(phone))[0], /^Aviso al equipo/);
  // El siguiente mensaje lo contesta el asistente con normalidad.
  h.setScript(() => ({ messages: ['Con gusto le ayudo con lo que necesite.'] }));
  await customer('Gracias, ¿y algo más que deba saber?', phone);
  assert.equal(textsTo(phone).at(-1), 'Con gusto le ayudo con lo que necesite.');
  // Otra cosa que no sabe: responde otra vez, pero el equipo no recibe un segundo aviso (12 horas).
  h.setScript(() => ({ action: 'handoff', messages: ['Eso se lo confirma una persona del equipo cuando lo contacte.'], handoff_reason: 'Otra duda' }));
  await customer('¿Hacen rejas curvas?', phone);
  assert.equal(textsTo(phone).at(-1), 'Eso se lo confirma una persona del equipo cuando lo contacte.');
  const all = await notices(phone);
  assert.equal(all.length, 2);
  assert.match(all[1], /^Pendiente para el equipo \(ya avisado\)/);
});

t('el cliente pide un asesor: se avisa al equipo y el asistente sigue atendiendo', async () => {
  const phone = nextPhone();
  h.setScript(() => ({ messages: ['Con gusto.'] }));
  await customer('Quiero hablar con un asesor', phone);
  assert.equal(textsTo(phone).length, 1);
  assert.match(textsTo(phone)[0], /alguien del equipo le ayudará/);
  assert.equal(await statusOf(phone), 'bot');
  h.setScript(() => ({ messages: ['Claro, la reja Clásica es de acero.'] }));
  await customer('¿De qué material es la Clásica?', phone);
  assert.equal(textsTo(phone).at(-1), 'Claro, la reja Clásica es de acero.');
});

t('si la IA no logra una respuesta válida, el cliente no se queda sin respuesta', async () => {
  const phone = nextPhone();
  h.setScript(() => '{"thinking": "respuesta cortada');
  await customer('Hola, ¿me ayudan?', phone);
  assert.equal(textsTo(phone).length, 1, 'antes: silencio y reintento en 10 minutos');
  assert.match(textsTo(phone)[0], /alguien del equipo le ayudará/);
  assert.equal(await statusOf(phone), 'bot');
});

t('una emergencia sigue pasando a una persona (el asistente se calla)', async () => {
  const phone = nextPhone();
  h.setScript(() => ({ messages: ['No debería salir.'] }));
  await customer('Me quiero morir, ya no aguanto', phone);
  assert.equal(await statusOf(phone), 'human');
});

t('en «Deja de responder» se comporta como antes', async () => {
  const phone = nextPhone();
  const bot = (await h.authed('GET', `/api/chatbots/${h.botId}`)).json();
  await h.authed('PUT', `/api/chatbots/${h.botId}`, { rules: { ...bot.rules, handoff_mode: 'transfer' } });
  try {
    h.setScript(() => ({ action: 'handoff', messages: [] }));
    await customer('¿Cuánto cuesta la reja de 3 metros?', phone);
    assert.equal(await statusOf(phone), 'human');
    assert.match(textsTo(phone)[0], /comunico con alguien del equipo/);
  } finally {
    await h.authed('PUT', `/api/chatbots/${h.botId}`, { rules: { ...bot.rules, handoff_mode: 'keep_answering' } });
  }
});
