/** Estadísticas del panel: cifras por periodo, reparto por turnos, mensajes por persona, citas, costo de IA y zona horaria. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, store, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let phoneN = 0;
const newPhone = () => `52157${String(3000000 + ++phoneN)}`;
const PASS = 'clave-segura-1';
let ana: Awaited<ReturnType<typeof h.loginAs>>;
let luis: Awaited<ReturnType<typeof h.loginAs>>;
let anaId = '';
let luisId = '';

/** Un cliente nuevo que escribe y recibe respuesta: queda creada su conversación. */
async function chat(phone: string, text = 'Hola') {
  h.setScript(() => ({ messages: ['¡Hola! ¿En qué te ayudo?'] }));
  await h.webhook(text, { phone });
  await waitFor(() => h.sent.some((s) => s.to === phone));
  await h.idle();
  return h.conversationFor(phone);
}
const stats = async (query: string) => {
  const r = await h.authed('GET', `/api/analytics?${query}&account_id=${h.accountId}`);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const person = (s: any, email: string) => s.team.users.find((u: any) => u.email === email);
const tzOf = async () => (await pool.query(`SELECT coalesce(settings->>'timezone', 'America/Mexico_City') AS tz FROM accounts WHERE id = $1`, [h.accountId])).rows[0].tz as string;
/** Día local de la cuenta, desplazado n días desde hoy. */
const localDay = async (n: number) => (await pool.query(`SELECT to_char((now() AT TIME ZONE $1)::date + $2::int, 'YYYY-MM-DD') AS d`, [await tzOf(), n])).rows[0].d as string;
/** Mensaje de un cliente en una conversación, con su hora de creación exacta. */
async function insertIn(convId: string, createdAtSql: string, params: unknown[] = []) {
  await pool.query(`INSERT INTO messages (conversation_id, direction, sender, type, content, processed, status, meta, created_at) VALUES ($1, 'in', 'customer', 'text', 'Mensaje de prueba', true, 'ok', '{}', ${createdAtSql})`, [convId, ...params]);
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ personality: { prompt: 'Eres Sofi, la asistente de una clínica dental.' } });
  for (const [email, name] of [['ana@clinica.mx', 'Ana'], ['luis@clinica.mx', 'Luis']] as const) {
    const u = await h.authed('POST', '/api/users', { account_id: h.accountId, email, name, password: PASS, role: 'agent' });
    assert.equal(u.statusCode, 200, u.body);
  }
  anaId = (await pool.query(`SELECT id FROM users WHERE email = 'ana@clinica.mx'`)).rows[0].id;
  luisId = (await pool.query(`SELECT id FROM users WHERE email = 'luis@clinica.mx'`)).rows[0].id;
  ana = await h.loginAs('ana@clinica.mx', PASS);
  luis = await h.loginAs('luis@clinica.mx', PASS);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('resumen del día: conversaciones nuevas, mensajes recibidos y respuestas del asistente', async () => {
  const before = await stats('range=today');
  for (const p of [newPhone(), newPhone(), newPhone()]) await chat(p, '¿Cuánto cuesta una limpieza?');
  const after = await stats('range=today');
  assert.equal(after.totals.conversations_new - before.totals.conversations_new, 3);
  assert.equal(after.totals.messages_received - before.totals.messages_received, 3);
  assert.equal(after.totals.messages_sent_bot - before.totals.messages_sent_bot, 3, 'una respuesta del asistente por cliente');
  assert.equal(after.totals.conversations_answered_by_bot - before.totals.conversations_answered_by_bot, 3);
  assert.equal(after.period.range, 'today');
  assert.equal(after.period.from, after.period.to);
  assert.equal(after.daily.length, 1);
  assert.equal(after.daily[0].messages_received, after.totals.messages_received, 'el desglose por día cuadra con el total');
});

