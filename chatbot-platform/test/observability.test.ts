/**
 * Observabilidad: estados, niveles de salud, métricas (sin datos personales) e incidencias (deduplicación, silencio,
 * escalamiento y recuperación). Las pruebas de estado y formato no necesitan base de datos; las demás sí.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { config } = await import('../src/config.js');
const { stateOf, overallState, ACTIONS } = await import('../src/observability/status.js');
const { toComponents, readinessReport, functionalReport } = await import('../src/observability/health.js');
const { renderMetrics } = await import('../src/observability/metrics.js');
const incidents = await import('../src/observability/incidents.js');
const mon = await import('../src/monitor.js');
type Check = import('../src/monitor.js').CheckResult;

const check = (name: string, status: Check['status'], detail = '', extra: Partial<Check> = {}): Check => ({ name, label: name, status, detail, ...extra });

/* ------------------------------ Estados (sin base de datos) ------------------------------ */

test('un resultado se traduce a su estado; "no verificado" se marca explícitamente', () => {
  assert.equal(stateOf(check('x', 'ok')), 'operativo');
  assert.equal(stateOf(check('x', 'warn')), 'degradado');
  assert.equal(stateOf(check('x', 'fail')), 'no_disponible');
  assert.equal(stateOf(check('x', 'na')), 'no_configurado');
  assert.equal(stateOf(check('x', 'na', '', { state: 'no_verificado' })), 'no_verificado');
});

test('la salud general ignora lo no configurado y lo no verificado, pero no lo degradado ni lo caído', () => {
  assert.equal(overallState([{ state: 'operativo' }, { state: 'no_configurado' }, { state: 'no_verificado' }]), 'operativo');
  assert.equal(overallState([{ state: 'operativo' }, { state: 'degradado' }]), 'degradado');
  assert.equal(overallState([{ state: 'degradado' }, { state: 'no_disponible' }]), 'no_disponible');
});

test('las acciones solo aparecen cuando el componente no está operativo ni sin configurar', () => {
  const comps = toComponents([check('ai', 'ok'), check('ai', 'warn', 'lento'), check('whatsapp', 'na'), check('backup', 'fail', 'vencido')]);
  assert.deepEqual(comps[0].actions, []);
  assert.deepEqual(comps[1].actions, ACTIONS.ai);
  assert.deepEqual(comps[2].actions, []); // no configurado: no es un fallo
  assert.deepEqual(comps[3].actions, ACTIONS.backup);
  assert.equal(comps[2].state, 'no_configurado');
});

test('verified es false cuando el estado es no verificado', () => {
  const [c] = toComponents([check('models', 'na', 'sin catálogo', { state: 'no_verificado' })]);
  assert.equal(c.verified, false);
  assert.equal(c.state, 'no_verificado');
});

test('la preparación devuelve 503 solo si falla la base de datos o las tareas, sin detalles', () => {
  const sano = [check('database', 'ok', 'Responde'), check('scheduler', 'ok', 'Al día')];
  assert.equal(readinessReport(sano).code, 200);
  // WhatsApp caído no tumba la preparación: el funcional lo muestra, el balanceador no reinicia nada.
  assert.equal(readinessReport([...sano, check('whatsapp', 'fail', 'No responde')]).code, 200);
  assert.equal(readinessReport([...sano, check('whatsapp', 'fail', 'No responde')]).body.status, 'ok');
  assert.equal(readinessReport([check('database', 'ok'), check('scheduler', 'fail', 'atrasadas')]).code, 503);
  const body = readinessReport([check('database', 'fail', 'contraseña rechazada: postgres://usuario:secreto@db')]).body;
  assert.ok(body.checks.every((c) => !('detail' in c)));
  assert.doesNotMatch(JSON.stringify(body), /secreto|postgres:\/\//);
});

test('el informe funcional tiene el id y el estado al principio de cada componente (lo lee ./riverrun)', () => {
  const r = functionalReport([check('whatsapp', 'fail', 'No responde')]);
  assert.equal(r.status, 'no_disponible');
  assert.equal(JSON.stringify(r.components[0]).indexOf('"id"'), 1);
  assert.ok(JSON.stringify(r.components[0]).indexOf('"state"') < JSON.stringify(r.components[0]).indexOf('"label"'));
});

test('métricas: una cifra desconocida se omite (no se publica un 0 inventado)', () => {
  const text = renderMetrics([check('queue', 'ok', '', { metrics: { jobs_pending: 2, jobs_stuck: null } })], emptyExtra());
  assert.match(text, /riverrun_check_value\{component="queue",metric="jobs_pending"\} 2/);
  assert.doesNotMatch(text, /jobs_stuck/);
});

test('métricas: no exportan teléfonos, correos, nombres ni el texto de las comprobaciones', () => {
  const sensible = 'Cliente +52 55 1234 5678 ana@ejemplo.mx, sk-or-v1-abcdef';
  const text = renderMetrics(
    [check('whatsapp_sessions', 'warn', sensible, { metrics: { channels: 3 } })],
    { ...emptyExtra(), channels: [{ type: 'whatsapp', connection: 'open', n: 3 }] },
  );
  assert.doesNotMatch(text, /55 1234|ana@|sk-or|Cliente/);
  assert.match(text, /riverrun_channels\{type="whatsapp",connection="open"\} 3/);
  assert.match(text, /riverrun_component_state\{component="whatsapp_sessions",state="degradado"\} 1/);
});

test('métricas: un valor de etiqueta que no es un identificador simple se agrupa como "otro"', () => {
  const text = renderMetrics([], { ...emptyExtra(), channels: [{ type: 'whatsapp" evil="x', connection: 'ok', n: 1 }] });
  assert.match(text, /riverrun_channels\{type="otro",connection="ok"\} 1/);
  assert.doesNotMatch(text, /evil/);
});

test('OUTBOUND_MODE con un valor desconocido impide arrancar (no se envía nada real por un typo)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/config.ts').then(() => process.exit(0), (e) => { console.error(e.message); process.exit(3); })"], {
    cwd: root,
    env: { ...process.env, OUTBOUND_MODE: 'sandboxx', RIVERRUN_ENV: 'development' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(r.status, 3, r.stderr || r.stdout);
  assert.match(r.stderr, /OUTBOUND_MODE/);
});

