/**
 * Copiloto en el día a día (con el modelo simulado por guion): agenda y reagenda citas con «Deshacer» (y confirma
 * las que avisan al cliente), mueve oportunidades, registra cobros solo al confirmar, corrige cobros, cotizaciones y
 * la lista de precios con «Deshacer», y responde con las estadísticas.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, waitFor, type CopilotOut } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
type Req = Awaited<ReturnType<typeof h.loginAs>>;
let owner: Req;
let conv: { id: string; contact_id: string };
let serviceId = '';

function script(outs: CopilotOut[]) {
  let k = 0;
  h.setCopilotScript(() => outs[k++] ?? 'Listo.');
}
const call = (name: string, args: Record<string, unknown>) => ({ tool_calls: [{ name, arguments: args }] });

async function ask(text: string) {
  const th = (await owner('POST', '/api/copilot/threads', {})).json().id as string;
  const r = await owner('POST', `/api/copilot/threads/${th}/messages`, { text });
  assert.equal(r.statusCode, 202, r.body);
  await waitFor(async () => (await owner('GET', `/api/copilot/threads/${th}`)).json().turn?.status !== 'running', 8000);
  return (await owner('GET', `/api/copilot/threads/${th}`)).json();
}
const lastAction = (out: any) => out.actions.filter((a: any) => a.risk !== 'read').at(-1);
const confirm = (a: any) => owner('POST', `/api/copilot/actions/${a.id}/confirm`, { seen_hash: a.seen_hash });
const undo = (a: any) => owner('POST', `/api/copilot/actions/${a.id}/undo`);
/** Lo último que el Copiloto le pasó al modelo como resultado de una herramienta. */
const lastToolResult = () => JSON.parse(String((h.copilotCalls.at(-1) as any).messages.filter((m: any) => m.role === 'tool').at(-1).content));
const appointments = async () => (await owner('GET', `/api/appointments?from=${new Date(Date.now() - 86400_000).toISOString()}&to=${new Date(Date.now() + 40 * 86400_000).toISOString()}`)).json() as any[];

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['Con gusto.'] }));
  assert.equal((await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'duena@ops.mx', name: 'Dueña', password: 'clave-duena-123', role: 'admin' })).statusCode, 200);
  assert.equal((await h.authed('PUT', `/api/accounts/${h.accountId}`, { copilot_enabled: true })).statusCode, 200);
  owner = await h.loginAs('duena@ops.mx', 'clave-duena-123');
  const tpl = (await owner('GET', '/api/pipelines/template')).json();
  assert.equal((await owner('POST', '/api/pipelines', { ...tpl, chatbot_ids: [h.botId] })).statusCode, 200);
  await h.webhook('Hola, quiero agendar', { phone: '5215533330001' });
  await waitFor(async () => !!(await h.conversationFor('5215533330001')), 8000);
  await h.idle();
  conv = (await h.conversationFor('5215533330001')) as { id: string; contact_id: string };
  await owner('PUT', `/api/contacts/${conv.contact_id}`, { name: 'Carla Méndez' });
  const s = await owner('POST', '/api/services', { name: 'Corte', duration_minutes: 30, min_notice_minutes: 0, max_days_ahead: 30, notify_team: false, reminders: [] });
  assert.equal(s.statusCode, 200, s.body);
  serviceId = s.json().id;
});

after(async () => {
  if (ok) await h.app.close();
});