t('reparto por turnos: cada persona recibe su parte y las reasignaciones no borran el historial', async () => {
  const convs = [];
  for (const p of [newPhone(), newPhone(), newPhone(), newPhone()]) convs.push(await chat(p));
  const assignment = await import('../src/automation/assignment.js');
  for (const c of convs) await assignment.assignRoundRobin(c, { scope: 'prueba-turnos', roles: ['agent'], reason: 'prueba' });

  let s = await stats('range=today');
  assert.equal(person(s, 'ana@clinica.mx').round_robin, 2, 'Ana recibe la mitad por turnos');
  assert.equal(person(s, 'luis@clinica.mx').round_robin, 2, 'Luis recibe la otra mitad');
  assert.equal(s.team.round_robin_total, 4);
  assert.equal(person(s, 'ana@clinica.mx').round_robin_share, 50);

  // Una reasignación manual de la primera conversación: quien la tenía sigue contándola en su historial.
  const owner = (await pool.query(`SELECT assigned_user_id AS id FROM conversations WHERE id = $1`, [convs[0].id])).rows[0].id as string;
  const other = owner === anaId ? luisId : anaId;
  const r = await h.authed('PUT', `/api/conversations/${convs[0].id}/assign`, { user_id: other });
  assert.equal(r.statusCode, 200, r.body);
  s = await stats('range=today');
  const was = owner === anaId ? person(s, 'ana@clinica.mx') : person(s, 'luis@clinica.mx');
  const now = owner === anaId ? person(s, 'luis@clinica.mx') : person(s, 'ana@clinica.mx');
  assert.equal(was.conversations_received, 2, 'quien la tuvo sigue contándola');
  assert.equal(was.open_now, 1, 'pero ya no la tiene abierta');
  assert.equal(now.conversations_received, 3, 'quien la recibe por reasignación suma una más');
  assert.equal(now.manual, 1, 'la reasignación a mano cuenta como manual');
  assert.equal(now.open_now, 3);
  const history = (await pool.query(`SELECT source FROM conversation_assignments WHERE conversation_id = $1 ORDER BY id`, [convs[0].id])).rows.map((x) => x.source);
  assert.deepEqual(history, ['round_robin', 'manual'], 'el historial guarda cada asignación');

  const unassigned = (await pool.query(
    `SELECT count(*)::int AS n FROM conversations c WHERE c.account_id = $1 AND c.status <> 'closed' AND c.assigned_user_id IS NULL AND c.channel_id IN (SELECT id FROM channels WHERE account_id = $1 AND type <> 'playground')`,
    [h.accountId],
  )).rows[0].n;
  assert.equal(s.team.unassigned_open_now, unassigned, 'las conversaciones sin persona se cuentan aparte');
});

t('mensajes que una persona envía desde el panel se cuentan por esa persona', async () => {
  const conv = await chat(newPhone());
  // Un agente solo escribe en las conversaciones que tiene asignadas.
  assert.equal((await h.authed('PUT', `/api/conversations/${conv.id}/assign`, { user_id: anaId })).statusCode, 200);
  const before = await stats('range=today');
  const sent = await ana('POST', `/api/conversations/${conv.id}/send`, { text: 'Hola, soy Ana, te confirmo tu cita', takeover: true });
  assert.equal(sent.statusCode, 200, sent.body);
  const after = await stats('range=today');
  assert.equal(person(after, 'ana@clinica.mx').messages_sent - person(before, 'ana@clinica.mx').messages_sent, 1);
  assert.equal(person(after, 'ana@clinica.mx').conversations_replied - person(before, 'ana@clinica.mx').conversations_replied, 1);
  assert.equal(after.totals.messages_sent_human - before.totals.messages_sent_human, 1);
  const meta = (await pool.query(`SELECT meta FROM messages WHERE conversation_id = $1 AND sender = 'human' ORDER BY id DESC LIMIT 1`, [conv.id])).rows[0].meta;
  assert.equal(meta.user_id, anaId, 'el mensaje guarda quién lo envió');
});

