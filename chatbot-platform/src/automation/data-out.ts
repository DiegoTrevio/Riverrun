/**
 * Reglas que mandan datos de clientes fuera del panel (a una URL, a un correo o a un número cualquiera). Crear un webhook
 * en Integraciones pide la verificación reciente; una regla con los mismos efectos también debe pedirla, o una sesión
 * robada se lleva cada mensaje sin escribir el código. `send_conversation` no cuenta: solo llega a los webhooks de
 * Integraciones, que ya se crearon con el código.
 */
import type { Action } from './types.js';

/** A dónde manda datos cada acción de la lista («webhook:https://…», «correo:…», «número:…»), sin repetir y en orden. */
export function dataOutTargets(actions: readonly Action[]): string[] {
  const out = new Set<string>();
  for (const a of actions) {
    if (a.type === 'webhook') out.add(`webhook:${a.url}`);
    if (a.type === 'send_report') {
      for (const e of a.emails) out.add(`correo:${e}`);
      for (const p of a.phones) out.add(`número:${p.replace(/\D/g, '')}`);
    }
    if (a.type === 'alert_team') for (const p of a.phones) out.add(`número:${p.replace(/\D/g, '')}`);
  }
  return [...out].sort();
}

/** La regla nueva manda datos a algún lugar al que la anterior no los mandaba (o es nueva y manda a alguno). */
export function addsDataOut(next: readonly Action[], prev: readonly Action[] = []): boolean {
  const before = new Set(dataOutTargets(prev));
  return dataOutTargets(next).some((t) => !before.has(t));
}
