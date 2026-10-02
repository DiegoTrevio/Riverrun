/** Autoregistro de empresas, asistente de configuración, WhatsApp por cliente y gasto de IA por cuenta. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { outbox } = await import('../src/mailer.js');
const { checkTrials, checkAiSpend } = await import('../src/lifecycle.js');
const { evolutionFor } = await import('../src/channels/whatsapp.js');
const { config } = await import('../src/config.js');

const signup = (body: Record<string, unknown>, ip = '10.0.0.1') =>
  h.app.inject({
    method: 'POST',
    url: '/api/signup',
    remoteAddress: ip,
    payload: { name: 'Laura Pérez', company: 'Clínica Sonrisa', business_type: 'salud', email: 'laura@sonrisa.mx', password: 'clave-laura-1', accept_terms: true, ...body },
  });
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
const as = (cookie: string) => (method: string, url: string, payload?: unknown) => h.app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
const tokenFrom = (to: string, route: string) => {
  const mail = [...outbox].reverse().find((m) => m.to === to && m.text.includes(`#/${route}?token=`));
  assert.ok(mail, `no llegó el correo (${route}) a ${to}`);
  return decodeURIComponent(mail!.text.match(new RegExp(`#/${route}\\?token=([^\\s]+)`))![1]);
};

const L = { cookie: '', account: '', api: null as unknown as ReturnType<typeof as>, channel: '', token: '', instance: '' };

before(async () => {
  if (!ok) return;
  h = await createHarness();
  h.setScript(() => ({ messages: ['¡Hola! ¿En qué te ayudo?'] }));
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

t('registro: crea la cuenta en prueba con su administradora y abre sesión', async () => {
  const info = (await h.app.inject({ method: 'GET', url: '/api/signup/info' })).json();
  assert.equal(info.enabled, true);
  assert.equal(info.trial_days, 14);
  assert.ok(info.business_types.some((b: any) => b.key === 'salud'));

  const r = await signup({});
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.account.status, 'trial');
  assert.equal(body.account.name, 'Clínica Sonrisa');
  assert.equal(body.account.business_type, 'salud');
  const days = (new Date(body.account.trial_ends_at).getTime() - Date.now()) / 86400_000;
  assert.ok(days > 13.9 && days <= 14, `prueba de 14 días (${days})`);
  assert.equal(body.user.role, 'admin');
  assert.equal(body.user.email_verified_at, null);
  assert.equal(body.verification_sent, true);
  assert.equal(body.account.owner_user_id, body.user.id);

  L.cookie = cookieOf(r);
  L.api = as(L.cookie);
  L.account = body.account.id;
  const me = (await L.api('GET', '/api/me')).json();
  assert.equal(me.user.email, 'laura@sonrisa.mx');
  assert.equal(me.account.status, 'trial');

  // El superadmin recibe el aviso de la cuenta nueva y la ve con su dueña.
  const notes = (await h.authed('GET', '/api/notifications')).json();
  assert.ok(notes.items.some((n: any) => n.title.includes('Clínica Sonrisa')));
  const accs = (await h.authed('GET', '/api/accounts')).json();
  const mine = accs.find((a: any) => a.id === L.account);
  assert.equal(mine.owner_email, 'laura@sonrisa.mx');
  assert.equal(mine.owner_verified, false);
});

t('registro: correo repetido, campo trampa, términos y límite por conexión', async () => {
  assert.equal((await signup({}, '10.0.0.2')).statusCode, 409);
  assert.equal((await signup({ email: 'bot@spam.mx', website: 'http://spam' }, '10.0.0.2')).statusCode, 400);
  assert.equal((await signup({ email: 'x@y.mx', accept_terms: false }, '10.0.0.2')).statusCode, 400);
  assert.equal((await signup({ email: 'corta@y.mx', password: '123' }, '10.0.0.2')).statusCode, 400);
  assert.equal((await signup({ email: 'z1@y.mx' }, '10.0.0.2')).statusCode, 200, 'el quinto intento aún pasa');
  assert.equal((await signup({ email: 'z9@y.mx' }, '10.0.0.2')).statusCode, 429, 'máximo 5 intentos por hora por IP');
});

t('asistente: negocio y asistente desde la plantilla del giro', async () => {
  let st = (await L.api('GET', '/api/onboarding')).json();
  assert.equal(st.complete, false);
  assert.equal(st.email_verified, false);
  assert.deepEqual(st.steps, { business: false, assistant: false, photos: false, test: false, whatsapp: false });

  const b = await L.api('POST', '/api/onboarding/business', { timezone: 'America/Monterrey', alert_phone: '+52 81 1111 2222' });
  assert.equal(b.statusCode, 200, b.body);
  assert.equal((await L.api('POST', '/api/onboarding/business', { timezone: 'Marte/Olympus' })).statusCode, 400);

  // Sin información del negocio no se puede: el bot solo responde con lo que le den.
  assert.equal((await L.api('POST', '/api/onboarding/assistant', { assistant_name: 'Sofi' })).statusCode, 400);
  const a = await L.api('POST', '/api/onboarding/assistant', {
    assistant_name: 'Sofi',
    description: 'Clínica dental familiar en Monterrey',
    knowledge: { catalog: 'Limpieza dental: $600\nResina: $900', hours: 'Lunes a viernes de 9 a 18', location: 'Av. Constitución 100, Monterrey' },
  });
  assert.equal(a.statusCode, 200, a.body);
  const bot = (await L.api('GET', `/api/chatbots/${a.json().chatbot_id}`)).json();
  assert.equal(bot.account_id, L.account);
  assert.equal(bot.active, true);
  assert.equal(bot.personality.formality, 'usted', 'la plantilla de salud trata de usted');
  assert.match(bot.personality.prompt, /Sofi.*Clínica Sonrisa/s);
  assert.ok(bot.rules.custom_rules.some((r: string) => /diagnóstic/.test(r)));
  assert.ok(bot.data_fields.some((f: any) => f.key === 'motivo'));
  const kn = (await L.api('GET', `/api/chatbots/${bot.id}/knowledge`)).json();
  assert.deepEqual(kn.map((k: any) => k.title).sort(), ['Horarios', 'Productos, servicios y precios', 'Ubicación y contacto']);

  // Repetir el paso actualiza (no duplica) el bot ni la información.
  const again = await L.api('POST', '/api/onboarding/assistant', { assistant_name: 'Sofi', knowledge: { catalog: 'Limpieza dental: $650', faq: '¿Aceptan tarjeta? Sí' } });
  assert.equal(again.json().chatbot_id, bot.id);
  const kn2 = (await L.api('GET', `/api/chatbots/${bot.id}/knowledge`)).json();
  assert.equal(kn2.find((k: any) => k.title === 'Productos, servicios y precios').content, 'Limpieza dental: $650');
  assert.equal(kn2.find((k: any) => k.title === 'Horarios').active, false, 'lo que se borra en el asistente se desactiva');
  assert.equal((await L.api('GET', '/api/chatbots')).json().length, 1);

  await L.api('POST', '/api/onboarding/step', { step: 'photos' });
  await L.api('POST', '/api/onboarding/step', { step: 'test' });
  st = (await L.api('GET', '/api/onboarding')).json();
  assert.deepEqual(st.steps, { business: true, assistant: true, photos: true, test: true, whatsapp: false });
  assert.equal(st.business.timezone, 'America/Monterrey');
  assert.equal(st.business.alert_phone, '528111112222');
  assert.equal(st.assistant.knowledge.catalog, 'Limpieza dental: $650');
});

t('correo sin confirmar: no puede conectar WhatsApp hasta abrir el enlace (de un solo uso)', async () => {
  const r = await L.api('POST', '/api/onboarding/whatsapp');
  assert.equal(r.statusCode, 403);
  assert.match(r.json().error, /Confirma tu correo/);

  const token = tokenFrom('laura@sonrisa.mx', 'verificar');
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/verify-email', payload: { token: 'x'.repeat(20) } })).statusCode, 400);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/verify-email', payload: { token } })).statusCode, 200);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/verify-email', payload: { token } })).statusCode, 400, 'el enlace no se reutiliza');
  assert.notEqual((await L.api('GET', '/api/me')).json().user.email_verified_at, null);
});

t('WhatsApp por cliente: instancia generada, sin acceso al servidor ni a la llave de Evolution', async () => {
  const r = await L.api('POST', '/api/onboarding/whatsapp');
  assert.equal(r.statusCode, 200, r.body);
  const ch = r.json();
  assert.equal(ch.type, 'whatsapp');
  assert.ok(ch.chatbot_id, 'queda asignado al bot del asistente');
  assert.match(ch.config.instance, /^acc[0-9a-f]{8}_[0-9a-f]{6}$/);
  assert.equal((await L.api('POST', '/api/onboarding/whatsapp')).json().id, ch.id, 'repetir no crea otro canal');
  L.channel = ch.id;
  L.token = ch.webhook_token;
  L.instance = ch.config.instance;

  // El cliente no puede apuntar su canal a otro servidor, otra llave ni la instancia de otra empresa.
  const put = await L.api('PUT', `/api/channels/${ch.id}`, { config: { url: 'https://atacante.example', api_key: '', instance: 'palmas', number: '5218111112222' } });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal(put.json().config.url, '');
  assert.equal(put.json().config.instance, L.instance);
  assert.equal(put.json().config.number, '5218111112222', 'los demás campos sí se guardan');
  const created = await L.api('POST', '/api/channels', { type: 'whatsapp', name: 'Otro', config: { instance: 'palmas', url: 'https://atacante.example' } });
  assert.notEqual(created.json().config.instance, 'palmas');
  assert.equal(created.json().config.url, '');
  await L.api('DELETE', `/api/channels/${created.json().id}`);

  // Solo el superadmin define otro servidor, y entonces exige su propia llave: la global nunca sale a otra URL.
  const sup = await h.authed('PUT', `/api/channels/${ch.id}`, { config: { url: 'https://evo2.example' } });
  assert.equal(sup.json().config.url, 'https://evo2.example');
  const row = (await pool.query(`SELECT * FROM channels WHERE id = $1`, [ch.id])).rows[0];
  assert.throws(() => evolutionFor(row), /no tiene API key/);
  assert.doesNotThrow(() => evolutionFor({ ...row, config: { ...row.config, api_key: 'llave-propia' } }));
  assert.doesNotThrow(() => evolutionFor({ ...row, config: { ...row.config, url: config.evolution.url } }), 'el servidor global usa la llave global');
  await h.authed('PUT', `/api/channels/${ch.id}`, { config: { url: '' } });

  // Webhooks de otra instancia se ignoran; los de la suya se atienden.
  h.token = L.token;
  h.reset();
  await h.webhook('hola', { instance: 'palmas', phone: '5218100000001' });
  await h.webhook('hola', { instance: L.instance, phone: '5218100000002' });
  await waitFor(() => h.sent.length === 1, 10_000); // la plantilla espera 5 s para agrupar mensajes
  assert.equal(h.sent[0].to, '5218100000002');
  await h.idle();
});

t('estado de conexión: el primer "open" completa el asistente; si se cae, se avisa a la cuenta', async () => {
  const send = (state: string) =>
    h.app.inject({ method: 'POST', url: `/webhook/${L.token}`, payload: { event: 'connection.update', instance: L.instance, data: { state } } });
  await send('connecting');
  await send('open');
  await waitFor(async () => (await L.api('GET', '/api/onboarding')).json().steps.whatsapp === true);
  assert.equal((await L.api('GET', '/api/onboarding')).json().complete, true);
  assert.equal((await h.authed('GET', '/api/accounts')).json().find((a: any) => a.id === L.account).whatsapp_state, 'open');

  outbox.length = 0;
  await send('close');
  await waitFor(async () => (await L.api('GET', '/api/notifications')).json().items.some((n: any) => n.title === 'Tu WhatsApp se desconectó'));
  assert.ok(outbox.some((m) => m.to === 'laura@sonrisa.mx' && /se desconectó/.test(m.subject)));
  await send('close');
  assert.equal((await L.api('GET', '/api/notifications')).json().items.filter((n: any) => n.title === 'Tu WhatsApp se desconectó').length, 1, 'un solo aviso por caída');
  await send('open');
});

t('contraseña olvidada: enlace de un solo uso que vence; la nueva contraseña cierra las otras sesiones', async () => {
  outbox.length = 0;
  const forgot = (email: string) => h.app.inject({ method: 'POST', url: '/api/forgot-password', remoteAddress: '10.0.1.1', payload: { email } });
  assert.equal((await forgot('nadie@nada.mx')).statusCode, 200, 'misma respuesta aunque el correo no exista');
  assert.equal(outbox.length, 0);
  assert.equal((await forgot('laura@sonrisa.mx')).statusCode, 200);
  const token = tokenFrom('laura@sonrisa.mx', 'restablecer');

  const reset = (body: unknown) => h.app.inject({ method: 'POST', url: '/api/reset-password', payload: body as any });
  assert.equal((await reset({ token, password: '123' })).statusCode, 400);
  assert.equal((await reset({ token, password: 'nueva-clave-99' })).statusCode, 200);
  assert.equal((await reset({ token, password: 'otra-clave-99' })).statusCode, 400, 'no se reutiliza');
  assert.equal((await L.api('GET', '/api/me')).statusCode, 401, 'la sesión anterior deja de servir');
  const login = await h.app.inject({ method: 'POST', url: '/api/login', payload: { email: 'laura@sonrisa.mx', password: 'nueva-clave-99' } });
  assert.equal(login.statusCode, 200);
  L.cookie = cookieOf(login);
  L.api = as(L.cookie);

  // Un enlace vencido no sirve.
  await forgot('laura@sonrisa.mx');
  const old = tokenFrom('laura@sonrisa.mx', 'restablecer');
  await pool.query(`UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE kind = 'reset_password' AND used_at IS NULL`);
  assert.equal((await reset({ token: old, password: 'vencida-clave-1' })).statusCode, 400);
});

t('gasto de IA: costo por llamada, por cuenta y solo de la propia cuenta', async () => {
  const runs = (await pool.query(`SELECT * FROM ai_runs WHERE account_id = $1 AND kind = 'decision'`, [L.account])).rows;
  assert.ok(runs.length >= 1);
  // gpt-4.1-mini: 100 tokens de entrada × $0.40/M + 20 de salida × $1.60/M
  assert.equal(Number(runs[0].cost_usd), 0.000072);

  // Transcripción: por minuto de audio.
  const { insertAiRun } = await import('../src/store/index.js');
  await insertAiRun({ account_id: L.account, chatbot_id: runs[0].chatbot_id, conversation_id: null, kind: 'transcription', model: 'gpt-4o-mini-transcribe', input_tokens: 0, cached_tokens: 0, output_tokens: 0, latency_ms: 1, audio_seconds: 30 });
  // Modelo con fecha: usa el precio de su prefijo más largo (gpt-4.1-mini, no gpt-4.1).
  await insertAiRun({ account_id: L.account, chatbot_id: runs[0].chatbot_id, conversation_id: null, kind: 'summary', model: 'gpt-4.1-mini-2025-04-14', input_tokens: 1_000_000, cached_tokens: 500_000, output_tokens: 0, latency_ms: 1 });
  const costs = (await pool.query(`SELECT kind, cost_usd::float AS c FROM ai_runs WHERE account_id = $1 AND kind <> 'decision' ORDER BY id`, [L.account])).rows;
  assert.deepEqual(costs.map((r) => [r.kind, r.c]), [['transcription', 0.0015], ['summary', 0.25]]);

  const mine = (await L.api('GET', '/api/usage')).json();
  assert.equal(mine.account_id, L.account);
  assert.ok(Math.abs(mine.total_usd - (0.000072 * runs.length + 0.0015 + 0.25)) < 1e-9);
  assert.ok(mine.kinds.some((k: any) => k.kind === 'transcription'));
  const other = (await L.api('GET', `/api/usage?account_id=${h.accountId || '00000000-0000-0000-0000-000000000000'}`)).json();
  assert.equal(other.account_id, L.account, 'un administrador solo ve su cuenta');

  const all = (await h.authed('GET', '/api/usage')).json();
  assert.ok(all.accounts.find((a: any) => a.id === L.account).cost_usd > 0.25);
  assert.equal((await h.authed('GET', '/api/accounts')).json().find((a: any) => a.id === L.account).ai_cost_month > 0.25, true);

  // Aviso al superadmin por gasto alto: una vez por mes.
  config.aiAlertUsdPerAccount = 0.1;
  assert.equal(await checkAiSpend(), 1);
  assert.equal(await checkAiSpend(), 0);
  config.aiAlertUsdPerAccount = 0;
  assert.ok((await h.authed('GET', '/api/notifications')).json().items.some((n: any) => n.title === 'Gasto de IA alto: Clínica Sonrisa'));

  // Precios editables por el superadmin (no por los clientes).
  assert.equal((await L.api('GET', '/api/ai-prices')).statusCode, 403);
  const p = await h.authed('PUT', '/api/ai-prices/gpt-9', { input_per_mtok: 1, output_per_mtok: 2 });
  assert.equal(Number(p.json().output_per_mtok), 2);
});

t('fin de la prueba: aviso antes, pausa al vencer (panel sí, bot no) y reactivación por el superadmin', async () => {
  outbox.length = 0;
  await pool.query(`UPDATE accounts SET trial_ends_at = now() + interval '2 days' WHERE id = $1`, [L.account]);
  assert.deepEqual(await checkTrials(), { warned: 1, paused: 0 });
  assert.deepEqual(await checkTrials(), { warned: 0, paused: 0 }, 'el aviso se manda una vez');
  assert.ok(outbox.some((m) => m.to === 'laura@sonrisa.mx' && /por terminar/.test(m.subject)));

  await pool.query(`UPDATE accounts SET trial_ends_at = now() - interval '1 minute' WHERE id = $1`, [L.account]);
  assert.deepEqual(await checkTrials(), { warned: 0, paused: 1 });
  const me = await L.api('GET', '/api/me');
  assert.equal(me.statusCode, 200, 'el panel sigue funcionando');
  assert.equal(me.json().account.status, 'paused');

  h.reset();
  h.token = L.token;
  await h.webhook('¿siguen ahí?', { instance: L.instance, phone: '5218100000003' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.service.queue.size, 0, 'cuenta pausada: no se programa respuesta');
  assert.equal(h.sent.length, 0, 'cuenta pausada: el bot no responde');
  assert.equal(h.calls.length, 0, 'ni gasta IA');

  // El cliente no puede reactivarse solo.
  assert.equal((await L.api('PUT', `/api/accounts/${L.account}`, { status: 'active' })).statusCode, 403);
  const ext = await h.authed('PUT', `/api/accounts/${L.account}`, { extend_trial_days: 7 });
  assert.equal(ext.json().status, 'trial');
  assert.ok(new Date(ext.json().trial_ends_at).getTime() > Date.now() + 6.9 * 86400_000);
  const act = await h.authed('PUT', `/api/accounts/${L.account}`, { status: 'active', plan: 'Básico' });
  assert.equal(act.json().status, 'active');
  assert.equal(act.json().plan, 'Básico');
  await h.webhook('hola de nuevo', { instance: L.instance, phone: '5218100000003' });
  await waitFor(() => h.sent.length === 1, 10_000);
  await h.idle();
});

t('registro cerrado: SIGNUP_ENABLED=false', async () => {
  config.signup.enabled = false;
  try {
    assert.equal((await signup({ email: 'cerrado@x.mx' }, '10.0.9.9')).statusCode, 404);
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/signup/info' })).json().enabled, false);
  } finally {
    config.signup.enabled = true;
  }
});