t('citas: por estado, por origen y por persona asignada', async () => {
  const svc = (await h.authed('POST', '/api/services', { account_id: h.accountId, name: 'Limpieza dental', duration_minutes: 30 })).json();
  const slots = (await h.authed('GET', `/api/services/${svc.id}/slots`)).json();
  assert.ok(slots.length >= 4, 'hay horarios para la prueba');
  const ids: string[] = [];
  for (const slot of slots.slice(0, 4)) {
    const r = await h.authed('POST', '/api/appointments', { service_id: svc.id, slot: slot.key, customer_name: 'Cliente de prueba', notify_customer: false });
    assert.equal(r.statusCode, 200, r.body);
    ids.push(r.json().id);
  }
  await pool.query(`UPDATE appointments SET status = 'completed', assigned_user_id = $2 WHERE id = $1`, [ids[0], anaId]);
  await pool.query(`UPDATE appointments SET status = 'no_show', assigned_user_id = $2 WHERE id = $1`, [ids[1], anaId]);
  await pool.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [ids[2]]);
  const from = await localDay(-30);
  const to = await localDay(30);
  const s = await stats(`range=custom&from=${from}&to=${to}`);
  assert.equal(s.totals.appointments, 4);
  assert.equal(s.totals.appointments_completed, 1);
  assert.equal(s.totals.appointments_no_show, 1);
  assert.equal(s.totals.appointments_cancelled, 1);
  assert.equal(s.totals.appointments_confirmed, 1);
  assert.equal(s.totals.appointments_by_people, 4, 'las citas del panel no son del asistente');
  assert.equal(s.totals.appointments_by_bot, 0);
  assert.equal(person(s, 'ana@clinica.mx').appointments, 2, 'las citas no canceladas de Ana');
  assert.equal(s.services[0].name, 'Limpieza dental');
  assert.equal(s.services[0].total, 4);
});

t('costo de IA del periodo: total y por tipo de llamada', async () => {
  const before = await stats('range=today');
  await store.insertAiRun({ account_id: h.accountId, chatbot_id: h.botId, conversation_id: null, kind: 'summary', model: 'modelo-prueba', input_tokens: 10, cached_tokens: 0, output_tokens: 5, cost_usd: 0.25, latency_ms: 1 });
  const after = await stats('range=today');
  assert.ok(Math.abs(after.totals.ai_cost_usd - before.totals.ai_cost_usd - 0.25) < 1e-6, 'suma el costo de la llamada');
  assert.equal(after.totals.ai_runs - before.totals.ai_runs, 1);
  const kind = after.ai_by_kind.find((k: any) => k.kind === 'summary');
  assert.ok(kind && kind.runs >= 1 && kind.cost >= 0.25 - 1e-6);
});

t('periodos 7, 15, 30, 60 y 90 días: cada uno cuenta lo que cae dentro, según la zona horaria de la cuenta', async () => {
  const conv = (await pool.query(`SELECT id FROM conversations WHERE account_id = $1 ORDER BY created_at LIMIT 1`, [h.accountId])).rows[0].id as string;
  // Mensajes de hace 3, 10, 20, 45 y 80 días. Un periodo de k días (contando hoy) llega hasta hace k-1 días.
  const ages = [3, 10, 20, 45, 80];
  const periods = ['7', '15', '30', '60', '90'];
  const base: Record<string, number> = {};
  for (const k of periods) base[k] = (await stats(`range=${k}`)).totals.messages_received;
  for (const days of ages) await insertIn(conv, `now() - interval '${days} days'`);
  for (const k of periods) {
    const after = (await stats(`range=${k}`)).totals.messages_received;
    assert.equal(after - base[k], ages.filter((a) => a <= Number(k) - 1).length, `periodo de ${k} días`);
  }
  // Fechas personalizadas: un mensaje a las 23:30 del día D cuenta en D y no en D+1; uno a las 00:10 de D+1 cuenta en D+1.
  const tz = await tzOf();
  const D = await localDay(-3);
  const D1 = await localDay(-2);
  const baseD = (await stats(`range=custom&from=${D}&to=${D}`)).totals.messages_received;
  const baseD1 = (await stats(`range=custom&from=${D1}&to=${D1}`)).totals.messages_received;
  await insertIn(conv, `timezone($2, ($3::date + interval '23 hours 30 minutes')::timestamp)`, [tz, D]);
  await insertIn(conv, `timezone($2, ($3::date + interval '10 minutes')::timestamp)`, [tz, D1]);
  const rangeD = await stats(`range=custom&from=${D}&to=${D}`);
  const rangeD1 = await stats(`range=custom&from=${D1}&to=${D1}`);
  assert.equal(rangeD.totals.messages_received - baseD, 1, 'el mensaje de las 23:30 cuenta en su día local');
  assert.equal(rangeD1.totals.messages_received - baseD1, 1, 'el de las 00:10 cuenta en el día siguiente');
  assert.equal(rangeD.daily[0].messages_received, rangeD.totals.messages_received, 'el desglose por día coincide');
});

