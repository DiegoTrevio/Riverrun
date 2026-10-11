/**
 * Revisa la configuración sin arrancar el servidor (no se conecta a nada ni muestra valores).
 *   npm run config:check [-- --json] [-- --all]
 *   docker compose run --rm --no-deps backend node dist/cli/config-check.js
 * Salida: 0 = puede arrancar · 2 = hay problemas críticos que impedirían el arranque.
 */
import { blocksStartup, formatReport, validateConfig } from '../config-check.js';

const args = new Set(process.argv.slice(2));
const report = validateConfig(process.env);
if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
else console.log(formatReport(report, { optional: args.has('--all') }));
process.exitCode = blocksStartup(report) ? 2 : 0;