function emptyExtra() {
  return { incidents: {}, channels: [], ai: [], inbound: [], uptimeSeconds: 1, rssBytes: 1, pool: { total: 0, idle: 0, waiting: 0 } };
}

/* ------------------------------ Rutas y incidencias (con PostgreSQL) ------------------------------ */

let h: Awaited<ReturnType<typeof createHarness>>;
const savedToken = config.monitor.healthToken;
const savedMute = config.monitor.alertMute;
const savedEscalate = config.monitor.escalateMinutes;
const SECRET_AI_KEY = 'clave-de-ia-no-debe-salir-1234';

before(async () => {
  if (!ok) return;
  h = await createHarness();
  config.openai.apiKey = SECRET_AI_KEY;
});
after(async () => {
  config.monitor.healthToken = savedToken;
  config.monitor.alertMute = savedMute;
  config.monitor.escalateMinutes = savedEscalate;
  if (h) await h.app.close();
  await pool.end();
});
beforeEach(async () => {
  if (!ok) return;
  await pool.query('DELETE FROM incidents');
  config.monitor.alertMute = [];
  config.monitor.escalateMinutes = savedEscalate;
  mon.resetChecksCache();
});

const PROBE_TOKEN = 'token-de-sonda-prueba-7f3a9c1e5b2d8046';

t('/health/functional y /metrics no existen sin HEALTH_TOKEN (404)', async () => {
  config.monitor.healthToken = '';
  assert.equal((await h.app.inject({ method: 'GET', url: '/health/functional' })).statusCode, 404);
  assert.equal((await h.app.inject({ method: 'GET', url: '/metrics' })).statusCode, 404);
});