t('variación contra el periodo anterior del mismo largo', async () => {
  const s = await stats('range=7');
  const prevFrom = s.period.prev_from;
  const prevTo = s.period.prev_to;
  const expected = (await pool.query(
    `SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = $1 AND m.direction = 'in' AND m.sender = 'customer'
        AND m.created_at >= timezone($2, $3::date::timestamp) AND m.created_at < timezone($2, ($4::date + 1)::timestamp)`,
    [h.accountId, s.period.timezone, prevFrom, prevTo],
  )).rows[0].n;
  assert.equal(s.previous.messages_received, expected, 'el periodo anterior cubre las mismas fechas que el SQL');
  assert.equal(s.period.days, 7);
  assert.equal(s.daily.length, 7);
});

t('primera respuesta: tiempo promedio en minutos y cuántas conversaciones se miden', async () => {
  const s = await stats('range=today');
  assert.ok(s.totals.first_response_samples >= 3, 'se miden las conversaciones de hoy que tuvieron respuesta');
  assert.equal(typeof s.totals.first_response_minutes, 'number');
  assert.ok(s.totals.first_response_minutes >= 0);
});

t('el simulador del panel no cuenta en ninguna cifra', async () => {
  const bot = h.botId;
  const before = await stats('range=today');
  const r = await h.authed('POST', `/api/chatbots/${bot}/playground`, { text: 'Hola, soy una prueba del simulador', session: 'sim-estadisticas' });
  assert.equal(r.statusCode, 200, r.body);
  const after = await stats('range=today');
  assert.equal(after.totals.conversations_new, before.totals.conversations_new);
  assert.equal(after.totals.messages_received, before.totals.messages_received);
  assert.equal(after.totals.messages_sent, before.totals.messages_sent);
});

t('quién ve las estadísticas y qué rangos se aceptan', async () => {
  const forbidden = await ana('GET', '/api/analytics?range=7');
  assert.equal(forbidden.statusCode, 403, 'un operador no ve las estadísticas del equipo');
  const noAccount = await h.authed('GET', '/api/analytics?range=7');
  assert.equal(noAccount.statusCode, 400, 'el maestro debe elegir la cuenta');
  assert.equal((await h.authed('GET', `/api/analytics?range=custom&account_id=${h.accountId}`)).statusCode, 400, 'rango personalizado sin fechas');
  assert.equal((await h.authed('GET', `/api/analytics?range=custom&from=2026-10-08&to=2026-10-01&account_id=${h.accountId}`)).statusCode, 400, 'inicio posterior al fin');
  assert.equal((await h.authed('GET', `/api/analytics?range=custom&from=2024-01-01&to=2026-10-01&account_id=${h.accountId}`)).statusCode, 400, 'más de 366 días');
  assert.equal((await h.authed('GET', `/api/analytics?range=mes&account_id=${h.accountId}`)).statusCode, 400, 'rango desconocido');
  assert.equal((await h.authed('GET', `/api/analytics?range=custom&from=2026-02-31&to=2026-03-01&account_id=${h.accountId}`)).statusCode, 400, 'fecha inexistente');
  const ok7 = await h.authed('GET', `/api/analytics?range=week&account_id=${h.accountId}`);
  assert.equal(ok7.statusCode, 200, ok7.body);
  assert.equal(ok7.json().period.range, 'week');
});