t('agenda: busca horarios, agenda sin avisar (reversible), reagenda y deshace; avisar al cliente se confirma', async () => {
  h.copilotCalls.length = 0;
  script([call('horarios_libres', { servicio_id: serviceId }), 'Estos son los horarios.']);
  await ask('¿Qué horarios hay para corte?');
  const slots = lastToolResult().horarios;
  assert.ok(slots.length >= 2, JSON.stringify(slots));
  const [first, second] = [slots[0].horario, slots[1].horario];

  script([call('crear_cita', { servicio_id: serviceId, horario: first, conversacion_id: conv.id, avisar_al_cliente: false }), 'Agendada.']);
  const made = lastAction(await ask('Agéndale a Carla el primer horario, sin avisarle'));
  assert.equal(made.status, 'done', JSON.stringify(made));
  const appt = (await appointments()).find((a) => a.conversation_id === conv.id && a.status === 'confirmed');
  assert.ok(appt);

  script([call('cambiar_cita', { cita_id: appt.id, horario: second }), 'Reagendada.']);
  const moved = lastAction(await ask('Pásala al siguiente horario'));
  assert.equal(moved.status, 'done', JSON.stringify(moved));
  const startOf = async () => new Date((await appointments()).find((a) => a.id === appt.id).starts_at).getTime();
  assert.notEqual(await startOf(), new Date(appt.starts_at).getTime());
  assert.equal((await undo(moved)).statusCode, 200);
  assert.equal(await startOf(), new Date(appt.starts_at).getTime(), 'volvió al primer horario');
  assert.equal((await undo(made)).statusCode, 200);
  assert.equal((await appointments()).find((a) => a.id === appt.id).status, 'cancelled');

  const sent = h.sent.length;
  script([call('crear_cita', { servicio_id: serviceId, horario: second, conversacion_id: conv.id }), 'Confírmalo en la tarjeta.']);
  const notify = lastAction(await ask('Agéndale el segundo horario y avísale'));
  assert.equal(notify.status, 'proposed', JSON.stringify(notify));
  assert.ok(notify.reasons.some((r: string) => /confirmación de la cita/.test(r)));
  assert.equal(h.sent.length, sent, 'nada sale antes de confirmar');
  assert.equal((await confirm(notify)).json().status, 'done');
  await waitFor(() => h.sent.length > sent, 8000);

  const booked = (await appointments()).find((a) => a.conversation_id === conv.id && a.status === 'confirmed');
  script([call('cancelar_cita', { cita_id: booked.id, avisar_al_cliente: false }), 'Confírmalo.']);
  const cancel = lastAction(await ask('Cancélala sin avisarle'));
  assert.equal(cancel.status, 'proposed');
  assert.match(cancel.preview.lines.join(' '), /No se le avisa/);
  assert.equal((await confirm(cancel)).json().status, 'done');
  assert.equal((await appointments()).find((a) => a.id === booked.id).status, 'cancelled');
});

t('oportunidades: se ve el tablero y se mueve de columna con «Deshacer»', async () => {
  h.copilotCalls.length = 0;
  script([call('ver_oportunidades', {}), 'Este es el tablero.']);
  await ask('¿Cómo va el tablero?');
  const board = lastToolResult();
  const card = board.columnas.flatMap((c: any) => c.oportunidades ?? []).find((o: any) => o.contacto === 'Carla Méndez');
  assert.ok(card, JSON.stringify(board));
  const target = board.columnas.find((c: any) => !(c.oportunidades ?? []).some((o: any) => o.id === card.id));

  script([call('actualizar_oportunidad', { oportunidad_id: card.id, columna: target.nombre, valor: 1500 }), 'Movida.']);
  const moved = lastAction(await ask(`Mueve a Carla a ${target.nombre} con valor 1500`));
  assert.equal(moved.status, 'done', JSON.stringify(moved));
  const cards = async () => (await owner('GET', `/api/conversations/${conv.id}/pipeline`)).json() as any[];
  const now = (await cards()).find((c) => String(c.id) === card.id);
  assert.deepEqual([now.stage_id, Number(now.value)], [target.id, 1500]);
  assert.equal((await undo(moved)).statusCode, 200);
  const back = (await cards()).find((c) => String(c.id) === card.id);
  assert.notEqual(back.stage_id, target.id);
  assert.equal(Number(back.value), 0);
});

