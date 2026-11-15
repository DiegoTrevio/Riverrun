/**
 * Avisos de privacidad (LFPDPPP): integral en /privacidad, simplificado en /privacidad/simplificado y protección de
 * datos (encargados) en /proteccion-de-datos; el registro los enlaza siempre y la constancia guarda la versión.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, type Env } from '../src/config-check.js';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { config } = await import('../src/config.js');
const { PROCESSORS } = await import('../src/routes/legal-pages.js');
const { PRIVACY_NOTICE_VERSION } = await import('../src/signup-guard.js');

/** Cambia datos del responsable solo durante una prueba. */
async function withPrivacy(over: Partial<typeof config.signup>, fn: () => Promise<void>) {
  const prev = { ...config.signup };
  Object.assign(config.signup, over);
  try {
    await fn();
  } finally {
    Object.assign(config.signup, prev);
  }
}
const get = (url: string) => h.app.inject({ method: 'GET', url });

before(async () => {
  if (!ok) return;
  h = await createHarness();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('aviso integral: responsable, finalidades, transferencias, ARCO, revocación, cookies, conservación y autoridad', async () => {
  await withPrivacy({ privacyCompany: 'Riverrun S.A. de C.V.', privacyAddress: 'Av. Reforma 1, CDMX', privacyContact: 'privacidad@riverrun.mx', privacyUrl: '' }, async () => {
    const r = await get('/privacidad');
    assert.equal(r.statusCode, 200);
    for (const text of ['Aviso de privacidad integral', 'Riverrun S.A. de C.V.', 'Av. Reforma 1, CDMX', 'privacidad@riverrun.mx', 'Finalidades necesarias', 'Finalidades secundarias',
      'Datos sensibles', 'ARCO', '20 días hábiles', '15 días hábiles', 'Revocar tu consentimiento', 'Cookies', 'Secretaría Anticorrupción y Buen Gobierno']) {
      assert.ok(r.body.includes(text), `falta «${text}»`);
    }
    assert.match(r.body, /href="\/privacidad\/simplificado"/);
    assert.match(r.body, /href="\/proteccion-de-datos#proveedores"/);
    assert.ok(!r.body.includes('<mark>'), 'sin marcadores cuando todo está definido');
  });
});

t('aviso integral: lo que falta del responsable se ve como marcador y lo que se define va escapado', async () => {
  await withPrivacy({ privacyCompany: '', privacyAddress: '', privacyContact: '', supportContact: '', superadminEmail: '', privacyUrl: '' }, async () => {
    const r = await get('/privacidad');
    assert.match(r.body, /<mark>\[Razón social del responsable\]<\/mark>/);
    assert.match(r.body, /<mark>\[Domicilio del responsable\]<\/mark>/);
    assert.match(r.body, /<mark>\[Correo para privacidad\]<\/mark>/);
  });
  await withPrivacy({ privacyCompany: '<script>x</script>', privacyAddress: 'Calle "1"', privacyContact: 'a@b.mx', privacyUrl: '' }, async () => {
    const r = await get('/privacidad');
    assert.ok(!r.body.includes('<script>x</script>'));
    assert.ok(r.body.includes("&#60;script&#62;x&#60;/script&#62;"), "la razón social va escapada");
  });
});

t('aviso simplificado: responsable, finalidades, transferencias y enlace al integral', async () => {
  await withPrivacy({ privacyCompany: 'Riverrun S.A. de C.V.', privacyUrl: '' }, async () => {
    const r = await get('/privacidad/simplificado');
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /Aviso de privacidad simplificado/);
    assert.match(r.body, /Riverrun S\.A\. de C\.V\. es responsable/);
    assert.match(r.body, /Los usamos para:/);
    assert.match(r.body, /Los compartimos/);
    assert.match(r.body, /href="\/privacidad"/);
  });
});

t('protección de datos: encargado del negocio, cada proveedor, medidas, vulneraciones y texto para sus clientes', async () => {
  const r = await get('/proteccion-de-datos');
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /<strong>encargado<\/strong>/);
  assert.ok(PROCESSORS.length >= 8);
  for (const p of PROCESSORS) assert.ok(r.body.includes(p.name), `falta el proveedor ${p.name}`);
  for (const name of ['DigitalOcean', 'Zernio', 'OpenRouter', 'Stripe', 'Mercado Pago', 'Facturapi', 'Resend', 'Cloudflare']) assert.ok(r.body.includes(name), name);
  assert.match(r.body, /id="proveedores"/);
  assert.match(r.body, /vulneración de seguridad/);
  assert.match(r.body, /<blockquote>\[Nombre de tu negocio\]/);
});

t('con un aviso propio (PRIVACY_URL), /privacidad y el simplificado llevan a ese', async () => {
  await withPrivacy({ privacyUrl: 'https://legal.ejemplo.mx/privacidad' }, async () => {
    for (const url of ['/privacidad', '/privacidad/simplificado']) {
      const r = await get(url);
      assert.equal(r.statusCode, 302, url);
      assert.equal(r.headers.location, 'https://legal.ejemplo.mx/privacidad');
    }
    assert.equal((await get('/proteccion-de-datos')).statusCode, 200);
  });
  // Si apunta a esta misma página, se sirve la incluida en lugar de redirigir sin fin.
  await withPrivacy({ privacyUrl: '/privacidad' }, async () => {
    assert.equal((await get('/privacidad')).statusCode, 200);
  });
});

