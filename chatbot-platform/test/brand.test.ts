/** Marca blanca: nombre, logo, color y dominio por cliente. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { outbox, fromFor } = await import('../src/mailer.js');

// PNG de 1×1
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let brandId = '';
let ip = 0;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('el superadmin crea una marca con logo y se validan los datos', async () => {
  const bad = async (body: object, re: RegExp, code = 400) => {
    const r = await h.authed('POST', '/api/brands', { name: 'X', ...body });
    assert.equal(r.statusCode, code, r.body);
    assert.match(`${r.json().error} ${(r.json().issues ?? []).join(' ')}`, re);
  };
  await bad({ color: 'rojo' }, /color/i);
  await bad({ logo: 'data:image/svg+xml;base64,PHN2Zy8+' }, /PNG, JPG o WebP/);
  await bad({ domain: 'https://panel.mi.com' }, /dominio/i);
  const r = await h.authed('POST', '/api/brands', { name: 'Mi Agencia', color: '#1a73e8', domain: 'Panel.MiAgencia.com', support_email: 'soporte@miagencia.com', logo: PNG });
  assert.equal(r.statusCode, 200, r.body);
  brandId = r.json().id;
  await bad({ domain: 'panel.miagencia.com' }, /ya pertenece/, 409);
  const list = (await h.authed('GET', '/api/brands')).json();
  const b = list.brands.find((x: any) => x.id === brandId);
  assert.equal(b.domain, 'panel.miagencia.com', 'el dominio se guarda en minúsculas');
  assert.match(b.logo, /^\/brand\/.+\/logo\?v=1$/);
  assert.ok(!JSON.stringify(list).includes('iVBOR'), 'la lista no incluye los bytes del logo');
});

t('la marca se resuelve por dominio y el logo se sirve con tipo seguro', async () => {
  const get = (host: string) => h.app.inject({ method: 'GET', url: '/api/brand', headers: { host } });
  const mine = (await get('panel.miagencia.com:443')).json();
  assert.deepEqual([mine.name, mine.color, mine.support_email], ['Mi Agencia', '#1a73e8', 'soporte@miagencia.com']);
  assert.equal((await get('otro.com')).json().name, 'Panel de Chatbots', 'dominio desconocido → marca de la plataforma');
  const logo = await h.app.inject({ method: 'GET', url: mine.logo.split('?')[0] });
  assert.equal(logo.statusCode, 200);
  assert.equal(logo.headers['content-type'], 'image/png');
  assert.equal(logo.headers['x-content-type-options'], 'nosniff');
  assert.equal((await h.app.inject({ method: 'GET', url: '/brand/00000000-0000-0000-0000-000000000000/logo' })).statusCode, 404);
});

t('quien se registra desde el dominio de la marca queda con ella, y sus correos salen con su nombre y su dirección', async () => {
  const r = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: `10.9.9.${++ip}`, headers: { host: 'panel.miagencia.com' }, payload: { name: 'Cliente', company: 'Tienda Uno', business_type: 'otro', email: 'uno@tienda.mx', password: 'clave-segura-1', accept_terms: true } });
  assert.equal(r.statusCode, 200, r.body);
  const accountId = r.json().account.id;
  assert.equal((await pool.query(`SELECT brand_id FROM accounts WHERE id = $1`, [accountId])).rows[0].brand_id, brandId);
  const cookie = String(r.headers['set-cookie']).split(';')[0];
  const me = (await h.app.inject({ method: 'GET', url: '/api/brand/mine', headers: { cookie } })).json();
  assert.equal(me.name, 'Mi Agencia');
  // El correo de verificación lleva el nombre y el dominio de la marca
  const mail = outbox.find((m) => m.to === 'uno@tienda.mx');
  assert.ok(mail, 'se envió el correo de verificación');
  assert.equal(mail!.fromName, 'Mi Agencia');
  assert.match(mail!.text, /https:\/\/panel\.miagencia\.com\/#\/verificar\?token=/);
  // Una cuenta sin marca usa la de la plataforma
  const plain = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: `10.9.9.${++ip}`, payload: { name: 'Otro', company: 'Tienda Dos', business_type: 'otro', email: 'dos@tienda.mx', password: 'clave-segura-1', accept_terms: true } });
  const c2 = String(plain.headers['set-cookie']).split(';')[0];
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/brand/mine', headers: { cookie: c2 } })).json().name, 'Panel de Chatbots');
  assert.equal(outbox.find((m) => m.to === 'dos@tienda.mx')!.fromName, undefined);
  // Un admin de cuenta no administra marcas
  for (const [method, url] of [['GET', '/api/brands'], ['POST', '/api/brands'], ['DELETE', `/api/brands/${brandId}`]] as const) {
    assert.equal((await h.app.inject({ method, url, headers: { cookie: c2 }, payload: method === 'POST' ? { name: 'x' } : undefined })).statusCode, 403, `${method} ${url}`);
  }
});

t('el superadmin asigna o quita la marca de una cuenta', async () => {
  assert.equal((await h.authed('PUT', `/api/accounts/${h.accountId}`, { brand_id: brandId })).statusCode, 200);
  assert.equal((await h.authed('GET', '/api/accounts')).json().find((a: any) => a.id === h.accountId).brand_id, brandId);
  assert.equal((await h.authed('PUT', `/api/accounts/${h.accountId}`, { brand_id: null })).statusCode, 200);
  assert.equal((await h.authed('GET', '/api/accounts')).json().find((a: any) => a.id === h.accountId).brand_id, null);
});

t('Caddy solo pide certificado para dominios registrados', async () => {
  const ask = (d: string) => h.app.inject({ method: 'GET', url: `/internal/domain-ok?domain=${d}` });
  assert.equal((await ask('panel.miagencia.com')).statusCode, 200);
  assert.equal((await ask('cualquiera.com')).statusCode, 404);
  assert.equal((await ask('')).statusCode, 404);
});

t('borrar la marca devuelve sus cuentas a la plataforma; el remitente no puede inyectar encabezados', async () => {
  assert.equal((await h.authed('DELETE', `/api/brands/${brandId}`)).statusCode, 200);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM accounts WHERE brand_id IS NOT NULL`)).rows[0].n, 0);
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/brand', headers: { host: 'panel.miagencia.com' } })).json().name, 'Panel de Chatbots');
  assert.doesNotMatch(fromFor('Evil"\r\nBcc: x@y.z <a@b.c>'), /[\r\n]|Bcc: x@y\.z <|"Evil"/);
});
