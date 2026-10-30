/**
 * Auditoría de aislamiento: recorre TODAS las rutas autenticadas del panel (leídas del código fuente,
 * así una ruta nueva queda cubierta sin tocar esta prueba) con usuarios de otra cuenta, y revisa
 * que ninguna respuesta exponga secretos.
 */
import crypto from 'node:crypto';
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
    [/^\/api\/ai-budget\/review\/:id/, 'budget_entry'],
    [/^\/api\/contact-views\/:id/, 'contact_view'],
    [/^\/api\/accounts\/:id/, 'account'],
    [/^\/api\/appointments\/:id/, 'appointment'],
    [/^\/api\/automations\/:id/, 'automation'],
    [/^\/api\/attachments\/:id/, 'attachment'],
    [/^\/api\/tasks\/:id/, 'task'],
    [/^\/api\/campaigns\/:id/, 'campaign'],
    [/^\/api\/channels\/:id/, 'channel'],
    [/^\/api\/meta\/sessions\/:id/, 'meta_session'],
    [/^\/api\/chatbots\/:id/, 'bot'],
    [/^\/api\/contacts\/:id/, 'contact'],
    [/^\/api\/conversations\/:cid/, 'conv'],
    [/^\/api\/images\/:iid/, 'image'],
    [/^\/api\/messages\/:mid/, 'message'],
    [/^\/api\/knowledge\/:kid/, 'knowledge'],
    [/^\/api\/sequences\/:id/, 'sequence'],
    [/^\/api\/flow-boards\/:id/, 'flow_board'],
    [/^\/api\/services\/:id/, 'service'],
    [/^\/api\/users\/:id/, 'user'],
    [/^\/api\/ai-prices\/:model/, 'model'],
    // Los planes son globales (solo el superadmin los edita): la cuenta A debe recibir 403 sea cual sea la clave.
    [/^\/api\/plans\/:key/, 'bot'],
    [/^\/api\/webhook-endpoints\/:id/, 'endpoint'],
    [/^\/api\/api-keys\/:id/, 'apikey'],
    [/^\/api\/wa-pools\/:id/, 'wapool'],
    [/^\/api\/brands\/:id/, 'brand'],
    [/^\/api\/pipelines\/:id/, 'pipeline'],
    [/^\/api\/pipeline-cards\/:id/, 'card'],
    [/^\/api\/price-items\/:id/, 'price_item'],
    [/^\/api\/quotes\/:id/, 'quote'],
    [/^\/api\/quote-templates\/:id/, 'quote_template'],
    [/^\/api\/team\/:userId/, 'user'],
    [/^\/api\/social-accounts\/:id/, 'social'],
    [/^\/api\/wa-templates\/:id/, 'wa_template'],
    [/^\/api\/booking-links\/:id/, 'booking_link'],
    [/^\/api\/social-comments\/:id/, 'social_comment'],
    [/^\/api\/social-reviews\/:id/, 'social_review'],
    [/^\/api\/social-publications\/:id/, 'social_publication'],
    [/^\/api\/billing\/invoices\/:id/, 'cfdi'],
    [/^\/api\/invitations\/:id/, 'invitation'],
    [/^\/api\/receivables\/:id/, 'receivable'],
    [/^\/api\/receivable-plans\/:id/, 'receivable_plan'],
    [/^\/api\/contact-fields\/:id/, 'contact_field'],
    // Una sesión del admin de B: nadie de A la cierra.
    [/^\/api\/me\/sessions\/:id/, 'user_session'],
    // Un dispositivo recordado del admin de B: nadie de A lo olvida.
    [/^\/api\/me\/devices\/:id/, 'user_device'],
    [/^\/api\/alert-deliveries\/:id/, 'alert_receipt'],
    // Solo el superadmin: la cuenta A debe recibir 403.
    [/^\/api\/system\/zernio\/tenants\/:id/, 'account'],
    [/^\/api\/system\/zernio\/webhook-logs\/:id/, 'bot'],
  ];
  const hit = byPrefix.find(([re]) => re.test(url));
  if (!hit) return null;
  return url
    .replace(/:(id|cid|iid|kid|model|key|mid|userId)\b/, B[hit[1]])
    .replace(':session', 'sesion-b')
    .replace(':sid', B.sequence).replace(':receipt','1').replace(':format', 'pdf');
}

/** Lo que nunca debe aparecer en una respuesta del panel. */
const FORBIDDEN = [/password_hash/, /key_hash/, /refresh_token/, /token_hash/, /"qr_code"/, /"pairing_code"/, /llave-global-de-pruebas/, /TG-SECRETO-123/, /APP-SECRETO-456/, /PAGE-SECRETO-789/];

