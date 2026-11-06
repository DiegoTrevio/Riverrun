/**
 * El Copiloto arma el cotizador de un agente desde productos, precios y reglas: la tarjeta muestra lo que entendió y
 * ejemplos calculados por el sistema; al confirmar activa exactamente eso (con historial y Deshacer). También lo prueba
 * con datos, y cambiar las cotizaciones del agente ya no le quita la calculadora.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor, type CopilotOut } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
type Req = Awaited<ReturnType<typeof h.loginAs>>;
let owner: Req;
let agent: Req;

function script(outs: CopilotOut[]) {
  let k = 0;
  h.setCopilotScript(() => outs[k++] ?? 'Listo.');
}
const call = (name: string, args: Record<string, unknown>) => ({ tool_calls: [{ name, arguments: args }] });
async function ask(req: Req, text: string) {
  const th = (await req('POST', '/api/copilot/threads', {})).json().id as string;
  const r = await req('POST', `/api/copilot/threads/${th}/messages`, { text });
  assert.equal(r.statusCode, 202, r.body);
  await waitFor(async () => (await req('GET', `/api/copilot/threads/${th}`)).json().turn?.status !== 'running', 8000);
  return (await req('GET', `/api/copilot/threads/${th}`)).json();
}
const actionOf = (out: any, tool: string) => out.actions.filter((a: any) => a.tool === tool).at(-1);
const confirm = (a: any) => owner('POST', `/api/copilot/actions/${a.id}/confirm`, { seen_hash: a.seen_hash });
const undo = (a: any) => owner('POST', `/api/copilot/actions/${a.id}/undo`);
const quotesOf = async () => (await owner('GET', `/api/chatbots/${h.botId}`)).json().ai.quotes;
/** Lo que la herramienta le devolvió al Copiloto (el mensaje de herramienta del último paso). */
const toolResult = () => JSON.stringify(h.copilotCalls.at(-1)!.messages.filter((m: any) => m.role === 'tool').at(-1)?.content ?? '');

const tiers = (o: Record<string, unknown> = {}) => ({ of: '', steps: [], otherwise_value: '', otherwise_stop: '', ...o });
const litro = (code: string, acabado: string, escalon: string, price: number) => ({ code, name: `Pintura ${acabado}`, unit: 'litro', family: 'pintura', attributes: [{ key: 'acabado', value: acabado }, { key: 'escalon', value: escalon }], price, price_max: null, price_mode: 'exact', iva_mode: 'default' });
const BUILT = (mate = 90) => ({
  summary: 'Pintura por m² con menudeo y mayoreo.',
  price_items: [litro('CP-MATE-MEN', 'mate', 'menudeo', mate), litro('CP-MATE-MAY', 'mate', 'mayoreo', 80), litro('CP-SAT-MEN', 'satinado', 'menudeo', 110), litro('CP-SAT-MAY', 'satinado', 'mayoreo', 95)],
  inputs: [
    { key: 'largo', label: 'Largo', help: '', type: 'number', unit: 'm', min: 0.1, max: null, decimals: 2, options: [], required: true, default: '' },
    { key: 'ancho', label: 'Ancho', help: '', type: 'number', unit: 'm', min: 0.1, max: null, decimals: 2, options: [], required: true, default: '' },
    { key: 'acabado', label: 'Acabado', help: '', type: 'option', unit: '', min: null, max: null, decimals: 0, options: [{ value: 'mate', label: 'Mate' }, { value: 'satinado', label: 'Satinado' }], required: true, default: '' },
  ],
  values: [
    { key: 'area', label: 'Área', formula: 'redondear(largo * ancho, 2)', tiers: tiers() },
    { key: 'litros', label: 'Litros', formula: 'redondear_arriba(area / 10)', tiers: tiers() },
    { key: 'escalon', label: 'Escalón', formula: '', tiers: tiers({ of: 'area', steps: [{ below: 50, value: 'menudeo' }], otherwise_value: 'mayoreo' }) },
  ],
  lines: [{ label: 'Pintura {acabado}', family: 'pintura', match: [{ attribute: 'acabado', formula: 'acabado' }, { attribute: 'escalon', formula: 'escalon' }], qty: 'litros', when: '' }],
  stops: [{ when: 'area > 500', message: 'Para más de 500 m² te atiende un asesor.' }],
  legend: 'Precio aproximado.',
  examples: [{ description: 'Cuarto', inputs: [{ key: 'largo', value: '5' }, { key: 'ancho', value: '4' }, { key: 'acabado', value: 'mate' }] }],
  unclear: [],
});
const TEXT = 'Pintura por m². Litros = m² ÷ 10 hacia arriba. Menudeo menos de 50 m², mayoreo desde 50. Mate $90/$80, satinado $110/$95. Más de 500 m² lo ve un asesor.';
let builds = 0;
const builder = (outs: unknown[]) => {
  let n = 0;
  h.setScript((req) => (req.json_schema?.name === 'quote_builder' ? (builds++, JSON.stringify(outs[Math.min(n++, outs.length - 1)])) : { messages: ['Con gusto.'] }));
};

