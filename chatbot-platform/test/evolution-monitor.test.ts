/**
 * Evolution API: versión fijada, compatibilidad detectada en tiempo real, estado de sesiones y webhooks, vigilancia
 * después de una actualización y diagnóstico del panel. Evolution aquí es simulado (test/harness.ts); la suite contra
 * Evolution real está en test/evolution-live.test.ts (scripts/evolution-compat.sh).
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createHarness, dbAvailable, evo, ext, pool } from './harness.js';
import { EVOLUTION_EXPECTED, KNOWN_VERSIONS, assessVersion, isPinned, parseImageRef, planUpgrade } from '../src/evolution/compat.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const { config } = await import('../src/config.js');
const mon = await import('../src/monitor.js');
const status = await import('../src/evolution/status.js');
const diag = await import('../src/diagnostics.js');
const { attempts } = await import('../src/channels/whatsapp-session.js');
const by = (checks: any[], name: string) => checks.find((c) => c.name === name)!;
const destructive = () => ext.requests.filter((r) => r.method === 'DELETE' || /\/instance\/(create|connect\/|logout\/|restart\/)/.test(r.path) || r.path.startsWith('/webhook/set'));

// Proveedor de IA simulado para la comprobación de la clave (/models con Authorization).
const aiSeen: string[] = [];
const aiServer = http.createServer((req, res) => {
  aiSeen.push(String(req.headers.authorization));
  res.writeHead(req.headers.authorization === 'Bearer clave-ia-valida' ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: [] }));
});
await new Promise<void>((r) => aiServer.listen(0, '127.0.0.1', r));

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot();
  config.openai.baseUrl = `http://127.0.0.1:${(aiServer.address() as any).port}/v1`;
  config.openai.apiKey = 'clave-ia-valida';
  mon.monitorTiming.startupGraceMs = 0; // el proceso de pruebas acaba de arrancar: sin margen salvo donde se prueba
});
beforeEach(async () => {
  if (!ok) return;
  status.resetEvolutionStatusCache();
  diag.resetDiagnostics();
  Object.assign(evo, { version: '2.3.7', rejectKey: false, down: false, licenseRequired: false });
  evo.instances.clear();
  evo.webhooks.clear();
  await pool.query(`DELETE FROM system_state`);
  await pool.query(`UPDATE channels SET connection_state = '', config = config - 'number' WHERE type = 'whatsapp'`);
  await pool.query(`DELETE FROM event_logs WHERE source = 'evolution'`);
});
after(async () => {
  aiServer.close();
  if (h) await h.app.close();
  await pool.end();
});

/** Instancia "palmas" existente en Evolution, conectada y con el webhook correcto. */
async function healthyInstance(state = 'open') {
  evo.instances.set('palmas', { state, qrN: 1 });
  evo.webhooks.set('palmas', { url: `http://backend:3000/webhook/${h.token}`, enabled: true, events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'] });
  await pool.query(`UPDATE channels SET connection_state = $2, config = config || '{"number":"5218111112222"}' WHERE id = $1`, [h.channelId, state]);
}

test('7. docker-compose.yml fija Evolution a la versión verificada por digest (nunca latest)', () => {
  const compose = fs.readFileSync('docker-compose.yml', 'utf8');
  const m = /x-evolution-image: &evolution-image \$\{EVOLUTION_IMAGE:-([^}]+)\}/.exec(compose);
  assert.ok(m, 'la imagen se define una sola vez con un ancla');
  assert.equal(m![1], EVOLUTION_EXPECTED.image);
  const ref = parseImageRef(m![1])!;
  assert.ok(isPinned(ref) && ref.digest && ref.tag !== 'latest');
  assert.equal(KNOWN_VERSIONS.find((k) => k.digest === ref.digest)?.status, 'verified');
  assert.match(compose, /image: \*evolution-image/);
  assert.equal((compose.match(/EVOLUTION_IMAGE: \*evolution-image/g) ?? []).length, 3, 'backend, respaldo y restauración conocen la imagen');
  assert.doesNotMatch(compose, /evolution-api:latest/);
  assert.doesNotMatch(fs.readFileSync('.env.example', 'utf8'), /^EVOLUTION_IMAGE=.*latest/m);
});

test('8. compatibilidad de versiones: incompatible, no verificada, preliminar y desconocida', () => {
  assert.equal(assessVersion('2.3.7').status, 'verified');
  assert.equal(assessVersion('v2.3.7').status, 'verified');
  assert.equal(assessVersion('1.8.7').status, 'incompatible');
  assert.equal(assessVersion('2.1.1').status, 'incompatible');
  assert.equal(assessVersion('3.0.0').status, 'incompatible');
  assert.equal(assessVersion('2.3.6').status, 'unverified');
  assert.equal(assessVersion('2.3.8').status, 'unverified');
  // Solo la RC probada (2.4.0-rc2, con licencia requerida) es incompatible. La 2.4.0 final y las demás 2.4.x no se han
  // probado: no se dan por buenas, pero tampoco se bloquean a ciegas (el monitoreo detecta LICENSE_REQUIRED en tiempo real).
  assert.equal(assessVersion('2.4.0-rc2').status, 'incompatible');
  assert.equal(assessVersion('2.4.0').status, 'unverified');
  assert.match(assessVersion('2.4.0').detail, /licencia/);
  assert.equal(assessVersion('2.4.1').status, 'unverified');
  assert.equal(assessVersion('2.5.1').status, 'unverified');
  assert.equal(assessVersion('2.4.0-rc1').status, 'unverified', 'la rc1 no se ha probado');
  assert.equal(assessVersion('3.0.0').status, 'incompatible');
  assert.equal(planUpgrade('evoapicloud/evolution-api:2.4.0-rc2', KNOWN_VERSIONS[0].lastMigration).code, 4);
  assert.equal(planUpgrade('evoapicloud/evolution-api:2.4.0', KNOWN_VERSIONS[0].lastMigration).code, 3, 'la 2.4.0 final pide confirmación con su plan');
  assert.equal(assessVersion(null).status, 'unknown');
  assert.equal(assessVersion(null).label, 'No verificada');
  // Plan de actualización: esquema hacia adelante pide confirmación; bajar de esquema se bloquea.
  assert.equal(planUpgrade(EVOLUTION_EXPECTED.image, '20250918182355_add_kafka_integration').code, 3);
  assert.equal(planUpgrade(EVOLUTION_EXPECTED.image, KNOWN_VERSIONS[0].lastMigration).code, 0);
  assert.equal(planUpgrade('evoapicloud/evolution-api:v2.3.6', KNOWN_VERSIONS[0].lastMigration).code, 4);
  assert.equal(planUpgrade('evoapicloud/evolution-api:v1.8.7', '').code, 4);
  assert.equal(planUpgrade('evoapicloud/evolution-api:latest', KNOWN_VERSIONS[0].lastMigration).schema, 'unknown');
});

t('8. el monitoreo detecta la versión real: verificada, no verificada, incompatible y sin versión', async () => {
  await healthyInstance();
  let wa = by(await mon.runChecks(), 'whatsapp');
  assert.equal(wa.status, 'ok', wa.detail);
  assert.match(wa.detail, /2\.3\.7/);
  for (const [version, expected, text] of [['2.3.8', 'warn', /no está verificada/], ['2.4.0', 'warn', /no está verificada/], ['1.8.7', 'fail', /API v2/], [null, 'warn', /no informó su versión/]] as const) {
    status.resetEvolutionStatusCache();
    evo.version = version;
    wa = by(await mon.runChecks(), 'whatsapp');
    assert.equal(wa.status, expected, `${version}: ${wa.detail}`);
    assert.match(wa.detail, text);
  }
  const snap = await status.evolutionSnapshot();
  assert.equal(snap.detected_version, null);
  assert.equal(snap.compatibility.label, 'No verificada', 'sin versión no se inventa una');
});

t('llave rechazada y Evolution caído son fallos del servicio, distintos de las sesiones', async () => {
  await healthyInstance();
  evo.rejectKey = true;
  let checks = await mon.runChecks();
  assert.equal(by(checks, 'whatsapp').status, 'fail');
  assert.match(by(checks, 'whatsapp').detail, /EVOLUTION_API_KEY/);
  evo.rejectKey = false;
  evo.down = true;
  checks = await mon.runChecks();
  assert.equal(by(checks, 'whatsapp').status, 'fail');
  assert.equal(by(checks, 'whatsapp_sessions').status, 'ok', 'una caída del servicio no duplica la alerta en las sesiones');
  // Recién arrancado el backend (p. ej. durante una actualización), Evolution puede seguir iniciando: atención, no falla.
  mon.monitorTiming.startupGraceMs = 3_600_000;
  try {
    const wa = by(await mon.runChecks(), 'whatsapp');
    assert.equal(wa.status, 'warn');
    assert.match(wa.detail, /acaba de arrancar/);
    evo.down = false;
    evo.rejectKey = true;
    assert.equal(by(await mon.runChecks(), 'whatsapp').status, 'fail', 'una llave rechazada no espera');
  } finally {
    mon.monitorTiming.startupGraceMs = 0;
    evo.rejectKey = false;
  }
});

t('Evolution 2.4 sin licencia: la raíz dice "it is working" pero no atiende la API → falla (también recién arrancado)', async () => {
  await healthyInstance();
  Object.assign(evo, { version: '2.4.0', licenseRequired: true });
  mon.monitorTiming.startupGraceMs = 3_600_000;
  try {
    const wa = by(await mon.runChecks(), 'whatsapp');
    assert.equal(wa.status, 'fail');
    assert.match(wa.detail, /licencia/);
    const s = status.lastService()!;
    assert.deepEqual([s.reachable, s.auth, s.blocked, s.version], [true, null, 'license', '2.4.0']);
    const after = status.assessAfterChange(s, null, [], '2.4.0-rc2');
    assert.equal(after.status, 'fail');
    assert.ok(after.fail.some((f) => /no atiende la API/.test(f)));
    assert.ok(!after.warn.some((w) => /configurada es/.test(w)), '2.4.0-rc2 informa 2.4.0: no es otra versión');
    const forced = await diag.refreshDiagnostics({ force: true });
    const p = forced.probes.find((x) => x.id === 'whatsapp')!;
    assert.deepEqual([p.reachable, p.functional, p.ready, p.status], [true, false, false, 'fail']);
  } finally {
    mon.monitorTiming.startupGraceMs = 0;
    evo.licenseRequired = false;
  }
});

t('verificación después de cambiar Evolution: sesiones que no vuelven, instancias perdidas y versión distinta', async () => {
  await healthyInstance();
  const s = await status.probeService({ force: true });
  let deep = await status.deepCheck();
  assert.equal(status.assessAfterChange(s, deep, ['palmas'], '2.3.7').status, 'ok');
  assert.equal(status.assessAfterChange(s, deep, ['palmas'], '2.3.6').status, 'warn', 'otra versión responde: ¿no se recreó el contenedor?');
  evo.instances.get('palmas')!.state = 'close';
  deep = await status.deepCheck();
  const none = status.assessAfterChange(s, deep, ['palmas'], '2.3.7');
  assert.equal(none.status, 'fail');
  assert.match(none.fail.join(), /Ninguna de las 1 sesiones/);
  evo.instances.delete('palmas');
  deep = await status.deepCheck();
  assert.match(status.assessAfterChange(s, deep, ['palmas'], '2.3.7').fail.join(), /ya no existen en Evolution: palmas/);
});

t('umbrales de WhatsApp ajustables: envíos fallidos y ventana tras actualizar', async () => {
  await healthyInstance();
  await status.deepCheck();
  const saved = { ...config.whatsappAlerts };
  try {
    for (let i = 0; i < 2; i++) await pool.query(`INSERT INTO event_logs (level, source, message) VALUES ('error', 'evolution', 'No se pudo enviar el mensaje (whatsapp): HTTP 500')`);
    assert.equal(by(await mon.runChecks(), 'whatsapp_sessions').status, 'ok', 'con el umbral por defecto (5), 2 envíos fallidos no avisan');
    config.whatsappAlerts.sendFailures = 2;
    assert.equal(by(await mon.runChecks(), 'whatsapp_sessions').status, 'warn', 'con el umbral en 2, sí');
    config.whatsappAlerts = { ...saved };
    // Ventana: con 1 hora, un cambio de versión de hace 2 horas ya no cuenta como "tras actualizar".
    await status.probeService({ force: true });
    evo.version = '2.3.6';
    await status.probeService({ force: true });
    evo.version = '2.3.7';
    await status.probeService({ force: true });
    await pool.query(`UPDATE system_state SET value = jsonb_set(value, '{changed_at}', to_jsonb((now() - interval '2 hours')::text)) WHERE key = 'evolution'`);
    assert.ok(await status.recentVersionChange(), 'dentro de 24 h hay cambio reciente');
    config.whatsappAlerts.postUpdateHours = 1;
    assert.equal(await status.recentVersionChange(), null, 'con una ventana de 1 h ya no');
  } finally {
    config.whatsappAlerts = { ...saved };
    evo.version = '2.3.7';
  }
});

t('sesiones: instancias vinculadas perdidas, webhooks incorrectos y fallos de entrega', async () => {
  await healthyInstance();
  await status.deepCheck();
  assert.equal(by(await mon.runChecks(), 'whatsapp_sessions').status, 'ok');

  evo.webhooks.set('palmas', { url: 'http://otro-servidor/webhook/x', enabled: true, events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'] });
  await status.deepCheck();
  let s = by(await mon.runChecks(), 'whatsapp_sessions');
  assert.equal(s.status, 'warn');
  assert.match(s.detail, /webhook/);

  evo.instances.delete('palmas');
  await status.deepCheck();
  s = by(await mon.runChecks(), 'whatsapp_sessions');
  assert.equal(s.status, 'fail', 'una sesión vinculada que desaparece es una pérdida');
  assert.match(s.detail, /no existe en Evolution/);

  // Un canal que nunca se vinculó no tiene instancia todavía: no es un problema.
  await pool.query(`UPDATE channels SET connection_state = '', config = config - 'number' WHERE id = $1`, [h.channelId]);
  await status.deepCheck();
  assert.equal(status.lastDeepCheck()!.summary.missing, 0);

  await healthyInstance();
  await status.deepCheck();
  for (let i = 0; i < 5; i++) await pool.query(`INSERT INTO event_logs (level, source, message) VALUES ('error', 'evolution', 'No se pudo enviar el mensaje (whatsapp): HTTP 500')`);
  s = by(await mon.runChecks(), 'whatsapp_sessions');
  assert.equal(s.status, 'warn');
  assert.match(s.detail, /envíos fallidos/);
});

t('12. tras cambiar de versión: se registra, las desconexiones masivas son fallo y las sesiones no se recrean solas', async () => {
  await healthyInstance();
  evo.version = '2.3.6';
  await status.probeService({ force: true });
  evo.version = '2.3.7';
  await status.probeService({ force: true });
  const change = await status.recentVersionChange();
  assert.deepEqual([change?.from, change?.to], ['2.3.6', '2.3.7']);
  const log = await pool.query(`SELECT message FROM event_logs WHERE source = 'evolution' AND message LIKE 'Evolution cambió de versión%'`);
  assert.equal(log.rowCount, 1, 'el cambio se registra una vez');
  await status.probeService({ force: true });
  assert.equal((await pool.query(`SELECT 1 FROM event_logs WHERE message LIKE 'Evolution cambió de versión%'`)).rowCount, 1);

  // Mensajes y webhooks siguen entrando después de actualizar (el webhook del canal no cambió).
  const r = await h.webhook('hola después de actualizar');
  assert.equal(r.statusCode, 200);
  await h.idle();
  assert.ok(h.sent.some((m) => m.kind === 'text'), 'el asistente respondió');

  await pool.query(`UPDATE channels SET connection_state = 'close' WHERE id = $1`, [h.channelId]);
  const s = by(await mon.runChecks(), 'whatsapp_sessions');
  assert.equal(s.status, 'fail');
  assert.match(s.detail, /desde que Evolution cambió a 2\.3\.7/);

  // La vinculación no borra ni recrea una instancia ya vinculada mientras dure la ventana posterior a la actualización.
  evo.instances.set('palmas', { state: 'connecting', qrN: 1 });
  evo.stuck.add('palmas');
  attempts.set(h.channelId, { connectAt: 0, recreateAt: 0, waitingSince: Date.now() - 60_000 });
  const before = ext.requests.length;
  const res = await h.authed('POST', `/api/channels/${h.channelId}/whatsapp/session`, {});
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().error, /no la reiniciamos automáticamente/);
  assert.equal(ext.requests.slice(before).filter((x) => x.path.startsWith('/instance/delete/') || x.path.startsWith('/instance/logout/')).length, 0, 'no se borró la sesión');
  assert.ok(evo.instances.has('palmas'));
  evo.stuck.delete('palmas');
  attempts.delete(h.channelId);
});

t('el monitoreo y el diagnóstico solo leen: nunca crean, borran, desconectan ni reconfiguran instancias', async () => {
  await healthyInstance();
  const start = ext.requests.length;
  await mon.runChecks();
  await status.deepCheck();
  await diag.refreshDiagnostics({ force: true });
  await h.authed('GET', '/api/system/diagnostics');
  const calls = ext.requests.slice(start);
  assert.ok(calls.length > 0);
  assert.deepEqual(calls.filter((r) => destructive().includes(r)), []);
  assert.ok(calls.every((r) => r.method === 'GET'), calls.map((r) => `${r.method} ${r.path}`).join(', '));
});

t('5. diagnóstico del panel: niveles por servicio, solo superadmin y sin secretos', async () => {
  await healthyInstance();
  const run = await h.authed('POST', '/api/system/diagnostics/run');
  assert.equal(run.statusCode, 200, run.body);
  const body = run.json();
  const probe = (id: string) => body.connectivity.probes.find((p: any) => p.id === id);
  assert.deepEqual(['configured', 'reachable', 'credentials', 'functional'].map((k) => probe('database')[k]), [true, true, true, true]);
  const wa = probe('whatsapp');
  assert.deepEqual([wa.configured, wa.reachable, wa.credentials, wa.functional, wa.ready], [true, true, true, true, true], wa.detail);
  assert.equal(probe('ai').credentials, true);
  assert.equal(aiSeen.at(-1), 'Bearer clave-ia-valida');
  assert.equal(probe('email').configured, false);
  assert.equal(probe('stripe').reachable, null, 'lo que no se verifica se dice "no verificado"');
  assert.equal(body.evolution.detected_version, '2.3.7');
  assert.equal(body.evolution.expected.version, EVOLUTION_EXPECTED.version);
  assert.ok(body.config.issues.every((i: any) => i.fix), 'cada problema trae cómo corregirlo');

  // Clave de IA rechazada: accesible pero credenciales inválidas (no "funciona" solo porque responde).
  config.openai.apiKey = 'clave-ia-mala';
  const bad = (await h.authed('POST', '/api/system/diagnostics/run')).json();
  assert.equal(bad.connectivity.checked_at, body.connectivity.checked_at, 'como máximo una comprobación cada 30 s');
  const forced = await diag.refreshDiagnostics({ force: true });
  const ai = forced.probes.find((p) => p.id === 'ai')!;
  assert.deepEqual([ai.reachable, ai.credentials, ai.ready, ai.status], [true, false, false, 'fail']);
  config.openai.apiKey = 'clave-ia-valida';

  const text = JSON.stringify((await h.authed('GET', '/api/system/diagnostics')).json());
  for (const secret of [config.evolution.apiKey, config.sessionSecret, config.adminPassword, 'clave-ia-valida', 'clave-ia-mala', process.env.DATABASE_URL!]) {
    assert.ok(!text.includes(secret), `el diagnóstico expone un secreto (${secret.slice(0, 4)}…)`);
  }
  assert.ok(!text.includes(h.token), 'tampoco el token del webhook');

  const r = await h.authed('POST', '/api/accounts', { name: 'Cliente', admin: { name: 'Dueño', email: 'dueno@cliente.mx', password: 'clave-segura-1' } });
  assert.equal(r.statusCode, 200, r.body);
  const client = await h.loginAs('dueno@cliente.mx', 'clave-segura-1');
  assert.equal((await client('GET', '/api/system/diagnostics')).statusCode, 403);
  assert.equal((await client('POST', '/api/system/diagnostics/run')).statusCode, 403);
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/system/diagnostics' })).statusCode, 401);
});
