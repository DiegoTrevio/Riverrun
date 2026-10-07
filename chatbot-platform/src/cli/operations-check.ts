import { pool } from '../db.js';
import { operationalStatus } from '../engine/operations.js';
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--window-minutes')) throw new Error('args');
  const result = await operationalStatus(args.length ? Number(args[1]) : 60);
  console.log(JSON.stringify(result, null, 2));
  if (!result.database_ready || (result.rollout.enabled && (!result.key_present || !result.rollout.valid || !result.knowledge.complete))) process.exitCode = 1;
} catch {
  console.error('Diagnóstico incompleto. Revisa PostgreSQL y argumentos: operations:check [--window-minutes 1..1440]. No se muestran credenciales ni mensajes de clientes.');
  process.exitCode = 1;
} finally { await pool.end(); }
