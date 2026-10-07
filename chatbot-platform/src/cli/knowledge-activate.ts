import { config } from '../config.js';
import { migrate, pool } from '../db.js';
import { knowledgeReadiness } from '../engine/knowledge-readiness.js';

const args = process.argv.slice(2);
try {
  if (args.some((arg) => !['--apply', '--verify-provider'].includes(arg))) throw new Error('flags');
  if (args.includes('--apply')) {
    // Refuse incompatible/missing-extension servers before changing ANY application tables.
    const check = await knowledgeReadiness();
    if (!check.collation_ready || !check.postgres_version.startsWith('16.') || !(await pool.query("SELECT 1 FROM pg_available_extensions WHERE name='vector'")).rowCount) {
      console.log(JSON.stringify(check, null, 2));
      process.exitCode = 1;
    } else if (!config.knowledgeSearch.enabled || !config.openai.apiKey) {
      console.log(JSON.stringify(check, null, 2));
      process.exitCode = 1;
    } else {
      await migrate();
    }
  }
  if (!process.exitCode) {
    const result = await knowledgeReadiness({ verifyProvider: args.includes('--verify-provider') });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) process.exitCode = 1;
  }
} catch {
  console.error('No se completó la activación. Verifica DATABASE_URL, permisos de migración y argumentos (--apply, --verify-provider). No se muestra información sensible del proveedor o de la conexión.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
