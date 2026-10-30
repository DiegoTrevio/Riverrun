/**
 * La verificación de tarjeta del registro: la cuenta nueva espera la tarjeta (en pausa, motivo `card`) y la prueba
 * gratis empieza cuando el proveedor confirma una tarjeta. Sin cobro en línea configurado no se pide tarjeta.
 */
import { billingEnabled } from './service.js';

/** ¿La cuenta nueva necesita una tarjeta para empezar su prueba? Sí, si hay cobro en línea (proveedor y planes). */
export async function cardRequired(): Promise<boolean> {
  return billingEnabled();
}
