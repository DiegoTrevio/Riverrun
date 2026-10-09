/** Varios números de WhatsApp por cuenta: enlace que reparte clientes y campañas repartidas con tope diario. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, store } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let B = '', C = '';
const numbers: Record<string, string> = {};

const hit = async (token: string) => h.app.inject({ method: 'GET', url: `/wa/${token}`, remoteAddress: `10.1.1.${Math.floor(Math.random() * 200) + 1}` });
const dest = (r: any) => String(r.headers.location);
const newPool = async (body: Record<string, unknown>) => { const r = await h.authed('POST', '/api/wa-pools', { account_id: h.accountId, ...body }); assert.equal(r.statusCode, 200, r.body); return r.json(); };
const setState = (id: string, state: string) => pool.query(`UPDATE channels SET connection_state = $2 WHERE id = $1`, [id, state]);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  for (const [name, inst] of [['Sucursal Norte', 'norte'], ['Sucursal Sur', 'sur']] as const) {
    const r = await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'whatsapp', name, chatbot_id: h.botId, config: { instance: inst } });
    assert.equal(r.statusCode, 200, r.body);
    if (name.endsWith('Norte')) B = r.json().id; else C = r.json().id;
  }
  const A = h.channelId;
  numbers[A] = '5218100000001'; numbers[B] = '5218100000002'; numbers[C] = '5218100000003';
  for (const id of [A, B, C]) await pool.query(`UPDATE channels SET config = config || jsonb_build_object('number', $2::text), connection_state = 'open' WHERE id = $1`, [id, numbers[id]]);
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('el enlace reparte a los clientes nuevos solo entre los números conectados', async () => {
  await setState(C, 'close');
  const p = await newPool({ name: 'Anuncio octubre', channel_ids: [h.channelId, B, C], strategy: 'least_busy', message: 'Hola, vi su anuncio' });
  assert.match(p.url, /\/wa\/[\w-]{10,}$/);
  const token = p.token;
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await hit(token);
    assert.equal(r.statusCode, 302, r.body);
    assert.match(dest(r), /^https:\/\/wa\.me\/5218100000\d+\?text=Hola%2C%20vi%20su%20anuncio$/);
    seen.push(dest(r).match(/wa\.me\/(\d+)/)![1]);
  }
  assert.ok(!seen.includes(numbers[C]), 'el número desconectado no recibe clientes');
  assert.equal(seen.filter((n) => n === numbers[h.channelId]).length, 3);
  assert.equal(seen.filter((n) => n === numbers[B]).length, 3);
  // Reconecta el tercero: el que menos clientes lleva hoy recibe los siguientes
  await setState(C, 'open');
  assert.equal(dest(await hit(token)).match(/wa\.me\/(\d+)/)![1], numbers[C]);
  assert.equal(dest(await hit(token)).match(/wa\.me\/(\d+)/)![1], numbers[C]);
  const list = (await h.authed('GET', `/api/wa-pools?account_id=${h.accountId}`)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].hits.reduce((a: number, x: any) => a + x.today, 0), 8);
});

t('reparto por turnos, sin números, enlace inactivo o inexistente', async () => {
  const p = await newPool({ name: 'Turnos', channel_ids: [h.channelId, B], strategy: 'round_robin' });
  const seq: string[] = [];
  for (let i = 0; i < 4; i++) { const r = await hit(p.token); assert.equal(dest(r), `https://wa.me/${dest(r).match(/wa\.me\/(\d+)/)![1]}`, 'sin mensaje inicial no hay ?text'); seq.push(dest(r).match(/wa\.me\/(\d+)/)![1]); }
  assert.notEqual(seq[0], seq[1]);
  assert.deepEqual(seq.slice(0, 2), seq.slice(2, 4), 'alterna');
  await setState(h.channelId, 'close'); await setState(B, 'close');
  const none = await hit(p.token);
  assert.equal(none.statusCode, 503);
  assert.match(none.body, /no hay un número disponible/);
  await setState(h.channelId, 'open'); await setState(B, 'open');
  await h.authed('PUT', `/api/wa-pools/${p.id}`, { active: false });
  assert.equal((await hit(p.token)).statusCode, 404);
  assert.equal((await hit('no-existe')).statusCode, 404);
  assert.equal((await h.authed('DELETE', `/api/wa-pools/${p.id}`)).statusCode, 200);
  assert.equal((await hit(p.token)).statusCode, 404);
});

t('solo canales de WhatsApp de la propia cuenta', async () => {
  const web = (await h.authed('POST', '/api/channels', { account_id: h.accountId, type: 'webchat', name: 'Web' })).json();
  const bad = await h.authed('POST', '/api/wa-pools', { account_id: h.accountId, name: 'x', channel_ids: [web.id] });
  assert.equal(bad.statusCode, 400);
  const acc2 = (await h.authed('POST', '/api/accounts', { name: 'Otra cuenta' })).json();
  const foreign = (await h.authed('POST', '/api/channels', { account_id: acc2.id, type: 'whatsapp', name: 'Ajeno', config: { instance: 'ajeno' } })).json();
  assert.equal((await h.authed('POST', '/api/wa-pools', { account_id: h.accountId, name: 'y', channel_ids: [foreign.id] })).statusCode, 400);
  assert.equal((await h.authed('POST', '/api/wa-pools', { account_id: h.accountId, name: 'z', channel_ids: [] })).statusCode, 400);
});

/** Crea n conversaciones con consentimiento en un canal. */
async function audience(channelId: string, n: number, prefix: string) {
  const ch = await store.getChannel(channelId);
  for (let i = 0; i < n; i++) {
    const c = await store.upsertContact(ch!, `${prefix}${i}@s.whatsapp.net`, `${prefix}${i}`, `Cliente ${prefix}${i}`);
    await pool.query(`UPDATE contacts SET consent_at = now(), consent_source = 'panel' WHERE id = $1`, [c.id]);
    await store.getOrCreateConversation(ch!, c.id);
  }
}
const jobsOf = async (campaignId: string) => (await pool.query(
  `SELECT j.run_at, cv.channel_id FROM jobs j JOIN conversations cv ON cv.id = (j.payload->>'conversation_id')::uuid WHERE j.type = 'campaign_send' AND j.payload->>'campaign_id' = $1 ORDER BY j.run_at`, [campaignId])).rows;

