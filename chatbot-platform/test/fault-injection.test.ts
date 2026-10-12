/**
 * Fallos inyectados sobre la lógica de monitoreo real (sin Docker): base de datos caída, Evolution caído, IA sin clave o con
 * clave inválida, y un fallo que dura un solo ciclo. Miden dos cosas: falsos positivos (sin fallo no debe haber avisos ni
 * incidencias) y falsos negativos (cada fallo sostenido debe avisar en el segundo ciclo y cerrarse al recuperarse).
 * Un ciclo = una pasada de runChecks + evaluateAlerts, como la del monitor real (cada minuto).
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createHarness, dbAvailable, evo, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { config } = await import('../src/config.js');
const { setPool } = await import('../src/db.js');
const mon = await import('../src/monitor.js');
const incidents = await import('../src/observability/incidents.js');
const { journalPath } = await import('../src/observability/journal.js');

const MIN = 60_000;
const T0 = Date.now();
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-fallos-'));
const savedKey = config.openai.apiKey;
const savedGrace = mon.monitorTiming.startupGraceMs;

let h: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  if (!ok) return;
  h = await createHarness();
  // Sin el margen de arranque: el proceso de pruebas acaba de nacer y, si no, "no responde" sería solo atención.
  mon.monitorTiming.startupGraceMs = 0;
  config.monitor.backupDir = backupDir;
  // Sin salida a internet: el catálogo de modelos no responde (no es un fallo, es "no verificado").
  config.openai.baseUrl = 'http://127.0.0.1:1';
  await h.createBot();
});
after(async () => {
  config.openai.apiKey = savedKey;
  mon.monitorTiming.startupGraceMs = savedGrace;
  setPool(pool);
  if (h) await h.app.close();
  await pool.end();
});
beforeEach(async () => {
  if (!ok) return;
  evo.down = false;
  config.openai.apiKey = 'clave-de-prueba';
  setPool(pool);
  await pool.query(`DELETE FROM incidents; DELETE FROM event_logs WHERE source = 'ai'`);
  fs.rmSync(path.join(backupDir, 'status.json'), { force: true });
  fs.rmSync(journalPath(), { force: true });
  mon.resetChecksCache();
});

/** Un ciclo del monitor: mide, evalúa avisos y devuelve lo que midió. */
async function cycle(st: ReturnType<typeof mon.newAlertState>, sent: string[], minute: number) {
  const now = T0 + minute * MIN;
  const checks = await mon.runChecks(new Date(now));
  await mon.evaluateAlerts(checks, st, async (title) => void sent.push(title), now);
  return checks;
}
const check = (checks: Awaited<ReturnType<typeof mon.runChecks>>, name: string) => checks.find((c) => c.name === name)!;
/** Fallos abiertos: lo que avisa y escala. Los degradados (severidad baja) van aparte, en openDegraded. */
const openIncidents = async () => (await incidents.listIncidents()).filter((i) => i.state === 'abierto' && i.severity !== 'baja').map((i) => i.component);
const openDegraded = async () => (await incidents.listIncidents()).filter((i) => i.state === 'abierto' && i.severity === 'baja').map((i) => i.component);

t('sin fallos: cuatro ciclos seguidos sin avisos, sin incidencias y sin ningún fallo medido (falsos positivos)', async () => {
  const st = mon.newAlertState();
  const sent: string[] = [];
  for (let m = 0; m < 4; m++) {
    const checks = await cycle(st, sent, m);
    assert.deepEqual(checks.filter((c) => c.status === 'fail').map((c) => c.name), [], 'no debe haber fallos sin fallo inyectado');
  }
  assert.deepEqual(sent, []);
  assert.deepEqual(await openIncidents(), []);
});

t('un fallo que dura un solo ciclo no avisa ni abre incidencia (falso positivo evitado)', async () => {
  const st = mon.newAlertState();
  const sent: string[] = [];
  await cycle(st, sent, 0);
  evo.down = true;
  await cycle(st, sent, 1);
  evo.down = false;
  await cycle(st, sent, 2);
  await cycle(st, sent, 3);
  assert.deepEqual(sent, []);
  assert.deepEqual(await openIncidents(), []);
});

t('Evolution caído dos ciclos: aviso en el segundo, incidencia crítica, sin repetir, y recuperación al volver', async () => {
  const st = mon.newAlertState();
  const sent: string[] = [];
  await cycle(st, sent, 0);
  evo.down = true;
  const c1 = await cycle(st, sent, 1);
  assert.equal(check(c1, 'whatsapp').status, 'fail', 'Evolution caído debe medirse como fallo');
  assert.deepEqual(sent, [], 'el primer fallo no avisa');
  await cycle(st, sent, 2);
  assert.equal(sent.length, 1, 'el segundo fallo seguido avisa una vez');
  assert.match(sent[0], /WhatsApp|Evolution/);
  await cycle(st, sent, 3);
  assert.equal(sent.length, 1, 'mientras siga caído no se repite cada minuto');
  assert.deepEqual(await openIncidents(), ['whatsapp']);
  assert.equal((await incidents.listIncidents())[0].severity, 'critica');

  evo.down = false;
  await cycle(st, sent, 4);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /se recuperó/);
  assert.deepEqual(await openIncidents(), [], 'la incidencia se cierra al recuperarse');
});