before(async () => {
  if (!ok) return;
  h = await createHarness();
  (await import('../src/config.js')).config.copilot.turnsPerHour = 200;
  await h.createBot();
  await h.addUser({ account_id: h.accountId, email: 'duena@cotizador.mx', name: 'Dueña', password: 'Pz-124-Qx-324-Kv', role: 'admin' });
  await h.addUser({ account_id: h.accountId, email: 'agente@cotizador.mx', name: 'Luis', password: 'Pz-125-Qx-325-Kv', role: 'agent' });
  assert.equal((await h.authed('PUT', `/api/accounts/${h.accountId}`, { copilot_enabled: true })).statusCode, 200);
  owner = await h.loginAs('duena@cotizador.mx', 'Pz-124-Qx-324-Kv');
  agent = await h.loginAs('agente@cotizador.mx', 'Pz-125-Qx-325-Kv');
});
after(async () => {
  if (ok) await h.app.close();
});

t('armar_cotizador: la tarjeta muestra lo que entendió y ejemplos; al confirmar activa ese mismo borrador; Deshacer regresa el agente', async () => {
  builder([BUILT(90)]);
  builds = 0;
  script([call('armar_cotizador', { agente_id: h.botId, texto: TEXT }), 'Te dejé el cotizador listo para confirmar.']);
  const a = actionOf(await ask(owner, `Arma mi cotizador: ${TEXT}`), 'armar_cotizador');
  assert.equal(a.status, 'proposed', 'cambia precios y lo que recibe el cliente: se confirma');
  const lines = a.preview.lines.join('\n');
  assert.match(lines, /Pedirá: Largo; Ancho; Acabado \(Mate, Satinado\)/);
  assert.match(lines, /Lo atiende un asesor: Para más de 500 m² te atiende un asesor\./);
  assert.match(lines, /Ejemplo «Cuarto»: total \$208\.80/);
  assert.equal(builds, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM quote_calculators WHERE account_id = $1', [h.accountId])).rows[0].n, 0, 'proponer no guarda nada');

  // Aunque la IA cambiara de opinión, se activa lo que se vio en la tarjeta (sin volver a traducir).
  builder([BUILT(999)]);
  const done = await confirm(a);
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(builds, 1, 'al confirmar no se vuelve a llamar a la IA');
  const q = await quotesOf();
  assert.equal(q.enabled, true);
  assert.ok(q.calculator_id);
  const calc = (await pool.query('SELECT source_text, template_key FROM quote_calculators WHERE id = $1', [q.calculator_id])).rows[0];
  assert.deepEqual([calc.source_text, calc.template_key], [TEXT, 'texto']);
  assert.equal((await pool.query(`SELECT price_min::int AS p FROM price_items WHERE account_id = $1 AND code = 'CP-MATE-MEN'`, [h.accountId])).rows[0].p, 9000);

  assert.equal((await undo(a)).statusCode, 200);
  assert.equal((await quotesOf()).calculator_id, '', 'Deshacer regresa el agente como estaba');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM quote_calculators WHERE account_id = $1', [h.accountId])).rows[0].n, 1, 'la calculadora y sus precios se quedan guardados');
});

t('armar_cotizador: si el texto no alcanza, no propone nada y dice qué falta', async () => {
  const broken = { ...BUILT(), values: [{ key: 'area', label: '', formula: 'largo x ancho', tiers: tiers() }, ...BUILT().values.slice(1)] };
  builder([broken]);
  script([call('armar_cotizador', { agente_id: h.botId, texto: TEXT }), 'Me falta aclarar algo.']);
  const out = await ask(owner, `Arma mi cotizador: ${TEXT}`);
  assert.equal(out.actions.some((a: any) => a.tool === 'armar_cotizador' && a.status === 'proposed'), false);
  assert.match(toolResult(), /todavía no se puede activar/);
});

t('armar_cotizador sin texto vuelve a armar con el texto que ya tiene el agente; probar_cotizador calcula con datos', async () => {
  builder([BUILT(90)]);
  script([call('armar_cotizador', { agente_id: h.botId, texto: TEXT }), 'Listo.']);
  assert.equal((await confirm(actionOf(await ask(owner, `Arma mi cotizador: ${TEXT}`), 'armar_cotizador'))).statusCode, 200);

  builder([BUILT(95)]);
  script([call('armar_cotizador', { agente_id: h.botId }), 'Listo.']);
  const again = actionOf(await ask(owner, 'Vuelve a armar el cotizador'), 'armar_cotizador');
  assert.equal(again.status, 'proposed');
  const lastBuild = h.calls.filter((c) => c.json_schema?.name === 'quote_builder').at(-1)!;
  assert.match(String(lastBuild.messages.at(-1)!.content), /Mate \$90\/\$80/, 'usa el texto guardado');
  assert.equal((await confirm(again)).statusCode, 200);
  assert.equal((await pool.query(`SELECT price_min::int AS p FROM price_items WHERE account_id = $1 AND code = 'CP-MATE-MEN'`, [h.accountId])).rows[0].p, 9500);

  // 80 m² satinado → mayoreo: 8 litros × $95 = $760 + IVA = $881.60.
  script([call('probar_cotizador', { agente_id: h.botId, datos: { largo: 10, ancho: 8, acabado: 'satinado' } }), 'Saldría en $881.60.']);
  const tried = await ask(owner, '¿Cuánto saldría pintar 10 por 8 en satinado?');
  assert.equal(actionOf(tried, 'probar_cotizador')?.status, 'done');
  assert.match(toolResult(), /\$881\.60/);
  script([call('probar_cotizador', { agente_id: h.botId, datos: { largo: 30, ancho: 20, acabado: 'mate' } }), 'Eso lo ve un asesor.']);
  await ask(owner, '¿Y 30 por 20?');
  assert.match(toolResult(), /500 m² te atiende un asesor/);
});

t('cotizaciones_del_agente conserva la calculadora y elige cómo se envía', async () => {
  const calcId = (await quotesOf()).calculator_id;
  assert.ok(calcId);
  script([call('cotizaciones_del_agente', { agente_id: h.botId, permitir_final: false, enviar_pdf: false }), 'Listo.']);
  const out = await ask(owner, 'Que ya no mande el PDF y no permita finales');
  assert.equal(actionOf(out, 'cotizaciones_del_agente')?.status, 'done');
  const q = await quotesOf();
  assert.deepEqual([q.calculator_id, q.allow_final, q.send_pdf, q.send_summary], [calcId, false, false, true]);
});

t('un agente del equipo no puede armar el cotizador', async () => {
  h.copilotCalls.length = 0;
  script([call('armar_cotizador', { agente_id: h.botId, texto: TEXT }), 'No puedo.']);
  const out = await ask(agent, 'Arma el cotizador');
  assert.ok(!((h.copilotCalls[0] as any).tools as any[]).some((x) => x.name === 'armar_cotizador'), 'no se le ofrece');
  assert.equal(out.actions.some((a: any) => a.tool === 'armar_cotizador' && ['proposed', 'done'].includes(a.status)), false);
});