t('las páginas nuevas llevan la CSP de las páginas del servidor y el pie enlaza protección de datos', async () => {
  for (const url of ['/privacidad/simplificado', '/proteccion-de-datos']) {
    const r = await get(url);
    assert.match(String(r.headers['content-security-policy']), /'unsafe-inline'/, url);
    assert.match(r.body, /href="\/proteccion-de-datos">Protección de datos<\/a>/, url);
  }
  assert.match((await get('/precios')).body, /href="\/proteccion-de-datos"/);
  assert.match((await get('/ayuda.html')).body, /href="\/proteccion-de-datos"/);
});

t('registro: sin PRIVACY_URL enlaza el aviso incluido y la constancia guarda su versión', async () => {
  await withPrivacy({ privacyUrl: '' }, async () => {
    const info = (await get('/api/signup/info')).json();
    assert.equal(info.privacy_url, '/privacidad');
    const r = await h.app.inject({
      method: 'POST', url: '/api/signup', remoteAddress: '10.66.0.1',
      payload: { name: 'Ana Aviso', company: 'Papelería Aviso', business_type: 'tienda', email: 'ana@aviso.mx', password: 'Pz-151-Qx-351-Kv', accept_terms: true },
    });
    assert.equal(r.statusCode, 200, r.body);
    const row = (await pool.query(`SELECT privacy_url FROM terms_acceptances WHERE user_id = $1`, [r.json().user.id])).rows[0];
    assert.equal(row.privacy_url, `${config.publicBaseUrl}/privacidad?version=${PRIVACY_NOTICE_VERSION}`);
  });
  await withPrivacy({ privacyUrl: 'https://legal.ejemplo.mx/privacidad' }, async () => {
    assert.equal((await get('/api/signup/info')).json().privacy_url, 'https://legal.ejemplo.mx/privacidad');
  });
});

/* ------------------------------ Revisión de la configuración (sin base de datos) ------------------------------ */

const prodEnv = (over: Env = {}): Env => ({ NODE_ENV: 'production', ...over });
const privacyIssue = (env: Env) => validateConfig(env).issues.find((i) => i.id === 'privacy.responsible_missing');

test('config:check avisa en producción si el aviso incluido no tiene razón social, domicilio o correo', () => {
  const issue = privacyIssue(prodEnv());
  assert.ok(issue);
  assert.equal(issue.level, 'warning');
  assert.deepEqual(issue.vars, ['PRIVACY_COMPANY', 'PRIVACY_ADDRESS', 'PRIVACY_CONTACT']);
  assert.match(issue.message, /razón social/);
});

test('config:check no avisa con los datos completos, con un aviso propio ni fuera de producción', () => {
  assert.equal(privacyIssue(prodEnv({ PRIVACY_COMPANY: 'X S.A.', PRIVACY_ADDRESS: 'Calle 1', PRIVACY_CONTACT: 'p@x.mx' })), undefined);
  // Con un aviso propio el domicilio ya no hace falta, pero /proteccion-de-datos sigue diciendo la razón social y el correo.
  assert.equal(privacyIssue(prodEnv({ PRIVACY_URL: 'https://x.mx/privacidad', PRIVACY_COMPANY: 'X S.A.', SUPPORT_CONTACT: 'p@x.mx' })), undefined);
  assert.deepEqual(privacyIssue(prodEnv({ PRIVACY_URL: 'https://x.mx/privacidad' }))?.vars, ['PRIVACY_COMPANY', 'PRIVACY_CONTACT']);
  assert.equal(privacyIssue({ NODE_ENV: 'development' }), undefined);
  // El correo, si falta, sale del de soporte o del superadmin (como en la página).
  assert.deepEqual(privacyIssue(prodEnv({ SUPERADMIN_EMAIL: 'yo@x.mx' }))?.vars, ['PRIVACY_COMPANY', 'PRIVACY_ADDRESS']);
});

test('config:check avisa si PRIVACY_URL no es https o apunta a la misma /privacidad (se repetiría sin fin)', () => {
  const urlIssue = (env: Env) => validateConfig(env).issues.find((i) => i.id === 'privacy.url_invalid');
  const base = { PUBLIC_BASE_URL: 'https://bot.ejemplo.com' };
  for (const bad of ['/privacidad', 'http://legal.ejemplo.mx/aviso', 'https://bot.ejemplo.com/privacidad', 'no es una dirección']) {
    assert.ok(urlIssue(prodEnv({ ...base, PRIVACY_URL: bad })), bad);
  }
  assert.equal(urlIssue(prodEnv({ ...base, PRIVACY_URL: 'https://legal.ejemplo.mx/aviso' })), undefined);
  assert.equal(urlIssue(prodEnv(base)), undefined);
});
