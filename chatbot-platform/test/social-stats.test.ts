/**
 * Salud y estadísticas de las redes (Zernio): una cuenta caída cierra su canal o avisa (con enlace a Redes sociales) una
 * sola vez, vuelve sola al recuperarse, un permiso por vencer avisa una vez por fecha, muchas caídas a la vez no cambian
 * nada, el webhook apagado se repara y avisa al superadmin; y las estadísticas diarias por cuenta, sin ids de Zernio.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHarness, dbAvailable, ext, pool, zer } from './harness.js';
const { config } = await import('../src/config.js');
const { checkZernioHealth } = await import('../src/social/health.js');
const { setStatsSpacing, syncStatsDue } = await import('../src/social/stats.js');
const { platformWebhookSecret, platformWebhookUrl } = await import('../src/channels/zernio.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let owner: Awaited<ReturnType<typeof h.loginAs>>;
let agent: Awaited<ReturnType<typeof h.loginAs>>;
const nets: Record<string, string> = {};
const savedMeta = { appId: '', appSecret: '' };
const day = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
const healthy = { status: 'healthy', tokenValid: true, needsReconnect: false, canPost: true, canFetchAnalytics: true };
const notes = async (like: string) => (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE account_id = $1 AND title LIKE $2`, [h.accountId, like])).rows[0].n;
const run = () => checkZernioHealth({ force: true });
const deliver = (body: Record<string, unknown>) => {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', platformWebhookSecret()).update(raw).digest('hex');
  return h.app.inject({ method: 'POST', url: '/zernio/events', headers: { 'content-type': 'application/json', 'x-zernio-signature': sig }, payload: raw });
};

async function connect(platform: string, zid: string) {
  const r = await owner('POST', '/api/social-accounts/connect', { platform, ...(platform === 'instagram' ? { chatbot_id: h.botId } : {}) });
  assert.equal(r.statusCode, 200, r.body);
  const q = [...ext.requests].reverse().find((x) => x.path.startsWith('/api/v1/connect/'))!.query;
  const profileId = q.get('profileId')!;
  zer.accounts.set(zid, { _id: zid, platform, profileId, username: `palmas_${platform}`, displayName: `Palmas ${platform}`, isActive: true });
  const ret = await h.app.inject({ method: 'GET', url: `/zernio/return/${q.get('redirect_url')!.split('/').pop()}?connected=${platform}&profileId=${profileId}&accountId=${zid}` });
  assert.match(String(ret.headers.location), /zernio=ok$/, String(ret.headers.location));
  nets[platform] = (await pool.query(`SELECT id FROM social_accounts WHERE zernio_account_id = $1`, [zid])).rows[0].id;
}

before(async () => {
  if (!ok) return;
  Object.assign(savedMeta, { appId: config.meta.appId, appSecret: config.meta.appSecret });
  config.meta.appId = '';
  config.meta.appSecret = '';
  h = await createHarness();
  await h.createBot();
  for (const [email, role] of [['duena@salud.mx', 'admin'], ['agente@salud.mx', 'agent']] as const) {
    await h.authed('POST', '/api/users', { account_id: h.accountId, email, name: role, password: 'clave-salud-1', role });
  }
  await pool.query('UPDATE users SET email_verified_at = now()');
  owner = await h.loginAs('duena@salud.mx', 'clave-salud-1');
  agent = await h.loginAs('agente@salud.mx', 'clave-salud-1');
  await connect('instagram', 'acc_hi');
  await connect('linkedin', 'acc_hl');
  await connect('googlebusiness', 'acc_hg');
  setStatsSpacing(0);
});
after(async () => {
  Object.assign(config.meta, savedMeta);
  if (h) await h.app.close();
  await pool.end();
});

t('salud: caída con canal cierra el canal; sin canal avisa con enlace a Redes; una vez; al recuperarse vuelve', async () => {
  zer.health.set('acc_hi', { status: 'error', needsReconnect: true, tokenValid: false, canPost: false });
  zer.health.set('acc_hl', { status: 'error', needsReconnect: true });
  zer.health.set('acc_hg', healthy);
  const r = await run();
  assert.equal(r.down, 2);
  const ch = (await pool.query(`SELECT c.connection_state FROM channels c JOIN social_accounts s ON s.channel_id = c.id WHERE s.id = $1`, [nets.instagram])).rows[0];
  assert.equal(ch.connection_state, 'close');
  assert.equal(await notes('%volver a conectar LinkedIn%'), 1);
  assert.equal((await pool.query(`SELECT link FROM notifications WHERE account_id = $1 AND title LIKE '%LinkedIn%'`, [h.accountId])).rows[0].link, '#/redes');
  assert.deepEqual((await pool.query(`SELECT platform, status FROM social_accounts WHERE account_id = $1 ORDER BY platform`, [h.accountId])).rows.map((x) => [x.platform, x.status]),
    [['googlebusiness', 'active'], ['instagram', 'needs_reconnect'], ['linkedin', 'needs_reconnect']]);
  // Otra vuelta igual: nada nuevo.
  await run();
  assert.equal(await notes('%volver a conectar LinkedIn%'), 1);
  // La cuenta que Zernio no menciona no se toca.
  zer.health.delete('acc_hg');
  await run();
  assert.equal((await pool.query(`SELECT status FROM social_accounts WHERE id = $1`, [nets.googlebusiness])).rows[0].status, 'active');
  // Recuperadas: vuelven a estar activas y el canal se reabre.
  for (const zid of ['acc_hi', 'acc_hl', 'acc_hg']) zer.health.set(zid, healthy);
  const back = await run();
  assert.equal(back.back, 2);
  assert.equal((await pool.query(`SELECT c.connection_state FROM channels c JOIN social_accounts s ON s.channel_id = c.id WHERE s.id = $1`, [nets.instagram])).rows[0].connection_state, 'open');
  // El panel lo muestra en palabras, sin ids de Zernio.
  const list = await owner('GET', '/api/social-accounts');
  assert.ok(!list.body.includes('acc_h'));
  assert.ok(list.json().accounts.every((a: any) => a.health.level === 'ok' && a.health.problem === ''));
});

t('Meta a veces dice que el permiso venció sin ser cierto: hace falta verlo dos veces seguidas', async () => {
  zer.health.set('acc_hi', { ...healthy, status: 'warning', tokenValid: false });
  await run();
  assert.equal((await pool.query(`SELECT status FROM social_accounts WHERE id = $1`, [nets.instagram])).rows[0].status, 'active');
  await run();
  assert.equal((await pool.query(`SELECT status FROM social_accounts WHERE id = $1`, [nets.instagram])).rows[0].status, 'needs_reconnect');
  zer.health.set('acc_hi', healthy);
  await run();
  assert.equal((await pool.query(`SELECT status FROM social_accounts WHERE id = $1`, [nets.instagram])).rows[0].status, 'active');
});

t('permiso por vencer: un aviso por fecha (Instagram y LinkedIn); Google no', async () => {
  const soon = new Date(Date.now() + 5 * 86400_000).toISOString();
  zer.health.set('acc_hl', { ...healthy, tokenExpiresAt: soon });
  zer.health.set('acc_hg', { ...healthy, tokenExpiresAt: soon });
  await run();
  assert.equal(await notes('El permiso de LinkedIn%vence en 5 días%'), 1);
  assert.equal(await notes('%Google%vence%'), 0);
  await run();
  assert.equal(await notes('El permiso de LinkedIn%'), 1, 'la misma fecha no vuelve a avisar');
  zer.health.set('acc_hl', { ...healthy, tokenExpiresAt: new Date(Date.now() + 3 * 86400_000).toISOString() });
  await run();
  assert.equal(await notes('El permiso de LinkedIn%'), 2, 'una fecha nueva sí');
  const list = (await owner('GET', '/api/social-accounts')).json();
  assert.match(list.accounts.find((a: any) => a.platform === 'linkedin').health.problem, /vence pronto/);
  assert.equal(list.accounts.find((a: any) => a.platform === 'googlebusiness').health.problem, '', 'Google renueva su permiso sola: no se le pide reconectar');
  zer.health.set('acc_hl', healthy);
  await pool.query(`UPDATE social_accounts SET token_expires_at = NULL WHERE id = $1`, [nets.linkedin]);
});

t('muchas caídas a la vez parecen un problema de Zernio: no se marca ninguna y se abre una incidencia', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const zid = `acc_mass_${i}`;
    ids.push((await pool.query(`INSERT INTO social_accounts (account_id, zernio_account_id, profile_id, platform, username) VALUES ($1, $2, 'prof_mass', 'linkedin', $3) RETURNING id`, [h.accountId, zid, `masa${i}`])).rows[0].id);
    zer.health.set(zid, { status: 'error', needsReconnect: true });
  }
  await run();
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM social_accounts WHERE id = ANY($1::uuid[]) AND status = 'active' AND health = '{}'::jsonb`, [ids])).rows[0].n, 6, 'ni caídas ni avisos de salud');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM incidents WHERE component = 'zernio_health_mass' AND state = 'abierto'`)).rows[0].n, 1);
  for (let i = 0; i < 6; i++) zer.health.delete(`acc_mass_${i}`);
  await pool.query(`DELETE FROM social_accounts WHERE id = ANY($1::uuid[])`, [ids]);
  await run();
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM incidents WHERE component = 'zernio_health_mass' AND state = 'abierto'`)).rows[0].n, 0);
});

t('reconectar borra la caída anterior: una caída nueva (por el webhook) vuelve a avisar', async () => {
  const before = await notes('%volver a conectar LinkedIn%');
  zer.health.set('acc_hl', { status: 'error', needsReconnect: true });
  await run();
  assert.equal(await notes('%volver a conectar LinkedIn%'), before + 1);
  // El negocio la vuelve a conectar desde el panel.
  zer.health.set('acc_hl', healthy);
  await connect('linkedin', 'acc_hl');
  const row = (await pool.query(`SELECT status, health, down_since, down_notified_at, profile_id FROM social_accounts WHERE id = $1`, [nets.linkedin])).rows[0];
  assert.deepEqual([row.status, row.health, row.down_since, row.down_notified_at], ['active', {}, null, null]);
  assert.equal((await owner('GET', '/api/social-accounts')).json().accounts.find((a: any) => a.platform === 'linkedin').health.problem, '');
  // Se cae otra vez y Zernio lo avisa por el webhook: llega un aviso nuevo.
  const ev = { id: `evt_${crypto.randomUUID()}`, event: 'account.disconnected', timestamp: new Date().toISOString(), account: { accountId: 'acc_hl', profileId: row.profile_id, platform: 'linkedin' } };
  assert.equal((await deliver(ev)).statusCode, 200);
  await h.idle();
  assert.equal(await notes('%volver a conectar LinkedIn%'), before + 2);
  // Y al recuperarse queda como antes para las demás pruebas.
  await run();
  assert.equal((await pool.query(`SELECT status FROM social_accounts WHERE id = $1`, [nets.linkedin])).rows[0].status, 'active');
});

t('webhook de la plataforma: si Zernio lo apagó se reactiva y se abre una incidencia; al estar bien se cierra', async () => {
  const hook = zer.webhooks.find((w) => w.url === platformWebhookUrl())!;
  hook.isActive = false;
  await run();
  assert.equal(hook.isActive, true);
  const put = ext.requests.filter((x) => x.method === 'PUT' && x.path === '/api/v1/webhooks/settings').pop()!;
  assert.equal(put.body.isActive, true);
  assert.ok(put.body.secret, 'se vuelve a mandar el secreto');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM incidents WHERE component = 'zernio_webhook' AND state = 'abierto'`)).rows[0].n, 1);
  await run();
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM incidents WHERE component = 'zernio_webhook' AND state = 'abierto'`)).rows[0].n, 0);
  const summary = await h.authed('GET', '/api/system/zernio/health');
  assert.equal(summary.statusCode, 200, summary.body);
  assert.equal(summary.json().webhook.active, true);
  assert.ok(!summary.body.includes(String(hook.secret)) && !summary.body.includes('acc_h'), 'sin secreto ni ids de Zernio');
});

t('estadísticas: seguidores, alcance e interacción por día (UTC), sin duplicar y solo de redes con estadísticas', async () => {
  zer.followers.set('acc_hi', [{ date: day(-2), followers: 1000 }, { date: day(-1), followers: 1012 }]);
  zer.followers.set('acc_hl', [{ date: day(-1), followers: 300 }]);
  zer.metrics.set('acc_hi', [{ date: day(-1), postCount: 2, metrics: { impressions: 5000, reach: 3200, likes: 120, comments: 14, shares: 6, saves: 10, clicks: 40, views: 900 } }]);
  zer.metrics.set('acc_hl', [{ date: day(-1), postCount: 1, metrics: { impressions: 800, reach: 500, likes: 30, comments: 2, shares: 1, saves: 0 } }]);
  zer.gbp.set('acc_hg', { BUSINESS_IMPRESSIONS_MOBILE_MAPS: { total: 70, values: [{ date: day(-3), value: 70 }] }, CALL_CLICKS: { total: 4, values: [{ date: day(-3), value: 4 }] }, WEBSITE_CLICKS: { total: 6, values: [{ date: day(-3), value: 6 }] } });
  const before = ext.requests.length;
  assert.equal(await syncStatsDue(10), 3);
  const calls = ext.requests.slice(before);
  const follower = calls.filter((x) => x.path === '/api/v1/accounts/follower-stats');
  assert.equal(follower.length, 1, 'una llamada para varias cuentas');
  assert.deepEqual(follower[0].query.get('accountIds')!.split(',').sort(), ['acc_hi', 'acc_hl']);
  assert.ok(calls.filter((x) => x.path === '/api/v1/analytics/daily-metrics').every((x) => x.query.get('attribution') === 'received'));
  const r = await owner('GET', '/api/analytics/social?days=30');
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(!r.body.includes('acc_h'), 'sin ids de Zernio');
  const ig = r.json().accounts.find((a: any) => a.platform === 'instagram');
  assert.deepEqual([ig.followers, ig.followers_change, ig.totals.impressions, ig.totals.reach, ig.totals.engagement, ig.totals.posts], [1012, 12, 5000, 3200, 150, 2]);
  assert.deepEqual(ig.series.map((s: any) => s.day), [day(-2), day(-1)], 'los días no se corren');
  const gb = r.json().accounts.find((a: any) => a.platform === 'googlebusiness');
  assert.deepEqual([gb.followers, gb.totals.impressions, gb.totals.engagement, gb.totals.reach], [null, 70, 10, null], 'lo que Google no reporta queda vacío, no en cero');
  // Otra vuelta (con datos nuevos de seguidores) no duplica ni borra lo que ya estaba.
  await pool.query(`UPDATE social_accounts SET stats_synced_at = NULL WHERE account_id = $1`, [h.accountId]);
  zer.metrics.set('acc_hi', []);
  await syncStatsDue(10);
  const again = (await owner('GET', '/api/analytics/social?days=30')).json().accounts.find((a: any) => a.platform === 'instagram');
  assert.deepEqual([again.series.length, again.totals.impressions], [2, 5000]);
  assert.equal((await agent('GET', '/api/analytics/social')).statusCode, 403);
  // Si Zernio rechaza los seguidores, las cuentas siguen con lo demás y no se quedan atoradas al inicio de la fila.
  ext.fail.add('/accounts/follower-stats');
  try {
    zer.metrics.set('acc_hl', [{ date: day(-1), postCount: 1, metrics: { impressions: 900, reach: 500, likes: 30, comments: 2, shares: 1, saves: 0 } }]);
    await pool.query(`UPDATE social_accounts SET stats_synced_at = NULL WHERE account_id = $1`, [h.accountId]);
    assert.equal(await syncStatsDue(10), 3);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM social_accounts WHERE account_id = $1 AND platform IN ('instagram', 'linkedin', 'googlebusiness') AND stats_synced_at IS NOT NULL`, [h.accountId])).rows[0].n, 3);
    const li = (await owner('GET', '/api/analytics/social?days=30')).json().accounts.find((a: any) => a.platform === 'linkedin');
    assert.equal(li.totals.impressions, 900, 'las demás cifras sí llegan');
  } finally {
    ext.fail.delete('/accounts/follower-stats');
  }
});

t('sin el complemento de estadísticas en Zernio: se anota y no se vuelve a intentar hasta el día siguiente', async () => {
  zer.analyticsAddon = false;
  try {
    await pool.query(`UPDATE social_accounts SET stats_synced_at = NULL WHERE account_id = $1`, [h.accountId]);
    await syncStatsDue(10);
    assert.equal((await pool.query(`SELECT value->>'available' AS a FROM system_state WHERE key = 'zernio_analytics'`)).rows[0].a, 'false');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM social_accounts WHERE account_id = $1 AND stats_synced_at IS NOT NULL`, [h.accountId])).rows[0].n, 0, 'las cuentas quedan para después');
    const before = ext.requests.length;
    assert.equal(await syncStatsDue(10), 0);
    assert.equal(ext.requests.length, before, 'no se llama a Zernio en 24 h');
    assert.equal((await owner('GET', '/api/analytics/social')).json().analytics_available, false);
  } finally {
    zer.analyticsAddon = true;
    await pool.query(`DELETE FROM system_state WHERE key = 'zernio_analytics'`);
  }
});
