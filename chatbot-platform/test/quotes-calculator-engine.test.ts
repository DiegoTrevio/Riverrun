/**
 * El asistente cotiza con la calculadora del negocio: la IA solo junta los datos (con las palabras del cliente) y el
 * sistema calcula, guarda y envía el desglose y/o el PDF. Las reglas del negocio y los precios que faltan pasan con un
 * asesor. Ningún mensaje lleva montos tapados, con o sin calculadora.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';
const qstore = await import('../src/store/quotes.js');
const calcstore = await import('../src/store/quote-calculators.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let phoneN = 0;
const nextPhone = () => `52155100${String(++phoneN).padStart(5, '0')}`;
const say = async (text: string, phone: string) => {
  await h.webhook(text, { phone });
  await waitFor(async () => !!(await h.conversationFor(phone).catch(() => null)));
  await h.idle();
};
const sentTo = (phone: string) => h.sent.filter((s) => s.to === phone);
const quotesOf = async (phone: string) => qstore.listQuotes(h.accountId, { conversationId: (await h.conversationFor(phone)).id });
const setQuotes = async (patch: Record<string, unknown>) =>
  pool.query(`UPDATE chatbots SET ai = jsonb_set(ai, '{quotes}', (ai->'quotes') || $2::jsonb) WHERE id = $1`, [h.botId, JSON.stringify(patch)]);
const calculate = (inputs: { key: string; value: string; quote: string }[]) => ({ action: 'calculate', items: [], inputs, notes: '', wants_final: false });

/** Cercas por metro lineal (el caso de MetroMalla, con precios inventados). */
const CERCAS = {
  inputs: [
    { key: 'metros', label: 'Metros lineales', type: 'number', unit: 'ML', min: 0.5, max: 10000 },
    { key: 'producto', label: 'Producto', type: 'option', options: [{ value: 'recta', label: 'MetroMalla Recta' }, { value: 'clasica', label: 'MetroMalla Clásica' }] },
    { key: 'altura', label: 'Altura', type: 'option', options: [{ value: '1.5', label: '1.50 m' }, { value: '2', label: '2.00 m' }] },
    { key: 'fijacion', label: 'Fijación', type: 'option', options: [{ value: 'placa', label: 'Con placa' }, { value: 'cimentado', label: 'Cimentado' }] },
  ],
  values: [
    { key: 'escalon', tiers: { of: 'metros', steps: [{ below: 15, value: 'A' }, { below: 50, value: 'B' }, { below: 100, value: 'C' }, { below: 130, value: 'D' }], otherwise: { stop: 'Para 130 metros o más te atiende un asesor.' } } },
    { key: 'paneles', formula: 'redondear_arriba(metros / 2.5)' },
    { key: 'postes', formula: 'paneles + 1' },
    { key: 'largo_poste', formula: "altura + si(fijacion == 'cimentado', 0.5, 0)" },
    { key: 'abrazaderas', formula: 'postes * si(altura <= 1, 2, si(altura == 1.5, 3, 4))' },
  ],
  lines: [
    { family: 'panel', match: { producto: 'producto', altura: 'altura', escalon: 'escalon' }, qty: 'paneles' },
    { label: 'Poste de {largo_poste} m', family: 'poste', match: { largo: 'largo_poste', escalon: 'escalon' }, qty: 'postes' },
    { family: 'placa', match: { escalon: 'escalon' }, qty: 'postes', when: "fijacion == 'placa'" },
    { family: 'abrazadera', match: { escalon: 'escalon' }, qty: 'abrazaderas' },
  ],
  legend: 'Precio aproximado sujeto a visita. Vigencia: 15 días.',
};

