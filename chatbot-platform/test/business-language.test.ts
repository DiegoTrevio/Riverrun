/**
 * Idioma del negocio con sus clientes (Ajustes → Idioma con tus clientes): los mensajes fijos que el sistema le manda al
 * cliente salen en inglés para un negocio de Estados Unidos, con fechas, horas y montos en su formato. Lo que el negocio
 * escribió a mano nunca se traduce ni se pisa.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
// El arnés primero (fija la base de pruebas); el código, después, para que abra la conexión a esa base.
import { createHarness, dbAvailable, pool } from './harness.js';
const { agentForLanguage, englishAgent, ENGLISH_AGENT, langFrom, settingsForLanguage, voiceOf } = await import('../src/locale.js');
const { AccountSettingsSchema, DEFAULT_REMINDER_EN } = await import('../src/automation/types.js');
const { PersonalitySchema, RulesSchema } = await import('../src/types.js');
const { localDate, localTime } = await import('../src/automation/time.js');
const { renderTemplate } = await import('../src/automation/templates.js');
const { eventVars } = await import('../src/automation/template-vars.js');
const { confirmationText, withLink } = await import('../src/automation/agenda.js');
const { paymentVars, reminderText, DEFAULT_MESSAGES } = await import('../src/receivables/index.js');
const { formatMoney } = await import('../src/quotes/format.js');
const { planCharges } = await import('../src/quotes/accept.js');
const { keepAnsweringMessage } = await import('../src/engine/engine.js');
const { failedMessage, pendingMessage, quoteMessage, summaryMessage } = await import('../src/quotes/messages.js');
import type { Quote } from '../src/store/quotes.js';

const TZ = 'America/Los_Angeles';
const ES_RULES = RulesSchema.parse({});
const ES_PERSONALITY = PersonalitySchema.parse({});

/* ------------------------------ Sin base de datos ------------------------------ */

test('el idioma del agente decide la voz de los mensajes fijos: inglés, de tú o de usted', () => {
  assert.equal(voiceOf({ language: 'English (United States)' }), 'en');
  assert.equal(voiceOf({ language: 'inglés' }), 'en');
  assert.equal(voiceOf({ language: 'en-US' }), 'en');
  assert.equal(voiceOf({ language: 'español de México', formality: 'usted' }), 'usted');
  assert.equal(voiceOf({ language: 'español de México' }), 'tu');
  assert.equal(voiceOf(null), 'tu');
  assert.equal(voiceOf({ language: 'entusiasta' }), 'tu', '«entusiasta» no es inglés');
  assert.equal(voiceOf({ language: 'en español' }), 'tu', '«en español» tampoco');
  assert.equal(voiceOf({ language: 'en' }), 'en');
  assert.equal(langFrom('en-US,en;q=0.9'), 'en');
  assert.equal(langFrom('es-MX'), 'es');
});

test('agente en inglés: los textos de fábrica pasan al inglés y lo escrito a mano se queda', () => {
  const mine = 'Gracias, en un momento te atiende Carla.';
  const bot = englishAgent({ personality: ES_PERSONALITY, rules: { ...ES_RULES, handoff_message: mine } });
  const rules = bot.rules as Record<string, unknown>;
  assert.equal((bot.personality as Record<string, unknown>).language, 'English (United States)');
  assert.equal(rules.fallback_message, ENGLISH_AGENT.rules.fallback_message);
  assert.deepEqual(rules.handoff_keywords, ENGLISH_AGENT.rules.handoff_keywords);
  assert.equal(rules.handoff_message, mine, 'el mensaje que escribió el negocio no se toca');
  // De regreso: lo de fábrica en inglés vuelve al español; lo propio sigue igual.
  const back = agentForLanguage(bot, 'es');
  assert.equal((back.rules as Record<string, unknown>).fallback_message, ES_RULES.fallback_message);
  assert.equal((back.rules as Record<string, unknown>).handoff_message, mine);
  assert.equal((back.personality as Record<string, unknown>).language, ES_PERSONALITY.language);
});