t('cobros: registrar se confirma; corregir se deshace; recordar se confirma', async () => {
  script([call('crear_cobro', { contacto_id: conv.contact_id, concepto: 'Paquete de cortes', monto: 850, vence: '2026-12-15' }), 'Confírmalo en la tarjeta.']);
  const prop = lastAction(await ask('Cóbrale a Carla 850 por el paquete, vence el 15 de diciembre'));
  assert.equal(prop.status, 'proposed', JSON.stringify(prop));
  assert.match(prop.title, /Cobrar \$850 MXN a Carla Méndez/);
  const list = async () => (await owner('GET', `/api/receivables?contact_id=${conv.contact_id}`)).json().data as any[];
  assert.equal((await list()).length, 0, 'no se registra sin confirmar');
  assert.equal((await confirm(prop)).json().status, 'done');
  const r = (await list())[0];
  assert.deepEqual([r.amount_cents, String(r.due_date).slice(0, 10)], [85000, '2026-12-15']);

  // El monto y el enlace de pago deciden cuánto y a dónde paga el cliente: se confirman, aunque se puedan deshacer.
  script([call('editar_cobro', { cobro_id: r.id, monto: 900 }), 'Confírmalo.']);
  const edit = lastAction(await ask('Que sean 900'));
  assert.equal(edit.status, 'proposed', JSON.stringify(edit));
  assert.equal((await list())[0].amount_cents, 85000, 'no cambia sin confirmar');
  assert.equal((await confirm(edit)).json().status, 'done');
  assert.equal((await list())[0].amount_cents, 90000);
  assert.equal((await undo(edit)).statusCode, 200);
  assert.equal((await list())[0].amount_cents, 85000);

  script([call('editar_cobro', { cobro_id: r.id, enlace_de_pago: 'https://pagos.example.com/otra-cuenta' }), 'Confírmalo.']);
  const link = lastAction(await ask('Cambia el enlace de pago'));
  assert.equal(link.status, 'proposed', JSON.stringify(link));
  assert.equal((await list())[0].payment_link ?? '', '', 'el enlace no cambia sin confirmar');
  assert.equal((await owner('POST', `/api/copilot/actions/${link.id}/decline`)).statusCode, 200);

  script([call('editar_cobro', { cobro_id: r.id, concepto: 'Paquete de 4 cortes' }), 'Corregido.']);
  const concept = lastAction(await ask('Ponle «Paquete de 4 cortes»'));
  assert.equal(concept.status, 'done', 'el concepto se corrige sin confirmar');
  assert.equal((await undo(concept)).statusCode, 200);

  script([call('recordar_cobro', { cobro_id: r.id }), 'Confírmalo.']);
  const remind = lastAction(await ask('Recuérdale el pago'));
  assert.equal(remind.status, 'proposed', JSON.stringify(remind));
  assert.match(remind.preview.lines.join(' '), /Le llega ahora por WhatsApp/);
});

t('cotizaciones y lista de precios: corregir renglones y precios se deshace; rechazar se confirma', async () => {
  const { createQuote } = await import('../src/store/quotes.js');
  const q = await createQuote({ accountId: h.accountId, kind: 'approximate', status: 'pending_approval', source: 'panel', today: '2026-10-20', contactId: conv.contact_id,
    customer: { nombre: 'Carla Méndez' }, lines: [{ name: 'Corte', qty: 1, price_mode: 'exact', price_min: 15000, price_max: null, iva_mode: 'plus' }] } as any);
  script([call('editar_cotizacion', { cotizacion_id: q.id, cambiar: [{ renglon: 1, cantidad: 2 }], agregar: [{ nombre: 'Barba', cantidad: 1, precio: 90 }] }), 'Corregida.']);
  const edit = lastAction(await ask('Que sean 2 cortes y agrega una barba de 90'));
  assert.equal(edit.status, 'done', JSON.stringify(edit));
  let detail = (await owner('GET', `/api/quotes/${q.id}`)).json();
  assert.deepEqual(detail.lines.map((l: any) => [l.name, Number(l.qty)]), [['Corte', 2], ['Barba', 1]]);
  assert.equal((await undo(edit)).statusCode, 200);
  detail = (await owner('GET', `/api/quotes/${q.id}`)).json();
  assert.deepEqual(detail.lines.map((l: any) => [l.name, Number(l.qty)]), [['Corte', 1]]);

  script([call('decidir_cotizacion', { cotizacion_id: q.id, decision: 'rechazar', motivo: 'Precio desactualizado' }), 'Confírmalo.']);
  const reject = lastAction(await ask('Recházala, el precio está desactualizado'));
  assert.equal(reject.status, 'proposed');
  assert.equal((await confirm(reject)).json().status, 'done');
  assert.equal((await owner('GET', `/api/quotes/${q.id}`)).json().status, 'rejected');

  script([call('editar_lista_de_precios', { codigo: 'CORTE', nombre: 'Corte de cabello', precio: 150 }), 'Agregado.']);
  const add = lastAction(await ask('Agrega el corte a 150 a la lista de precios'));
  assert.equal(add.status, 'done', JSON.stringify(add));
  const items = async () => (await owner('GET', '/api/price-items')).json() as any[];
  const item = (await items()).find((i) => i.code === 'CORTE');
  assert.equal(Number(item.price_min), 15000);
  script([call('editar_lista_de_precios', { concepto_id: item.id, precio: 180 }), 'Cambiado.']);
  const raise = lastAction(await ask('Súbelo a 180'));
  assert.equal(raise.status, 'done', JSON.stringify(raise));
  assert.equal(Number((await items()).find((i) => i.id === item.id).price_min), 18000);
  assert.equal((await undo(raise)).statusCode, 200);
  assert.equal(Number((await items()).find((i) => i.id === item.id).price_min), 15000);
  assert.equal((await undo(add)).statusCode, 200);
  assert.ok(!(await items()).some((i) => i.id === item.id));
});

