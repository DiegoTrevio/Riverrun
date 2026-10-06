/**
 * Auditoría de aislamiento: recorre TODAS las rutas autenticadas del panel (leídas del código fuente,
 * así una ruta nueva queda cubierta sin tocar esta prueba) con usuarios de otra cuenta, y revisa
 * que ninguna respuesta exponga secretos.
 */
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
type Api = Awaited<ReturnType<typeof h.loginAs>>;
let adminA: Api, agentA: Api, adminB: Api;

const MARK = 'SECRETO-B';
const B: Record<string, string> = {};

/** Rutas autenticadas declaradas en src/routes (método + ruta). */
function routes() {
  const dir = path.resolve(import.meta.dirname, '../src/routes');
  const out: { method: string; url: string }[] = [];
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/api\.(get|post|put|delete)\('([^']+)'/g)) out.push({ method: m[1].toUpperCase(), url: m[2] });
  }
  return out;
}

/** Sustituye cada parámetro por el recurso equivalente de la cuenta B. */
function fillParams(url: string): string | null {
  const byPrefix: [RegExp, string][] = [
    [/^\/api\/accounts\/:id/, 'account'],
    [/^\/api\/appointments\/:id/, 'appointment'],
    [/^\/api\/automations\/:id/, 'automation'],
    [/^\/api\/campaigns\/:id/, 'campaign'],
    [/^\/api\/channels\/:id/, 'channel'],
    [/^\/api\/chatbots\/:id/, 'bot'],
    [/^\/api\/contacts\/:id/, 'contact'],
    [/^\/api\/conversations\/:cid/, 'conv'],
    [/^\/api\/images\/:iid/, 'image'],
    [/^\/api\/knowledge\/:kid/, 'knowledge'],
    [/^\/api\/sequences\/:id/, 'sequence'],
    [/^\/api\/services\/:id/, 'service'],
    [/^\/api\/users\/:id/, 'user'],
    [/^\/api\/ai-prices\/:model/, 'model'],
    // Los planes son globales (solo el superadmin los edita): la cuenta A debe recibir 403 sea cual sea la clave.
    [/^\/api\/plans\/:key/, 'bot'],
  ];
  const hit = byPrefix.find(([re]) => re.test(url));
  if (!hit) return null;
  return url
    .replace(/:(id|cid|iid|kid|model|key)\b/, B[hit[1]])
    .replace(':session', 'sesion-b')
    .replace(':sid', B.sequence);
}

/** Lo que nunca debe aparecer en una respuesta del panel. */
const FORBIDDEN = [/password_hash/, /token_hash/, /"qr_code"/, /"pairing_code"/, /llave-global-de-pruebas/, /TG-SECRETO-123/, /APP-SECRETO-456/, /PAGE-SECRETO-789/];

