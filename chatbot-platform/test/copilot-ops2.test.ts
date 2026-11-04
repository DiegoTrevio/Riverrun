/**
 * Copiloto, fase 2 (con el modelo simulado por guion): arma la agenda (servicios con «Deshacer», enlaces para reservar),
 * los campos de los clientes, importa contactos de un CSV adjunto, borra un contacto solo con el código escrito en la
 * tarjeta, crea embudos, cambia los ajustes del negocio (la retención, con código), aprueba cobros, registra pagos
 * recurrentes y exporta a CSV: el archivo lo baja el panel con «Descargar», nunca pasa por el Copiloto.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor, type CopilotOut } from './harness.js';

const { config } = await import('../src/config.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const OWNER = 'duena@fase2.mx';
let owner: Awaited<ReturnType<typeof h.loginAs>>;
let conv: { id: string; contact_id: string };

const call = (name: string, args: Record<string, unknown>) => ({ tool_calls: [{ name, arguments: args }] });
function script(outs: CopilotOut[]) {
  let k = 0;
  h.setCopilotScript(() => outs[k++] ?? 'Listo.');
}
async function newThread() {
  return (await owner('POST', '/api/copilot/threads', {})).json().id as string;
}
async function ask(text: string, o: { thread?: string; files?: string[] } = {}) {
  const id = o.thread ?? (await newThread());
  const r = await owner('POST', `/api/copilot/threads/${id}/messages`, { text, ...(o.files ? { files: o.files } : {}) });
  assert.equal(r.statusCode, 202, r.body);
  await waitFor(async () => (await owner('GET', `/api/copilot/threads/${id}`)).json().turn?.status !== 'running', 10000);
  return { id, thread: (await owner('GET', `/api/copilot/threads/${id}`)).json() };
}
const last = (r: any, tool: string) => [...r.thread.actions].reverse().find((a: any) => a.tool === tool);
const confirm = (a: any, body: Record<string, unknown> = {}) => owner('POST', `/api/copilot/actions/${a.id}/confirm`, { seen_hash: a.seen_hash, ...body });
const undo = (a: any) => owner('POST', `/api/copilot/actions/${a.id}/undo`, {});
const sidOf = (cookie: string) => JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0], 'base64url').toString()).sid as string;

/** Adjunta un archivo a la conversación del Copiloto (como el clip del panel). */
async function attach(thread: string, name: string, type: string, content: Buffer) {
  const boundary = '----prueba' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), content, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const r = await h.app.inject({ method: 'POST', url: `/api/copilot/threads/${thread}/files`, payload: body, headers: { cookie: owner.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().id as string;
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  h.setScript(() => ({ messages: ['Con gusto.'] }));
  // La primera administradora de la cuenta es su dueña.
  await h.addUser({ email: OWNER, name: 'Dueña', password: 'Pz-160-Qx-360-Kv', role: 'admin' });
  owner = await h.loginAs(OWNER, 'Pz-160-Qx-360-Kv');
  config.copilot.turnsPerHour = 1000;
  await h.webhook('Hola, quiero informes', { phone: '5215544440001' });
  await waitFor(async () => !!(await h.conversationFor('5215544440001')), 8000);
  await h.idle();
  conv = (await h.conversationFor('5215544440001')) as { id: string; contact_id: string };
});

after(async () => {
  if (ok) await h.app.close();
});

t('agenda: crea un servicio (y se deshace), uno con anticipo se confirma, y un enlace para reservar', async () => {
  script([call('guardar_servicio', { nombre: 'Manicure', duracion_min: 45, anticipacion_min: 0, recordatorios_min: [60] }), 'Listo.']);
  const r = await ask('Crea el servicio Manicure de 45 minutos');
  const s = last(r, 'guardar_servicio');
  assert.equal(s.status, 'done', JSON.stringify(s));
  assert.equal(s.can_undo, true);
  const created = (await owner('GET', '/api/services')).json().find((x: any) => x.name === 'Manicure');
  assert.equal(created.duration_minutes, 45);
  assert.deepEqual(created.reminders, [60]);
  assert.equal((await undo(s)).statusCode, 200);
  assert.ok(!(await owner('GET', '/api/services')).json().some((x: any) => x.name === 'Manicure'), 'Deshacer lo quita');

  // Pedir anticipo cambia lo que pagan los clientes: se confirma.
  script([call('guardar_servicio', { nombre: 'Tinte', duracion_min: 90, anticipo: 200 }), 'Confírmalo.']);
  const dep = last(await ask('Crea Tinte de hora y media con anticipo de 200'), 'guardar_servicio');
  assert.equal(dep.status, 'proposed', JSON.stringify(dep));
  assert.ok(dep.reasons.some((x: string) => /anticipo/.test(x)));
  assert.equal((await confirm(dep)).json().status, 'done');
  const tinte = (await owner('GET', '/api/services')).json().find((x: any) => x.name === 'Tinte');
  assert.equal(tinte.deposit_cents, 20000);

  script([call('enlace_para_reservar', { nombre: 'Reservas en línea', servicio_ids: [tinte.id] }), 'Listo.']);
  const l = last(await ask('Hazme un enlace para que reserven el tinte'), 'enlace_para_reservar');
  assert.equal(l.status, 'done', JSON.stringify(l));
  const link = (await owner('GET', '/api/booking-links')).json().find((x: any) => x.name === 'Reservas en línea');
  assert.deepEqual(link.service_ids, [tinte.id]);
  assert.match(link.url, /\/reservar\//);
});

t('campos de los clientes: crear es reversible; borrar se confirma', async () => {
  script([call('campo_de_contacto', { clave: 'cumpleanos', etiqueta: 'Cumpleaños', tipo: 'fecha' }), 'Listo.']);
  const c = last(await ask('Agrega el dato cumpleaños de tipo fecha'), 'campo_de_contacto');
  assert.equal(c.status, 'done', JSON.stringify(c));
  const field = (await owner('GET', '/api/contact-fields')).json().find((f: any) => f.key === 'cumpleanos');
  assert.equal(field.type, 'date');

  script([call('borrar_campo_de_contacto', { campo_id: field.id }), 'Confírmalo.']);
  const d = last(await ask('Quita el dato cumpleaños'), 'borrar_campo_de_contacto');
  assert.equal(d.status, 'proposed');
  assert.ok((await owner('GET', '/api/contact-fields')).json().some((f: any) => f.key === 'cumpleanos'), 'no se borra sin confirmar');
  assert.equal((await confirm(d)).json().status, 'done');
  assert.ok(!(await owner('GET', '/api/contact-fields')).json().some((f: any) => f.key === 'cumpleanos'));
});

t('importar contactos de un CSV adjunto: la tarjeta dice cuántos y qué columnas; al confirmar, entran', async () => {
  const id = await newThread();
  const csv = Buffer.from('telefono,nombre,etiquetas,color favorito\n5215511110001,Lupita Ruiz,vip\n5215511110002,Pedro Soto,\n');
  const file = await attach(id, 'clientes.csv', 'text/csv', csv);
  script([call('importar_contactos', { archivo_id: file }), 'Revisa la tarjeta.']);
  const r = await ask('Importa estos contactos', { thread: id, files: [file] });
  const p = last(r, 'importar_contactos');
  assert.equal(p.status, 'proposed', JSON.stringify(p));
  assert.match(p.title, /Importar 2 contacto/);
  assert.match(p.preview.lines.join(' '), /telefono, nombre, etiquetas/);
  assert.match(p.preview.lines.join(' '), /Se ignoran: color favorito/);
  assert.equal((await owner('GET', '/api/contacts?search=5215511110001')).json().items.length, 0, 'no entra sin confirmar');
  const done = await confirm(p);
  assert.equal(done.json().status, 'done', done.body);
  assert.match(done.json().title, /2 nuevo/);
  const lupita = (await owner('GET', '/api/contacts?search=5215511110001')).json().items[0];
  assert.equal(lupita.name, 'Lupita Ruiz');
  assert.deepEqual(lupita.tags, ['vip']);

  // Sus datos (derecho de acceso): al confirmar, la tarjeta trae «Descargar»; el JSON lo baja el panel.
  script([call('descargar_datos_de_contacto', { contacto_id: lupita.id }), 'Confírmalo.']);
  const d = last(await ask('Dame todos los datos de Lupita'), 'descargar_datos_de_contacto');
  assert.equal(d.status, 'proposed', JSON.stringify(d));
  const got = await confirm(d);
  assert.equal(got.json().download_href, `/api/contacts/${lupita.id}/data`, got.body);
  const json = await owner('GET', got.json().download_href);
  assert.equal(json.statusCode, 200);
  assert.match(json.body, /Lupita Ruiz/);
});

t('borrar un contacto pide el código en la tarjeta: sin código no; con el código, se borra todo', async () => {
  const pedro = (await owner('GET', '/api/contacts?search=5215511110002')).json().items[0];
  assert.ok(pedro, 'el contacto importado existe');
  script([call('borrar_contacto', { contacto_id: pedro.id }), 'Confírmalo con tu código.']);
  const r = await ask('Borra a Pedro Soto y todos sus datos');
  const p = last(r, 'borrar_contacto');
  assert.equal(p.risk, 'code', JSON.stringify(p));
  assert.equal(p.status, 'proposed');
  assert.doesNotMatch(p.title, /Pedro/, 'el título no lleva el nombre');
  assert.match(p.preview.lines.join(' '), /Pedro Soto/, 'la tarjeta sí dice a quién');
  const none = await confirm(p);
  assert.deepEqual([none.statusCode, none.json().code], [400, 'code_required']);
  assert.equal((await owner('GET', `/api/contacts/${pedro.id}/profile`)).statusCode, 200, 'sigue ahí');
  const good = await confirm(p, { code: await h.codeFor(OWNER) });
  assert.equal(good.statusCode, 200, good.body);
  assert.equal(good.json().status, 'done', good.body);
  assert.doesNotMatch(good.json().title, /Pedro/);
  assert.equal((await owner('GET', `/api/contacts/${pedro.id}/profile`)).statusCode, 404);
  const sec = await pool.query(`SELECT 1 FROM security_events WHERE kind = 'contact.erased' AND account_id = $1 AND target = $2`, [h.accountId, pedro.id]);
  assert.equal(sec.rowCount, 1, 'queda en la bitácora de seguridad');
});

t('embudos: crear uno (y deshacerlo)', async () => {
  script([call('guardar_embudo', { nombre: 'Mayoreo', columnas: [{ nombre: 'Nuevo' }, { nombre: 'Cotizado', cuando: 'Ya se le dio precio' }, { nombre: 'Ganado', tipo: 'ganada' }] }), 'Listo.']);
  const e = last(await ask('Crea un embudo Mayoreo con Nuevo, Cotizado y Ganado'), 'guardar_embudo');
  assert.equal(e.status, 'done', JSON.stringify(e));
  const p = (await owner('GET', '/api/pipelines')).json().find((x: any) => x.name === 'Mayoreo');
  assert.deepEqual(p.stages.map((s: any) => [s.name, s.kind]), [['Nuevo', 'open'], ['Cotizado', 'open'], ['Ganado', 'won']]);
  assert.equal(p.stages[1].when, 'Ya se le dio precio');
  assert.equal((await undo(e)).statusCode, 200);
  assert.ok(!(await owner('GET', '/api/pipelines')).json().some((x: any) => x.name === 'Mayoreo'));
});

t('ajustes del negocio: un cambio se aplica y se deshace; la retención se confirma con código', async () => {
  const before = (await owner('GET', '/api/settings')).json();
  script([call('ajustes_del_negocio', { tope_diario_por_numero: 250, bajas: { palabras: ['baja', 'stop', 'ya no'] } }), 'Listo.']);
  const a = last(await ask('Pon un tope de 250 mensajes de campaña al día y agrega «ya no» a las palabras de baja'), 'ajustes_del_negocio');
  assert.equal(a.status, 'done', JSON.stringify(a));
  const mid = (await owner('GET', '/api/settings')).json();
  assert.equal(mid.sending.daily_cap_per_number, 250);
  assert.deepEqual(mid.opt_out.keywords, ['baja', 'stop', 'ya no']);
  assert.equal(mid.opt_out.confirm_message, before.opt_out.confirm_message, 'lo demás de la sección no cambia');
  assert.equal((await undo(a)).statusCode, 200);
  const back = (await owner('GET', '/api/settings')).json();
  assert.equal(back.sending.daily_cap_per_number, before.sending.daily_cap_per_number);
  assert.deepEqual(back.opt_out.keywords, before.opt_out.keywords);

  script([call('ajustes_del_negocio', { retencion: { mensajes_dias: 90 } }), 'Confírmalo con tu código.']);
  const ret = last(await ask('Borra los mensajes de más de 90 días'), 'ajustes_del_negocio');
  assert.equal(ret.risk, 'code', JSON.stringify(ret));
  assert.deepEqual(ret.preview.lines, ['Retención · messages_days: 90'], 'la tarjeta muestra solo lo que cambia');
  assert.equal((await confirm(ret)).json().code, 'code_required');
  const done = await confirm(ret, { code: await h.codeFor(OWNER) });
  assert.equal(done.json().status, 'done', done.body);
  const pending = (await owner('GET', '/api/settings')).json().retention.pending;
  assert.equal(pending?.messages_days, 90, 'borra más: queda programada, con aviso a la dueña');
});

t('cobros: aprobar uno que registró un agente se confirma; un pago recurrente en pausa se deshace', async () => {
  const created = await owner('POST', '/api/receivables', { contact_id: conv.contact_id, concept: 'Paquete de uñas', amount_cents: 35000, due_date: '2026-12-20' });
  assert.equal(created.statusCode, 201, created.body);
  const cobro = created.json().receivable;
  // Como si lo hubiera registrado un agente: queda por aprobar.
  await pool.query(`UPDATE receivables SET approved_at = NULL, approved_by = NULL WHERE id = $1`, [cobro.id]);
  script([call('aprobar_cobro', { cobro_id: cobro.id }), 'Confírmalo.']);
  const ap = last(await ask('Aprueba el cobro del paquete de uñas'), 'aprobar_cobro');
  assert.equal(ap.status, 'proposed', JSON.stringify(ap));
  assert.equal((await owner('GET', `/api/receivables/${cobro.id}`)).json().receivable.needs_approval, true, 'no cambia sin confirmar');
  assert.equal((await confirm(ap)).json().status, 'done');
  assert.equal((await owner('GET', `/api/receivables/${cobro.id}`)).json().receivable.needs_approval, false);

  script([call('guardar_pago_recurrente', { contacto_id: conv.contact_id, concepto: 'Membresía', monto: 500, frecuencia: 'mensual', dia: 5, desde: '2026-12-01', activo: false }), 'Listo.']);
  const plan = last(await ask('Regístrale una membresía de 500 al mes, en pausa por ahora'), 'guardar_pago_recurrente');
  assert.equal(plan.status, 'done', JSON.stringify(plan));
  const list = (await owner('GET', `/api/receivable-plans?contact_id=${conv.contact_id}`)).json().data;
  assert.equal(list.find((p: any) => p.concept === 'Membresía')?.amount_cents, 50000);
  assert.equal((await undo(plan)).statusCode, 200);
  assert.ok(!(await owner('GET', `/api/receivable-plans?contact_id=${conv.contact_id}`)).json().data.some((p: any) => p.concept === 'Membresía'));

  // Activo, empieza a cobrar: se confirma.
  script([call('guardar_pago_recurrente', { contacto_id: conv.contact_id, concepto: 'Mantenimiento', monto: 300, frecuencia: 'semanal', dia: 1, desde: '2026-12-01' }), 'Confírmalo.']);
  const active = last(await ask('Cóbrale 300 cada semana de mantenimiento'), 'guardar_pago_recurrente');
  assert.equal(active.status, 'proposed', JSON.stringify(active));
});

t('exportar a CSV: con el código en la tarjeta deja «Descargar»; el panel baja el archivo sin pedir el código otra vez', async () => {
  const sid = sidOf(owner.cookie);
  // La verificación de la sesión ya pasó: sin código reciente, la exportación del panel lo pide.
  await pool.query(`UPDATE user_sessions SET mfa_at = now() - interval '2 hours' WHERE id = $1`, [sid]);
  const blocked = await owner('GET', '/api/export/contacts.csv?tag=vip');
  assert.deepEqual([blocked.statusCode, blocked.json().code], [403, 'step_up']);

  script([call('exportar_datos', { que: 'contactos', etiqueta: 'vip' }), 'Confírmalo con tu código.']);
  const r = await ask('Exporta a CSV los contactos VIP');
  const p = last(r, 'exportar_datos');
  assert.equal(p.risk, 'code', JSON.stringify(p));
  assert.match(p.preview.lines.join(' '), /etiqueta: vip/);
  assert.equal((await confirm(p)).json().code, 'code_required');
  const done = await confirm(p, { code: await h.codeFor(OWNER) });
  assert.equal(done.json().status, 'done', done.body);
  assert.equal(done.json().download_href, '/api/export/contacts.csv?tag=vip');
  const mfa = (await pool.query(`SELECT mfa_at FROM user_sessions WHERE id = $1`, [sid])).rows[0].mfa_at;
  assert.ok(Date.now() - new Date(mfa).getTime() < 60_000, 'el código de la tarjeta cuenta como la verificación reciente de la sesión');
  const file = await owner('GET', done.json().download_href);
  assert.equal(file.statusCode, 200, file.body);
  assert.match(String(file.headers['content-type']), /text\/csv/);
  assert.match(file.body, /Lupita Ruiz/);
  // El modelo nunca ve el archivo: solo que quedó listo.
  const tool = (await pool.query(`SELECT content FROM copilot_messages WHERE thread_id = $1 AND role = 'tool'`, [r.id])).rows.map((x) => x.content).join(' ');
  assert.doesNotMatch(tool, /Lupita/);
  // Sigue disponible al volver a abrir la conversación.
  assert.equal((await owner('GET', `/api/copilot/threads/${r.id}`)).json().actions.find((a: any) => a.id === p.id).download_href, '/api/export/contacts.csv?tag=vip');
});
