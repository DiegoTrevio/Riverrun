/**
 * «Confirmar y seguir»: un pedido de varios pasos («crea el agente, ponle preguntas y hazle un flujo») se detiene en la
 * primera propuesta, porque lo que sigue necesita lo que se crea al confirmar. Si el Copiloto anotó lo que faltaba
 * (`seguir_al_confirmar`), al confirmar la última propuesta de ese pedido arranca solo un pedido de continuación: sin
 * texto nuevo, con el resultado de lo confirmado en el historial y con los mismos límites que un pedido escrito.
 *
 * Nunca sigue solo después de descartar, de un error o de deshacer; ni si hay otro pedido más nuevo o en curso; ni más
 * allá de `COPILOT_MAX_CONTINUATIONS` continuaciones seguidas.
 */
import { config } from '../config.js';
import type { User } from '../types.js';
import { turnAllowance } from './allowance.js';
import { startTurnInBackground, type RunnerDeps } from './runner.js';
import * as cs from './store.js';

export async function maybeContinue(deps: RunnerDeps, o: { action: cs.Action; user: User; cookie: string; ip?: string }): Promise<cs.Turn | null> {
  const { action, user } = o;
  if (action.status !== 'done' || action.user_id !== user.id) return null;
  const parent = await cs.getTurn(action.turn_id);
  if (!parent || !parent.continue_plan || parent.status !== 'done') return null;
  // Solo el último pedido de la conversación: si la persona ya pidió otra cosa, eso manda.
  if ((await cs.currentTurn(parent.thread_id))?.id !== parent.id) return null;
  // Sigue al confirmar la última propuesta pendiente de ese pedido, no la primera.
  if ((await cs.pendingProposals(parent.id)) > 0) return null;
  if (parent.chain_depth >= config.copilot.maxContinuations) return null;
  const thread = await cs.ownThread(parent.thread_id, user.id, parent.account_id);
  if (!thread) return null;
  let maxUsd: number | undefined;
  try {
    ({ maxUsd } = await turnAllowance(user.id, parent.account_id));
  } catch (e: any) {
    await cs.addMessage({ thread_id: thread.id, turn_id: parent.id, role: 'event', content: `No seguí solo: ${e?.message ?? 'se llegó a un límite'}. Escríbeme «sigue» cuando quieras.` });
    return null;
  }
  // Otro pedido en curso (índice único): no se encima.
  const turn = await cs.startTurn(thread, parent.page, config.copilot.model, { parent });
  if (!turn) return null;
  void startTurnInBackground(deps, { thread, turn, user, cookie: o.cookie, ip: o.ip, refs: [action.id], maxUsd, continuation: { plan: parent.continue_plan } });
  return turn;
}
