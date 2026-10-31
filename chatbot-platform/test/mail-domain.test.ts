/**
 * Correo saliente con Resend: RESEND_API_KEY arma el SMTP de Resend, Sistema revisa el dominio del remitente (SPF, DKIM,
 * DMARC y la verificación en Resend) y el superadmin puede mandarse un correo de prueba.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHarness, dbAvailable, pool } from './harness.js';
const { config } = await import('../src/config.js');
const { dnsChecks, fromDomain, resendDomainStatus } = await import('../src/mail-domain.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

const zone = (records: Record<string, string[]>) => async (host: string) => {
  if (!(host in records)) throw Object.assign(new Error('no'), { code: 'ENOTFOUND' });
  return records[host].map((r) => [r]);
};
const res = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;

test('el dominio del remitente sale de MAIL_FROM', () => {
  assert.equal(fromDomain('Mi Marca <Hola@Correo.Mx>'), 'correo.mx');
  assert.equal(fromDomain('avisos@tienda.com'), 'tienda.com');
  assert.equal(fromDomain('Chatbots <no-responder@localhost>'), 'localhost');
});

test('con Resend: DKIM en resend._domainkey, SPF de amazonses en send. y DMARC', async () => {
  const good = await dnsChecks('marca.mx', 'resend', zone({
    'send.marca.mx': ['v=spf1 include:amazonses.com ~all'],
    'resend._domainkey.marca.mx': ['p=MIGfMA0GCSqGSIb3DQEB'],
    '_dmarc.marca.mx': ['v=DMARC1; p=none;'],
  }));
  assert.deepEqual(good.map((c) => [c.id, c.host, c.ok]), [['spf', 'send.marca.mx', true], ['dkim', 'resend._domainkey.marca.mx', true], ['dmarc', '_dmarc.marca.mx', true]]);

  const bad = await dnsChecks('marca.mx', 'resend', zone({ 'send.marca.mx': ['v=spf1 include:_spf.google.com ~all'] }));
  assert.deepEqual(bad.map((c) => c.ok), [false, false, false]);
  assert.match(bad[0].detail, /amazonses/);
  assert.match(bad[2].detail, /v=DMARC1/);

  // DNS caído: no se sabe (no se marca como «falta»).
  const down = await dnsChecks('marca.mx', 'resend', async () => { throw Object.assign(new Error('x'), { code: 'ESERVFAIL' }); });
  assert.deepEqual(down.map((c) => c.ok), [null, null, null]);
});

test('con otro SMTP: SPF en el dominio y el DKIM queda sin revisar (depende del selector)', async () => {
  const c = await dnsChecks('marca.mx', 'smtp', zone({ 'marca.mx': ['v=spf1 include:sendgrid.net ~all'], '_dmarc.marca.mx': ['v=DMARC1; p=quarantine'] }));
  assert.deepEqual(c.map((x) => [x.id, x.ok]), [['spf', true], ['dkim', null], ['dmarc', true]]);
});

test('Resend dice si el dominio está verificado; una llave solo de envío no lo puede saber', async () => {
  assert.equal((await resendDomainStatus('marca.mx', 're_x', res(200, { data: [{ name: 'Marca.mx', status: 'verified' }] }))).status, 'verified');
  assert.equal((await resendDomainStatus('marca.mx', 're_x', res(200, { data: [{ name: 'marca.mx', status: 'not_started' }] }))).status, 'pending');
  assert.equal((await resendDomainStatus('marca.mx', 're_x', res(200, { data: [{ name: 'marca.mx', status: 'failed' }] }))).status, 'failed');
  assert.equal((await resendDomainStatus('marca.mx', 're_x', res(200, { data: [{ name: 'otra.mx', status: 'verified' }] }))).status, 'not_found');
  const restricted = await resendDomainStatus('marca.mx', 're_x', res(403, { name: 'restricted_api_key' }));
  assert.equal(restricted.status, 'unknown');
  assert.match(restricted.detail, /solo puede enviar/);
  const dead = await resendDomainStatus('marca.mx', 're_x', (async () => { throw new Error('sin red'); }) as typeof fetch);
  assert.equal(dead.status, 'unknown');
});

test('RESEND_API_KEY arma el SMTP de Resend (y SMTP_URL, si existe, manda)', () => {
  const mailWith = (env: Record<string, string>) => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/config.ts').then(({ config }) => console.log(JSON.stringify(config.mail)))"], {
      env: { ...process.env, SMTP_URL: '', RESEND_API_KEY: '', ...env }, encoding: 'utf8',
    });
    return JSON.parse(out.trim().split('\n').pop()!);
  };
  const resend = mailWith({ RESEND_API_KEY: 're_abc/123' });
  assert.equal(resend.provider, 'resend');
  assert.equal(resend.smtpUrl, 'smtps://resend:re_abc%2F123@smtp.resend.com:465');
  const smtp = mailWith({ RESEND_API_KEY: 're_abc', SMTP_URL: 'smtps://u:p@smtp.otro.mx:465' });
  assert.deepEqual([smtp.provider, smtp.smtpUrl], ['smtp', 'smtps://u:p@smtp.otro.mx:465']);
});

t('Sistema: solo el superadmin ve el correo; sin correo configurado la prueba lo dice', async () => {
  const s = (await h.authed('GET', '/api/system/mail')).json();
  assert.equal(s.from, config.mail.from);
  assert.ok(Array.isArray(s.dns) && 'bad_from' in s);
  await h.addUser({ account_id: h.accountId, email: 'admin@correo-prueba.mx', name: 'Admin', password: 'Pz-131-Qx-331-Kv', role: 'admin' });
  await pool.query('UPDATE users SET email_verified_at = now() WHERE email = $1', ['admin@correo-prueba.mx']);
  const admin = await h.loginAs('admin@correo-prueba.mx', 'Pz-131-Qx-331-Kv');
  assert.equal((await admin('GET', '/api/system/mail')).statusCode, 403);
  assert.equal((await admin('POST', '/api/system/mail/test')).statusCode, 403);

  const saved = config.mail.smtpUrl;
  config.mail.smtpUrl = '';
  try {
    const r = await h.authed('POST', '/api/system/mail/test');
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /RESEND_API_KEY/);
  } finally {
    config.mail.smtpUrl = saved;
  }
});
