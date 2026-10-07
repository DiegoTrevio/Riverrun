/** Las afirmaciones sin números ("sí tenemos alberca") se verifican contra el conocimiento antes de enviar. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let n = 0;
const phone = () => `52155300000${String(++n).padStart(2, '0')}`;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ rules: { fallback_message: 'Eso lo confirmo con el equipo y te aviso.' } });
  const k = await h.authed('POST', `/api/chatbots/${h.botId}/knowledge`, { title: 'Hotel', content: 'Hotel Palmas. Habitaciones dobles desde $1,200 por noche. Estacionamiento gratis. Desayuno incluido.', always_include: true });
  assert.equal(k.statusCode, 200, k.body);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

const setMode = async (mode: string) => {
  const r = await h.authed('PUT', `/api/chatbots/${h.botId}`, { rules: { verify_claims: mode } });
  assert.equal(r.statusCode, 200, r.body);
};

t('inventa "tenemos alberca": se rechaza y la IA corrige en el reintento', async () => {
  await setMode('reglas');
  h.reset();
  h.setScript((_req, i) => (i === 0 ? { messages: ['¡Sí, tenemos alberca climatizada para ti!'] } : { messages: ['No tengo confirmado ese dato; lo consulto con el equipo.'] }));
  await h.webhook('¿tienen alberca?', { phone: phone() });
  await waitFor(() => h.sent.length >= 1);
  assert.equal(h.calls.length, 2, 'hubo un reintento');
  assert.match(JSON.stringify(h.calls[1].messages), /Afirmaste que el negocio tiene u ofrece: alberca/);
  assert.doesNotMatch(h.sent[0].text, /alberca climatizada/);
});

t('si la IA insiste en inventarlo, se envía el mensaje de respaldo', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['Claro, contamos con gimnasio y alberca.'] }));
  await h.webhook('¿hay gimnasio?', { phone: phone() });
  await waitFor(() => h.sent.length >= 1);
  assert.equal(h.sent[0].text, 'Eso lo confirmo con el equipo y te aviso.');
});

t('lo que sí está cargado pasa sin reintentos', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['Sí, el estacionamiento es gratis y el desayuno está incluido.'] }));
  await h.webhook('¿incluye desayuno y estacionamiento?', { phone: phone() });
  await waitFor(() => h.sent.length >= 1);
  assert.equal(h.calls.length, 1);
  assert.match(h.sent[0].text, /estacionamiento es gratis/);
});

t('modo apagado: no revisa', async () => {
  await setMode('apagado');
  h.reset();
  h.setScript(() => ({ messages: ['Tenemos alberca.'] }));
  await h.webhook('¿alberca?', { phone: phone() });
  await waitFor(() => h.sent.length >= 1);
  assert.equal(h.sent[0].text, 'Tenemos alberca.');
});

t('modo estricto: un juez de IA revisa lo que las reglas no ven, y su costo queda registrado', async () => {
  await setMode('estricto');
  h.reset();
  let judged = 0;
  h.setScript((req, i) => {
    if (req.json_schema?.name === 'claim_check') {
      judged++;
      const reply = JSON.stringify(req.messages);
      return JSON.stringify({ unsupported: reply.includes('wifi gratis ilimitado') ? ['wifi gratis ilimitado'] : [] });
    }
    return i === 0 ? { messages: ['Tu habitación incluye wifi gratis ilimitado.'] } : { messages: ['Eso lo confirmo con el equipo.'] };
  });
  await h.webhook('¿qué incluye la habitación?', { phone: phone() });
  await waitFor(() => h.sent.length >= 1);
  assert.equal(judged, 2, 'juzgó la primera respuesta y la corregida');
  assert.match(h.sent[0].text, /confirmo con el equipo/);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ai_runs WHERE kind = 'verify'`)).rows[0].n >= 2, true);
});

t('modo estricto: si el juez falla, no se bloquea la respuesta', async () => {
  h.reset();
  h.setScript((req) => (req.json_schema?.name === 'claim_check' ? new Error('juez caído') : { messages: ['El desayuno está incluido.'] }));
  await h.webhook('¿desayuno?', { phone: phone() });
  await waitFor(() => h.sent.length >= 1);
  assert.equal(h.sent[0].text, 'El desayuno está incluido.');
});
