/**
 * Crear flujos y cambiar instrucciones con IA, de punta a punta: la idea (o una foto) se convierte en un lienzo que se
 * publica y funciona con un cliente real; un cambio pedido en palabras conserva lo demás; y las instrucciones del agente
 * se ajustan escribiendo qué cambiar, sin guardarse hasta aplicarlas.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  const s = (await h.authed('GET', `/api/settings?account_id=${h.accountId}`)).json();
  assert.equal((await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { consent: { ...s.consent, require_for_campaigns: false } })).statusCode, 200);
  const k = await h.authed('POST', `/api/chatbots/${h.botId}/knowledge`, { category: 'precios', title: 'Precios', content: 'Corte de cabello $150. Barba $90.', always_include: true });
  assert.equal(k.statusCode, 200, k.body);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

const block = (b: Record<string, unknown>) => ({ text: '', minutes: 0, at_time: '', photo: '', buttons: [], wait_for_choice: false, next: '', ...b });
const button = (label: string, go_to: string) => ({ label, kind: 'reply', url: '', reply: '', go_to });
const SPEC = {
  name: 'Promo de corte', summary: 'Armé la promo con dos opciones.', review: ['Revisa el precio de la promo.'],
  trigger: { type: 'message_received', keywords: ['promo'], match: 'keywords', minutes: 0, tag: '' },
  start: 'm1',
  blocks: [
    block({ id: 'm1', type: 'message', text: 'Hola {{nombre}}, esta semana el corte cuesta $120. ¿Lo apartamos?', wait_for_choice: true, buttons: [button('Sí, apartar', 'h1'), button('Ver precios', 'm2')] }),
    block({ id: 'm2', type: 'message', text: 'Corte $150 y barba $90.' }),
    block({ id: 'h1', type: 'handoff', text: 'Quiere apartar' }),
  ],
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function multipart(fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) {
  const b = '----lienzo';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) parts.push(Buffer.from(`--${b}\r\ncontent-disposition: form-data; name="file"; filename="${file.name}"\r\ncontent-type: ${file.type}\r\n\r\n`), file.data, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${b}`, cookie: h.cookie } };
}
const design = (body: Record<string, unknown>) => h.authed('POST', `/api/flow-boards/ai?account_id=${h.accountId}`, body);

t('escribir la idea arma un flujo que se publica y funciona con un cliente', async () => {
  h.reset();
  h.setScript(() => JSON.stringify(SPEC));
  const r = await design({ idea: 'Cuando escriban promo, ofréceles el corte a $120 y que puedan apartar o ver precios' });
  assert.equal(r.statusCode, 200, r.body);
  const out = r.json();
  assert.equal(out.name, 'Promo de corte');
  assert.equal(out.summary, 'Armé la promo con dos opciones.');
  assert.deepEqual(out.review, ['Revisa el precio de la promo.']);
  assert.deepEqual(out.problems, []);
  assert.equal(out.photo, null);
  const sent = JSON.stringify(h.calls[0].messages);
  assert.match(sent, /Cuenta de pruebas/, 'la IA conoce el nombre del negocio');
  assert.match(sent, /Corte de cabello \$150/, 'y la información de su agente');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ai_runs WHERE kind = 'flow_ai'`)).rows[0].n, 1);

  // Se guarda como lienzo, se publica y el cliente recibe el mensaje con sus botones.
  const created = await h.authed('POST', '/api/flow-boards', { account_id: h.accountId, name: out.name, board: out.board });
  assert.equal(created.statusCode, 200, created.body);
  const pub = await h.authed('POST', `/api/flow-boards/${created.json().id}/publish`, { revision: created.json().revision });
  assert.equal(pub.statusCode, 200, pub.body);
  h.reset();
  await h.webhook('quiero la promo', { phone: '5215500001111' });
  await h.idle();
  await h.fastForward();
  const texts = h.sent.filter((s) => s.to === '5215500001111').map((s) => s.text).join('\n');
  assert.match(texts, /Hola Ana, esta semana el corte cuesta \$120/);
  assert.match(texts, /Sí, apartar/);
  assert.match(texts, /Ver precios/);
});

t('una foto del dibujo o del volante: si es para los clientes, se guarda y va en el mensaje', async () => {
  h.reset();
  h.setScript((req: any) => {
    const parts = req.messages[1].content;
    assert.ok(Array.isArray(parts) && parts.some((p: any) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')), 'la imagen llega a la IA');
    return JSON.stringify({ ...SPEC, blocks: SPEC.blocks.map((b) => (b.id === 'm1' ? { ...b, photo: 'upload' } : b)) });
  });
  const form = multipart({ idea: 'Usa este volante' }, { name: 'volante.png', type: 'image/png', data: PNG });
  const r = await h.app.inject({ method: 'POST', url: `/api/flow-boards/ai?account_id=${h.accountId}`, ...form });
  assert.equal(r.statusCode, 200, r.body);
  const { board, photo } = r.json();
  assert.ok(photo?.id, 'la foto quedó en los archivos de la cuenta');
  assert.equal(photo.kind, 'image');
  assert.ok(board.nodes.some((n: any) => n.type === 'message' && n.data.attachment_id === photo.id));

  // Un dibujo del flujo (no es para enviarse) no se guarda.
  h.setScript(() => JSON.stringify(SPEC));
  const before = (await pool.query('SELECT count(*)::int AS n FROM attachments')).rows[0].n;
  const sketch = await h.app.inject({ method: 'POST', url: `/api/flow-boards/ai?account_id=${h.accountId}`, ...multipart({ idea: '' }, { name: 'dibujo.png', type: 'image/png', data: PNG }) });
  assert.equal(sketch.statusCode, 200, sketch.body);
  assert.equal(sketch.json().photo, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM attachments')).rows[0].n, before);

  const pdf = await h.app.inject({ method: 'POST', url: `/api/flow-boards/ai?account_id=${h.accountId}`, ...multipart({ idea: 'x' }, { name: 'a.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 hola') }) });
  assert.equal(pdf.statusCode, 400);
  assert.match(pdf.json().error, /Sube una foto JPG, PNG o WEBP/);
  assert.equal((await design({ idea: '   ' })).statusCode, 400);
});

t('pedir un cambio en palabras conserva lo que no se pidió cambiar', async () => {
  h.setScript(() => JSON.stringify(SPEC));
  const first = (await design({ idea: 'promo' })).json();
  const board = { ...first.board, nodes: [...first.board.nodes, { id: 'nota1', type: 'note', x: -400, y: 0, data: { text: 'Agregar opción de barba' } }] };
  const m1 = board.nodes.find((n: any) => n.type === 'message' && n.data.text.startsWith('Hola'));
  h.reset();
  h.setScript((req: any) => {
    const text = String(req.messages[1].content);
    assert.match(text, /Flujo actual «Promo de corte»/);
    assert.match(text, new RegExp(`"id":"${m1.id}"`), 'la IA ve los ids para conservarlos');
    assert.match(text, /Notas escritas en el lienzo:\n- Agregar opción de barba/);
    assert.match(text, /agrega un botón para barba/);
    return JSON.stringify({ ...SPEC, name: 'Otro nombre', trigger: { ...SPEC.trigger, type: 'keep' }, summary: 'Agregué la opción de barba.', blocks: [
      ...SPEC.blocks.map((b) => (b.id === 'm1' ? { ...b, id: m1.id, buttons: [...b.buttons, button('Barba', 'm3')] } : b)),
      block({ id: 'm3', type: 'message', text: 'La barba cuesta $90.' }),
    ], start: m1.id });
  });
  const r = await design({ idea: 'agrega un botón para barba', name: 'Promo de corte', board });
  assert.equal(r.statusCode, 200, r.body);
  const out = r.json();
  assert.equal(out.name, 'Promo de corte', 'al cambiar, el nombre no cambia');
  assert.equal(out.summary, 'Agregué la opción de barba.');
  const kept = out.board.nodes.find((n: any) => n.id === m1.id);
  assert.deepEqual([kept.x, kept.y, kept.data.buttons.length], [m1.x, m1.y, 3]);
  assert.ok(out.board.nodes.some((n: any) => n.id === 'nota1'), 'la nota sigue en el lienzo');
  assert.deepEqual(out.board.nodes.find((n: any) => n.type === 'trigger').data.trigger.keywords, ['promo']);
});

t('cambiar instrucciones escribiendo qué cambiar: propone, no guarda, y al aplicar queda en el agente', async () => {
  const prompt = 'Eres Lalo, de la barbería.\n\n- Corte $150\n- Envío gratis\n\nAtiende de tú.';
  const versions = (await h.authed('GET', `/api/chatbots/${h.botId}/versions`)).json();
  const applied = await h.authed('POST', `/api/chatbots/${h.botId}/version-apply`, { revision: versions.draft.revision, patch: { personality: { ...versions.draft_bot.personality, prompt } } });
  assert.equal(applied.statusCode, 200, applied.body);
  h.reset();
  h.setScript((req: any) => {
    const text = String(req.messages[1].content);
    assert.match(text, /\[3\] - Envío gratis/);
    assert.match(text, /Contexto de lo que la persona está viendo:\n<contexto>\nFlujo «Promo»/);
    return JSON.stringify({ summary: 'Quité el envío gratis y agregué que los domingos cierran.', question: '', operations: [{ op: 'remove', line: 3, text: '' }, { op: 'add', line: 4, text: 'Los domingos cerramos.' }] });
  });
  const r = await h.authed('POST', `/api/chatbots/${h.botId}/prompt-edit`, { instruction: 'ya no hay envío gratis y los domingos cerramos', context: 'Flujo «Promo»' });
  assert.equal(r.statusCode, 200, r.body);
  const out = r.json();
  assert.equal(out.changed, true);
  assert.equal(out.prompt, 'Eres Lalo, de la barbería.\n\n- Corte $150\n\nAtiende de tú.\n\nLos domingos cerramos.');
  assert.deepEqual(out.lines.filter((l: any) => l.state !== 'same').map((l: any) => l.state), ['removed', 'new']);
  assert.equal((await h.authed('GET', `/api/chatbots/${h.botId}`)).json().personality.prompt, prompt, 'la propuesta no se guarda sola');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ai_runs WHERE kind = 'prompt_edit'`)).rows[0].n, 1);

  const v = (await h.authed('GET', `/api/chatbots/${h.botId}/versions`)).json();
  const saved = await h.authed('POST', `/api/chatbots/${h.botId}/version-apply`, { revision: v.draft.revision, patch: { personality: { ...v.draft_bot.personality, prompt: out.prompt } } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal((await h.authed('GET', `/api/chatbots/${h.botId}`)).json().personality.prompt, out.prompt);

  h.setScript(() => JSON.stringify({ summary: '', question: 'No encontré nada sobre estacionamiento.', operations: [] }));
  const none = (await h.authed('POST', `/api/chatbots/${h.botId}/prompt-edit`, { instruction: 'quita lo del estacionamiento', prompt: out.prompt })).json();
  assert.equal(none.changed, false);
  assert.equal(none.question, 'No encontré nada sobre estacionamiento.');
  assert.equal((await h.authed('POST', `/api/chatbots/${h.botId}/prompt-edit`, { instruction: ' ' })).statusCode, 400);
});
