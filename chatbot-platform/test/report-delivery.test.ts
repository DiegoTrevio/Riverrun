/** Reporte de conversación: análisis guardado, consulta, descarga y envío con resultado por canal. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let convId: string;
let ana: { id: string; api: Awaited<ReturnType<typeof h.loginAs>> };
let beto: { id: string; api: Awaited<ReturnType<typeof h.loginAs>> };

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  for (const [n, role, phone] of [['ana', 'agent', '5215500000001'], ['beto', 'agent', '']] as const) {
    const r = await h.authed('POST', '/api/users', { account_id: h.accountId, email: `${n}@equipo.mx`, name: n, password: 'clave-equipo-1', role, phone, notify_whatsapp: !!phone });
    assert.equal(r.statusCode, 200, r.body);
    const u = { id: r.json().id, api: await h.loginAs(`${n}@equipo.mx`, 'clave-equipo-1') };
    if (n === 'ana') ana = u; else beto = u;
  }
  h.setScript(() => ({ messages: ['¿Cuántos tacos quieres?'], save_data: [{ field: 'nombre', value: 'Luis' }] }));
  await h.webhook('Hola, soy Luis y quiero tacos para el viernes');
  await waitFor(() => h.sent.length >= 1);
  await h.idle();
  convId = (await h.conversationFor()).id;
  // Un agente solo ve las conversaciones que tiene asignadas: esta es de Ana.
  assert.equal((await h.authed('PUT', `/api/conversations/${convId}/assign`, { user_id: ana.id })).statusCode, 200);
});
after(async () => { if (h) await h.app.close(); await pool.end(); });

t('el resumen guarda un análisis compacto y el reporte lo muestra', async () => {
  h.setSummary('Luis quiere tacos para el viernes.');
  h.setAnalysis({ intent: 'Pedido de tacos', sentiment: 'positivo', interest: 'alto', agreements: ['Entrega el viernes'], next_steps: ['Confirmar cantidad'] });
  assert.equal((await h.authed('POST', `/api/conversations/${convId}/summary`)).statusCode, 200);
  const r = (await ana.api('GET', `/api/conversations/${convId}/report`)).json();
  assert.match(r.summary, /tacos/);
  assert.equal(r.analysis.sentiment, 'positivo');
  assert.deepEqual(r.analysis.next_steps, ['Confirmar cantidad']);
  assert.equal(r.stale, false);
  assert.ok(r.messages >= 2);
});

t('descarga en texto plano con datos, acuerdos y pendientes', async () => {
  const res = await ana.api('GET', `/api/conversations/${convId}/report?format=txt&transcript=1`);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/plain/);
  for (const piece of ['REPORTE DE CONVERSACIÓN', 'Luis quiere tacos', 'nombre: Luis', 'Entrega el viernes', 'Confirmar cantidad', 'ÚLTIMOS MENSAJES']) assert.match(res.body, new RegExp(piece));
});

t('un mensaje nuevo marca el resumen como desactualizado', async () => {
  h.setScript(() => ({ messages: ['Anotado'] }));
  await h.webhook('Mejor 20 tacos');
  await h.idle();
  assert.equal((await ana.api('GET', `/api/conversations/${convId}/report`)).json().stale, true);
});

t('cualquier integrante envía al equipo; se informa el resultado de cada canal', async () => {
  // Beto envía desde una conversación que tiene asignada (la de Ana vuelve a ella al terminar).
  assert.equal((await h.authed('PUT', `/api/conversations/${convId}/assign`, { user_id: beto.id })).statusCode, 200);
  const before = h.sent.length;
  const res = await beto.api('POST', `/api/conversations/${convId}/report/send`, { user_ids: [ana.id], note: 'Revisar hoy' });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  const via = (v: string) => body.deliveries.filter((d: any) => d.via === v);
  assert.equal(via('panel')[0].ok, true);
  assert.equal(via('whatsapp')[0].ok, true);
  assert.equal(via('correo')[0].ok, false, 'sin SMTP no se finge una entrega');
  assert.match(via('correo')[0].detail, /SMTP/);
  const note = (await pool.query(`SELECT title, body FROM notifications WHERE user_id = $1 AND kind = 'report'`, [ana.id])).rows;
  assert.equal(note.length, 1);
  const wa = h.sent.slice(before).find((s) => s.to === '5215500000001');
  assert.match(wa!.text, /Revisar hoy/);
  assert.match(wa!.text, /20 tacos|tacos/);
  // El resumen se actualizó antes de enviar
  assert.equal(body.stale, false);
  assert.equal((await h.authed('PUT', `/api/conversations/${convId}/assign`, { user_id: ana.id })).statusCode, 200);
});

t('si la IA falla se envía el último resumen con una advertencia', async () => {
  await h.webhook('Gracias');
  await h.idle();
  h.setSummaryError(new Error('IA caída'));
  try {
    const res = await ana.api('POST', `/api/conversations/${convId}/report/send`, { user_ids: [ana.id] });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.json().warning, /No se pudo actualizar el resumen/);
    assert.equal(res.json().deliveries.find((d: any) => d.via === 'panel').ok, true);
  } finally { h.setSummaryError(null); }
});

t('permisos: externos solo administradores, destinatarios de otra cuenta rechazados, límite de datos', async () => {
  assert.equal((await ana.api('POST', `/api/conversations/${convId}/report/send`, { emails: ['jefe@fuera.mx'] })).statusCode, 403);
  assert.equal((await ana.api('POST', `/api/conversations/${convId}/report/send`, {})).statusCode, 400);
  assert.equal((await ana.api('POST', `/api/conversations/${convId}/report/send`, { user_ids: ['00000000-0000-4000-8000-000000000000'] })).statusCode, 400);
  const admin = await h.authed('POST', `/api/conversations/${convId}/report/send`, { emails: ['jefe@fuera.mx'], phones: ['5215599999999'], refresh: false });
  assert.equal(admin.statusCode, 200, admin.body);
  assert.ok(admin.json().deliveries.some((d: any) => d.via === 'whatsapp' && d.to === '+5215599999999' && d.ok));
  assert.equal((await h.authed('POST', `/api/conversations/${convId}/report/send`, { emails: Array(6).fill('a@b.mx') })).statusCode, 400);
});

t('la regla "enviar reporte" notifica al equipo', async () => {
  const rule = await h.authed('POST', '/api/automations', { account_id: h.accountId, name: 'Reporte al cerrar', trigger: { type: 'message_received', match: 'keywords', keywords: ['reportar'] }, actions: [{ type: 'send_report', user_ids: [beto.id] }] });
  assert.equal(rule.statusCode, 200, rule.body);
  const before = (await pool.query(`SELECT count(*)::int n FROM notifications WHERE user_id = $1 AND kind = 'report'`, [beto.id])).rows[0].n;
  await h.webhook('quiero reportar algo');
  await waitFor(async () => (await pool.query(`SELECT count(*)::int n FROM notifications WHERE user_id = $1 AND kind = 'report'`, [beto.id])).rows[0].n > before, 8000);
  await h.service.automator.settleAll();
});

t('la compactación borra el detalle técnico viejo y conserva consumo y costo', async () => {
  const { pruneAiRunDetail } = await import('../src/automation/store.js');
  await pool.query(`INSERT INTO ai_runs (account_id, conversation_id, kind, model, input_tokens, output_tokens, decision, validation, created_at) VALUES ($1,$2,'decision','m',10,5,'{"a":1}','{"b":2}', now() - interval '30 days')`, [h.accountId, convId]);
  await pruneAiRunDetail(14);
  const old = (await pool.query(`SELECT decision, validation, input_tokens FROM ai_runs WHERE created_at < now() - interval '20 days'`)).rows;
  assert.ok(old.length >= 1);
  assert.ok(old.every((r) => r.decision === null && r.validation === null && r.input_tokens === 10));
  const recent = (await pool.query(`SELECT count(*)::int n FROM ai_runs WHERE decision IS NOT NULL`)).rows[0].n;
  assert.ok(recent >= 1, 'el detalle reciente se conserva');
});