t('estadísticas: responde con los números del periodo', async () => {
  h.copilotCalls.length = 0;
  script([call('estadisticas', { periodo: '30' }), 'Estos son tus números.']);
  const out = await ask('¿Cómo vamos este mes?');
  assert.equal(out.actions.at(-1).tool, 'estadisticas');
  const data = lastToolResult();
  assert.ok(data.totales, JSON.stringify(data).slice(0, 300));
});

t('horarios libres a partir de un día: solo de ese día en adelante, aunque esté a más de dos semanas', async () => {
  const from = new Date(Date.now() + 20 * 86400_000).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  script([call('horarios_libres', { servicio_id: serviceId, desde: from }), 'Estos son.']);
  await ask(`¿Qué horarios hay a partir del ${from}?`);
  // La lista llega recortada para el modelo («… y N más» al final).
  const slots = (lastToolResult().horarios as any[]).filter((x) => typeof x === 'object');
  assert.ok(slots.length > 0, 'hay horarios aunque sea a más de 14 días');
  assert.ok(slots.every((x) => x.horario.slice(0, 10) >= from), JSON.stringify(slots.slice(0, 3)));
  script([call('horarios_libres', { servicio_id: serviceId, fecha: from }), 'Estos son.']);
  await ask(`¿Qué horarios hay el ${from}?`);
  const day = (lastToolResult().horarios as any[]).filter((x) => typeof x === 'object');
  assert.ok(day.length > 0 && day.every((x) => x.horario.startsWith(from)), 'un día a más de 14 días también tiene horarios');
});

t('agendar con el contacto, o con nombre y teléfono de alguien que ya es cliente, liga la cita a su ficha', async () => {
  script([call('horarios_libres', { servicio_id: serviceId, desde: new Date(Date.now() + 5 * 86400_000).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }) }), 'Estos son.']);
  await ask('¿Qué horarios hay?');
  const [first, second] = (lastToolResult().horarios as any[]).filter((x) => typeof x === 'object').map((x) => x.horario);
  script([call('crear_cita', { servicio_id: serviceId, horario: first, contacto_id: conv.contact_id, avisar_al_cliente: false }), 'Agendada.']);
  const byContact = lastAction(await ask('Agéndale a Carla'));
  assert.equal(byContact.status, 'done', JSON.stringify(byContact));
  script([call('crear_cita', { servicio_id: serviceId, horario: second, nombre_cliente: 'Carla Méndez', telefono: '+52 1 55 3333 0001', avisar_al_cliente: false }), 'Agendada.']);
  const byPhone = lastAction(await ask('Agéndale a Carla Méndez, su teléfono es 55 3333 0001'));
  assert.equal(byPhone.status, 'done', JSON.stringify(byPhone));
  const mine = (await appointments()).filter((x) => x.status === 'confirmed' && [first, second].some((s) => x.starts_at && new Date(x.starts_at).getTime() === new Date(`${s}:00-06:00`).getTime()));
  assert.equal(mine.length, 2, JSON.stringify((await appointments()).map((x) => [x.starts_at, x.contact_id])));
  assert.ok(mine.every((x) => x.contact_id === conv.contact_id && x.conversation_id === conv.id), 'las dos quedaron en la ficha de Carla');
  for (const a of [byContact, byPhone]) assert.equal((await undo(a)).statusCode, 200);
});
