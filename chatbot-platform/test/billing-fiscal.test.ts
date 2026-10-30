/** Datos fiscales («con o sin factura»): validación del SAT, guardado y exigencia antes de pagar con factura. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
// Orden obligatorio: los simulados fijan las claves y URLs ANTES de que el arnés cargue la configuración.
await import('./billing-fakes.js');
const { createHarness, dbAvailable, pool } = await import('./harness.js');
const { cleanLegalName, FiscalSchema, rfcProblem, usesFor } = await import('../src/billing/fiscal.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

/** Empresa de prueba del SAT. */
const MORAL = { wants_invoice: true, rfc: 'EKU9003173C9', legal_name: 'Escuela Kemper Urgate S.A. de C.V.', tax_regime: '601', zip: '42501', cfdi_use: 'G03', invoice_email: '' };
const issues = (d: unknown) => {
  const r = FiscalSchema.safeParse(d);
  return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message]));
};

before(async () => {
  if (!ok) return;
  h = await createHarness();
  assert.equal((await h.authed('POST', '/api/plans', { key: 'pro', name: 'Pro', price: 499 })).statusCode, 200);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

test('RFC: dígito verificador del SAT, longitud, fecha y genéricos', () => {
  // RFC de prueba del SAT: dos empresas (12) y dos personas físicas (13).
  for (const rfc of ['EKU9003173C9', 'IIA040805DZ4', 'CACX7605101P8', 'MASO451221PM4']) assert.equal(rfcProblem(rfc), '', rfc);
  assert.equal(rfcProblem(' eku9003173c9 '), '', 'acepta minúsculas y espacios');
  assert.match(rfcProblem('EKU9003173C8'), /homoclave/);
  assert.match(rfcProblem('EKU9013173C9'), /fecha/);
  assert.match(rfcProblem('EKU90031'), /12 caracteres/);
  for (const g of ['XAXX010101000', 'XEXX010101000']) assert.match(rfcProblem(g), /genérico/);
});

test('régimen según persona física o moral, uso del CFDI según régimen, CP y razón social', () => {
  assert.deepEqual(issues(MORAL), {});
  assert.match(issues({ ...MORAL, tax_regime: '612' }).tax_regime, /personas físicas y tu RFC es de empresa/);
  assert.match(issues({ ...MORAL, rfc: 'CACX7605101P8' }).tax_regime, /empresas y tu RFC es de persona física/);
  assert.deepEqual(issues({ ...MORAL, rfc: 'CACX7605101P8', tax_regime: '612' }), {});
  assert.deepEqual(usesFor('605'), ['S01'], 'sueldos y salarios no deduce gastos en general');
  assert.match(issues({ ...MORAL, rfc: 'CACX7605101P8', tax_regime: '605' }).cfdi_use, /no aplica/);
  assert.match(issues({ ...MORAL, zip: '4250' }).zip, /5 números/);
  assert.match(issues({ ...MORAL, invoice_email: 'no-es-correo' }).invoice_email, /no válido/);
  assert.match(issues({ ...MORAL, legal_name: '  ' }).legal_name, /Constancia/);
  assert.equal(cleanLegalName('Escuela Kemper Urgate, S.A. de C.V.'), 'ESCUELA KEMPER URGATE');
  assert.equal(cleanLegalName('Comercial del Norte SA de CV'), 'COMERCIAL DEL NORTE');
  assert.equal(cleanLegalName('Juan Pérez López'), 'JUAN PÉREZ LÓPEZ');
  assert.deepEqual(issues({ wants_invoice: false }), {}, 'sin factura no se exige nada');
});

t('guardar y leer los datos; un agente no puede; con factura y datos incompletos no se puede pagar', async () => {
  const r = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: '10.55.0.1',
    payload: { name: 'Ema Ruiz', company: 'Escuela Ema', business_type: 'servicios', email: 'ema@escuela.mx', password: 'Pz-119-Qx-319-Kv', accept_terms: true } });
  assert.equal(r.statusCode, 200, r.body);
  const accountId = r.json().account.id;
  const cookie = String(r.headers['set-cookie']).split(';')[0];
  const api = (method: string, url: string, payload?: unknown) => h.app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });

  let g = (await api('GET', '/api/billing/fiscal')).json();
  assert.deepEqual([g.fiscal.wants_invoice, g.complete], [false, false]);
  assert.ok(g.regimes.some((x: any) => x.code === '626' && x.for.includes('moral') && x.for.includes('fisica')));
  assert.deepEqual(g.uses_by_regime['601'], ['G03', 'S01']);
  assert.equal((await api('GET', '/api/billing')).json().fiscal.wants_invoice, false);

  // Sin factura se puede pagar.
  let pay = await api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' });
  assert.equal(pay.statusCode, 200, pay.body);

  // Pide factura con un RFC mal escrito: el error dice qué campo.
  const bad = await api('PUT', '/api/billing/fiscal', { ...MORAL, rfc: 'EKU9003173C8' });
  assert.equal(bad.statusCode, 400);
  assert.ok(bad.json().issues.some((i: string) => /^rfc: .*homoclave/.test(i)));

  // Marcada «con factura» sin datos completos (p. ej. de antes): no puede pagar hasta completarlos.
  await pool.query(`INSERT INTO account_fiscal (account_id, wants_invoice) VALUES ($1, true)`, [accountId]);
  pay = await api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' });
  assert.equal(pay.statusCode, 400);
  assert.match(pay.json().error, /Completa tus datos de facturación/);

  const saved = await api('PUT', '/api/billing/fiscal', MORAL);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json(), { ok: true, complete: true, wants_invoice: true });
  g = (await api('GET', '/api/billing/fiscal')).json();
  assert.equal(g.fiscal.legal_name, 'ESCUELA KEMPER URGATE', 'sin el régimen societario');
  assert.equal(g.fiscal.rfc, 'EKU9003173C9');
  assert.deepEqual((await api('GET', '/api/billing')).json().fiscal, { wants_invoice: true, complete: true });
  assert.equal((await api('POST', '/api/billing/checkout', { plan: 'pro', provider: 'stripe' })).statusCode, 200);

  // Cambia a sin factura: se conservan los datos por si los vuelve a pedir.
  assert.equal((await api('PUT', '/api/billing/fiscal', { wants_invoice: false, rfc: 'EKU9003173C9', legal_name: 'ESCUELA KEMPER URGATE', tax_regime: '601', zip: '42501', cfdi_use: 'G03' })).statusCode, 200);
  g = (await api('GET', '/api/billing/fiscal')).json();
  assert.deepEqual([g.fiscal.wants_invoice, g.fiscal.rfc, g.complete], [false, 'EKU9003173C9', true]);

  assert.equal((await h.authed('POST', '/api/users', { account_id: accountId, name: 'Iker', email: 'iker@escuela.mx', password: 'Pz-126-Qx-326-Kv', role: 'agent' })).statusCode, 200);
  const agent = await h.loginAs('iker@escuela.mx', 'Pz-126-Qx-326-Kv');
  assert.equal((await agent('GET', '/api/billing/fiscal')).statusCode, 403);
  assert.equal((await agent('PUT', '/api/billing/fiscal', MORAL)).statusCode, 403);
});
