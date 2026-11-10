/**
 * Cotización de principio a fin con el PDF REAL (LibreOffice, como en el servidor): el cliente da su nombre y lo que
 * quiere, el sistema calcula con la calculadora del negocio, el PDF lleva toda la información (folio, cliente,
 * conceptos, cantidades, precios, importes, subtotal, IVA, total y leyenda) y la cotización queda guardada en el
 * agente, la conversación y el contacto, y aparece en el panel. Se omite donde no hay LibreOffice o pdftotext.
 */
process.env.QUOTE_PDF_BACKEND = 'soffice';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const has = (cmd: string) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
const tools = has('soffice') && has('pdftotext');
const { createHarness, dbAvailable, pool, waitFor } = await import('./harness.js');
const qstore = await import('../src/store/quotes.js');
const calcstore = await import('../src/store/quote-calculators.js');

const ok = (await dbAvailable()) && tools;
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'Sin PostgreSQL de pruebas, LibreOffice o pdftotext', timeout: 120_000 }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

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

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({
    data_fields: [{ key: 'nombre', label: 'Nombre', type: 'text' }],
    ai: { debounce_seconds: 0.1, quotes: { enabled: true, allow_final: false, required_fields: [], template_id: '' } },
  });
  const price = (code: string, name: string, family: string, attributes: Record<string, string>, cents: number) => qstore.createPriceItem(h.accountId, {
    code, name, description: '', unit: 'pieza', price_mode: 'exact', price_min: cents, price_max: null, iva_mode: 'plus', active: true, sort: 0, family, attributes,
  });
  // Precios con centavos, para que el redondeo del IVA cuente.
  await price('PAN-CL-15-A', 'Panel MetroMalla Clásica 1.50 m', 'panel', { producto: 'clasica', altura: '1.5', escalon: 'A' }, 90471);
  await price('POS-15-A', 'Poste', 'poste', { largo: '1.5', escalon: 'A' }, 32683);
  await price('PLA-A', 'Placa con anclas', 'placa', { escalon: 'A' }, 9889);
  await price('ABR-A', 'Abrazadera', 'abrazadera', { escalon: 'A' }, 2919);
  const calc = await calcstore.createCalculator(h.accountId, { name: 'Cercas', description: '', template_key: '', definition: CERCAS, active: true });
  await pool.query(`UPDATE chatbots SET ai = jsonb_set(ai, '{quotes}', (ai->'quotes') || $2::jsonb) WHERE id = $1`, [h.botId, JSON.stringify({ calculator_id: calc.id, send_summary: true, send_pdf: true })]);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('PDF real: el cálculo es exacto, el PDF lleva toda la información y la cotización queda guardada en el agente', async () => {
  const phone = '5215512340001';
  h.setScript(() => ({
    messages: ['Con gusto, Laura. Aquí está su cotización.'],
    save_data: [{ field: 'nombre', value: 'Laura Garza' }],
    quote: {
      action: 'calculate', items: [], notes: '', wants_final: false,
      inputs: [
        { key: 'metros', value: '12', quote: '12 metros' },
        { key: 'producto', value: 'clasica', quote: 'la clásica' },
        { key: 'altura', value: '1.5', quote: 'de 1.50' },
        { key: 'fijacion', value: 'placa', quote: 'con placa' },
      ],
    },
  }));
  await h.webhook('Soy Laura Garza, quiero 12 metros de la clásica de 1.50 con placa', { phone });
  await waitFor(async () => !!(await h.conversationFor(phone).catch(() => null)));
  await h.idle(60_000);
  const conv = await h.conversationFor(phone);

  // 1) El cálculo. 12 m → escalón A: 5 paneles, 6 postes de 1.5 m, 6 placas, 6 × 3 = 18 abrazaderas.
  //    4,523.55 + 1,960.98 + 593.34 + 525.42 = 7,603.29; IVA 7,603.29 × 0.16 = 1,216.5264 → 1,216.53; total 8,819.82.
  const [q] = await qstore.listQuotes(h.accountId, { conversationId: conv.id });
  assert.ok(q, 'se creó la cotización');
  assert.equal(q.status, 'sent');
  assert.deepEqual([q.subtotal_min, q.iva_min, q.total_min], [760329, 121653, 881982]);
  const lines = (await pool.query('SELECT name, qty, price_min, amount_min FROM quote_lines WHERE quote_id = $1 ORDER BY position', [q.id])).rows;
  assert.deepEqual(lines.map((l) => [l.name, Number(l.qty), Number(l.price_min), Number(l.amount_min)]), [
    ['Panel MetroMalla Clásica 1.50 m', 5, 90471, 452355],
    ['Poste de 1.5 m', 6, 32683, 196098],
    ['Placa con anclas', 6, 9889, 59334],
    ['Abrazadera', 18, 2919, 52542],
  ]);

  // 2) Guardada en el agente: ligada al agente, la conversación y el contacto, con la calculadora y los datos usados.
  const row = (await pool.query('SELECT chatbot_id, conversation_id, contact_id, calculator_id, calculator_inputs, pdf_path, folio FROM quotes WHERE id = $1', [q.id])).rows[0];
  assert.equal(row.chatbot_id, h.botId);
  assert.equal(row.conversation_id, conv.id);
  assert.equal(row.contact_id, conv.contact_id);
  assert.ok(row.calculator_id);
  assert.deepEqual(row.calculator_inputs, { metros: '12', producto: 'clasica', altura: '1.5', fijacion: 'placa' });
  assert.ok(row.pdf_path, 'el PDF quedó guardado');
  const list = (await h.authed('GET', `/api/quotes?account_id=${h.accountId}`)).json();
  const items = Array.isArray(list) ? list : (list.quotes ?? list.items ?? []);
  assert.ok(items.some((x: any) => x.id === q.id), `aparece en Cotizaciones del panel: ${JSON.stringify(list).slice(0, 300)}`);

  // 3) El PDF real, descargado como desde el panel, trae toda la información.
  const file = await h.authed('GET', `/api/quotes/${q.id}/file`);
  assert.equal(file.statusCode, 200);
  assert.match(String(file.headers['content-type']), /application\/pdf/);
  assert.equal(file.rawPayload.subarray(0, 5).toString(), '%PDF-');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cot-pdf-'));
  fs.writeFileSync(path.join(dir, 'c.pdf'), file.rawPayload);
  const text = execFileSync('pdftotext', ['-layout', path.join(dir, 'c.pdf'), '-'], { encoding: 'utf8' }).replace(/[ \t]+/g, ' ');
  fs.rmSync(dir, { recursive: true, force: true });
  if (process.env.SHOW_PDF_TEXT) console.log(text);
  for (const expected of [
    'COTIZACIÓN APROXIMADA', `Folio: ${row.folio}`, 'Fecha:', 'Cliente: Laura Garza', `Teléfono: ${phone}`,
    'Concepto Cantidad Unidad Precio Importe',
    'Panel MetroMalla Clásica 1.50 m', '$904.71', '$4,523.55',
    'Poste de 1.5 m', '$326.83', '$1,960.98',
    'Placa con anclas', '$98.89', '$593.34',
    'Abrazadera', '$29.19', '$525.42',
    'Subtotal: $7,603.29', 'IVA (16 %): $1,216.53', 'Total: $8,819.82', 'Vigencia:',
    'Precio aproximado sujeto a visita',
  ]) assert.ok(text.includes(expected), `El PDF debe incluir «${expected}». Texto:\n${text}`);

  // 4) El cliente recibió el desglose con los mismos montos y el PDF.
  const sent = h.sent.filter((s: any) => s.to === phone);
  assert.ok(sent.some((s: any) => s.kind === 'file' && s.mime === 'application/pdf'), JSON.stringify(sent));
  assert.ok(sent.some((s: any) => /Total: \$8,819\.82/.test(s.text ?? '')), JSON.stringify(sent));
});
