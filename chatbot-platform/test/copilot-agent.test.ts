/**
 * El Copiloto arma y ajusta un agente completo (con el modelo simulado por guion): lo crea (nace apagado), sigue solo
 * con sus preguntas y su objetivo al confirmar, cambia cuándo responde, regresa versiones, lo prueba como cliente, le
 * sube fotos que la persona adjuntó y le crea el chat para la web.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor, type CopilotOut } from './harness.js';

const { config } = await import('../src/config.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let owner: Awaited<ReturnType<typeof h.loginAs>>;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const call = (name: string, args: Record<string, unknown>) => ({ tool_calls: [{ name, arguments: args }] });
function script(outs: (CopilotOut | ((req: any) => CopilotOut))[]) {
  let k = 0;
  h.setCopilotScript((req) => { const o = outs[k++] ?? 'Listo.'; return typeof o === 'function' ? o(req) : o; });
}
async function newThread() {
  return (await owner('POST', '/api/copilot/threads', {})).json().id as string;
}
async function settle(id: string) {
  await waitFor(async () => (await owner('GET', `/api/copilot/threads/${id}`)).json().turn?.status !== 'running', 10000);
  return (await owner('GET', `/api/copilot/threads/${id}`)).json();
}
async function ask(id: string, text: string, extra: Record<string, unknown> = {}) {
  const r = await owner('POST', `/api/copilot/threads/${id}/messages`, { text, ...extra });
  assert.equal(r.statusCode, 202, r.body);
  return settle(id);
}
const last = (r: any, tool: string) => [...r.actions].reverse().find((a: any) => a.tool === tool);
const bot = async (id: string) => (await owner('GET', `/api/chatbots/${id}`)).json();

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['¡Hola! Con gusto te ayudo con tu corte.'] }));
  await h.addUser({ email: 'duena@agente.mx', name: 'Dueña', password: 'Pz-150-Qx-350-Kv', role: 'admin' });
  owner = await h.loginAs('duena@agente.mx', 'Pz-150-Qx-350-Kv');
  config.copilot.turnsPerHour = 1000;
});

after(async () => {
  if (ok) await h.app.close();
});

t('crear un agente: se propone, nace apagado y, al confirmar, el Copiloto sigue solo con sus preguntas y su objetivo', async () => {
  const id = await newThread();
  script([
    call('crear_agente', {
      nombre_negocio: 'Barbería Don Beto', tipo_de_negocio: 'belleza', que_hara: 'agendar_citas', trato: 'tu',
      informacion: { productos_y_precios: 'Corte de cabello $150. Barba $100. Corte y barba $220.', horario: 'Lunes a sábado de 10:00 a 20:00.' },
    }),
    call('seguir_al_confirmar', { faltan: 'Ponerle preguntas (nombre y servicio) y su objetivo' }),
    'Te dejé el agente para confirmar; luego le pongo preguntas y objetivo.',
    // La continuación: lee el id del agente nuevo en el aviso de la confirmación.
    (req) => {
      const text = String(req.messages.at(-1)?.content ?? '');
      const agent = text.match(/"agente_id":"([0-9a-f-]{36})"/)?.[1];
      assert.ok(agent, `la continuación ve el id del agente creado: ${text}`);
      return {
        tool_calls: [
          { name: 'cambiar_preguntas', arguments: { agente_id: agent, preguntas: [{ clave: 'nombre', pregunta: '¿Cómo te llamas?', tipo: 'nombre' }, { clave: 'servicio', pregunta: '¿Qué servicio quieres?', tipo: 'opcion', opciones: ['Corte', 'Barba'] }] } },
          { name: 'cambiar_objetivo', arguments: { agente_id: agent, objetivo: 'Agendar una cita', etapas: [{ titulo: 'Saludar' }, { titulo: 'Agendar' }], al_cumplir: 'avisar_al_equipo' } },
        ],
      };
    },
    'Listo: ya tiene preguntas y objetivo.',
  ]);
  const r = await ask(id, 'Crea un agente para mi barbería que agende citas y pregunte nombre y servicio');
  const p = last(r, 'crear_agente');
  assert.equal(p.status, 'proposed', JSON.stringify(p));
  assert.match(p.preview.lines.join(' '), /Nace apagado/);
  assert.equal(r.turn.continue_plan, 'Ponerle preguntas (nombre y servicio) y su objetivo');
  const before = (await owner('GET', '/api/chatbots')).json().length;

  const c = await owner('POST', `/api/copilot/actions/${p.id}/confirm`, { seen_hash: p.seen_hash, seguir: true });
  assert.equal(c.statusCode, 200, c.body);
  assert.equal(c.json().status, 'done', c.body);
  assert.ok(c.json().continued_turn, 'siguió solo');
  const done = await settle(id);
  assert.equal((await owner('GET', '/api/chatbots')).json().length, before + 1);
  const created = (await owner('GET', '/api/chatbots')).json().find((b: any) => b.name.includes('Don Beto'));
  const full = await bot(created.id);
  assert.equal(full.active, false, 'nace apagado');
  assert.deepEqual(full.data_fields.map((f: any) => f.key), ['nombre', 'servicio']);
  assert.equal(full.data_fields[1].type, 'option');
  assert.equal(full.flow.goal, 'Agendar una cita');
  assert.equal(full.flow.on_goal_action, 'notify');
  assert.ok(done.actions.some((a: any) => a.tool === 'cambiar_preguntas' && a.status === 'done' && a.can_undo));
  assert.equal((await owner('POST', `/api/copilot/actions/${p.id}/confirm`, { seen_hash: p.seen_hash })).statusCode, 409, 'una sola vez');
});

t('cuándo responde se confirma; las preguntas se deshacen; una versión anterior se restaura', async () => {
  const id = await newThread();
  script([call('cambiar_activacion', { agente_id: h.botId, modo: 'con_palabras', palabras_para_empezar: ['hola barbería'], al_parar: 'pasar_a_persona' }), 'Confírmalo.']);
  const act = last(await ask(id, 'Que solo conteste cuando escriban «hola barbería»'), 'cambiar_activacion');
  assert.equal(act.status, 'proposed');
  assert.equal((await bot(h.botId)).rules.activation.mode, 'always', 'no cambia sin confirmar');
  assert.equal((await owner('POST', `/api/copilot/actions/${act.id}/confirm`, { seen_hash: act.seen_hash })).json().status, 'done');
  const activation = (await bot(h.botId)).rules.activation;
  assert.equal(activation.mode, 'keywords');
  assert.deepEqual(activation.on_keywords, ['hola barbería']);
  assert.equal(activation.off_action, 'handoff');

  const prev = (await bot(h.botId)).data_fields;
  script([call('cambiar_preguntas', { agente_id: h.botId, preguntas: [{ clave: 'correo', pregunta: '¿Tu correo?', tipo: 'correo', obligatoria: true }] }), 'Listo.']);
  const q = last(await ask(id, 'Que solo pida el correo'), 'cambiar_preguntas');
  assert.equal(q.status, 'done', JSON.stringify(q));
  assert.deepEqual((await bot(h.botId)).data_fields.map((f: any) => f.key), ['correo']);
  assert.equal((await owner('POST', `/api/copilot/actions/${q.id}/undo`, {})).statusCode, 200);
  assert.deepEqual((await bot(h.botId)).data_fields, prev, 'Deshacer regresa las preguntas de antes');

  // Regresar a la versión más vieja: queda en el historial como una versión nueva.
  const releases = (await owner('GET', `/api/chatbots/${h.botId}/versions`)).json().releases;
  const oldest = releases[releases.length - 1];
  script([call('restaurar_version', { agente_id: h.botId, version_id: Number(oldest.id) }), 'Confírmalo.']);
  const rv = last(await ask(id, 'Regrésalo a como estaba al principio'), 'restaurar_version');
  assert.equal(rv.status, 'proposed', JSON.stringify(rv));
  const done = await owner('POST', `/api/copilot/actions/${rv.id}/confirm`, { seen_hash: rv.seen_hash });
  assert.equal(done.json().status, 'done', done.body);
  assert.ok((await owner('GET', `/api/chatbots/${h.botId}/versions`)).json().releases.length > releases.length, 'queda en el historial');
});

t('probar el agente como cliente y revisar qué se activaría (sin enviar nada a nadie)', async () => {
  const id = await newThread();
  const sentBefore = h.sent.length;
  script([call('probar_agente', { agente_id: h.botId, mensaje: '¿cuánto cuesta un corte?', empezar_de_nuevo: true }), call('probar_palabras', { agente_id: h.botId, mensaje: 'hola barbería' }), 'Así contestaría.']);
  const r = await ask(id, 'Pruébalo como si fuera un cliente');
  assert.equal(last(r, 'probar_agente').status, 'done', JSON.stringify(last(r, 'probar_agente')));
  const tool = (await pool.query(`SELECT content FROM copilot_messages WHERE thread_id = $1 AND role = 'tool' ORDER BY id`, [id])).rows.map((x) => x.content);
  assert.match(tool[0], /datos_del_cliente/, 'lo que contesta el agente va como dato');
  assert.match(tool[0], /respuestas_del_agente/);
  assert.equal(last(r, 'probar_palabras').status, 'done');
  assert.equal(h.sent.length, sentBefore, 'no se le mandó nada a nadie');
});

t('fotos: una foto adjunta se sube a la biblioteca del agente y se deshace; el chat web trae su código', async () => {
  const id = await newThread();
  const boundary = '----prueba' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="corte.png"\r\nContent-Type: image/png\r\n\r\n`), PNG, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const up = await h.app.inject({ method: 'POST', url: `/api/copilot/threads/${id}/files`, payload: body, headers: { cookie: owner.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(up.statusCode, 200, up.body);
  const fileId = up.json().id;
  script([call('subir_foto', { agente_id: h.botId, archivo_id: fileId, codigo: 'corte_clasico', nombre: 'Corte clásico', cuando_usarla: 'Cuando pregunten por cortes' }), 'Listo.']);
  const r = await ask(id, 'Agrega esta foto al agente para cuando pregunten por cortes', { files: [fileId] });
  const s = last(r, 'subir_foto');
  assert.equal(s.status, 'done', JSON.stringify(s));
  const images = (await owner('GET', `/api/chatbots/${h.botId}/images`)).json();
  assert.ok(images.some((i: any) => i.code === 'corte_clasico' && i.usage_rule === 'Cuando pregunten por cortes'), JSON.stringify(images));
  assert.equal((await owner('POST', `/api/copilot/actions/${s.id}/undo`, {})).statusCode, 200);
  assert.ok(!(await owner('GET', `/api/chatbots/${h.botId}/images`)).json().some((i: any) => i.code === 'corte_clasico'), 'Deshacer la quita');

  script([call('crear_chat_web', { agente_id: h.botId }), 'Pega el código en tu página.']);
  const w = last(await ask(id, 'Hazme el chat para mi página web'), 'crear_chat_web');
  assert.equal(w.status, 'done', JSON.stringify(w));
  const tool = (await pool.query(`SELECT content FROM copilot_messages WHERE thread_id = $1 AND role = 'tool' ORDER BY id DESC LIMIT 1`, [id])).rows[0].content;
  assert.match(tool, /codigo_para_la_pagina/);
  assert.doesNotMatch(tool, /webhook_token/, 'nunca el token del canal');
});

t('un agente del equipo no puede crear ni configurar agentes', async () => {
  await h.addUser({ email: 'agente@agente.mx', name: 'Luis', password: 'Pz-151-Qx-351-Kv', role: 'agent' });
  const agent = await h.loginAs('agente@agente.mx', 'Pz-151-Qx-351-Kv');
  const id = (await agent('POST', '/api/copilot/threads', {})).json().id;
  script([call('crear_agente', { nombre_negocio: 'Otra', informacion: { otra: 'Vendemos cosas variadas todos los días del año.' } }), 'No pude.']);
  await agent('POST', `/api/copilot/threads/${id}/messages`, { text: 'Crea un agente' });
  await waitFor(async () => (await agent('GET', `/api/copilot/threads/${id}`)).json().turn?.status !== 'running', 8000);
  const tool = (await pool.query(`SELECT content FROM copilot_messages WHERE thread_id = $1 AND role = 'tool'`, [id])).rows[0].content;
  assert.match(tool, /no_disponible/);
});
