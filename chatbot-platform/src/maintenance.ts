/**
 * Mantenimiento periódico de la base (cada 6 h): retención de datos de los negocios y limpieza de bitácora, trabajos,
 * avisos y detalle de la IA. Todo en lotes y en una sola instancia a la vez; un paso que falla queda en la bitácora y no
 * detiene a los demás.
 */
import { config } from './config.js';
import { exclusively } from './db.js';
import { logEvent, pruneLogs } from './logs.js';
import { applyRetention } from './privacy.js';
import { pruneAiRunDetail, pruneAutomationData } from './automation/store.js';

export async function runMaintenance(): Promise<'ran' | 'locked'> {
  const r = await exclusively('maintenance', async () => {
    const steps: [string, () => Promise<unknown>][] = [
      ['Retención de datos', () => applyRetention()],
      ['Limpieza de la bitácora', () => pruneLogs(config.logRetentionDays)],
      ['Limpieza de trabajos y avisos', () => pruneAutomationData(config.logRetentionDays)],
      ['Limpieza del detalle de la IA', () => pruneAiRunDetail(config.aiRunDetailDays)],
    ];
    for (const [label, run] of steps) {
      try {
        await run();
      } catch (e: any) {
        await logEvent({ level: 'error', source: 'system', message: `${label}: ${e?.message ?? e}` }).catch(() => undefined);
      }
    }
  });
  return r.ran ? 'ran' : 'locked';
}