t('/health/functional y /metrics exigen el token: 401 sin él o con uno incorrecto', async () => {
  config.monitor.healthToken = PROBE_TOKEN;
  assert.equal((await h.app.inject({ method: 'GET', url: '/health/functional' })).statusCode, 401);
  assert.equal((await h.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer otro' } })).statusCode, 401);
  assert.equal((await h.app.inject({ method: 'GET', url: '/metrics', headers: { 'x-health-token': PROBE_TOKEN.slice(0, -1) } })).statusCode, 401);
});

t('con el token correcto, el informe funcional y las métricas responden sin filtrar la clave de IA', async () => {
  config.monitor.healthToken = PROBE_TOKEN;
  const f = await h.app.inject({ method: 'GET', url: '/health/functional', headers: { authorization: `Bearer ${PROBE_TOKEN}` } });
  assert.equal(f.statusCode, 200, f.body);
  const body = f.json();
  assert.deepEqual(body.components.map((c: any) => c.id), ['database', 'whatsapp', 'whatsapp_sessions', 'scheduler', 'ai', 'models', 'backup', 'disk', 'queue', 'resources']);
  assert.ok(body.components.every((c: any) => ['operativo', 'degradado', 'no_disponible', 'no_configurado', 'no_verificado'].includes(c.state)));
  assert.doesNotMatch(f.body, new RegExp(SECRET_AI_KEY));

  const m = await h.app.inject({ method: 'GET', url: '/metrics', headers: { 'x-health-token': PROBE_TOKEN } });
  assert.equal(m.statusCode, 200, m.body);
  assert.match(String(m.headers['content-type']), /text\/plain/);
  assert.match(m.body, /riverrun_component_state\{component="database",state="operativo"\} 1/);
  assert.match(m.body, /riverrun_db_pool_connections\{state="total"\}/);
  assert.doesNotMatch(m.body, new RegExp(SECRET_AI_KEY));
  assert.doesNotMatch(m.body, /@/);
});

t('/health/ready sigue en 200 aunque Evolution esté caído, y no nombra WhatsApp', async () => {
  const { evo } = await import('./harness.js');
  evo.down = true;
  try {
    const r = await h.app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().checks.map((c: any) => c.name), ['database', 'scheduler']);
  } finally {
    evo.down = false;
  }
});

t('la incidencia se abre una sola vez por componente y se cierra al recuperarse', async () => {
  const a = await incidents.openIncident('whatsapp', 'WhatsApp', 'No responde');
  const b = await incidents.openIncident('whatsapp', 'WhatsApp', 'Sigue sin responder');
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.id, b.id);
  const rows = await incidents.listIncidents();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].severity, 'critica');
  assert.equal(rows[0].detail, 'Sigue sin responder');
  assert.notEqual(await incidents.resolveIncident('whatsapp'), null);
  assert.equal(await incidents.resolveIncident('whatsapp'), null);
  assert.equal((await incidents.listIncidents())[0].state, 'resuelto');
});

t('las incidencias de componentes no críticos se registran como altas', async () => {
  await incidents.openIncident('backup', 'Respaldos', 'Vencido');
  assert.equal((await incidents.listIncidents())[0].severity, 'alta');
});

t('con ALERT_MUTE el fallo queda en el historial, pero no sale ningún aviso', async () => {
  config.monitor.alertMute = [{ name: 'whatsapp', until: null }];
  const sent: string[] = [];
  const send = async (title: string) => void sent.push(title);
  const down = [check('whatsapp', 'fail', 'No responde')];
  const st = mon.newAlertState();
  await mon.evaluateAlerts(down, st, send, 1_000_000);
  await mon.evaluateAlerts(down, st, send, 1_000_000 + 60_000); // segundo fallo seguido: se confirma
  assert.equal(sent.length, 0);
  assert.equal((await incidents.listIncidents())[0].state, 'abierto');
  await mon.evaluateAlerts([check('whatsapp', 'ok')], st, send, 1_000_000 + 120_000);
  assert.equal(sent.length, 0, 'tampoco avisa la recuperación');
  assert.equal((await incidents.listIncidents())[0].state, 'resuelto');
});

t('sin silencio: un aviso al confirmar la falla, otro al recuperarse, y no se repite cada minuto', async () => {
  const sent: string[] = [];
  const send = async (title: string) => void sent.push(title);
  const down = [check('backup', 'fail', 'Vencido')];
  const st = mon.newAlertState();
  for (let i = 0; i < 4; i++) await mon.evaluateAlerts(down, st, send, 1_000_000 + i * 60_000);
  assert.equal(sent.length, 1, 'un aviso para la falla confirmada, sin repetir en minutos');
  await mon.evaluateAlerts([check('backup', 'ok')], st, send, 1_000_000 + 5 * 60_000);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /se recuperó/);
});

t('escalamiento: una incidencia vieja se anuncia una sola vez, aunque se llame varias veces', async () => {
  config.monitor.escalateMinutes = 60;
  await incidents.openIncident('scheduler', 'Tareas programadas', 'Atrasadas');
  await pool.query(`UPDATE incidents SET opened_at = now() - interval '2 hours' WHERE component = 'scheduler'`);
  const sent: string[] = [];
  const send = async (title: string) => void sent.push(title);
  await mon.escalateIncidents(send);
  await mon.escalateIncidents(send);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /ESCALADO/);
});

t('escalamiento: no escala una incidencia silenciada ni una reciente', async () => {
  config.monitor.escalateMinutes = 60;
  await incidents.openIncident('scheduler', 'Tareas programadas', 'Atrasadas');
  const sent: string[] = [];
  const send = async (title: string) => void sent.push(title);
  await mon.escalateIncidents(send); // reciente: todavía no
  assert.equal(sent.length, 0);
  await pool.query(`UPDATE incidents SET opened_at = now() - interval '2 hours'`);
  config.monitor.alertMute = [{ name: 'scheduler', until: null }];
  await mon.escalateIncidents(send);
  assert.equal(sent.length, 0);
});

