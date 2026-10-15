/**
 * Lo que el agente hace solo, sin que el cliente vuelva a escribir: «devolver al asistente después de N minutos» cuando
 * nadie del equipo atiende, y la transcripción de notas de voz aunque la cuenta tenga presupuesto de IA.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';
const { accountAi } = await import('../src/ai/budget.js');
const { config } = await import('../src/config.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const PHONE = '5215511112222';
const status = async () => (await h.conversationFor(PHONE))?.status;
/** Simula que pasaron `min` minutos desde el pase a una persona y desde los mensajes. */
const ago = async (convId: string, min: number) => {
  await pool.query(`UPDATE conversations SET status_changed_at = status_changed_at - make_interval(mins => $2) WHERE id = $1`, [convId, min]);
  await pool.query(`UPDATE messages SET created_at = created_at - make_interval(mins => $2) WHERE conversation_id = $1`, [convId, min]);
};

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ rules: { auto_resume_minutes: 10 }, ai: { debounce_seconds: 0.1 } });
  h.setScript(() => ({ messages: ['Con gusto te ayudo con tu reservación'] }));
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('nadie del equipo atiende: a los N minutos vuelve al asistente y contesta lo que el cliente dejó esperando', async () => {
  await h.webhook('quiero hablar con un asesor');
  await waitFor(async () => (await status()) === 'human');
  await h.idle();
  const conv = await h.conversationFor(PHONE);
  await h.webhook('¿hay alguien? quiero reservar');
  await h.idle();
  h.reset();
  // Antes de los 10 minutos no pasa nada.
  assert.equal(await (h.service as any).autoResumeIdle(), 0);
  assert.equal(await status(), 'human');
  await ago(conv.id, 11);
  assert.equal(await (h.service as any).autoResumeIdle(), 1);
  assert.equal(await status(), 'bot');
  await waitFor(() => h.sent.some((s) => s.to === PHONE && /reservación/.test(s.text)), 15000);
  await h.idle();
  // Una sola vez.
  assert.equal(await (h.service as any).autoResumeIdle(), 0);
});

t('si alguien del equipo escribió en esos minutos, la conversación sigue con la persona', async () => {
  await h.webhook('quiero hablar con un asesor');
  await waitFor(async () => (await status()) === 'human');
  await h.idle();
  const conv = await h.conversationFor(PHONE);
  await ago(conv.id, 30);
  const r = await h.authed('POST', `/api/conversations/${conv.id}/send`, { text: 'Hola, soy Carla del hotel' });
  assert.equal(r.statusCode, 200, r.body);
  await pool.query(`UPDATE conversations SET status_changed_at = now() - interval '30 minutes' WHERE id = $1`, [conv.id]);
  assert.equal(await (h.service as any).autoResumeIdle(), 0, 'Carla escribió hace un momento');
  assert.equal(await status(), 'human');
  // Pasan los minutos sin que nadie escriba y el cliente no espera nada: vuelve al asistente sin enviar mensajes.
  await ago(conv.id, 11);
  h.reset();
  assert.equal(await (h.service as any).autoResumeIdle(), 1);
  assert.equal(await status(), 'bot');
  await h.idle();
  assert.equal(h.sent.filter((s) => s.to === PHONE).length, 0, 'el último mensaje fue del equipo: no hay a quién contestar');
});

t('notas de voz: con presupuesto de IA se transcriben y se cobran por la duración', async () => {
  const current = (await h.authed('GET', `/api/ai-budget?account_id=${h.accountId}`)).json();
  const put = await h.authed('PUT', `/api/ai-budget?account_id=${h.accountId}`, { revision: current.revision, settings: { monthly_usd: 5 } });
  assert.equal(put.statusCode, 200, put.body);
  // Un modelo que cobra por minuto de audio (OpenAI directo): antes, cualquier presupuesto bloqueaba la transcripción.
  const old = config.openai.transcriptionModel;
  config.openai.transcriptionModel = 'gpt-4o-mini-transcribe';
  try {
    const ai = accountAi(h.ai as any, h.accountId, h.botId, 'transcription');
    // Con la duración de la plataforma (WhatsApp la informa) y sin ella (se estima por el tamaño).
    await ai.transcribe(Buffer.alloc(30_000), 'audio/ogg', 12);
    await ai.transcribe(Buffer.alloc(40_000), 'audio/ogg');
  } finally { config.openai.transcriptionModel = old; }
  const rows = (await pool.query(`SELECT state, charged_usd FROM ai_spend WHERE account_id = $1 AND kind = 'transcription' ORDER BY created_at`, [h.accountId])).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.state === 'settled'), JSON.stringify(rows));
  // gpt-4o-mini-transcribe: $0.003 por minuto → 12 s = $0.0006; 40 KB ≈ 20 s = $0.001.
  assert.ok(Math.abs(Number(rows[0].charged_usd) - 0.0006) < 1e-9, JSON.stringify(rows));
  assert.ok(Math.abs(Number(rows[1].charged_usd) - 0.001) < 1e-9, JSON.stringify(rows));
});
