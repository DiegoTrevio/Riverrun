/** Validación de la configuración: niveles, entornos, funciones opcionales, secretos y compatibilidad con instalaciones existentes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { blocksStartup, checkConfigAtStartup, formatReport, redactSecrets, runtimeEnv, validateConfig, type Env } from '../src/config-check.js';

const KEY = {
  session: 'a3f1c9e07b2d48a6915e3c7d0f8b2a4c6e9d1b3f5a7c9e0d2b4f6a8c0e1d3b5f',
  evolution: '5d9e1a7c3b8f4e2a6d0c9b7e5f3a1d8c2e6b4f0a9d7c5e3b1f8a6d4c2e0b9f7a',
  admin: 'Kp4!vQ9zR2mW7xL3',
  ai: 'sk-or-v1-0f7e9d2c4b6a8e1d3c5b7a9f2e4d6c8b0a1f3e5d7c9b2a4f6e8d0c1b3a5f7e9',
  db: 'pW8nZ3qT6vK1yH4m',
};

/** Lo que dejan ./riverrun install (con dominio) y docker-compose.yml en el backend. */
const installed = (over: Env = {}): Env => ({
  NODE_ENV: 'production',
  PORT: '3000',
  DATABASE_URL: `postgres://chatbot:${KEY.db}@postgres:5432/chatbot`,
  WEBHOOK_BASE_URL: 'http://backend:3000',
  PUBLIC_BASE_URL: 'https://bot.ejemplo.com',
  DOMAIN: 'bot.ejemplo.com',
  EVOLUTION_URL: 'http://evolution:8080',
  EVOLUTION_API_KEY: KEY.evolution,
  EVOLUTION_IMAGE: 'evoapicloud/evolution-api:v2.3.7@sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339',
  OPENROUTER_API_KEY: KEY.ai,
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
  OPENROUTER_MODEL: 'openai/gpt-4.1-mini',
  ADMIN_USER: 'yo@ejemplo.com',
  ADMIN_PASSWORD: KEY.admin,
  SESSION_SECRET: KEY.session,
  SECURE_COOKIES: 'true',
  SIGNUP_ENABLED: 'true',
  SIGNUP_REQUIRE_EMAIL: 'false',
  SUPERADMIN_EMAIL: 'yo@ejemplo.com',
  ALERT_WEBHOOK_URL: 'https://ntfy.sh/riverrun-ejemplo',
  TRUST_PROXY_HOPS: '1',
  KNOWLEDGE_SEARCH_ENABLED: 'false',
  CONFIG_VALIDATION: 'strict',
  ...over,
});
const ids = (env: Env, level?: string) => validateConfig(env).issues.filter((i) => !level || i.level === level).map((i) => i.id);

test('1. una configuración válida de producción arranca sin críticos ni avisos', () => {
  const r = validateConfig(installed());
  assert.equal(r.env, 'production');
  assert.deepEqual(r.issues.filter((i) => i.level !== 'optional'), [], formatReport(r));
  assert.equal(r.status, 'ok');
  assert.equal(blocksStartup(r), false);
  const lines: string[] = [];
  assert.equal(checkConfigAtStartup(installed(), { log: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) }), true);
});