t('la base de datos caída: los avisos salen aunque no se pueda escribir en la base (la incidencia no queda registrada)', async () => {
  const st = mon.newAlertState();
  const sent: string[] = [];
  await cycle(st, sent, 0);
  // Un pool a un puerto cerrado: cualquier consulta falla, como si PostgreSQL estuviera caído.
  const caida = new pg.Pool({ connectionString: 'postgres://nadie:x@127.0.0.1:1/nada', connectionTimeoutMillis: 500 });
  setPool(caida);
  try {
    const c1 = await cycle(st, sent, 1);
    assert.equal(check(c1, 'database').status, 'fail');
    await cycle(st, sent, 2);
  } finally {
    setPool(pool);
    await caida.end().catch(() => undefined);
  }
  assert.ok(sent.some((s) => /Base de datos/.test(s)), `avisos: ${sent.join(' | ')}`);
  await cycle(st, sent, 3);
  assert.ok(sent.some((s) => /Base de datos se recuperó/.test(s)), 'al volver, avisa la recuperación');
});

t('IA sin clave: fallo confirmado en el segundo ciclo, incidencia alta y aviso', async () => {
  const st = mon.newAlertState();
  const sent: string[] = [];
  config.openai.apiKey = '';
  await cycle(st, sent, 0);
  assert.equal(sent.length, 0);
  const c = await cycle(st, sent, 1);
  assert.equal(check(c, 'ai').status, 'fail');
  assert.equal(sent.length, 1);
  assert.deepEqual(await openIncidents(), ['ai']);
  assert.equal((await incidents.listIncidents())[0].severity, 'alta');
});

t('IA con clave inválida: las llamadas fallan y no hay ninguna respuesta buena, así que es un fallo (no "operativo" ni "degradado")', async () => {
  const st = mon.newAlertState();
  const sent: string[] = [];
  // Con una clave inválida cada respuesta falla: se registran errores y ninguna llamada correcta llega a ai_runs.
  for (let i = 0; i < 3; i++) {
    await pool.query(`INSERT INTO event_logs (level, source, message) VALUES ('error', 'ai', 'La IA no pudo responder tras reintentar')`);
  }
  await cycle(st, sent, 0);
  const c = await cycle(st, sent, 1);
  assert.equal(check(c, 'ai').status, 'fail', `detalle: ${check(c, 'ai').detail}`);
  assert.equal(sent.length, 1, 'debe avisar en el segundo ciclo');
  assert.deepEqual(await openIncidents(), ['ai']);
});

t('IA con errores pero también con respuestas correctas: degradado, sin aviso; se anota con severidad baja', async () => {
  const st = mon.newAlertState();
  const sent: string[] = [];
  await pool.query(`INSERT INTO ai_runs (kind, model, input_tokens, output_tokens, latency_ms, attempt) VALUES ('reply', 'modelo-prueba', 10, 10, 800, 1)`);
  for (let i = 0; i < 6; i++) {
    await pool.query(`INSERT INTO event_logs (level, source, message) VALUES ('error', 'ai', 'Error transitorio del proveedor')`);
  }
  await cycle(st, sent, 0);
  const c = await cycle(st, sent, 1);
  assert.equal(check(c, 'ai').status, 'warn', 'errores con respuestas buenas siguen siendo aviso, no caída');
  assert.deepEqual(sent, []);
  assert.ok((await openDegraded()).includes('ai'), 'el degradado de IA queda en el historial');
  assert.equal((await incidents.listIncidents())[0].severity, 'baja');
});

const writeBackupStatus = (s: Record<string, unknown>) => fs.writeFileSync(path.join(backupDir, 'status.json'), JSON.stringify(s));

t('respaldo fallido y vencido: aviso en el segundo ciclo, incidencia alta, y se cierra con un respaldo correcto', async () => {
  const st = mon.newAlertState();
  const sent: string[] = [];
  const hace2Dias = new Date(Date.now() - 48 * 3600_000).toISOString();
  writeBackupStatus({ ok: false, last_success_at: hace2Dias, error: 'pg_dump: no se pudo conectar' });
  await cycle(st, sent, 0);
  assert.equal(sent.length, 0);
  const c = await cycle(st, sent, 1);
  assert.equal(check(c, 'backup').status, 'fail');
  assert.equal(sent.length, 1);
  assert.deepEqual(await openIncidents(), ['backup']);
  assert.equal((await incidents.listIncidents())[0].severity, 'alta');

  writeBackupStatus({ ok: true, last_success_at: new Date().toISOString(), error: null });
  await cycle(st, sent, 2);
  assert.match(sent[1], /se recuperó/);
  assert.deepEqual(await openIncidents(), []);
});