before(async () => {
  if (!ok) return;
  h = await createHarness();
  h.setScript(() => ({ messages: ['Hola'] }));
  for (const [name, email] of [['Cuenta A', 'admin@a.mx'], [`Cuenta ${MARK}`, 'admin@b.mx']]) {
    const r = await h.authed('POST', '/api/accounts', { name, admin: { name: 'Admin', email, password: 'Pz-144-Qx-344-Kv' } });
    assert.equal(r.statusCode, 200, r.body);
    if (email === 'admin@b.mx') B.account = r.json().id;
  }
  adminA = await h.loginAs('admin@a.mx', 'Pz-144-Qx-344-Kv');
  adminB = await h.loginAs('admin@b.mx', 'Pz-144-Qx-344-Kv');
  assert.equal((await adminA('POST', '/api/users', { email: 'agente@a.mx', name: 'Agente', password: 'Pz-144-Qx-344-Kv', role: 'agent' })).statusCode, 200);
  agentA = await h.loginAs('agente@a.mx', 'Pz-144-Qx-344-Kv');

  // Recursos de la cuenta B (con un marcador para detectar fugas).
  const ok200 = async (p: Promise<any>) => { const r = await p; assert.ok(r.statusCode < 300, r.body); return r.json(); };
  B.bot = (await ok200(adminB('POST', '/api/chatbots', { name: `Bot ${MARK}`, active: true, ai: { debounce_seconds: 0.1 } }))).id;
  B.knowledge = (await ok200(adminB('POST', `/api/chatbots/${B.bot}/knowledge`, { title: `Precios ${MARK}`, content: `Dato ${MARK}: $999` }))).id;
  const att = await pool.query(`INSERT INTO attachments (account_id, name, mime, kind, size_bytes, file_path) VALUES ($1, $2, 'application/pdf', 'document', 10, 'b.pdf') RETURNING id`, [B.account, `Archivo ${MARK}.pdf`]);
  B.attachment = att.rows[0].id;
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
  const task = await pool.query(`INSERT INTO contact_tasks (account_id, contact_id, kind, body) VALUES ($1, $2, 'nota', $3) RETURNING id`, [B.account, B.contact, `Nota ${MARK}`]);
  B.task = task.rows[0].id;
  B.budget_entry = (await pool.query("INSERT INTO ai_spend(account_id,kind,models,state,cost_source) VALUES($1,'decision',ARRAY['privado'],'unknown','unknown') RETURNING id",[B.account])).rows[0].id;
  B.contact_view = (await ok200(adminB('POST','/api/contact-views',{name:`Vista ${MARK}`,filters:{view:'pending'}}))).id;
  // Una foto del cliente de la cuenta B con su archivo real: si A la alcanzara, la descarga respondería 200 y la fuga se vería.
  const photo = await pool.query(
    `INSERT INTO messages (conversation_id, direction, sender, type, content, external_message_id, processed, status, meta)
     VALUES ($1, 'in', 'customer', 'image', $2, 'FOTO-B', true, 'ok', '{}') RETURNING id`,
    [conv.id, `Foto ${MARK}`],
  );
  B.message = String(photo.rows[0].id);
  fs.mkdirSync(path.join(process.env.UPLOADS_DIR as string, 'inbound', B.account), { recursive: true });
  fs.writeFileSync(path.join(process.env.UPLOADS_DIR as string, 'inbound', B.account, 'foto-b.png'), `PNG-${MARK}`);
  await pool.query(
    `INSERT INTO message_media (message_id, kind, mime, file_name, size_bytes, sha256, file_path) VALUES ($1, 'image', 'image/png', 'foto.png', $2, $3, $4)`,
    [B.message, Buffer.byteLength(`PNG-${MARK}`), '0'.repeat(64), `inbound/${B.account}/foto-b.png`],
  );
  B.automation = (await ok200(adminB('POST', '/api/automations', { name: `Regla ${MARK}`, trigger: { type: 'new_contact' }, actions: [{ type: 'add_tag', tag: 'b' }] }))).id;
  B.sequence = (await ok200(adminB('POST', '/api/sequences', { name: `Secuencia ${MARK}`, steps: [{ delay_value: 1, delay_unit: 'days', text: 'hola' }] }))).id;
  B.flow_board = (await ok200(adminB('POST', '/api/flow-boards', { name: `Lienzo ${MARK}`, board: { nodes: [{ id: 't1', type: 'trigger', x: 0, y: 0, data: { trigger: null } }, { id: 'm1', type: 'message', x: 0, y: 200, data: { text: `hola ${MARK}` } }], edges: [{ id: 'e1', from: 't1', port: 'out', to: 'm1' }] } }))).id;
  B.campaign = (await ok200(adminB('POST', '/api/campaigns', { name: `Campaña ${MARK}`, channel_id: B.channel, message: 'promo' }))).id;
  B.service = (await ok200(adminB('POST', '/api/services', { name: `Servicio ${MARK}`, duration_minutes: 30 }))).id;
  const slot = (await adminB('GET', `/api/services/${B.service}/slots`)).json()[0];
  B.appointment = (await ok200(adminB('POST', '/api/appointments', { service_id: B.service, slot: slot.key, customer_name: `Cliente ${MARK}`, notify_customer: false }))).id;
  B.user = (await ok200(adminB('POST', '/api/users', { email: 'agente@b.mx', name: `Agente ${MARK}`, password: 'Pz-144-Qx-344-Kv', role: 'agent' }))).id;
  B.endpoint = (await ok200(adminB('POST', '/api/webhook-endpoints', { url: 'https://example.com/hook', description: `Hook ${MARK}` }))).id;
  B.apikey = (await ok200(adminB('POST', '/api/api-keys', { name: `Llave ${MARK}` }))).id;
  // Sesión de «Conectar con Facebook» de B, con una página y su token: A no la ve ni la aplica.
  B.meta_session = (await pool.query(`INSERT INTO meta_connect_sessions (account_id, pages, expires_at) VALUES ($1, $2, now() + interval '30 minutes') RETURNING id`,
    [B.account, JSON.stringify([{ id: 'PAGEB', name: `Página ${MARK}`, picture: '', access_token: `tok-${MARK}`, instagram: null }])])).rows[0].id;
  B.wapool = (await pool.query(`INSERT INTO wa_pools (account_id, name, token) VALUES ($1, $2, 'tok-b-aislamiento') RETURNING id`, [B.account, `Grupo ${MARK}`])).rows[0].id;
  B.brand = (await pool.query(`INSERT INTO brands (name) VALUES ('Marca B') RETURNING id`)).rows[0].id;
  B.model = 'gpt-4.1-mini';
  B.pipeline = (await ok200(adminB('POST', '/api/pipelines', { name: `Pipeline ${MARK}`, stages: [{ name: 'Nuevo' }, { name: 'Ganado', kind: 'won' }] }))).id;
  B.social = (await pool.query(`INSERT INTO social_accounts (account_id, zernio_account_id, profile_id, platform, username, display_name) VALUES ($1, 'acc_b_aislamiento', 'prof_b', 'linkedin', 'b', $2) RETURNING id`, [B.account, `Red ${MARK}`])).rows[0].id;
  B.wa_template = (await pool.query(`INSERT INTO wa_templates (account_id, social_account_id, name, language, status, components) VALUES ($1, $2, 'aviso_b', 'es_MX', 'APPROVED', $3) RETURNING id`, [B.account, B.social, JSON.stringify([{ type: 'BODY', text: `Hola ${MARK}` }])])).rows[0].id;
  const postB = (await pool.query(`INSERT INTO social_posts (account_id, social_account_id, platform_post_id, caption) VALUES ($1, $2, 'post_b', $3) RETURNING id`, [B.account, B.social, `Post ${MARK}`])).rows[0].id;
  B.social_comment = (await pool.query(`INSERT INTO social_comments (account_id, social_account_id, post_id, platform, platform_post_id, comment_id, text) VALUES ($1, $2, $3, 'linkedin', 'post_b', 'cb1', $4) RETURNING id`, [B.account, B.social, postB, `Comentario ${MARK}`])).rows[0].id;
  B.social_review = (await pool.query(`INSERT INTO social_reviews (account_id, social_account_id, platform, review_id, rating, text) VALUES ($1, $2, 'googlebusiness', 'rb1', 5, $3) RETURNING id`, [B.account, B.social, `Reseña ${MARK}`])).rows[0].id;
  B.social_publication = (await pool.query(`INSERT INTO social_publications (account_id, text, status) VALUES ($1, $2, 'borrador') RETURNING id`, [B.account, `Publicación ${MARK}`])).rows[0].id;
  await pool.query(`INSERT INTO social_publication_targets (publication_id, account_id, social_account_id, zernio_account_id, platform, username) VALUES ($1, $2, $3, 'acc_b_aislamiento', 'linkedin', $4)`, [B.social_publication, B.account, B.social, `b_${MARK}`]);
  await pool.query(`INSERT INTO social_account_stats (social_account_id, account_id, day, followers, impressions) VALUES ($1, $2, current_date - 1, 4321, 98765)`, [B.social, B.account]);
  B.cfdi = (await pool.query(`INSERT INTO cfdi_invoices (kind, account_id, status, provider_invoice_id, sat_uuid, receiver) VALUES ('payment', $1, 'issued', 'fac_b', 'UUID-B', $2) RETURNING id`, [B.account, JSON.stringify({ legal_name: `Receptor ${MARK}` })])).rows[0].id;
  B.invitation = (await pool.query(`INSERT INTO account_invitations (account_id, email, name, role, token_hash, expires_at) VALUES ($1, 'invitada@b.mx', $2, 'agent', 'hash-b-aislamiento', now() + interval '7 days') RETURNING id`, [B.account, `Invitada ${MARK}`])).rows[0].id;
  B.booking_link = (await pool.query(`INSERT INTO booking_links (account_id, token, name) VALUES ($1, 'tok-b-reservas', $2) RETURNING id`, [B.account, `Reservas ${MARK}`])).rows[0].id;
  B.card = String((await pool.query(`INSERT INTO pipeline_cards (account_id, pipeline_id, conversation_id, stage_id) VALUES ($1, $2, $3, 'nuevo') RETURNING id`, [B.account, B.pipeline, B.conv])).rows[0].id);
  B.price_item = (await ok200(adminB('POST', '/api/price-items', { code: 'B1', name: `Concepto ${MARK}`, price_mode: 'exact', price_min: 99900 }))).id;
  const { createQuote, insertTemplate } = await import('../src/store/quotes.js');
  const { exampleTemplate } = await import('../src/quotes/template.js');
  const { attachmentAbsolutePath } = await import('../src/attachments.js');
  const tplPath = `${B.account}/quote-templates/b.docx`;
  fs.mkdirSync(path.dirname(attachmentAbsolutePath(tplPath)), { recursive: true });
  fs.writeFileSync(attachmentAbsolutePath(tplPath), exampleTemplate());
  B.quote_template = (await insertTemplate({ id: crypto.randomUUID(), accountId: B.account, name: `Formato ${MARK}`, filePath: tplPath, sha256: 'x', size: 1, placeholders: [], createdBy: null })).id;
  B.quote = (await createQuote({ accountId: B.account, kind: 'approximate', status: 'sent', source: 'panel', today: '2026-10-20', notes: `Nota ${MARK}`,
    lines: [{ name: `Concepto ${MARK}`, qty: 1, price_mode: 'exact', price_min: 99900, price_max: null, iva_mode: 'plus' }] })).id;
  const due = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
  const rec = await adminB('POST', '/api/receivables', { contact_id: B.contact, concept: `Cobro ${MARK}`, amount_cents: 12300, due_date: due });
  assert.equal(rec.statusCode, 201, rec.body);
  B.receivable = rec.json().receivable.id;
  const plan = await adminB('POST', '/api/receivable-plans', { contact_id: B.contact, concept: `Plan ${MARK}`, amount_cents: 45600, frequency: 'monthly', day: 5, starts_on: due });
  assert.equal(plan.statusCode, 201, plan.body);
  B.receivable_plan = plan.json().plan.id;
  const cf = await adminB('POST', '/api/contact-fields', { label: `Campo ${MARK}`, key: 'campo_b', type: 'text' });
  assert.equal(cf.statusCode, 201, cf.body);
  B.contact_field = cf.json().id;
  B.alert_receipt = (await pool.query(
    `INSERT INTO alert_receipts (account_id, alert_key, channel, destination, payload, status, last_error)
     VALUES ((SELECT account_id FROM users WHERE email = 'admin@b.mx'), gen_random_uuid(), 'email', 'equipo@b.mx', $1, 'failed', 'falla') RETURNING id`,
    [{ title: `Aviso ${MARK}`, body: MARK }])).rows[0].id;
  B.user_device = (await pool.query(
    `INSERT INTO user_devices (user_id, device_hash, trust_hash, trusted_until) VALUES ((SELECT id FROM users WHERE email = 'admin@b.mx'), 'disp-b', 'confianza-b', now() + interval '30 days') RETURNING id`)).rows[0].id;
  B.user_session = (await pool.query(`SELECT s.id FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'admin@b.mx' AND s.revoked_at IS NULL ORDER BY s.created_at DESC LIMIT 1`)).rows[0].id;
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
  assert.equal((await adminB('GET', `/api/flow-boards/${B.flow_board}`)).json().revision, 0, 'nadie de A guardó ni publicó el lienzo de B');
  assert.equal((await adminB('GET', `/api/appointments`)).json().find((a: any) => a.id === B.appointment).status, 'confirmed');
  assert.equal((await adminB('GET', '/api/users')).json().length, 2);
  assert.equal((await adminB('GET','/api/contact-views')).json().length,1);
  assert.equal((await pool.query('SELECT state FROM ai_spend WHERE id=$1',[B.budget_entry])).rows[0].state,'unknown');
  assert.equal((await adminB('GET', `/api/conversations/${B.conv}`)).json().conversation.status, 'bot');
  assert.equal((await pool.query('SELECT trust_hash FROM user_devices WHERE id = $1', [B.user_device])).rows[0].trust_hash, 'confianza-b', 'nadie de A olvidó su dispositivo');
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
    ['POST', '/api/users', { email: 'x@a.mx', name: 'x', password: 'Pz-144-Qx-344-Kv', role: 'admin' }],
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
