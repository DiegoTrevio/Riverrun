/** Avisos al equipo desde el agente: por objetivo, etapa y contexto, y «solo una vez por conversación». */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

// Cada aviso va a un teléfono distinto del equipo: así se cuenta cuántas veces salió cada uno.
const GOAL = '5215599990001';
const STAGE = '5215599990002';
const CONTEXT = '5215599990003';
const EVERY_TIME = '5215599990004';
const to = (phone: string) => h.sent.filter((s) => s.to === phone);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ flow: { goal: 'Que el cliente solicite su reserva', steps: [{ title: 'Saludo' }, { title: 'Fechas' }] } });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

async function notice(name: string, trigger: Record<string, unknown>, phone: string, once = true) {
  const r = await h.authed('POST', '/api/automations', {
    account_id: h.accountId, chatbot_id: h.botId, name, active: true, trigger, conditions: [],
    actions: [{ type: 'alert_team', message: `${name}: {{cliente}} — "{{mensaje}}"`, roles: [], phones: [phone] }],
    once_per_conversation: once,
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}

t('avisos por objetivo, etapa y contexto; «una vez por conversación» no repite y vuelve a contar al reiniciar', async () => {
  const goal = await notice('Objetivo cumplido', { type: 'goal_completed' }, GOAL);
  await notice('Llegó a fechas', { type: 'stage_reached', step: 2 }, STAGE);
  await notice('Evento grande', { type: 'intent', intent: 'aviso_evento_grande', description: 'El cliente quiere cotizar un evento para muchas personas' }, CONTEXT);
  await notice('Evento grande (siempre)', { type: 'intent', intent: 'aviso_evento_grande', description: 'El cliente quiere cotizar un evento para muchas personas' }, EVERY_TIME, false);
  assert.equal(goal.once_per_conversation, true, 'la opción se guarda');

  const P = '5215510009001';
  const say = async (text: string, decision: Record<string, unknown>, until: () => boolean) => {
    h.setScript((req) => {
      // El contexto descrito llega a la IA para que lo detecte.
      assert.match(String(req.messages[0].content), /`aviso_evento_grande`: El cliente quiere cotizar un evento para muchas personas/);
      return decision;
    });
    await h.webhook(text, { phone: P });
    await waitFor(until);
    await h.idle();
  };

  // 1) Detecta el contexto y llega a la etapa 2: avisos de contexto (los dos) y de etapa.
  await say('Quiero cotizar una boda para 150 personas', { messages: ['¡Con gusto! ¿Para qué fecha sería?'], intents: ['aviso_evento_grande'], flow_step: 2 }, () => to(CONTEXT).length === 1 && to(STAGE).length === 1 && to(EVERY_TIME).length === 1);
  assert.match(to(CONTEXT)[0].text, /Evento grande: .* — "Quiero cotizar una boda para 150 personas"/);
  assert.equal(to(GOAL).length, 0);

  // 2) El contexto vuelve a salir: el de «una vez» no se repite; el otro sí.
  await say('Serían unas 150 personas en total', { messages: ['Perfecto. ¿Qué día?'], intents: ['aviso_evento_grande'] }, () => to(EVERY_TIME).length === 2);
  await h.service.automator.settle((await h.conversationFor(P)).id);
  assert.equal(to(CONTEXT).length, 1, 'el aviso de una vez no se repite');
  assert.equal(to(STAGE).length, 1);

  // 3) Se cumple el objetivo: sale su aviso.
  await say('El 14 de febrero', { messages: ['Listo, quedó tu solicitud. El equipo te confirma.'], goal_completed: true }, () => to(GOAL).length === 1);

  // 4) Se reinicia la conversación: el aviso de una vez vuelve a contar en el recorrido nuevo.
  assert.equal((await h.authed('POST', `/api/chatbots/${h.botId}/restart-conversations`)).statusCode, 200);
  await say('Hola de nuevo, otra boda grande', { messages: ['¡Hola! Cuéntame.'], intents: ['aviso_evento_grande'] }, () => to(CONTEXT).length === 2 && to(EVERY_TIME).length === 3);
});

t('el panel ve los avisos del agente como reglas de Automatización, con la opción guardada', async () => {
  const rules = (await h.authed('GET', `/api/automations?account_id=${h.accountId}`)).json();
  const mine = rules.filter((r: any) => r.chatbot_id === h.botId && r.actions.some((a: any) => a.type === 'alert_team'));
  assert.equal(mine.length, 4);
  assert.deepEqual(mine.filter((r: any) => !r.once_per_conversation).map((r: any) => r.name), ['Evento grande (siempre)']);
  // Desactivar desde el agente usa la misma regla.
  const ctx = mine.find((r: any) => r.name === 'Evento grande');
  const off = await h.authed('PUT', `/api/automations/${ctx.id}`, { active: false });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().once_per_conversation, true, 'un cambio parcial no borra la opción');
});