t('disco casi lleno: fallo; con espacio: operativo (se inyecta el estado del disco, no se llena uno de verdad)', () => {
  const lleno = mon.checkDisk((() => ({ bavail: 1000, bsize: 4096, blocks: 100000 })) as any);
  assert.equal(lleno.status, 'fail', lleno.detail);
  assert.match(lleno.detail, /Casi sin espacio/);
  const sano = mon.checkDisk((() => ({ bavail: 10_000_000, bsize: 4096, blocks: 20_000_000 })) as any);
  assert.equal(sano.status, 'ok', sano.detail);
});

t('memoria del proceso sobre el aviso: degradado, se anota con severidad baja y no avisa', async () => {
  const antes = config.monitor.rssWarnMb;
  config.monitor.rssWarnMb = 1; // cualquier proceso real supera 1 MB
  try {
    const st = mon.newAlertState();
    const sent: string[] = [];
    await cycle(st, sent, 0);
    const c = await cycle(st, sent, 1);
    assert.equal(check(c, 'resources').status, 'warn', check(c, 'resources').detail);
    assert.deepEqual(sent, []);
    assert.ok((await openDegraded()).includes('resources'), 'el degradado de memoria queda en el historial');
    assert.equal((await incidents.listIncidents())[0].severity, 'baja');
  } finally {
    config.monitor.rssWarnMb = antes;
  }
});

t('degradado sostenido: se anota con severidad baja, no avisa y no escala aunque pase la hora', async () => {
  const antes = config.monitor.rssWarnMb;
  config.monitor.rssWarnMb = 1;
  try {
    const st = mon.newAlertState();
    const sent: string[] = [];
    await cycle(st, sent, 0);
    await cycle(st, sent, 1);
    await mon.escalateIncidents(async (title) => void sent.push(title), T0 + 5 * 3600_000);
    assert.deepEqual(sent, [], 'ni aviso al confirmarse ni escalamiento');
    assert.ok((await openDegraded()).includes('resources'), 'el degradado de memoria queda en el historial');
  } finally {
    config.monitor.rssWarnMb = antes;
  }
});

t('reinicio: no repite el aviso de un fallo que sigue, y la recuperación sí se anuncia', async () => {
  const sent: string[] = [];
  const antesDelReinicio = mon.newAlertState();
  evo.down = true;
  await cycle(antesDelReinicio, sent, 0);
  await cycle(antesDelReinicio, sent, 1);
  assert.equal(sent.length, 1, 'el primer aviso sale');
  // Reinicio: memoria nueva. El historial de la base conserva cuándo salió el aviso.
  const despuesDelReinicio = mon.newAlertState();
  await cycle(despuesDelReinicio, sent, 2);
  await cycle(despuesDelReinicio, sent, 3);
  assert.equal(sent.length, 1, 'tras reiniciar no se repite el aviso');
  evo.down = false;
  await cycle(despuesDelReinicio, sent, 4);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /se recuperó/, 'la recuperación se anuncia aunque el proceso se haya reiniciado');
});

t('base caída: lo decidido mientras no responde se anota en el diario y se vuelca al volver', async () => {
  const st = mon.newAlertState();
  const sent: string[] = [];
  await cycle(st, sent, 0);
  const caida = new pg.Pool({ connectionString: 'postgres://nadie:x@127.0.0.1:1/nada', connectionTimeoutMillis: 500 });
  setPool(caida);
  try {
    await cycle(st, sent, 1);
    await cycle(st, sent, 2);
  } finally {
    setPool(pool);
    await caida.end().catch(() => undefined);
  }
  assert.ok(fs.existsSync(journalPath()), 'la incidencia de la base queda en el diario mientras no responde');
  await cycle(st, sent, 3);
  assert.equal(fs.existsSync(journalPath()), false, 'el diario se vacía al volver la base');
  const rows = (await incidents.listIncidents()).filter((i) => i.component === 'database');
  assert.equal(rows.length, 1, 'queda una sola incidencia de la base en el historial');
  assert.equal(rows[0].state, 'resuelto', 'y se cierra al volver');
});

t('ALERT_MUTE con fecha: silencia hasta el vencimiento y después los avisos vuelven solos', async () => {
  const antes = config.monitor.alertMute;
  config.monitor.alertMute = [{ name: 'whatsapp', until: T0 + 2 * MIN + 30_000 }];
  try {
    const st = mon.newAlertState();
    const sent: string[] = [];
    await cycle(st, sent, 0);
    evo.down = true;
    await cycle(st, sent, 1);
    await cycle(st, sent, 2);
    assert.deepEqual(sent, [], 'silenciado: el fallo se registra pero no sale aviso');
    assert.ok((await openIncidents()).includes('whatsapp'), 'la incidencia sí queda en el historial');
    evo.down = false;
    await cycle(st, sent, 4);
    assert.equal(sent.length, 1, 'vencido el silencio, la recuperación sí sale');
    assert.match(sent[0], /se recuperó/);
  } finally {
    config.monitor.alertMute = antes;
    evo.down = false;
  }
});
