/**
 * Correos al equipo en el idioma de cada persona (el que eligió para el panel, users.lang): registro, contraseña,
 * invitaciones, avisos de seguridad, prueba y avisos del panel. Quien usa el panel en español los recibe como siempre.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, waitFor } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { outbox } = await import('../src/mailer.js');
const { toEnglish, englishDates } = await import('../src/mail-language.js');
const { notifyUser } = await import('../src/identity/notices.js');
const { checkTrials } = await import('../src/lifecycle.js');
const { tell } = await import('../src/billing/service.js');

const PASS = 'Zq-417-Wx-418-Lm';
/** Palabras que delatan un renglón que se quedó en español. */
const SPANISH = /\b(?:Hola|tu cuenta|tu correo|contraseña|enlace|vence|prueba|asistente|cobro|pago|ignora|cuando quieras)\b/i;
const lastTo = (to: string) => [...outbox].reverse().find((m) => m.to === to);
const signup = (email: string, headers: Record<string, string>, ip: string) => h.app.inject({
  method: 'POST', url: '/api/signup', remoteAddress: ip, headers,
  payload: { name: 'Mia Lee', company: 'Sunny Nails', business_type: 'otro', email, password: PASS, accept_terms: true },
});

before(async () => {
  if (!ok) return;
  h = await createHarness();
});
after(async () => {
  if (h) await h.app.close();
  if (ok) await pool.end();
});

test('fechas y avisos del panel pasan al inglés con el mismo diccionario', async () => {
  assert.equal(englishDates('vence el 30 de noviembre de 2026.'), 'vence el November 30, 2026.');
  assert.equal(await toEnglish('⏰ Pago vencido: Ana'), '⏰ Payment past due: Ana');
  assert.equal(await toEnglish('Tu cuenta "Sunny" quedó al corriente con el plan Riverrun. Próxima renovación: 1 de diciembre de 2026.'),
    'Your account "Sunny" is up to date on the Riverrun plan. Next renewal: December 1, 2026.');
  assert.equal(await toEnglish('Hola Ana,\n\nUn texto que no está en el diccionario.'), 'Hi Ana,\n\nUn texto que no está en el diccionario.', 'lo que no conoce se queda igual, renglón por renglón');
});

t('quien se registra con el panel en inglés recibe la confirmación en inglés y su negocio atiende en inglés', async () => {
  const r = await signup('mia@sunny.test', { cookie: 'lang=en' }, '10.71.0.1');
  assert.equal(r.statusCode, 200, r.body);
  const mail = lastTo('mia@sunny.test');
  assert.ok(mail, 'salió el correo de confirmación');
  assert.equal(mail.subject, 'Confirm your email');
  assert.match(mail.text, /^Hi Mia Lee,\n\nConfirm your email/);
  assert.doesNotMatch(mail.text, SPANISH);
  const row = (await pool.query(`SELECT u.lang, a.settings->>'language' AS business FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.email = $1`, ['mia@sunny.test'])).rows[0];
  assert.deepEqual({ ...row }, { lang: 'en', business: 'en' });
  // Sin cookie, el idioma del navegador; en español, todo como siempre.
  await signup('rosa@flores.test', { 'accept-language': 'es-MX,es;q=0.9,en;q=0.5' }, '10.71.0.2');
  assert.equal(lastTo('rosa@flores.test')?.subject, 'Confirma tu correo');
  await signup('sam@shop.test', { 'accept-language': 'en-US,en;q=0.9' }, '10.71.0.3');
  assert.equal(lastTo('sam@shop.test')?.subject, 'Confirm your email');
});

t('el idioma del panel se copia a la persona y cambia el de sus correos de contraseña, seguridad y cobro', async () => {
  const acc = await h.addAccount({ name: 'Bloom', admin: { name: 'Lily', email: 'lily@bloom.test', password: PASS } });
  const api = await h.loginAs('lily@bloom.test', PASS);
  const me = await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${api.cookie}; lang=en` } });
  assert.equal(me.statusCode, 200, me.body);
  assert.equal((await pool.query(`SELECT lang FROM users WHERE email = $1`, ['lily@bloom.test'])).rows[0].lang, 'en');

  // El enlace sale en segundo plano (la respuesta es la misma exista o no la cuenta).
  await h.app.inject({ method: 'POST', url: '/api/forgot-password', remoteAddress: '10.71.1.1', payload: { email: 'lily@bloom.test' } });
  await waitFor(() => /password/i.test(lastTo('lily@bloom.test')?.subject ?? ''));
  const reset = lastTo('lily@bloom.test')!;
  assert.equal(reset.subject, 'Reset your password');
  assert.doesNotMatch(reset.text, SPANISH);

  const lily = { id: acc.admin!.id, email: 'lily@bloom.test', name: 'Lily', account_id: acc.id };
  await notifyUser(lily, 'new_device', { device: 'Chrome' });
  const notice = lastTo('lily@bloom.test')!;
  assert.equal(notice.subject, 'New sign-in to your account');
  assert.match(notice.text, /from a new device: Chrome/);
  assert.doesNotMatch(notice.text, SPANISH);

  // Un aviso de cobro (panel y correo): el correo llega traducido con el diccionario del panel.
  await tell(acc.id, 'No pudimos cobrar tu plan', 'No se pudo procesar el pago de "Bloom". Actualiza tu forma de pago en los próximos 7 días para que tu asistente siga respondiendo.');
  const billing = lastTo('lily@bloom.test')!;
  assert.equal(billing.subject, "We couldn't charge your plan");
  assert.match(billing.text, /^The payment for "Bloom" couldn't be processed/);

  // Vuelve al español: sus correos también.
  await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${api.cookie}; lang=es` } });
  await notifyUser(lily, 'password_changed');
  assert.equal(lastTo('lily@bloom.test')!.subject, 'Tu contraseña cambió');
});

t('la invitación va en el idioma de quien invita y el aviso de fin de prueba en el del dueño', async () => {
  const acc = await h.addAccount({ name: 'Peak Gym', admin: { name: 'Noah', email: 'noah@peak.test', password: PASS } });
  await pool.query(`UPDATE users SET lang = 'en' WHERE email = 'noah@peak.test'`);
  const api = await h.loginAs('noah@peak.test', PASS);
  const inv = await api('POST', '/api/invitations', { email: 'ava@peak.test', name: 'Ava', role: 'agent' });
  assert.equal(inv.statusCode, 200, inv.body);
  const invite = lastTo('ava@peak.test')!;
  assert.match(invite.subject, /invited you to “Peak Gym”/);
  assert.match(invite.text, /as an agent/);
  assert.doesNotMatch(invite.text, SPANISH);

  await pool.query(`UPDATE accounts SET status = 'trial', trial_ends_at = now() + interval '2 days', trial_warned_at = NULL, owner_user_id = (SELECT id FROM users WHERE email = 'noah@peak.test') WHERE id = $1`, [acc.id]);
  await checkTrials();
  const trial = lastTo('noah@peak.test')!;
  assert.equal(trial.subject, 'Your trial is about to end');
  assert.match(trial.text, /^Hi Noah,\n\nYour trial of "Peak Gym" ends on [A-Z][a-z]+ \d{1,2}, \d{4}/);
});