test('bajas en inglés: STOP y START, y los textos que el negocio cambió se quedan', () => {
  const es = AccountSettingsSchema.parse({});
  const custom = { ...es, opt_out: { ...es.opt_out, resume_message: 'Bienvenido de vuelta 🌸' } };
  const en = settingsForLanguage(custom, 'en');
  assert.equal(en.language, 'en');
  assert.ok(en.opt_out.keywords.includes('stop'));
  assert.match(en.opt_out.confirm_message, /unsubscribed/);
  assert.equal(en.opt_out.resume_message, 'Bienvenido de vuelta 🌸');
  assert.match(en.consent.opt_in_message, /Reply STOP/);
  const back = settingsForLanguage(en, 'es');
  assert.deepEqual(back.opt_out.keywords, es.opt_out.keywords);
  assert.equal(back.opt_out.confirm_message, es.opt_out.confirm_message);
});

test('fechas, horas y montos con el formato de Estados Unidos', () => {
  const at = new Date('2026-11-17T17:30:00Z'); // 9:30 AM en Los Ángeles
  assert.equal(localDate(at, TZ, 'en'), 'Tuesday, November 17');
  assert.equal(localTime(at, TZ, 'en'), '9:30 AM');
  assert.equal(localTime(new Date('2026-11-17T08:05:00Z'), TZ, 'en'), '12:05 AM');
  assert.equal(localTime(new Date('2026-11-17T20:00:00Z'), TZ, 'en'), '12:00 PM');
  assert.equal(localDate(at, TZ), 'martes 17 de noviembre', 'en español, como siempre');
  assert.equal(localTime(at, TZ), '09:30');
  assert.equal(formatMoney(165000, 'USD', 'en'), '$1,650.00');
});

test('variables de cita y cotización en inglés para las plantillas del negocio', () => {
  const appointment = { starts_at: '2026-11-17T17:30:00Z', service_name: 'Haircut', kind: 'appointment' } as never;
  const contact = { name: 'Ana Ruiz', push_name: '', phone: '', data: {} } as never;
  const text = renderTemplate('Hi {{nombre}}, your {{cita.tipo}} is on {{cita.fecha}} at {{cita.hora}}.', { contact, appointment, timezone: TZ, lang: 'en' });
  assert.equal(text, 'Hi Ana, your appointment is on Tuesday, November 17 at 9:30 AM.');
  assert.equal(eventVars({ quote: { folio: 'C-7', total: '$500.00', valid_until: '2026-11-30' } } as never, TZ, 'en')['cotizacion.vigencia'], 'Monday, November 30');
});

test('confirmación, recordatorio y enlace de videollamada de una cita en inglés', () => {
  assert.equal(confirmationText({ assigned_user_name: 'Sam' }, { location: '12 Main St' }, 'en'),
    'Hi {{nombre}}, your {{cita.tipo}} for {{cita.servicio}} is booked for {{cita.fecha}} at {{cita.hora}} with {{cita.persona}}. Location: {{cita.lugar}}.');
  assert.match(confirmationText({ assigned_user_name: null }, null, 'es'), /^Hola \{\{nombre\}\}, tu \{\{cita\.tipo\}\}/);
  assert.match(withLink(DEFAULT_REMINDER_EN, { meeting_url: 'https://meet.example/x' }, 'en'), /Video call link: \{\{cita\.enlace\}\}$/);
  assert.match(withLink('Hola', { meeting_url: 'https://meet.example/x' }), /Enlace para la videollamada/);
});

test('recordatorio de pago en inglés: el texto de fábrica, el monto en dólares y cómo pagar', () => {
  const s = { message_before: '', message_due: '', message_overdue: '', payment_instructions: 'Zelle to pay@shop.example' } as never;
  const r = { payment_link: 'https://pay.example/1', reference: 'INV-9' };
  const text = reminderText('before', s, r, 'en');
  assert.match(text, /^Hi \{\{nombre\}\}, this is a reminder that your payment/);
  assert.match(text, /Pay here: \{\{pago\.link\}\}/);
  assert.match(text, /How to pay:\n\{\{pago\.instrucciones\}\}/);
  assert.match(text, /Reference: \{\{pago\.referencia\}\}/);
  assert.equal(reminderText('due', s, { payment_link: '', reference: '' }), `${DEFAULT_MESSAGES.due}\n\nCómo pagar:\n{{pago.instrucciones}}`, 'en español no cambia');
  const own = { ...(s as object), message_due: 'Tu pago vence hoy, {{nombre}}.' } as never;
  assert.match(reminderText('due', own, r, 'en'), /^Tu pago vence hoy/, 'el texto que escribió el negocio no se traduce');
  const vars = paymentVars({ concept: 'Deposit', amount_cents: 5000, currency: 'USD', due_date: '2026-11-30', payment_link: '', reference: '' }, { payment_instructions: '' }, TZ, new Date('2026-11-17T18:00:00Z'), 'en');
  assert.equal(vars['pago.monto'], '$50.00');
  assert.equal(vars['pago.vencimiento'], 'Monday, November 30');
});