const BASE = [
  { key: 'metros', value: '40', quote: '40 metros' },
  { key: 'producto', value: 'clasica', quote: 'la clásica' },
  { key: 'altura', value: '2', quote: 'de 2 metros de alto' },
  { key: 'fijacion', value: 'cimentado', quote: 'cimentado' },
];
const ASK = 'Quiero cotizar 40 metros de la clásica de 2 metros de alto, cimentado';

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ ai: { debounce_seconds: 0.1, quotes: { enabled: true, allow_final: true, required_fields: [], template_id: '' } } });
  await h.addUser({ account_id: h.accountId, name: 'Dueño', email: 'dueno@cercas.test', password: 'Pz-117-Qx-317-Kv', role: 'admin' });
  const price = (code: string, name: string, family: string, attributes: Record<string, string>, pesos: number) => qstore.createPriceItem(h.accountId, {
    code, name, description: '', unit: 'pieza', price_mode: 'exact', price_min: pesos * 100, price_max: null, iva_mode: 'plus', active: true, sort: 0, family, attributes,
  });
  await price('PAN-CL-2-B', 'Panel MetroMalla Clásica 2.00 m', 'panel', { producto: 'clasica', altura: '2', escalon: 'B' }, 1000);
  await price('POS-25-B', 'Poste', 'poste', { largo: '2.5', escalon: 'B' }, 450);
  await price('POS-2-B', 'Poste', 'poste', { largo: '2', escalon: 'B' }, 400);
  await price('PLA-B', 'Placa', 'placa', { escalon: 'B' }, 80);
  await price('ABR-B', 'Abrazadera', 'abrazadera', { escalon: 'B' }, 12);
  const calc = await calcstore.createCalculator(h.accountId, { name: 'Cercas', description: '', template_key: '', definition: CERCAS, active: true });
  await setQuotes({ calculator_id: calc.id, send_summary: true, send_pdf: true });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('calculadora: con los datos del cliente sale el desglose exacto y el PDF; la cotización guarda calculadora, versión y datos', async () => {
  const phone = nextPhone();
  h.reset();
  h.setScript(() => ({ messages: ['¡Listo! Te comparto tu cotización.'], quote: calculate(BASE) }));
  await say(ASK, phone);
  const sent = sentTo(phone);
  assert.deepEqual(sent.map((s) => s.kind), ['text', 'text', 'file'], JSON.stringify(sent));
  const summary = sent[1].text;
  assert.match(summary, /cotización APROXIMADA \(folio COT-0001\)/);
  assert.match(summary, /16 × Panel MetroMalla Clásica 2\.00 m — \$1,000\.00 = \$16,000\.00/);
  assert.match(summary, /17 × Poste de 2\.5 m — \$450\.00 = \$7,650\.00/);
  assert.match(summary, /68 × Abrazadera — \$12\.00 = \$816\.00/);
  assert.doesNotMatch(summary, /Placa/, 'cimentado no lleva placas');
  // 24,466.00 + IVA 3,914.56 = 28,380.56.
  assert.match(summary, /Subtotal: \$24,466\.00\nIVA: \$3,914\.56\nTotal: \$28,380\.56/);
  assert.match(summary, /Precio aproximado sujeto a visita/);
  assert.equal(sent[2].mime, 'application/pdf');
  const [q] = await quotesOf(phone);
  assert.equal(q.status, 'sent');
  assert.equal(q.total_min, 2_838_056);
  const row = (await pool.query('SELECT calculator_id, calculator_version, calculator_inputs FROM quotes WHERE id = $1', [q.id])).rows[0];
  assert.ok(row.calculator_id);
  assert.equal(row.calculator_version, 1);
  assert.deepEqual(row.calculator_inputs, { metros: '40', producto: 'clasica', altura: '2', fijacion: 'cimentado' });
  // El prompt lista los datos de la calculadora y no los precios.
  const prompt = h.calls.at(-1)!.messages[0].content as string;
  assert.match(prompt, /Cotizaciones \(calculadora del negocio\)/);
  assert.match(prompt, /`metros` \| Metros lineales/);
  assert.doesNotMatch(prompt, /\$1,000\.00/);
});

t('calculadora: las dos salidas son independientes (solo desglose, o solo PDF con el mensaje corto)', async () => {
  await setQuotes({ send_pdf: false, send_summary: true });
  let phone = nextPhone();
  h.reset();
  h.setScript(() => ({ messages: ['Te comparto tu cotización.'], quote: calculate(BASE) }));
  await say(ASK, phone);
  assert.deepEqual(sentTo(phone).map((s) => s.kind), ['text', 'text'], 'sin PDF');
  assert.match(sentTo(phone)[1].text, /Total: \$28,380\.56/);
  assert.equal((await quotesOf(phone))[0].status, 'sent', 'el desglose en el chat cuenta como enviada');

  await setQuotes({ send_pdf: true, send_summary: false });
  phone = nextPhone();
  h.reset();
  await say(ASK, phone);
  const sent = sentTo(phone);
  assert.deepEqual(sent.map((s) => s.kind), ['text', 'text', 'file']);
  assert.match(sent[1].text, /Te comparto tu cotización APROXIMADA \(folio COT-\d+\): total \$28,380\.56 con IVA/);
  assert.doesNotMatch(sent[1].text, /× Panel/, 'sin desglose');
  await setQuotes({ send_pdf: true, send_summary: true });
});