t('el historial de incidencias se ve solo con sesión de superadmin', async () => {
  await incidents.openIncident('disk', 'Disco', 'Lleno');
  const r = await h.authed('GET', '/api/system/incidents');
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().some((i: any) => i.component === 'disk' && i.state === 'abierto'));
  const anon = await h.app.inject({ method: 'GET', url: '/api/system/incidents' });
  assert.notEqual(anon.statusCode, 200);
});

t('la poda borra solo incidencias cerradas hace mucho; las abiertas nunca', async () => {
  await incidents.openIncident('disk', 'Disco', 'Lleno');
  await pool.query(`INSERT INTO incidents (component, severity, state, title, opened_at, last_seen_at, resolved_at)
     VALUES ('vieja', 'alta', 'resuelto', 'Vieja', now() - interval '400 days', now() - interval '400 days', now() - interval '300 days')`);
  assert.equal(await incidents.pruneIncidents(180), 1);
  const left = (await incidents.listIncidents()).map((i) => i.component);
  assert.deepEqual(left, ['disk']);
});

test('métricas de IA y canales: por modelo y tipo de canal, sin IDs;', () => {
  const text = renderMetrics([], {
    ...emptyExtra(),
    ai: [{ model: 'openai_gpt-4o-mini', runs: 3, input: 100, output: 20, cost: 0.0012, p95: 850 }],
    inbound: [{ type: 'whatsapp', silent: 1, lastAgeSeconds: 42 }, { type: 'web', silent: 0, lastAgeSeconds: null }],
  });
  assert.match(text, /riverrun_ai_runs_15m\{model="openai_gpt-4o-mini"\} 3/);
  assert.match(text, /riverrun_ai_tokens_15m\{model="openai_gpt-4o-mini",kind="input"\} 100/);
  assert.match(text, /riverrun_ai_tokens_15m\{model="openai_gpt-4o-mini",kind="output"\} 20/);
  assert.match(text, /riverrun_ai_cost_usd_15m\{model="openai_gpt-4o-mini"\} 0\.0012/);
  assert.match(text, /riverrun_ai_latency_p95_ms_15m\{model="openai_gpt-4o-mini"\} 850/);
  assert.match(text, /riverrun_channels_silent_24h\{type="whatsapp"\} 1/);
  assert.match(text, /riverrun_channel_last_inbound_age_seconds\{type="whatsapp"\} 42/);
  assert.doesNotMatch(text, /riverrun_channel_last_inbound_age_seconds\{type="web"\}/, 'sin mensajes no hay edad: no se inventa un valor');
});

test('métricas de IA: un nombre de modelo con comillas o espacios no abre otra etiqueta', () => {
  const text = renderMetrics([], { ...emptyExtra(), ai: [{ model: 'x" evil="y', runs: 1, input: 0, output: 0, cost: 0, p95: 1 }] });
  assert.match(text, /riverrun_ai_runs_15m\{model="otro"\} 1/);
  assert.doesNotMatch(text, /evil=/);
});

test('nombres de modelo con "/" o ":" (OpenRouter) se convierten en etiquetas válidas', async () => {
  const { modelLabel } = await import('../src/observability/metrics.js');
  assert.equal(modelLabel('openai/gpt-4o-mini'), 'openai_gpt-4o-mini');
  assert.equal(modelLabel('meta-llama/llama-3.1:free'), 'meta-llama_llama-3.1_free');
});

t('métricas: las consultas de IA y de canales funcionan contra la base (un error ahí no puede quedarse en silencio)', async () => {
  await pool.query(`INSERT INTO ai_runs (kind, model, input_tokens, output_tokens, latency_ms, attempt, cost_usd) VALUES ('reply', 'openai/prueba-metricas', 5, 6, 300, 1, 0.001)`);
  const { collectMetricsExtra, resetMetricsCache } = await import('../src/observability/metrics.js');
  resetMetricsCache();
  const extra = await collectMetricsExtra();
  const row = extra.ai.find((m) => m.model === 'openai_prueba-metricas');
  assert.ok(row, 'la fila reciente aparece en las métricas de IA (si la consulta fallara, la lista quedaría vacía sin error)');
  assert.equal(row.input, 5);
  assert.equal(row.output, 6);
  assert.ok(Array.isArray(extra.inbound));
  await pool.query(`DELETE FROM ai_runs WHERE model = 'openai/prueba-metricas'`);
});