test('cotización en inglés: FINAL o ESTIMATED, impuestos y vigencia en dólares', () => {
  const q = {
    folio: 'Q-12', kind: 'final', currency: 'USD', iva_rate: 0.0825, iva_min: 825, iva_max: 825, subtotal_min: 10000, subtotal_max: 10000,
    total_min: 10825, total_max: 10825, open_ended: false, has_tbd: false, valid_until: '2026-11-30',
    lines: [{ name: 'Lawn mowing', qty: 2, unit: 'pieza', price_mode: 'exact', price_min: 5000, price_max: null, iva_mode: 'plus', amount_min: 10000, amount_max: 10000 }],
  } as unknown as Quote;
  assert.equal(quoteMessage(q, 'en', 'https://x.example/q'), 'Here is your FINAL quote (no. Q-12) for $108.25 including tax, valid until November 30, 2026.\nYou can see it here: https://x.example/q');
  const summary = summaryMessage(q, 'en');
  assert.match(summary, /^This is your FINAL quote \(no\. Q-12\):/);
  assert.match(summary, /2 × Lawn mowing — \$50\.00 = \$100\.00/);
  assert.match(summary, /Tax: \$8\.25/);
  assert.match(summary, /Valid until November 30, 2026\./);
  assert.match(quoteMessage({ ...q, kind: 'approximate' } as Quote, 'en'), /ESTIMATED quote .* It's an estimate/);
  assert.match(pendingMessage('en'), /reviewing your final quote/);
  assert.match(failedMessage('en'), /preparing your quote/);
  assert.match(quoteMessage(q, 'usted'), /^Le comparto su cotización FINAL/, 'en español, igual que antes');
});

test('en inglés, «yes», «cancel» o «end» siguen siendo respuestas normales, no altas ni bajas', () => {
  const en = settingsForLanguage(AccountSettingsSchema.parse({}), 'en');
  for (const w of ['yes', 'cancel', 'end', 'quit', 'start']) {
    assert.ok(!en.opt_out.keywords.includes(w), `«${w}» no da de baja`);
    if (w !== 'start') assert.ok(!en.consent.opt_in_keywords.includes(w), `«${w}» no acepta promociones`);
  }
  assert.ok(en.opt_out.keywords.includes('stop') && en.opt_out.keywords.includes('unsubscribe'));
});

test('un agente de usted que pasa al inglés y regresa vuelve a hablar de usted', () => {
  const usted = { personality: { ...ES_PERSONALITY, formality: 'usted' as const }, rules: { ...ES_RULES, handoff_message: 'Claro, le comunico con alguien del equipo. En un momento le atienden.' } };
  const back = agentForLanguage(englishAgent(usted), 'es');
  assert.equal((back.rules as Record<string, unknown>).handoff_message, 'Claro, le comunico con alguien del equipo. En un momento le atienden.');
});

test('el plan de pagos de una cotización aceptada nombra cada cobro en el idioma del negocio', () => {
  const dep = planCharges('Q-3', 100000, { type: 'deposit', percent: 30, due_date: '2026-11-20', rest_due_date: '2026-12-20' }, 'en');
  assert.deepEqual(dep.map((c) => c.concept), ['Quote Q-3: deposit (30%)', 'Quote Q-3: balance']);
  assert.equal(dep[1].installment, '2 of 2');
  const three = planCharges('Q-3', 90000, { type: 'installments', count: 3, every: 'month', first_due: '2026-11-30' }, 'en');
  assert.equal(three[2].concept, 'Quote Q-3: payment 3 of 3');
  assert.equal(planCharges('C-1', 1000, { type: 'full', due_date: '2026-11-30' }).at(0)?.concept, 'Cotización C-1', 'en español, igual');
});

test('«sigue atendiendo» de fábrica sale en el idioma del agente', () => {
  const bot = (language: string, msg = '') => ({ personality: { ...ES_PERSONALITY, language }, rules: { ...ES_RULES, keep_answering_message: msg } }) as never;
  assert.equal(keepAnsweringMessage(bot('English (United States)')), ENGLISH_AGENT.rules.keep_answering_message);
  assert.equal(keepAnsweringMessage(bot('English (United States)', ES_RULES.keep_answering_message)), ENGLISH_AGENT.rules.keep_answering_message);
  assert.equal(keepAnsweringMessage(bot('español de México', 'Ahorita no, Carla te ayuda.')), 'Ahorita no, Carla te ayuda.');
});

/* ------------------------------ Con base de datos ------------------------------ */

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let api: Awaited<ReturnType<typeof h.loginAs>>;
let acc: string;
const PASS = 'Qw-731-Er-732-Ty';

before(async () => {
  if (!ok) return;
  h = await createHarness();
  acc = (await h.addAccount({ name: 'Sunny Nails', admin: { name: 'Mia', email: 'mia@sunny.test', password: PASS } })).id;
  api = await h.loginAs('mia@sunny.test', PASS);
});
after(async () => {
  if (h) await h.app.close();
  if (ok) await pool.end();
});

t('al elegir inglés, los ajustes y los asistentes que ya existen pasan al inglés; al volver, regresan al español', async () => {
  const created = await api('POST', '/api/chatbots', { account_id: acc, name: 'Front desk', rules: { handoff_message: 'Te paso con Mia.' } });
  assert.equal(created.statusCode, 200, created.body);
  const bot = created.json();
  const shown = (await api('GET', '/api/settings')).json();
  assert.equal(shown.language, 'es', 'de fábrica, español');
  const { ics_url, secrets_hidden, ...body } = shown;
  void ics_url; void secrets_hidden;
  const r = await api('PUT', '/api/settings', { ...body, language: 'en' });
  assert.equal(r.statusCode, 200, r.body);
  const saved = (await api('GET', '/api/settings')).json();
  assert.equal(saved.language, 'en');
  assert.ok(saved.opt_out.keywords.includes('stop'));
  const english = (await api('GET', `/api/chatbots/${bot.id}`)).json();
  assert.equal(english.personality.language, 'English (United States)');
  assert.equal(english.rules.fallback_message, ENGLISH_AGENT.rules.fallback_message);
  assert.equal(english.rules.handoff_message, 'Te paso con Mia.', 'lo escrito a mano se queda');

  // Un asistente nuevo de un negocio en inglés nace en inglés.
  const fresh = (await api('POST', '/api/chatbots', { account_id: acc, name: 'Second' })).json();
  assert.equal(fresh.personality.language, 'English (United States)');
  assert.equal(fresh.rules.unavailable_message, ENGLISH_AGENT.rules.unavailable_message);

  assert.equal((await api('PUT', '/api/settings', { language: 'es' })).statusCode, 200);
  const back = (await api('GET', `/api/chatbots/${bot.id}`)).json();
  assert.equal(back.rules.fallback_message, ES_RULES.fallback_message);
  assert.equal((await api('GET', '/api/settings')).json().opt_out.confirm_message, AccountSettingsSchema.parse({}).opt_out.confirm_message);
});

t('un idioma que no existe no se acepta', async () => {
  const r = await api('PUT', '/api/settings', { language: 'fr' });
  assert.equal(r.statusCode, 400, r.body);
});

test('cada idioma ve sus planes; si no hay de su moneda, ve todos y nunca pierde el plan que ya tiene', async () => {
  const { plansForLanguage } = await import('../src/locale.js');
  const plans = [{ key: 'mx', currency: 'MXN' }, { key: 'us', currency: 'usd' }];
  assert.deepEqual(plansForLanguage(plans, 'en').map((p) => p.key), ['us']);
  assert.deepEqual(plansForLanguage(plans, 'es').map((p) => p.key), ['mx']);
  assert.deepEqual(plansForLanguage(plans, 'en', 'mx').map((p) => p.key), ['mx', 'us'], 'conserva el plan actual');
  assert.deepEqual(plansForLanguage([plans[0]], 'en').map((p) => p.key), ['mx'], 'sin plan en dólares, ve el de pesos');
  // Solo con Mercado Pago (que cobra en pesos), el plan en dólares no se puede pagar: quien entra en inglés ve todos.
  const mpOnly = [{ key: 'mx', currency: 'MXN', providers: ['mercadopago'] }, { key: 'us', currency: 'USD', providers: [] }];
  assert.deepEqual(plansForLanguage(mpOnly, 'en').map((p) => p.key), ['mx', 'us']);
  assert.deepEqual(plansForLanguage(mpOnly, 'es').map((p) => p.key), ['mx']);
});