t('una campaña desde varios números va en paralelo: cada número lleva su ritmo', async () => {
  await audience(h.channelId, 4, 'norte');
  await audience(B, 4, 'sur');
  const mk = async (extra: Record<string, unknown>) => h.authed('POST', '/api/campaigns', { account_id: h.accountId, channel_id: h.channelId, name: 'Promo', message: 'Descuento', audience: { active_within_days: 0 }, rate_per_minute: 60, ...extra });
  const single = (await mk({})).json();
  await h.authed('POST', `/api/campaigns/${single.id}/launch`);
  const j1 = await jobsOf(single.id);
  assert.equal(j1.length, 4, 'solo los clientes del número elegido');
  await pool.query(`DELETE FROM jobs WHERE type = 'campaign_send'`);
  await pool.query(`UPDATE campaigns SET status = 'cancelled'`);

  const multi = (await mk({ channel_ids: [B] })).json();
  assert.deepEqual(multi.channel_ids, [B]);
  await h.authed('POST', `/api/campaigns/${multi.id}/launch`);
  const j = await jobsOf(multi.id);
  assert.equal(j.length, 8);
  const span = (rows: any[]) => new Date(rows.at(-1).run_at).getTime() - new Date(rows[0].run_at).getTime();
  const a = j.filter((x: any) => x.channel_id === h.channelId), b = j.filter((x: any) => x.channel_id === B);
  assert.ok(a.length === 4 && b.length === 4);
  assert.ok(span(a) >= 2900 && span(a) <= 3200, `un número por minuto: ${span(a)}`);
  assert.ok(span(j) <= 3300, `los dos números a la vez (no ${span(j)} ms en fila)`);
  assert.equal((await h.authed('POST', `/api/campaigns/${multi.id}/preview`)).json().count, 8);
  // Un canal de otro tipo, o el mismo canal repetido, no cuenta
  const web = (await h.authed('GET', `/api/channels?account_id=${h.accountId}`)).json().find((c: any) => c.type === 'webchat');
  assert.equal((await mk({ channel_ids: [web.id] })).statusCode, 400);
  assert.deepEqual((await mk({ channel_ids: [h.channelId, B, B] })).json().channel_ids, [B]);
  await pool.query(`DELETE FROM jobs WHERE type = 'campaign_send'`);
  await pool.query(`UPDATE campaigns SET status = 'cancelled'`);
});

t('tope diario por número: lo que no cabe hoy pasa al día siguiente', async () => {
  const s0 = (await h.authed('GET', `/api/settings?account_id=${h.accountId}`)).json();
  assert.equal((await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { sending: { daily_cap_per_number: 3 } })).statusCode, 200);
  assert.equal((await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { sending: { daily_cap_per_number: -1 } })).statusCode, 400);
  const camp = (await h.authed('POST', '/api/campaigns', { account_id: h.accountId, channel_id: h.channelId, channel_ids: [B], name: 'Con tope', message: 'Hola', audience: {}, rate_per_minute: 60 })).json();
  await h.authed('POST', `/api/campaigns/${camp.id}/launch`);
  const rows = await jobsOf(camp.id);
  const tz = s0.timezone;
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  for (const ch of [h.channelId, B]) {
    const mine = rows.filter((r: any) => r.channel_id === ch);
    const perDay = new Map<string, number>();
    for (const r of mine) perDay.set(day(new Date(r.run_at)), (perDay.get(day(new Date(r.run_at))) ?? 0) + 1);
    assert.ok([...perDay.values()].every((n) => n <= 3), JSON.stringify([...perDay]));
    assert.equal(mine.length, 4);
    assert.equal(perDay.size, 2, 'el cuarto mensaje pasa al día siguiente');
  }
  await h.authed('PUT', `/api/settings?account_id=${h.accountId}`, { sending: { daily_cap_per_number: 0 } });
});
