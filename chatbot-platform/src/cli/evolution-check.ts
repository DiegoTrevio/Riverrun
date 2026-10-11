/**
 * Evolution API desde la terminal (lo usa ./riverrun update; también sirve a mano):
 *
 *   evolution-check plan --target <imagen> [--db-migration <última migración aplicada>]
 *       Compatibilidad de la versión destino y efecto sobre el esquema. No se conecta a nada.
 *       Salida: 0 = sin riesgo de esquema · 3 = requiere confirmación · 4 = bloqueado.
 *   evolution-check status [--json]
 *       Servicio, versión, sesiones y webhooks ahora mismo (solo lecturas).
 *   evolution-check verify [--previous-open inst1,inst2] [--wait 120] [--json]
 *       Después de actualizar: espera a que Evolution responda con la versión configurada y a que las sesiones que
 *       estaban abiertas vuelvan. Salida: 0 = bien · 1 = funciona con avisos · 2 = falló.
 *
 * Nunca crea, borra, desconecta ni recrea instancias. No muestra claves.
 */
import { config } from '../config.js';
import { pool } from '../db.js';
import { assessVersion, imageVersion, parseImageRef, planUpgrade } from '../evolution/compat.js';
import { assessAfterChange, deepCheck, evolutionSnapshot, probeService, type DeepCheck, type EvolutionService } from '../evolution/status.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name: string, def = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const json = argv.includes('--json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const evaluate = (s: EvolutionService, deep: DeepCheck | null, previousOpen: string[]) => assessAfterChange(s, deep, previousOpen, imageVersion(parseImageRef(config.evolution.image)));

function print(lines: string[]) {
  for (const l of lines) console.log(l);
}

async function main() {
  if (cmd === 'plan') {
    const target = opt('target');
    if (!target) throw new Error('Falta --target <imagen>');
    const plan = planUpgrade(target, opt('db-migration'));
    if (json) console.log(JSON.stringify(plan, null, 2));
    else print(plan.lines.map((l) => `  ${l}`));
    return plan.code;
  }
  if (cmd === 'status') {
    const s = await probeService({ force: true });
    const deep = s.reachable && s.auth !== false ? await deepCheck() : null;
    const snap = await evolutionSnapshot();
    const r = evaluate(s, deep, []);
    if (json) console.log(JSON.stringify({ ...snap, result: r }, null, 2));
    else {
      print([
        `  Imagen configurada: ${snap.configured_image ?? '(por defecto)'}${snap.pinned === false ? ' — NO fijada' : ''}`,
        `  Versión esperada:   ${snap.expected.version}`,
        `  Versión detectada:  ${s.version ?? 'No verificada'} (${s.assessment.label})`,
        `  Servicio:           ${s.reachable ? 'responde' : 'no responde'}${s.auth === false ? ', llave rechazada' : s.auth ? ', llave aceptada' : ''}`,
        deep ? `  Sesiones:           ${deep.summary.open} abiertas, ${deep.summary.connecting} conectando, ${deep.summary.closed} cerradas, ${deep.summary.missing} perdidas (de ${deep.summary.total})` : '  Sesiones:           no revisadas',
        ...r.fail.map((x) => `  ✕ ${x}`),
        ...r.warn.map((x) => `  ! ${x}`),
      ]);
    }
    return r.status === 'fail' ? 2 : r.status === 'warn' ? 1 : 0;
  }
  if (cmd === 'verify') {
    const previousOpen = opt('previous-open').split(',').map((s) => s.trim()).filter(Boolean);
    const deadline = Date.now() + Math.max(0, Number(opt('wait', '120')) || 0) * 1000;
    let s: EvolutionService;
    let deep: DeepCheck | null = null;
    let r: ReturnType<typeof evaluate>;
    for (;;) {
      s = await probeService({ force: true });
      deep = s.reachable && s.auth !== false ? await deepCheck().catch(() => null) : null;
      r = evaluate(s, deep, previousOpen);
      // Se espera mientras Evolution arranca (aplica migraciones) y las sesiones se reconectan.
      const settled = r.status === 'ok' || (s.reachable && s.auth === false) || !!s.blocked || s.assessment.status === 'incompatible';
      if (settled || Date.now() >= deadline) break;
      await sleep(5000);
    }
    if (json) console.log(JSON.stringify({ version: s.version, assessment: s.assessment, sessions: deep?.summary ?? null, ...r }, null, 2));
    else print([`  Evolution ${s.version ?? '(versión no verificada)'} — ${assessVersion(s.version).label}`, ...r.fail.map((x) => `  ✕ ${x}`), ...r.warn.map((x) => `  ! ${x}`), ...(r.status === 'ok' ? ['  ✓ Servicio, versión y sesiones correctos'] : [])]);
    return r.status === 'fail' ? 2 : r.status === 'warn' ? 1 : 0;
  }
  console.error('Uso: evolution-check plan --target <imagen> [--db-migration <nombre>] | status [--json] | verify [--previous-open a,b] [--wait 120] [--json]');
  return 64;
}

try {
  process.exitCode = await main();
} catch (e: any) {
  console.error(`No se pudo completar la revisión de Evolution: ${e?.message ?? e}`);
  process.exitCode = 2;
} finally {
  await pool.end().catch(() => undefined);
}
