/**
 * Ritmo de las llamadas a la API de Resend desde este proceso. Resend permite pocas por segundo por cuenta (2 por
 * omisión) y una campaña, más las respuestas de todos los negocios, pasan de eso: aquí se espacian en vez de recibir un
 * 429 y perder el correo. El ritmo es por proceso: con varias réplicas del servidor, baja RESEND_API_PER_SECOND en
 * proporción.
 */
import { config } from '../config.js';

let nextSlot = 0;

/** Espera su turno: cada llamada sale al menos 1/RESEND_API_PER_SECOND segundos después de la anterior. */
export async function resendTurn(now = Date.now()): Promise<void> {
  const gap = Math.ceil(1000 / config.emailCampaigns.apiPerSecond);
  const at = Math.max(now, nextSlot);
  nextSlot = at + gap;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/** Solo para pruebas. */
export const resetResendPace = () => { nextSlot = 0; };
