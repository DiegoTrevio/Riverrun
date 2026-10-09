/** Cuando una persona escribe (teléfono o panel) o el asistente/una regla la pasa: el asistente se calla y queda registrado en el contacto. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

const handoffOf = async (phone: string) => (await pool.query(`SELECT handoff_at, handoff_by, handoff_via FROM contacts WHERE phone = $1`, [phone])).rows[0];
const statusOf = async (phone: string) => (await h.conversationFor(phone))?.status;
/** Mensaje del cliente, esperando a que el asistente termine de procesarlo. */
async function customer(text: string, phone: string) {
  await h.webhook(text, { phone });
  await waitFor(async () => !!(await h.conversationFor(phone)), 8000);
  await h.idle();
  await h.service.automator.settleAll();
}
/** Mensaje escrito desde el teléfono del negocio por una persona (no por el asistente). */
async function person(text: string, phone: string) {
  await h.webhook(text, { phone, fromMe: true });
  await h.idle();
  await h.service.automator.settleAll();
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['Con gusto te ayudo.'] }));
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('un mensaje escrito desde el teléfono pausa al asistente, aunque la conversación esté cerrada, y queda en el contacto', async () => {
  const phone = '5215530000201';
  await customer('hola, quiero información', phone);
  const conv = await h.conversationFor(phone);
  assert.equal((await h.authed('POST', `/api/conversations/${conv.id}/close`, {})).statusCode, 200);
  assert.equal(await statusOf(phone), 'closed');
  h.reset();
  await person('Hola, soy Ana de la clínica, te confirmo tu cita', phone);
  assert.equal(await statusOf(phone), 'human');
  const hf = await handoffOf(phone);
  assert.equal(hf.handoff_via, 'telefono');
  assert.equal(hf.handoff_by, null, 'desde el teléfono no hay usuario del panel');
  assert.ok(hf.handoff_at, 'queda la fecha');
  // Mientras atiende una persona, el asistente no contesta al siguiente mensaje del cliente.
  h.reset();
  await customer('ok, gracias', phone);
  assert.equal(h.sent.filter((s) => s.to === phone).length, 0, 'el asistente se calla');
});

t('responder desde el panel deja registrado quién atendió y desde dónde', async () => {
  const phone = '5215530000202';
  await customer('necesito una cotización', phone);
  const conv = await h.conversationFor(phone);
  const me = (await h.authed('GET', '/api/me')).json().user;
  assert.equal((await h.authed('POST', `/api/conversations/${conv.id}/send`, { text: 'Te preparo la cotización' })).statusCode, 200);
  const hf = await handoffOf(phone);
  assert.equal(hf.handoff_via, 'panel');
  assert.equal(hf.handoff_by, me.id, 'queda la persona que escribió');
  // La ficha de la conversación muestra el nombre de esa persona.
  const detail = (await h.authed('GET', `/api/conversations/${conv.id}`)).json();
  assert.equal(detail.handoff_by_user.id, me.id);
  assert.equal(detail.handoff_by_user.name, me.name);
});

t('con la opción apagada, lo que escribe una persona desde el teléfono no pausa al asistente', async () => {
  assert.equal((await h.authed('PUT', `/api/chatbots/${h.botId}`, { rules: { pause_on_human_reply: false } })).statusCode, 200);
  try {
    const phone = '5215530000203';
    await customer('hola', phone);
    await person('Le contesto yo después', phone);
    assert.equal(await statusOf(phone), 'bot');
    assert.equal((await handoffOf(phone)).handoff_via, '');
  } finally {
    assert.equal((await h.authed('PUT', `/api/chatbots/${h.botId}`, { rules: { pause_on_human_reply: true } })).statusCode, 200);
  }
});

t('si una persona escribe mientras la IA responde, la respuesta en curso ya no sale', async () => {
  const phone = '5215530000204';
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  h.setScript(async () => {
    await gate;
    return { messages: ['Claro, lo reviso y te aviso.'] };
  });
  h.reset();
  try {
    await h.webhook('¿tienen habitaciones dobles?', { phone });
    await waitFor(() => h.calls.length >= 1, 8000); // la IA ya está respondiendo
    await h.webhook('Yo le contesto, un momento', { phone, fromMe: true });
    await waitFor(async () => (await statusOf(phone)) === 'human', 8000); // la pausa queda antes de que siga la respuesta
    release();
    await h.idle();
    await h.service.automator.settleAll();
    assert.equal(h.sent.some((s) => s.to === phone && s.text === 'Claro, lo reviso y te aviso.'), false, 'la respuesta ya no sale');
    assert.equal(await statusOf(phone), 'human');
  } finally {
    release();
    h.setScript(() => ({ messages: ['Con gusto te ayudo.'] }));
  }
});

t('lo que escribe una persona desde el teléfono también enmascara números de tarjeta', async () => {
  const phone = '5215530000205';
  await customer('hola', phone);
  await person('Mi tarjeta es 4111 1111 1111 1111', phone);
  const row = (await pool.query(
    `SELECT m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id
     WHERE ct.phone = $1 AND m.sender = 'human' ORDER BY m.id DESC LIMIT 1`,
    [phone],
  )).rows[0];
  assert.ok(row, 'se guardó el mensaje');
  assert.ok(!row.content.includes('4111 1111 1111 1111'), 'el número completo no se guarda');
  assert.match(row.content, /1111/);
});

t('si el asistente pasa la conversación a una persona por una palabra clave, queda registrado como del asistente', async () => {
  const phone = '5215530000206';
  await customer('quiero hablar con un asesor', phone);
  assert.equal(await statusOf(phone), 'human');
  const hf = await handoffOf(phone);
  assert.equal(hf.handoff_via, 'bot');
  assert.equal(hf.handoff_by, null);
  assert.ok(hf.handoff_at);
});

t('una regla de automatización que pasa la conversación queda registrada como regla', async () => {
  const rule = await h.authed('POST', '/api/automations', {
    account_id: h.accountId,
    name: 'Urgente → persona',
    trigger: { type: 'message_received', match: 'keywords', keywords: ['urgente'] },
    actions: [{ type: 'handoff', reason: 'Mensaje urgente' }],
  });
  assert.equal(rule.statusCode, 200, rule.body);
  const phone = '5215530000207';
  await customer('esto es urgente, necesito ayuda', phone);
  assert.equal(await statusOf(phone), 'human');
  const hf = await handoffOf(phone);
  assert.equal(hf.handoff_via, 'regla');
  assert.equal(hf.handoff_by, null);
});
