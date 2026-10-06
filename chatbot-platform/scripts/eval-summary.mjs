import { readFileSync, appendFileSync } from 'node:fs';
let text;
try {
  const r = JSON.parse(readFileSync(process.env.RIVERRUN_EVAL_USAGE_FILE || 'evals/results/usage.json', 'utf8'));
  const n = value => typeof value === 'number' && Number.isFinite(value) ? value : 'desconocido';
  text = `Evaluación OpenRouter: ${n(r.calls)} solicitudes; USD reportados: ${n(r.reported_usd)}; reserva pendiente: ${n(r.reserved_usd)}; costos desconocidos: ${n(r.unknown_cost_calls)}; detenida por límites/error: ${r.blocked === true ? 'sí' : 'no'}.\n`;
} catch { text = 'Evaluación OpenRouter sin evidencia de consumo: comprueba el resultado del paso de evaluación.\n'; }
console.log(text.trim());
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