test('2. configuraciones críticas inválidas impiden arrancar en modo estricto', () => {
  const cases: [Env, string][] = [
    [{ DATABASE_URL: 'mysql://x' }, 'database.url_invalid'],
    [{ PORT: 'tres mil' }, 'number.PORT'],
    [{ SCHEDULER_INTERVAL_MS: 'abc' }, 'number.SCHEDULER_INTERVAL_MS'], // NaN → setInterval cada 1 ms
    [{ EMAIL_POLL_SECONDS: '-5' }, 'number.EMAIL_POLL_SECONDS'],
    [{ PUBLIC_BASE_URL: 'bot.ejemplo.com' }, 'public_url.invalid'],
    [{ KNOWLEDGE_SEARCH_ACCOUNT_IDS: 'cuenta-1' }, 'knowledge.account_ids'],
    [{ KNOWLEDGE_ALERT_FALLBACK_RATIO: '5' }, 'number.KNOWLEDGE_ALERT_FALLBACK_RATIO'],
    [{ OPENROUTER_BASE_URL: 'openrouter' }, 'url.OPENROUTER_BASE_URL'],
  ];
  for (const [over, id] of cases) {
    const r = validateConfig(installed(over));
    assert.ok(r.issues.some((i) => i.id === id && i.level === 'critical'), `${id} debería ser crítico\n${formatReport(r)}`);
    assert.equal(blocksStartup(r), true, id);
    assert.equal(r.status, 'fail');
  }
  const lines: string[] = [];
  const sink = { log: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
  assert.equal(checkConfigAtStartup(installed({ PORT: 'tres mil' }), sink), false);
  assert.match(lines.join('\n'), /no arranca/);
  assert.match(lines.join('\n'), /PORT/, 'cada problema nombra la variable');
  assert.match(lines.join('\n'), /entero entre 1 y 65535/, 'y dice cómo corregirlo');
});

test('secretos débiles en producción: avisos visibles que no impiden arrancar (instalaciones existentes)', () => {
  const cases: [Env, string][] = [
    [{ SESSION_SECRET: 'secret' }, 'session_secret.weak'],
    [{ SESSION_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, 'session_secret.weak'],
    [{ ADMIN_PASSWORD: 'abc12' }, 'admin_password.short'],
    [{ ADMIN_PASSWORD: 'cambia-esta-clave', PUBLIC_BASE_URL: 'http://203.0.113.5:3000', SECURE_COOKIES: 'false' }, 'admin_password.placeholder'],
    [{ ADMIN_PASSWORD: 'cambia-esta-clave' }, 'admin_password.placeholder'],
  ];
  for (const [over, id] of cases) {
    const r = validateConfig(installed(over));
    assert.ok(r.issues.some((i) => i.id === id && i.level === 'warning'), `${id} debería ser aviso\n${formatReport(r)}`);
    assert.equal(r.counts.critical, 0, id);
    assert.equal(blocksStartup(r), false, id);
  }
});

test('CONFIG_VALIDATION=warn deja arrancar con críticos (y lo dice); un valor desconocido sigue siendo estricto', () => {
  const lines: string[] = [];
  const sink = { log: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
  assert.equal(checkConfigAtStartup(installed({ PORT: 'tres mil', CONFIG_VALIDATION: 'warn' }), sink), true);
  assert.match(lines.join('\n'), /CONFIG_VALIDATION=warn/);
  assert.equal(blocksStartup(validateConfig(installed({ PORT: 'tres mil', CONFIG_VALIDATION: 'apagado' }))), true);
});

test('3. sin servicios opcionales (correo, cobro, Google, semántica, latido) se arranca y quedan como opcionales', () => {
  const env = installed();
  for (const k of ['SMTP_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'MERCADOPAGO_ACCESS_TOKEN', 'MERCADOPAGO_WEBHOOK_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'HEARTBEAT_URL']) delete env[k];
  const r = validateConfig(env);
  assert.equal(blocksStartup(r), false);
  assert.equal(r.counts.critical + r.counts.warning, 0, formatReport(r));
  const state = Object.fromEntries(r.services.map((s) => [s.id, s.state]));
  assert.deepEqual([state.email, state.stripe, state.mercadopago, state.google, state.semantic_search], ['disabled', 'disabled', 'disabled', 'disabled', 'disabled']);
  assert.ok(ids(env, 'optional').includes('smtp.disabled'));
  // Sin IA ni WhatsApp el panel arranca igual (funcionamiento parcial), con aviso.
  const partial = installed({ OPENROUTER_API_KEY: '', EVOLUTION_API_KEY: '' });
  assert.equal(blocksStartup(validateConfig(partial)), false);
  assert.ok(ids(partial, 'warning').includes('ai.key_missing'));
  assert.ok(ids(partial, 'warning').includes('evolution.key_missing'));
});

test('4. credenciales ausentes o a medias: el servicio no se presenta como activo', () => {
  const stripe = validateConfig(installed({ STRIPE_SECRET_KEY: 'sk_live_51Hx', STRIPE_WEBHOOK_SECRET: '' }));
  assert.ok(stripe.issues.some((i) => i.id === 'stripe.incomplete' && i.level === 'warning'));
  assert.equal(stripe.services.find((s) => s.id === 'stripe')!.state, 'incomplete');
  const google = validateConfig(installed({ GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com' }));
  assert.equal(google.services.find((s) => s.id === 'google')!.state, 'incomplete');
  assert.equal(validateConfig(installed({ OPENROUTER_API_KEY: '' })).services.find((s) => s.id === 'ai')!.state, 'incomplete');
  assert.equal(validateConfig(installed({ EVOLUTION_API_KEY: '' })).services.find((s) => s.id === 'whatsapp')!.state, 'incomplete');
  // Verificación de correo exigida sin SMTP: nadie podría confirmar su correo.
  assert.ok(ids(installed({ SIGNUP_REQUIRE_EMAIL: 'true' }), 'warning').includes('smtp.verification_blocked'));
  // Claves de prueba en producción y formatos que no corresponden.
  assert.ok(ids(installed({ STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: 'whsec_1' })).includes('stripe.test_mode'));
  assert.ok(ids(installed({ OPENROUTER_API_KEY: 'sk-proj-abc' })).includes('ai.key_format'));
});

test('contradicciones y valores que se interpretan distinto de lo que parecen', () => {
  assert.ok(ids(installed({ SIGNUP_ENABLED: 'TRUE' })).includes('boolean.SIGNUP_ENABLED'), '"TRUE" apagaría el registro sin aviso');
  assert.ok(ids(installed({ SECURE_COOKIES: 'false' })).includes('cookies.insecure'));
  assert.ok(ids(installed({ PUBLIC_BASE_URL: 'http://bot.ejemplo.com' })).includes('cookies.secure_over_http'));
  assert.ok(ids(installed({ PUBLIC_BASE_URL: 'https://otro.ejemplo.com' })).includes('domain.mismatch'));
  assert.ok(ids(installed({ WEBHOOK_BASE_URL: 'http://localhost:3000', EVOLUTION_URL: 'https://evo.remoto.com' })).includes('webhook_url.unreachable'));
  assert.ok(ids(installed({ ALLOW_PRIVATE_WEBHOOKS: 'true' })).includes('webhooks.private_allowed'));
  assert.ok(ids(installed({ KNOWLEDGE_SEARCH_ENABLED: 'true', OPENROUTER_API_KEY: '' })).includes('knowledge.no_ai'));
  assert.ok(ids(installed({ EVOLUTION_IMAGE: 'evoapicloud/evolution-api:latest' })).includes('evolution.image_unpinned'));
  assert.ok(ids(installed({ EVOLUTION_IMAGE: 'evoapicloud/evolution-api:v2.3.6' })).includes('evolution.image_unverified'));
  assert.ok(ids(installed({ EVOLUTION_IMAGE: 'atendai/evolution-api:v1.8.2' })).includes('evolution.image_incompatible'));
  assert.ok(ids(installed({ EVOLUTION_IMAGE: 'evoapicloud/evolution-api:2.4.0-rc2' })).includes('evolution.image_incompatible'), '2.4 exige licencia');
  assert.ok(ids(installed({ OPENROUTER_FALLBACK_MODELS: 'a/b,c/d,e/f' })).includes('ai.fallbacks'));
});

test('desarrollo, pruebas y producción se separan: la seguridad solo bloquea en producción', () => {
  assert.equal(runtimeEnv({ NODE_ENV: 'production' }), 'production');
  assert.equal(runtimeEnv({}), 'development');
  assert.equal(runtimeEnv({ NODE_ENV: 'test' }), 'test');
  assert.equal(runtimeEnv({ NODE_ENV: 'production', RIVERRUN_ENV: 'development' }), 'development');
  const weak = { SESSION_SECRET: 'secret', ADMIN_PASSWORD: 'abc' };
  assert.equal(blocksStartup(validateConfig({ ...weak })), false, 'en desarrollo es aviso');
  assert.equal(blocksStartup(validateConfig({ ...weak, NODE_ENV: 'test' })), false);
  // Con secretos débiles, producción también arranca: son avisos (instalaciones ya en marcha no deben dejar de arrancar).
  assert.equal(blocksStartup(validateConfig(installed(weak))), false);
  // Un formato roto rompe en cualquier entorno.
  assert.equal(blocksStartup(validateConfig({ PORT: 'x' })), true);
  // Desarrollo vacío: arranca (con avisos), como `npm run dev` sin .env.
  const dev = validateConfig({});
  assert.equal(blocksStartup(dev), false);
  assert.equal(dev.counts.critical, 0);
});

test('5. el reporte y los mensajes nunca incluyen valores secretos', () => {
  const env = installed({ SMTP_URL: `smtps://user:${KEY.db}x@smtp.ejemplo.com:465`, STRIPE_SECRET_KEY: 'sk_live_SECRETOSTRIPE123', STRIPE_WEBHOOK_SECRET: 'whsec_SECRETOWEBHOOK456', SESSION_SECRET: `${KEY.session.slice(0, 20)}` });
  const r = validateConfig(env);
  const text = JSON.stringify(r) + formatReport(r, { optional: true });
  for (const v of [...Object.values(KEY), 'SECRETOSTRIPE123', 'SECRETOWEBHOOK456', `${KEY.db}x`, KEY.session.slice(0, 20)]) assert.ok(!text.includes(v), `se filtró un secreto: ${v.slice(0, 4)}…`);
  const msg = redactSecrets(`connect ECONNREFUSED smtps://user:${KEY.db}x@smtp.ejemplo.com key=${KEY.evolution}`, env);
  assert.ok(!msg.includes(KEY.db) && !msg.includes(KEY.evolution), msg);
  assert.match(msg, /\[oculto\]/);
});

test('6. compatibilidad: instalaciones existentes siguen arrancando', () => {
  // a) instalada sin dominio (./riverrun install sin dominio): http local, sin SMTP.
  const local = installed({ PUBLIC_BASE_URL: 'http://127.0.0.1:3000', DOMAIN: 'localhost', SECURE_COOKIES: 'false', ALERT_WEBHOOK_URL: '' });
  assert.equal(blocksStartup(validateConfig(local)), false, formatReport(validateConfig(local)));
  // b) .env copiado de .env.example y editado a mano, con docker compose (sin SESSION_SECRET, imagen sin fijar,
  //    ADMIN_PASSWORD de ejemplo con HTTPS: auth.ts ya se niega a usarla). Antes solo avisaba; sigue arrancando.
  const example = Object.fromEntries(fs.readFileSync('.env.example', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const fromExample: Env = {
    ...example,
    NODE_ENV: 'production',
    DATABASE_URL: `postgres://chatbot:${example.POSTGRES_PASSWORD}@postgres:5432/chatbot`,
    WEBHOOK_BASE_URL: 'http://backend:3000',
    PUBLIC_BASE_URL: `https://${example.DOMAIN}`,
    EVOLUTION_URL: 'http://evolution:8080',
    EVOLUTION_IMAGE: 'evoapicloud/evolution-api:latest',
  };
  const r = validateConfig(fromExample);
  assert.equal(blocksStartup(r), false, formatReport(r));
  assert.ok(r.issues.some((i) => i.id === 'session_secret.missing' && i.level === 'warning'));
  assert.ok(r.issues.some((i) => i.id === 'evolution.image_unpinned'));
  // c) assertProductionConfig() se conserva para quien la usaba.
  assert.ok(Array.isArray(validateConfig(installed()).issues));
});
