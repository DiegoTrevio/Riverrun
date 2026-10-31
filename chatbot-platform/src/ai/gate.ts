/**
 * La puerta de la IA: una cuenta en pausa (esperando tarjeta, prueba vencida, pago, disputa o a mano) o desactivada no
 * gasta IA. `accountAi` la revisa antes de cada llamada, y las rutas de IA al empezar (así responden 402 en lugar de
 * un resultado vacío). El error es `AiBudgetBlocked` con el código `ai_paused`: quien ya atrapa el presupuesto agotado
 * (el motor, la entrada de mensajes, el Copiloto) tampoco falla con esta.
 */
import { queryOne } from '../db.js';
import { AiBudgetBlocked } from './budget.js';

export function aiPausedText(reason: string): string {
  return reason === 'card' ? 'Activa tu prueba para usar la IA' : 'Tu cuenta está en pausa';
}

export async function assertAiAllowed(accountId: string): Promise<void> {
  const acc = await queryOne<{ status: string; pause_reason: string; active: boolean }>(`SELECT status, pause_reason, active FROM accounts WHERE id = $1`, [accountId]);
  if (acc && (acc.status === 'paused' || !acc.active)) throw new AiBudgetBlocked('ai_paused', aiPausedText(acc.status === 'paused' ? acc.pause_reason : ''));
}