t('calculadora: una regla del negocio pasa con un asesor (130 metros) y no se crea cotización', async () => {
  const phone = nextPhone();
  h.reset();
  h.setScript(() => ({ messages: ['Te preparo la cotización.'], quote: calculate([{ key: 'metros', value: '130', quote: '130 metros' }, ...BASE.slice(1)]) }));
  await say('Quiero cotizar 130 metros de la clásica de 2 metros de alto, cimentado', phone);
  const conv = await h.conversationFor(phone);
  assert.equal(conv.status, 'human');
  assert.match(sentTo(phone).map((s) => s.text).join('\n'), /Para 130 metros o más te atiende un asesor/);
  assert.equal((await quotesOf(phone)).length, 0);
});

t('calculadora: si falta un precio en la lista pasa con un asesor y queda registrado qué falta', async () => {
  const phone = nextPhone();
  h.reset();
  h.setScript(() => ({ messages: ['Te preparo la cotización.'], quote: calculate([{ key: 'metros', value: '10', quote: '10 metros' }, ...BASE.slice(1)]) }));
  await say('Quiero cotizar 10 metros de la clásica de 2 metros de alto, cimentado', phone);
  assert.equal((await h.conversationFor(phone)).status, 'human');
  assert.equal((await quotesOf(phone)).length, 0);
  const logs = await pool.query(`SELECT message FROM event_logs WHERE account_id = $1 AND message LIKE '%no pudo cotizar%'`, [h.accountId]);
  const detail = String(logs.rows[0]?.message);
  assert.match(detail, /Falta en la lista de precios: «panel» con /);
  for (const part of ['producto = clasica', 'altura = 2', 'escalon = A']) assert.ok(detail.includes(part), detail);
});

t('calculadora: datos que el cliente no dio, opciones inventadas o números cambiados no cotizan', async () => {
  const phone = nextPhone();
  h.reset();
  // La IA inventa la altura (el cliente no la dijo) en los dos intentos: se le pregunta.
  h.setScript(() => ({ messages: ['Te comparto tu cotización.'], quote: calculate([BASE[0], BASE[1], { key: 'altura', value: '2', quote: 'dos metros' }, BASE[3]]) }));
  await say('Quiero cotizar 40 metros de la clásica, cimentado', phone);
  assert.equal((await quotesOf(phone)).length, 0);
  assert.match(sentTo(phone).map((s) => s.text).join('\n'), /necesito que me digas: Altura/);

  const other = nextPhone();
  h.reset();
  h.setScript(() => ({ messages: ['Te comparto tu cotización.'], quote: calculate([BASE[0], { key: 'producto', value: 'premium', quote: 'la clásica' }, BASE[2], BASE[3]]) }));
  await say(ASK, other);
  assert.equal((await quotesOf(other)).length, 0, 'una opción que no existe no cotiza');

  const third = nextPhone();
  h.reset();
  h.setScript(() => ({ messages: ['Te comparto tu cotización.'], quote: calculate([{ key: 'metros', value: '400', quote: '40 metros' }, ...BASE.slice(1)]) }));
  await say(ASK, third);
  assert.equal((await quotesOf(third)).length, 0, 'un número distinto al que dijo el cliente no cotiza');
});

t('montos tapados («$XX,XXX», «[precio]») nunca llegan al cliente, con o sin calculadora', async () => {
  for (const calculator of [true, false]) {
    if (!calculator) await setQuotes({ calculator_id: '' });
    const phone = nextPhone();
    h.reset();
    h.setScript(() => ({ messages: ['Claro. El total queda en $XX,XXX con IVA y la instalación en [precio] por metro.', '¿Te la mando?'] }));
    await say('¿Cuánto cuesta la cerca?', phone);
    const text = sentTo(phone).map((s) => s.text).join('\n');
    assert.doesNotMatch(text, /\$XX|\[precio\]/i, text);
  }
});
