/**
 * Pipelines personalizables: cada solicitud es una tarjeta que pasa de una columna a otra según el contexto que detecta
 * la IA o por eventos (objetivo, cita, transferencia…), y también a mano desde el tablero.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, sleep } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let pipelineId = '';
const WON_PHONE = '5215599992222';

const say = async (text: string, phone: string) => {
  const r = await h.webhook(text, { phone });
  assert.equal(r.statusCode, 200, r.body);
  await sleep(400);
  await h.idle();
  await h.service.automator.settle((await h.conversationFor(phone)).id);
};
const cardOf = async (phone: string) => {
  const conv = await h.conversationFor(phone);
  const cards = (await h.authed('GET', `/api/conversations/${conv.id}/pipeline`)).json();
  return { conv, cards, open: cards.find((c: any) => !c.closed_at) };
};
const ago = async (phone: string, hours: number) => {
  const conv = await h.conversationFor(phone);
  await pool.query(`UPDATE messages SET created_at = created_at - make_interval(hours => $2) WHERE conversation_id = $1`, [conv.id, hours]);
  await pool.query(`UPDATE conversations SET flow_started_at = flow_started_at - make_interval(hours => $2) WHERE id = $1`, [conv.id, hours]);
};

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ flow: { goal: 'Que el cliente reserve' } });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('reglas de movimiento: adelante sí, ganadas y perdidas no se mueven solas, atrás solo si se permite', async () => {
  const { targetStage, withStageIds, DEFAULT_STAGES } = await import('../src/automation/pipelines.js');
  const stages = withStageIds(DEFAULT_STAGES);
  assert.deepEqual(stages.map((s) => s.id), ['nuevo', 'interesado', 'cotizado', 'ganado', 'perdido']);
  const p = { stages, allow_backward: false };
  const intent = (id: string) => ({ type: 'intent' as const, conversationId: 'x', intents: [`etapa_${id}`] });
  assert.equal(targetStage(p, 'nuevo', intent('cotizado'))?.stage.id, 'cotizado');
  assert.equal(targetStage(p, 'nuevo', intent('cotizado'))?.source, 'ia');
  assert.equal(targetStage(p, 'cotizado', intent('interesado')), null, 'no regresa sola');
  assert.equal(targetStage({ ...p, allow_backward: true }, 'cotizado', intent('interesado'))?.stage.id, 'interesado');
  assert.equal(targetStage(p, 'cotizado', intent('perdido'))?.stage.id, 'perdido', 'perdida se alcanza desde cualquier columna');
  assert.equal(targetStage(p, 'ganado', intent('perdido')), null, 'ganada ya no se mueve sola');
  assert.equal(targetStage(p, 'interesado', { type: 'goal_completed', conversationId: 'x' })?.stage.id, 'ganado');
  assert.equal(targetStage(p, 'interesado', { type: 'goal_completed', conversationId: 'x' })?.source, 'evento');
  // Si varias aplican, la que va más adelante; una columna sin situación descrita no se detecta por contexto.
  assert.equal(targetStage(p, 'nuevo', { type: 'intent', conversationId: 'x', intents: ['etapa_interesado', 'etapa_cotizado'] })?.stage.id, 'cotizado');
  assert.equal(targetStage(p, 'interesado', intent('ganado')), null);
  const { publicEventFor } = await import('../src/integrations/webhooks.js');
  assert.equal(publicEventFor({ type: 'pipeline_stage', conversationId: 'x' }), 'pipeline.stage_changed');
});

t('se configura desde el panel: plantilla, validaciones y un agente usa un solo pipeline', async () => {
  const tpl = (await h.authed('GET', '/api/pipelines/template')).json();
  assert.equal(tpl.stages.length, 5);
  const bad = await h.authed('POST', '/api/pipelines', { account_id: h.accountId, name: 'Mal', stages: [{ name: 'Ganado', kind: 'won' }, { name: 'Nuevo' }] });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /primera columna/);
  assert.equal((await h.authed('POST', '/api/pipelines', { account_id: h.accountId, name: 'Una', stages: [{ name: 'Sola' }] })).statusCode, 400);

  const first = await h.authed('POST', '/api/pipelines', { account_id: h.accountId, name: 'Soporte', stages: [{ name: 'Abierto' }, { name: 'Resuelto', kind: 'won' }], chatbot_ids: [h.botId] });
  assert.equal(first.statusCode, 200, first.body);
  const r = await h.authed('POST', '/api/pipelines', { account_id: h.accountId, ...tpl, chatbot_ids: [h.botId] });
  assert.equal(r.statusCode, 200, r.body);
  pipelineId = r.json().id;
  const list = (await h.authed('GET', '/api/pipelines')).json();
  assert.deepEqual(list.map((p: any) => [p.name, p.chatbot_ids]), [['Soporte', []], ['Ventas', [h.botId]]], 'el agente pasa al pipeline nuevo');

  // Aviso al equipo cuando una solicitud llega a «Ganado».
  const rule = await h.authed('POST', '/api/automations', {
    account_id: h.accountId, chatbot_id: h.botId, name: 'Venta ganada', active: true, trigger: { type: 'pipeline_stage', pipeline_id: pipelineId, stage_id: 'ganado' }, conditions: [],
    actions: [{ type: 'alert_team', message: 'Ganada: {{cliente}}', roles: [], phones: [WON_PHONE] }],
  });
  assert.equal(rule.statusCode, 200, rule.body);
});

t('la tarjeta avanza sola por el contexto que detecta la IA y por eventos, y avisa al equipo', async () => {
  const P = '5215510020001';
  h.reset();
  let prompt = '';
  h.setScript((req) => { prompt = String(req.messages[0].content); return { messages: ['¡Hola! ¿En qué te ayudo?'] }; });
  await say('Hola', P);
  let { open } = await cardOf(P);
  assert.equal(open.stage_id, 'nuevo', 'la solicitud entra en la primera columna');
  // La IA conoce las columnas que se detectan por contexto y en cuál va.
  assert.match(prompt, /## Pipeline «Ventas»\n[^\n]*\n- `etapa_interesado` \(Interesado\): El cliente muestra interés/);
  assert.match(prompt, /Columna del pipeline: «Nuevo»\./);
  assert.ok(prompt.indexOf('## Pipeline «Ventas»') < prompt.indexOf('# Estado de la conversación'), 'las columnas van en la configuración; la actual, en el estado');

  h.setScript(() => ({ messages: ['Con gusto, ya te compartí la cotización de la habitación doble.'], intents: ['etapa_cotizado'] }));
  await say('¿Cuánto cuesta la doble?', P);
  ({ open } = await cardOf(P));
  assert.equal(open.stage_id, 'cotizado');

  // Si la respuesta no pasa la validación (dato inventado) y sale la de respaldo, la columna no cambia.
  const P2 = '5215510020009';
  h.setScript(() => ({ messages: ['La suite cuesta $9,999.'], intents: ['etapa_cotizado'] }));
  await say('¿Cuánto cuesta la suite?', P2);
  assert.equal((await cardOf(P2)).open.stage_id, 'nuevo', 'con la respuesta de respaldo no se da por cotizado');

  // Una intención que no corresponde (columna anterior) no la regresa.
  h.setScript(() => ({ messages: ['Claro.'], intents: ['etapa_interesado'] }));
  await say('Me interesa', P);
  ({ open } = await cardOf(P));
  assert.equal(open.stage_id, 'cotizado');

  h.setScript(() => ({ messages: ['¡Listo, quedó tu reserva!'], goal_completed: true }));
  await say('Va, resérvala', P);
  const { cards } = await cardOf(P);
  assert.equal(cards[0].stage_id, 'ganado');
  assert.deepEqual(cards[0].moves.map((m: any) => [m.from_stage, m.to_stage, m.source]), [[null, 'nuevo', 'inicio'], ['nuevo', 'cotizado', 'ia'], ['cotizado', 'ganado', 'evento']]);
  assert.match(cards[0].moves[1].reason, /La IA detectó: Ya se le dio al cliente un precio/);
  assert.equal(h.sent.filter((s) => s.to === WON_PHONE).length, 1, 'aviso al equipo por llegar a Ganado');

  // Ya ganada no se mueve sola, y la IA lo sabe.
  h.setScript((req) => { prompt = String(req.messages[0].content); return { messages: ['Ok'], intents: ['etapa_perdido'] }; });
  await say('Gracias', P);
  assert.equal((await cardOf(P)).open.stage_id, 'ganado');
  assert.match(prompt, /Columna del pipeline: «Ganado» \(ya terminó: no marques columnas\)/);

  const board = (await h.authed('GET', `/api/pipelines/${pipelineId}/board`)).json();
  const mine = board.cards.find((c: any) => c.conversation_id === open.conversation_id);
  assert.equal(mine.stage_id, 'ganado');
  assert.equal(mine.contact_phone, P);
});

t('a mano desde el tablero se mueve a cualquier columna y queda quién la movió', async () => {
  const P = '5215510020002';
  h.setScript(() => ({ messages: ['¡Hola!'] }));
  await say('Hola', P);
  const { open } = await cardOf(P);
  const bad = await h.authed('POST', `/api/pipeline-cards/${open.id}/move`, { stage_id: 'no_existe' });
  assert.equal(bad.statusCode, 400);
  const r = await h.authed('POST', `/api/pipeline-cards/${open.id}/move`, { stage_id: 'perdido', note: 'Dijo por teléfono que no' });
  assert.equal(r.statusCode, 200, r.body);
  const { cards } = await cardOf(P);
  const last = cards[0].moves.at(-1);
  assert.deepEqual([last.to_stage, last.source, last.reason], ['perdido', 'manual', 'Dijo por teléfono que no']);
  assert.ok(last.user_name, 'se ve quién la movió');
  // Y de regreso (a mano se puede ir hacia atrás).
  assert.equal((await h.authed('POST', `/api/pipeline-cards/${open.id}/move`, { stage_id: 'interesado' })).statusCode, 200);
  assert.equal((await cardOf(P)).open.stage_id, 'interesado');
});

t('cuando el cliente vuelve por otra solicitud, la anterior se cierra como perdida o ganada y empieza otra tarjeta', async () => {
  const P = '5215510020003';
  h.setScript(() => ({ messages: ['Te paso precios.'], intents: ['etapa_interesado'] }));
  await say('Quiero info de habitaciones', P);
  assert.equal((await cardOf(P)).open.stage_id, 'interesado');
  await ago(P, 25);
  h.setScript(() => ({ messages: ['¡Hola de nuevo!'] }));
  await say('Hola, ¿siguen teniendo promoción?', P);
  const { cards, open } = await cardOf(P);
  assert.equal(cards.length, 2);
  assert.deepEqual([open.stage_id, open.request_number], ['nuevo', 2]);
  const old = cards.find((c: any) => c.closed_at);
  assert.equal(old.stage_id, 'perdido', 'quedó en una columna intermedia sin cumplir el objetivo');
  assert.equal(old.moves.at(-1).source, 'cierre');
});

t('las columnas se pueden editar: una que se borra manda sus tarjetas a la primera; quien atiende solo ve las suyas', async () => {
  const p = (await h.authed('GET', '/api/pipelines')).json().find((x: any) => x.id === pipelineId);
  const r = await h.authed('PUT', `/api/pipelines/${pipelineId}`, { stages: p.stages.filter((s: any) => s.id !== 'interesado').map((s: any) => (s.id === 'nuevo' ? { ...s, name: 'Primer contacto' } : s)) });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().stages[0].id, 'nuevo', 'renombrar conserva el identificador');
  assert.equal((await cardOf('5215510020002')).open.stage_id, 'nuevo');

  const user = await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'agente-pipe@test.mx', password: 'secreto123', name: 'Agente', role: 'agent' });
  assert.equal(user.statusCode, 200, user.body);
  const agent = await h.loginAs('agente-pipe@test.mx', 'secreto123');
  assert.equal((await agent('GET', `/api/pipelines/${pipelineId}/board`)).json().cards.length, 0, 'sin conversaciones asignadas no ve tarjetas');
  assert.equal((await agent('POST', '/api/pipelines', { name: 'X', stages: [{ name: 'a' }, { name: 'b' }] })).statusCode, 403);
  const card = (await cardOf('5215510020002')).open;
  assert.equal((await agent('POST', `/api/pipeline-cards/${card.id}/move`, { stage_id: 'ganado' })).statusCode, 404);
});