before(async () => {
  if (!ok) return;
  h = await createHarness();
  h.setScript(() => ({ messages: ['Hola'] }));
  for (const [name, email] of [['Cuenta A', 'admin@a.mx'], [`Cuenta ${MARK}`, 'admin@b.mx']]) {
    const r = await h.authed('POST', '/api/accounts', { name, admin: { name: 'Admin', email, password: 'clave-segura-1' } });
    assert.equal(r.statusCode, 200, r.body);
    if (email === 'admin@b.mx') B.account = r.json().id;
  }
  adminA = await h.loginAs('admin@a.mx', 'clave-segura-1');
  adminB = await h.loginAs('admin@b.mx', 'clave-segura-1');
  assert.equal((await adminA('POST', '/api/users', { email: 'agente@a.mx', name: 'Agente', password: 'clave-segura-1', role: 'agent' })).statusCode, 200);
  agentA = await h.loginAs('agente@a.mx', 'clave-segura-1');

  // Recursos de la cuenta B (con un marcador para detectar fugas).
  const ok200 = async (p: Promise<any>) => { const r = await p; assert.ok(r.statusCode < 300, r.body); return r.json(); };
  B.bot = (await ok200(adminB('POST', '/api/chatbots', { name: `Bot ${MARK}`, active: true, ai: { debounce_seconds: 0.1 } }))).id;
  B.knowledge = (await ok200(adminB('POST', `/api/chatbots/${B.bot}/knowledge`, { title: `Precios ${MARK}`, content: `Dato ${MARK}: $999` }))).id;
  const img = await pool.query(`INSERT INTO images (chatbot_id, code, name, file_path, mime_type) VALUES ($1, 'foto_b', $2, 'x.jpg', 'image/jpeg') RETURNING id`, [B.bot, `Foto ${MARK}`]);
  B.image = img.rows[0].id;
  const wa = await ok200(adminB('POST', '/api/channels', { type: 'whatsapp', name: `WA ${MARK}`, chatbot_id: B.bot }));
  B.channel = wa.id;
  await ok200(adminB('POST', '/api/channels', { type: 'telegram', name: 'TG B', config: { bot_token: 'TG-SECRETO-123' } }));
  await ok200(adminB('POST', '/api/channels', { type: 'messenger', name: 'FB B', config: { app_secret: 'APP-SECRETO-456', page_access_token: 'PAGE-SECRETO-789' } }));
  await pool.query(`UPDATE channels SET qr_code = 'data:image/png;base64,QRSECRETO', pairing_code = 'PAIRSECR' WHERE id = $1`, [B.channel]);
  h.token = wa.webhook_token;
  await h.webhook('hola', { instance: wa.config.instance, phone: '5215599990000' });
  await waitFor(async () => (await adminB('GET', '/api/conversations')).json().length === 1);
  const conv = (await adminB('GET', '/api/conversations')).json()[0];
  B.conv = conv.id;
  B.contact = conv.contact_id;
  B.automation = (await ok200(adminB('POST', '/api/automations', { name: `Regla ${MARK}`, trigger: { type: 'new_contact' }, actions: [{ type: 'add_tag', tag: 'b' }] }))).id;
  B.sequence = (await ok200(adminB('POST', '/api/sequences', { name: `Secuencia ${MARK}`, steps: [{ delay_value: 1, delay_unit: 'days', text: 'hola' }] }))).id;
  B.campaign = (await ok200(adminB('POST', '/api/campaigns', { name: `Campaña ${MARK}`, channel_id: B.channel, message: 'promo' }))).id;
  B.service = (await ok200(adminB('POST', '/api/services', { name: `Servicio ${MARK}`, duration_minutes: 30 }))).id;
  const slot = (await adminB('GET', `/api/services/${B.service}/slots`)).json()[0];
  B.appointment = (await ok200(adminB('POST', '/api/appointments', { service_id: B.service, slot: slot.key, customer_name: `Cliente ${MARK}`, notify_customer: false }))).id;
  B.user = (await ok200(adminB('POST', '/api/users', { email: 'agente@b.mx', name: `Agente ${MARK}`, password: 'clave-segura-1', role: 'agent' }))).id;
  B.model = 'gpt-4.1-mini';
  await h.idle();
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('todas las rutas con :id de la cuenta B: el admin y el agente de A reciben 403/404 y nada de B', async () => {
  const all = routes();
  assert.ok(all.length >= 90, `se encontraron ${all.length} rutas`);
  const checked: string[] = [];
  for (const r of all.filter((x) => x.url.includes(':'))) {
    const url = fillParams(r.url);
    assert.ok(url, `ruta sin mapear en la prueba (agrégala a fillParams): ${r.method} ${r.url}`);
    for (const [who, api] of [['admin A', adminA], ['agente A', agentA]] as const) {
      const res = await api(r.method, url!, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
      const where = `${who} → ${r.method} ${r.url}`;
      assert.ok([400, 403, 404].includes(res.statusCode), `${where} respondió ${res.statusCode}: ${res.body.slice(0, 200)}`);
      assert.ok(!res.body.includes(MARK), `${where} filtró datos de B`);
    }
    checked.push(`${r.method} ${r.url}`);
  }
  assert.ok(checked.length >= 55, `${checked.length} rutas con parámetros revisadas`);

  // Nada de B se modificó ni se borró.
  const bot = (await adminB('GET', `/api/chatbots/${B.bot}`)).json();
  assert.equal(bot.name, `Bot ${MARK}`);
  assert.equal((await adminB('GET', '/api/automations')).json().length, 1);
  assert.equal((await adminB('GET', '/api/sequences')).json().length, 1);
  assert.equal((await adminB('GET', `/api/appointments`)).json().find((a: any) => a.id === B.appointment).status, 'confirmed');
  assert.equal((await adminB('GET', '/api/users')).json().length, 2);
  assert.equal((await adminB('GET', `/api/conversations/${B.conv}`)).json().conversation.status, 'bot');
});

t('listados y rutas sin parámetros: A nunca ve datos de B (aunque pida ?account_id=B)', async () => {
  for (const r of routes().filter((x) => x.method === 'GET' && !x.url.includes(':'))) {
    for (const [who, api] of [['admin A', adminA], ['agente A', agentA]] as const) {
      for (const qs of ['', `?account_id=${B.account}`]) {
        const res = await api('GET', `${r.url}${qs}`);
        assert.ok(!res.body.includes(MARK), `${who} → GET ${r.url}${qs} filtró datos de B`);
      }
    }
  }
});

t('ninguna respuesta del panel expone secretos (ni a la propia cuenta ni al superadmin)', async () => {
  const gets = routes().filter((x) => x.method === 'GET');
  for (const [who, api] of [['admin B', adminB], ['superadmin', h.authed]] as const) {
    for (const r of gets) {
      const url = r.url.includes(':') ? fillParams(r.url) : `${r.url}${who === 'superadmin' ? `?account_id=${B.account}` : ''}`;
      if (!url || url.endsWith('/file')) continue;
      const res = await api('GET', url);
      for (const re of FORBIDDEN) assert.ok(!re.test(res.body), `${who} → GET ${r.url} expone ${re}`);
    }
  }
});

t('el agente no puede usar rutas de administración de su propia cuenta', async () => {
  const adminOnly = [
    ['POST', '/api/chatbots', { name: 'x' }],
    ['POST', '/api/channels', { type: 'webchat', name: 'x' }],
    ['POST', '/api/users', { email: 'x@a.mx', name: 'x', password: 'clave-segura-1', role: 'admin' }],
    ['PUT', '/api/settings', { timezone: 'America/Bogota' }],
    ['POST', '/api/automations', { name: 'x', trigger: { type: 'new_contact' }, actions: [] }],
    ['POST', '/api/campaigns', { name: 'x', message: 'x' }],
    ['GET', '/api/logs'],
    ['GET', '/api/usage'],
    ['GET', '/api/onboarding'],
    ['POST', '/api/onboarding/whatsapp'],
    ['GET', '/api/ai-prices'],
    ['POST', '/api/accounts', { name: 'x' }],
  ] as const;
  for (const [method, url, body] of adminOnly) {
    const res = await agentA(method, url, body as any);
    assert.equal(res.statusCode, 403, `agente → ${method} ${url} respondió ${res.statusCode}`);
  }
});
