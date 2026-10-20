/**
 * Freno de envíos reales. En OUTBOUND_MODE=sandbox (staging, pruebas) ningún mensaje, correo ni webhook sale hacia un
 * destino que no esté en OUTBOUND_SANDBOX_ALLOW. En live (producción) no cambia nada.
 *
 * Es deliberadamente simple: una lista de destinos, comparada sin ambigüedad. El simulador del panel (playground) no pasa
 * por aquí, porque nunca sale de la plataforma.
 */
import { config } from './config.js';
import type { Transport } from './engine/transport.js';

export class OutboundBlockedError extends Error {
  constructor() {
    super('Envío bloqueado: este entorno es de pruebas (OUTBOUND_MODE=sandbox) y el destino no está en OUTBOUND_SANDBOX_ALLOW.');
    this.name = 'OutboundBlockedError';
  }
}

/** Teléfonos por dígitos (+52 55… = 5255…), correos en minúsculas y URLs tal cual, sin barra final. */
export function normalizeDestination(destination: string): string {
  const v = destination.trim();
  // WhatsApp identifica a los contactos con un JID ("5215…@s.whatsapp.net"): su parte numérica es el teléfono.
  if (/@(s\.whatsapp\.net|c\.us|lid)$/i.test(v)) return v.split('@')[0].replace(/\D/g, '');
  if (/^https?:\/\//i.test(v)) return v.replace(/\/$/, '').toLowerCase();
  if (v.includes('@')) return v.toLowerCase();
  return v.replace(/\D/g, '');
}

export function outboundAllowed(destination: string | null | undefined): boolean {
  if (config.outbound.mode === 'live') return true;
  const d = normalizeDestination(destination ?? '');
  return d.length > 0 && config.outbound.allow.some((a) => normalizeDestination(a) === d);
}

export function assertOutbound(destination: string | null | undefined) {
  if (!outboundAllowed(destination)) throw new OutboundBlockedError();
}

/**
 * Credenciales de pago. En sandbox solo se aceptan claves de prueba, también para leer: una clave de producción en staging
 * podría crear cobros reales o leer facturación de clientes. En live no cambia nada.
 */
export function credentialAllowed(key: string, testPrefixes: string[]): boolean {
  if (config.outbound.mode === 'live') return true;
  return testPrefixes.some((prefix) => key.startsWith(prefix));
}

/** Envuelve un transporte: cada envío comprueba su destino antes de salir. Ninguna llamada la evita. */
export function guardTransport(t: Transport, destination: string): Transport {
  return {
    kind: t.kind,
    typingSimulation: t.typingSimulation,
    ...(t.setDispatchGuard?{setDispatchGuard:(guard:()=>Promise<void>)=>t.setDispatchGuard!(guard)}:{}),
    ...(t.startTyping?{startTyping:async()=>{assertOutbound(destination);await t.startTyping!();}}:{}),
    sendText: async (text, delay) => {
      assertOutbound(destination);
      return t.sendText(text, delay);
    },
    sendImage: async (image, caption, delay) => {
      assertOutbound(destination);
      return t.sendImage(image, caption, delay);
    },
    ...(t.sendFile
      ? {
          sendFile: async (file: Parameters<NonNullable<Transport['sendFile']>>[0], caption: string, delay: number) => {
            assertOutbound(destination);
            return t.sendFile!(file, caption, delay);
          },
        }
      : {}),
    ...(t.sendTemplate
      ? {
          sendTemplate: async (template: Parameters<NonNullable<Transport['sendTemplate']>>[0]) => {
            assertOutbound(destination);
            return t.sendTemplate!(template);
          },
        }
      : {}),
    ...(t.sendButtons
      ? {
          sendButtons: async (text: string, buttons: Parameters<NonNullable<Transport['sendButtons']>>[1], delay: number) => {
            assertOutbound(destination);
            return t.sendButtons!(text, buttons, delay);
          },
        }
      : {}),
    notify: async (number, text) => {
      assertOutbound(number);
      return t.notify(number, text);
    },
  };
}
