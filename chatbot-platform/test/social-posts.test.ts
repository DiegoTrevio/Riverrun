/**
 * Publicaciones (Zernio): subir fotos firmadas para el negocio, validar por red sin llamar a Zernio, publicar ya o
 * programar (cuerpo exacto, hora del negocio, llave de idempotencia), un solo envío aunque se mande dos veces o Zernio no
 * conteste, cambiar y cancelar lo programado, reintentar, y el estado por red que avisa el webhook (o la revisión).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHarness, dbAvailable, ext, pool, zer } from './harness.js';
const { platformWebhookSecret } = await import('../src/channels/zernio.js');
const { config } = await import('../src/config.js');
const { zonedToUtc } = await import('../src/automation/time.js');
const { zernioFootprint } = await import('../src/channels/zernio-connect.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let owner: Awaited<ReturnType<typeof h.loginAs>>;
let agent: Awaited<ReturnType<typeof h.loginAs>>;
const nets: Record<string, { profileId: string; socialId: string }> = {};
let photo: any;
let video: any;
let tz = 'America/Mexico_City';
let scheduled: any;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), crypto.randomBytes(64)]);
const deliver = (body: Record<string, unknown>) => {
  const raw = JSON.stringify({ id: `evt_${crypto.randomUUID()}`, timestamp: new Date().toISOString(), ...body });
  const sig = crypto.createHmac('sha256', platformWebhookSecret()).update(raw).digest('hex');
  return h.app.inject({ method: 'POST', url: '/zernio/events', headers: { 'content-type': 'application/json', 'x-zernio-signature': sig }, payload: raw });
};
const upload = (name: string, buffer: Buffer, cookie = owner.cookie) => {
  const b = '----publicacion';
  const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), buffer, Buffer.from(`\r\n--${b}--\r\n`)]);
  return h.app.inject({ method: 'POST', url: '/api/social-media', payload: body, headers: { cookie, 'content-type': `multipart/form-data; boundary=${b}` } });
};
const posts = () => ext.requests.filter((r) => r.path === '/api/v1/posts' && r.method === 'POST');
const tomorrow = () => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 86400_000));

async function connect(platform: string, zid: string) {
  const r = await owner('POST', '/api/social-accounts/connect', { platform });
  assert.equal(r.statusCode, 200, r.body);
  const q = [...ext.requests].reverse().find((x) => x.path.startsWith('/api/v1/connect/'))!.query;
  const profileId = q.get('profileId')!;
  zer.accounts.set(zid, { _id: zid, platform, profileId, username: `palmas_${platform}`, displayName: `Palmas ${platform}`, isActive: true });
  const ret = await h.app.inject({ method: 'GET', url: `/zernio/return/${q.get('redirect_url')!.split('/').pop()}?connected=${platform}&profileId=${profileId}&accountId=${zid}` });
  assert.match(String(ret.headers.location), /zernio=ok$/, String(ret.headers.location));
  nets[platform] = { profileId, socialId: (await pool.query(`SELECT id FROM social_accounts WHERE zernio_account_id = $1`, [zid])).rows[0].id };
}

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  for (const [email, role] of [['duena@posts.mx', 'admin'], ['agente@posts.mx', 'agent']] as const) {
    await h.authed('POST', '/api/users', { account_id: h.accountId, email, name: role, password: 'clave-posts-1', role });
  }
  await pool.query('UPDATE users SET email_verified_at = now()');
  owner = await h.loginAs('duena@posts.mx', 'clave-posts-1');
  agent = await h.loginAs('agente@posts.mx', 'clave-posts-1');
  await connect('instagram', 'acc_pi');
  await connect('linkedin', 'acc_pl');
  await connect('youtube', 'acc_py');
  tz = (await pool.query(`SELECT coalesce(settings->>'timezone', '') AS tz FROM accounts WHERE id = $1`, [h.accountId])).rows[0].tz || tz;
  const s = (await owner('GET', '/api/automation/settings')).json?.();
  if (s?.timezone) tz = s.timezone;
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('archivos: se revisa su tipo real, se suben a Zernio y quedan firmados para el negocio', async () => {
  const r = await upload('playa.png', PNG);
  assert.equal(r.statusCode, 200, r.body);
  photo = r.json();
  assert.equal(photo.type, 'image');
  assert.match(photo.url, /^https:\/\/cdn\.zernio\.example\/up\/\d+\/publicacion-.+\.png$/);
  video = (await upload('tour.mp4', MP4)).json();
  assert.equal(video.type, 'video');
  assert.equal((await upload('pagina.html', Buffer.from('<html><script>alert(1)</script></html>'))).statusCode, 400);
  assert.equal((await upload('playa.png', PNG, agent.cookie)).statusCode, 403, 'solo el administrador publica');
});

t('validación por red: sin foto en Instagram, sin video en YouTube o texto largo en LinkedIn no llegan a Zernio', async () => {
  const before = posts().length;
  const bad = async (body: Record<string, unknown>, re: RegExp) => {
    const r = await owner('POST', '/api/social-publications', { mode: 'now', ...body });
    assert.equal(r.statusCode, 400, r.body);
    assert.match(r.json().error, re);
  };
  await bad({ text: 'Hola', targets: [{ social_account_id: nets.instagram.socialId }] }, /Instagram.*necesita una foto o un video/);
  await bad({ text: 'Hola', media: [photo], targets: [{ social_account_id: nets.youtube.socialId }] }, /YouTube.*necesita un video/);
  await bad({ text: 'x'.repeat(3001), targets: [{ social_account_id: nets.linkedin.socialId }] }, /LinkedIn.*3001 caracteres y el máximo es 3000/);
  // Un archivo con la firma de otro (o inventado) no sirve.
  await bad({ text: 'Hola', media: [{ ...photo, url: 'https://evil.example/x.png' }], targets: [{ social_account_id: nets.linkedin.socialId }] }, /no se subió desde aquí/);
  assert.equal(posts().length, before);
  // Un borrador sí puede quedar incompleto.
  const draft = await owner('POST', '/api/social-publications', { mode: 'draft', text: 'Idea para después', targets: [{ social_account_id: nets.instagram.socialId }] });
  assert.equal(draft.statusCode, 200, draft.body);
  assert.equal(draft.json().status, 'borrador');
});

t('programar: el cuerpo exacto (hora del negocio, texto por red, título), la llave de idempotencia y sin ids de Zernio', async () => {
  const date = tomorrow();
  const r = await owner('POST', '/api/social-publications', {
    client_ref: crypto.randomUUID(), mode: 'schedule', date, time: '10:30', text: 'Nueva suite con vista al mar', media: [video],
    targets: [{ social_account_id: nets.instagram.socialId }, { social_account_id: nets.linkedin.socialId, text: 'Abrimos nuestra nueva suite. ¡Te esperamos!' }, { social_account_id: nets.youtube.socialId, options: { title: 'Tour por la suite' } }],
  });
  assert.equal(r.statusCode, 200, r.body);
  scheduled = r.json();
  assert.equal(scheduled.status, 'programada');
  assert.ok(!r.body.includes('zp_') && !r.body.includes('acc_p'), 'sin ids de Zernio');
  const call = posts().pop()!;
  assert.equal(call.headers['idempotency-key'], `pub-${scheduled.id}-1`);
  assert.deepEqual(call.body, {
    content: 'Nueva suite con vista al mar', mediaItems: [{ url: video.url, type: 'video' }],
    platforms: [
      { platform: 'instagram', accountId: 'acc_pi' },
      { platform: 'linkedin', accountId: 'acc_pl', customContent: 'Abrimos nuestra nueva suite. ¡Te esperamos!' },
      { platform: 'youtube', accountId: 'acc_py', platformSpecificData: { title: 'Tour por la suite' } },
    ],
    metadata: { publication_id: scheduled.id, send_seq: 1 }, scheduledFor: zonedToUtc(date, '10:30', tz).toISOString(), timezone: tz,
  });
  assert.deepEqual(scheduled.targets.map((x: any) => [x.platform, x.status]), [['instagram', 'pendiente'], ['linkedin', 'pendiente'], ['youtube', 'pendiente']]);
});

t('doble envío: el mismo formulario dos veces es una sola publicación y una sola llamada a Zernio', async () => {
  const ref = crypto.randomUUID();
  const body = { client_ref: ref, mode: 'now', text: 'Promo de fin de semana', targets: [{ social_account_id: nets.linkedin.socialId }] };
  const before = posts().length;
  const [a, b] = await Promise.all([owner('POST', '/api/social-publications', body), owner('POST', '/api/social-publications', body)]);
  assert.equal(a.json().id, b.json().id);
  assert.equal(posts().length - before, 1);
});

t('publicar ya: enlace por red; si una falla queda parcial, se avisa una sola vez y se puede reintentar', async () => {
  zer.postFail.set('linkedin', 'Token expired');
  try {
    const r = await owner('POST', '/api/social-publications', { mode: 'now', text: 'Hoy hay música en vivo', media: [photo], targets: [{ social_account_id: nets.instagram.socialId }, { social_account_id: nets.linkedin.socialId }] });
    assert.equal(r.statusCode, 200, r.body);
    const p = r.json();
    assert.equal(p.status, 'parcial');
    const [ig, li] = p.targets;
    assert.deepEqual([ig.status, li.status, li.error], ['publicada', 'fallida', 'Token expired']);
    assert.match(ig.url, /^https:\/\/instagram\.test\/p\/\d+$/);
    const alerts = async () => (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE account_id = $1 AND title LIKE '%no salió en todas tus redes%'`, [h.accountId])).rows[0].n;
    assert.ok((await alerts()) >= 1);
    const n = await alerts();
    // El mismo resultado por el webhook no vuelve a avisar.
    const zpost = [...zer.publications.values()].find((x) => x.metadata?.publication_id === p.id);
    await deliver({ event: 'post.partial', post: zpost, profiles: [{ id: nets.instagram.profileId, externalId: h.accountId }] });
    await h.idle();
    assert.equal(await alerts(), n);
    zer.postFail.delete('linkedin');
    const retry = await owner('POST', `/api/social-publications/${p.id}/retry`);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().status, 'publicada');
    assert.equal(retry.json().targets[1].status, 'publicada');
  } finally {
    zer.postFail.delete('linkedin');
  }
});

t('si Zernio no contesta, queda "enviando" y la revisión la reenvía con la misma llave sin duplicarla', async () => {
  ext.fail.add('/api/v1/posts');
  let id = '';
  try {
    const r = await owner('POST', '/api/social-publications', { mode: 'now', text: 'Reapertura de la terraza', targets: [{ social_account_id: nets.linkedin.socialId }] });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().status, 'enviando');
    id = r.json().id;
  } finally {
    ext.fail.delete('/api/v1/posts');
  }
  await h.fastForward();
  const mine = posts().filter((x) => x.body?.metadata?.publication_id === id);
  assert.deepEqual(mine.map((x) => x.headers['idempotency-key']), [`pub-${id}-1`, `pub-${id}-1`]);
  assert.equal([...zer.publications.values()].filter((x) => x.metadata?.publication_id === id).length, 1);
  assert.equal((await owner('GET', `/api/social-publications/${id}`)).json().status, 'publicada');
});

t('cambiar lo programado: primero en Zernio (si falla, nada cambia aquí); versión vieja 409; a borrador sin borrarla', async () => {
  const body = (extra: Record<string, unknown>) => ({
    mode: 'schedule', date: tomorrow(), time: '12:00', text: 'Nueva suite: ¡reserva ya!', media: [video],
    targets: [{ social_account_id: nets.instagram.socialId }, { social_account_id: nets.youtube.socialId, options: { title: 'Tour por la suite' } }], ...extra,
  });
  const zid = [...zer.publications.values()].find((x) => x.metadata?.publication_id === scheduled.id)._id;
  // Zernio falla: la publicación queda igual aquí (texto, versión y redes) y se puede volver a intentar.
  ext.fail.add(`/posts/${zid}`);
  try {
    assert.equal((await owner('PUT', `/api/social-publications/${scheduled.id}`, body({ version: scheduled.version }))).statusCode, 502);
  } finally {
    ext.fail.delete(`/posts/${zid}`);
  }
  const same = (await owner('GET', `/api/social-publications/${scheduled.id}`)).json();
  assert.deepEqual([same.text, same.version, same.targets.length], [scheduled.text, scheduled.version, 3]);
  const r = await owner('PUT', `/api/social-publications/${scheduled.id}`, body({ version: scheduled.version }));
  assert.equal(r.statusCode, 200, r.body);
  const put = ext.requests.filter((x) => x.method === 'PUT' && x.path === `/api/v1/posts/${zid}`).pop()!;
  assert.equal(put.body.content, 'Nueva suite: ¡reserva ya!');
  assert.equal(put.body.isDraft, false);
  assert.equal(put.body.scheduledFor, zonedToUtc(tomorrow(), '12:00', tz).toISOString());
  assert.deepEqual(put.body.platforms.map((x: any) => x.platform), ['instagram', 'youtube']);
  assert.equal((await owner('PUT', `/api/social-publications/${scheduled.id}`, body({ version: scheduled.version }))).statusCode, 409, 'versión vieja');
  // A borrador: se queda en Zernio como borrador (no se borra: Zernio borraría también sus archivos).
  const draft = await owner('PUT', `/api/social-publications/${scheduled.id}`, body({ mode: 'draft', version: r.json().version }));
  assert.equal(draft.json().status, 'borrador');
  assert.equal(ext.requests.filter((x) => x.method === 'PUT' && x.path === `/api/v1/posts/${zid}`).pop()!.body.isDraft, true);
  assert.ok(!ext.requests.some((x) => x.method === 'DELETE' && x.path === `/api/v1/posts/${zid}`));
  // Y de borrador a "publicar ya": el mismo post de Zernio, con publishNow.
  const now = await owner('PUT', `/api/social-publications/${scheduled.id}`, body({ mode: 'now', version: draft.json().version }));
  assert.equal(now.statusCode, 200, now.body);
  assert.equal(ext.requests.filter((x) => x.method === 'PUT' && x.path === `/api/v1/posts/${zid}`).pop()!.body.publishNow, true);
});

t('rechazada por la red: se puede corregir y volver a enviar con el mismo formulario', async () => {
  const ref = crypto.randomUUID();
  const saved = zer.accounts.get('acc_pl');
  zer.accounts.delete('acc_pl');
  let first: any;
  try {
    first = await owner('POST', '/api/social-publications', { client_ref: ref, mode: 'now', text: 'Texto con error', targets: [{ social_account_id: nets.linkedin.socialId }] });
    assert.equal(first.statusCode, 409);
    assert.match(first.json().error, /desconectada/);
  } finally {
    zer.accounts.set('acc_pl', saved);
  }
  const again = await owner('POST', '/api/social-publications', { client_ref: ref, mode: 'now', text: 'Texto corregido', targets: [{ social_account_id: nets.linkedin.socialId }] });
  assert.equal(again.statusCode, 200, again.body);
  assert.deepEqual([again.json().status, again.json().text], ['publicada', 'Texto corregido']);
  assert.equal(posts().filter((x) => x.body?.content === 'Texto corregido').length, 1);
  // Una fecha que no existe no se corre al día siguiente.
  const bad = await owner('POST', '/api/social-publications', { mode: 'schedule', date: '2030-02-31', time: '10:00', text: 'x', targets: [{ social_account_id: nets.linkedin.socialId }] });
  assert.equal(bad.statusCode, 400);
});

t('cancelar: se quita de Zernio; lo publicado no se cancela', async () => {
  const r = await owner('POST', '/api/social-publications', { mode: 'schedule', date: tomorrow(), time: '18:00', text: 'Cena de gala', targets: [{ social_account_id: nets.linkedin.socialId }] });
  const zid = [...zer.publications.values()].find((x) => x.metadata?.publication_id === r.json().id)._id;
  const c = await owner('POST', `/api/social-publications/${r.json().id}/cancel`);
  assert.equal(c.json().status, 'cancelada');
  assert.ok(!zer.publications.has(zid));
  const published = (await pool.query(`SELECT id FROM social_publications WHERE status = 'publicada' LIMIT 1`)).rows[0];
  assert.equal((await owner('POST', `/api/social-publications/${published.id}/cancel`)).statusCode, 409);
});

t('webhook: enlace por red, un evento viejo no baja el estado y el de otro negocio se ignora', async () => {
  const r = await owner('POST', '/api/social-publications', { mode: 'schedule', date: tomorrow(), time: '09:00', text: 'Desayuno buffet', media: [photo], targets: [{ social_account_id: nets.instagram.socialId }, { social_account_id: nets.linkedin.socialId }] });
  const id = r.json().id;
  const zpost = [...zer.publications.values()].find((x) => x.metadata?.publication_id === id);
  const prof = [{ id: nets.instagram.profileId, externalId: h.accountId }];
  await deliver({ event: 'post.platform.published', post: { id: zpost._id }, platform: { name: 'instagram', status: 'published', publishedUrl: 'https://instagram.test/p/desayuno' }, account: { accountId: 'acc_pi' }, profiles: prof });
  // De otro negocio (externalId ajeno): no cambia nada.
  await deliver({ event: 'post.platform.failed', post: { id: zpost._id }, platform: { name: 'linkedin', status: 'failed', error: 'x' }, account: { accountId: 'acc_pl' }, profiles: [{ id: 'otro', externalId: crypto.randomUUID() }] });
  // Más viejo que lo guardado: no baja Instagram a fallida.
  await deliver({ event: 'post.platform.failed', post: { id: zpost._id }, platform: { name: 'instagram', status: 'failed', error: 'tarde' }, account: { accountId: 'acc_pi' }, profiles: prof, timestamp: new Date(Date.now() - 3600_000).toISOString() });
  await h.idle();
  const p = (await owner('GET', `/api/social-publications/${id}`)).json();
  assert.deepEqual(p.targets.map((x: any) => [x.platform, x.status, x.url]), [['instagram', 'publicada', 'https://instagram.test/p/desayuno'], ['linkedin', 'pendiente', '']]);
});

t('la revisión no se rinde: si Zernio falla al preguntarle, se vuelve a anotar', async () => {
  const r = await owner('POST', '/api/social-publications', { mode: 'schedule', date: tomorrow(), time: '21:00', text: 'Karaoke', targets: [{ social_account_id: nets.linkedin.socialId }] });
  const zid = [...zer.publications.values()].find((x) => x.metadata?.publication_id === r.json().id)._id;
  ext.fail.add(`/posts/${zid}`);
  try {
    await h.fastForward();
  } finally {
    ext.fail.delete(`/posts/${zid}`);
  }
  const job = (await pool.query(`SELECT status FROM jobs WHERE dedupe_key = $1 AND status = 'pending'`, [`social_post_check:${r.json().id}`])).rows;
  assert.equal(job.length, 1, 'quedó otra revisión anotada');
});

t('sin webhook: la revisión pregunta a Zernio cómo va', async () => {
  const r = await owner('POST', '/api/social-publications', { mode: 'schedule', date: tomorrow(), time: '20:00', text: 'Noche de jazz', targets: [{ social_account_id: nets.linkedin.socialId }] });
  const zpost = [...zer.publications.values()].find((x) => x.metadata?.publication_id === r.json().id);
  zpost.status = 'published';
  zpost.platforms = zpost.platforms.map((x: any) => ({ ...x, status: 'published', platformPostUrl: 'https://linkedin.test/p/jazz' }));
  await h.fastForward();
  const p = (await owner('GET', `/api/social-publications/${r.json().id}`)).json();
  assert.deepEqual([p.status, p.targets[0].url], ['publicada', 'https://linkedin.test/p/jazz']);
});

t('permisos y modo de prueba: el agente no publica; en sandbox solo se guardan borradores', async () => {
  assert.equal((await agent('GET', '/api/social-publications')).statusCode, 403);
  assert.equal((await agent('POST', '/api/social-publications', { mode: 'draft', text: 'x', targets: [{ social_account_id: nets.linkedin.socialId }] })).statusCode, 403);
  config.outbound.mode = 'sandbox';
  try {
    const now = await owner('POST', '/api/social-publications', { mode: 'now', text: 'Prueba', targets: [{ social_account_id: nets.linkedin.socialId }] });
    assert.equal(now.statusCode, 403);
    assert.match(now.json().error, /OUTBOUND_MODE=sandbox/);
    assert.equal((await owner('POST', '/api/social-publications', { mode: 'draft', text: 'Prueba', targets: [{ social_account_id: nets.linkedin.socialId }] })).statusCode, 200);
  } finally {
    config.outbound.mode = 'live';
  }
});

t('lista y borrado de un negocio: lo programado aparece para quitarse de Zernio', async () => {
  const list = (await owner('GET', '/api/social-publications')).json();
  assert.ok(list.items.length >= 5);
  assert.deepEqual(list.accounts.map((a: any) => a.platform).sort(), ['instagram', 'linkedin', 'youtube']);
  assert.equal(list.rules.twitter.warnAbove, 280);
  const footprint = await zernioFootprint(h.accountId);
  const pending = (await pool.query(`SELECT zernio_post_id FROM social_publications WHERE status = 'programada' AND zernio_post_id IS NOT NULL`)).rows.map((x) => x.zernio_post_id);
  assert.ok(pending.length > 0);
  assert.deepEqual(footprint.posts.sort(), pending.sort());
});
