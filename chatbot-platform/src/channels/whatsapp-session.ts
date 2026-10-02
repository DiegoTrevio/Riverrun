/**
 * Sesión de conexión de WhatsApp: lo que el panel pide cada pocos segundos mientras la persona vincula su teléfono.
 * Crea la instancia al instante, mantiene un QR vigente (sin reiniciar la vinculación en cada consulta),
 * ofrece el código para "Vincular con número de teléfono" y se recupera sola si la instancia quedó trabada.
 */
import { recordConnectionState } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import type { Channel } from '../types.js';
import { webhookUrl } from './index.js';
import { evolutionFor } from './whatsapp.js';

/** Vida útil de un QR de WhatsApp (se renueva antes de que venza). */
export const QR_TTL_S = 30;
/** El código de vinculación por número dura más (la persona lo teclea). */
export const CODE_TTL_S = 120;

export interface SessionResult {
  state: 'open' | 'connecting';
  qr: string | null;
  pairingCode: string | null;
  /** Segundos que le quedan al QR o al código mostrado. */
  expires_in: number;
  profile?: { number: string; name: string } | null;
  /** Aviso no bloqueante (p.ej. el número ya está conectado en otro canal de la cuenta). */
  warning?: string;
  /** Todavía no hay código: se está generando. */
  preparing?: boolean;
  /** Segundos esperando un código (para avisar si tarda demasiado). */
  waited_s?: number;
}

export class SessionError extends Error {}

/** Cada cuánto, como máximo, se pide a Evolution una vinculación nueva mientras no hay código. */
export const CONNECT_EVERY_MS = 15_000;
/** Tiempo sin código a partir del cual la instancia se considera trabada y se recrea. */
export const STUCK_AFTER_MS = 45_000;
/** Como máximo una recreación cada 2 minutos por canal. */
export const RECREATE_EVERY_MS = 120_000;

/** Intentos en curso por canal (en memoria: el backend corre en un solo proceso). */
export const attempts = new Map<string, { connectAt: number; recreateAt: number; waitingSince: number }>();

/** Aún no hay código: el panel muestra "preparando" y vuelve a consultar. */
const preparing = (waitedMs: number): SessionResult => ({ state: 'connecting', qr: null, pairingCode: null, expires_in: 0, preparing: true, waited_s: Math.round(waitedMs / 1000) });

/** Número para vincular: solo dígitos, con lada de país (10 dígitos = México, se agrega 52). */
export function normalizePairingNumber(raw: string): string {
  let d = raw.replace(/\D/g, '');
  if (d.length === 10) d = `52${d}`;
  if (d.length < 11 || d.length > 15) throw new SessionError('Escribe tu número de WhatsApp con lada de país, por ejemplo 52 81 1234 5678.');
  return d;
}

const ageS = (at: Date | null | undefined) => (at ? (Date.now() - new Date(at).getTime()) / 1000 : Infinity);
const dataUrl = (b64: string) => (b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`);

/** Errores de Evolution → mensaje entendible (el detalle técnico queda en Registros). */
async function friendly(ch: Channel, e: any): Promise<never> {
  if (e instanceof SessionError) throw e;
  await logEvent({ level: 'error', source: 'evolution', message: `Conexión de WhatsApp: ${e?.message ?? e}`, accountId: ch.account_id, channelId: ch.id });
  const status = e?.status as number | undefined;
  if (!status || status >= 500) throw new SessionError('No pudimos comunicarnos con el servidor de WhatsApp. Intenta de nuevo en unos segundos.');
  throw new SessionError('WhatsApp no aceptó la solicitud. Vuelve a intentarlo; si sigue fallando, avísanos.');
}

export async function whatsappSession(ch: Channel, o: { mode: 'qr' | 'code'; number?: string; refresh?: boolean }): Promise<SessionResult> {
  const instance = ch.config.instance;
  const evo = evolutionFor(ch);
  const number = o.mode === 'code' ? normalizePairingNumber(o.number ?? '') : '';

  try {
    let state = 'not_found';
    try {
      state = await evo.connectionState(instance);
    } catch (e: any) {
      if (e?.status !== 404) throw e;
    }

    // Ya conectado: se confirma con qué número y se deja de mostrar el QR.
    if (state === 'open') return await connected(ch);

    // Instancia nueva: se crea ya con su webhook y su primer QR (sin otro clic).
    if (state === 'not_found') {
      const created = await createOrWait(ch, number);
      if (!created) return preparing(0); // otra pestaña la está creando en este momento
      const qr = created?.qrcode;
      if (o.mode === 'qr' && qr?.base64) {
        await store.saveQr(ch.id, dataUrl(qr.base64));
        return { state: 'connecting', qr: dataUrl(qr.base64), pairingCode: null, expires_in: QR_TTL_S };
      }
      if (o.mode === 'code' && qr?.pairingCode) {
        await store.savePairingCode(ch.id, qr.pairingCode, number);
        return { state: 'connecting', qr: null, pairingCode: qr.pairingCode, expires_in: CODE_TTL_S };
      }
    }

    const now = Date.now();
    const t = attempts.get(ch.id) ?? { connectAt: 0, recreateAt: 0, waitingSince: now };
    attempts.set(ch.id, t);
    if (state === 'not_found') {
      // Recién creada sin código todavía: llega en segundos (por webhook o en la siguiente consulta).
      t.connectAt = now;
      t.waitingSince = now;
      return preparing(0);
    }

    // Mientras la persona escanea, se reutiliza el QR vigente: pedir uno nuevo reiniciaría la vinculación.
    if (o.mode === 'qr' && !o.refresh && ch.qr_code && ageS(ch.qr_at) < QR_TTL_S) {
      return { state: 'connecting', qr: ch.qr_code, pairingCode: null, expires_in: Math.max(1, Math.round(QR_TTL_S - ageS(ch.qr_at))) };
    }
    if (o.mode === 'code' && !o.refresh && ch.pairing_code && ch.pairing_number === number && ageS(ch.pairing_at) < CODE_TTL_S) {
      return { state: 'connecting', qr: null, pairingCode: ch.pairing_code, expires_in: Math.max(1, Math.round(CODE_TTL_S - ageS(ch.pairing_at))) };
    }
    // Pedir la vinculación en cada consulta la reiniciaría y el código nunca alcanzaría a salir:
    // como máximo una vez cada 15 s (sin `await` entre la revisión y la marca: dos pestañas no la duplican).
    if (!o.refresh && now - t.connectAt < CONNECT_EVERY_MS) return preparing(now - t.waitingSince);
    t.connectAt = now;

    await evo.setWebhook(instance, webhookUrl(ch));
    let c = await evo.connect(instance, number || undefined).catch(() => null);
    if (!(o.mode === 'qr' ? c?.base64 : c?.pairingCode) && now - t.waitingSince > STUCK_AFTER_MS && now - t.recreateAt > RECREATE_EVERY_MS) {
      // Lleva rato sin generar código (instancia trabada o QR agotados): se recrea una vez con el mismo nombre.
      t.recreateAt = now;
      t.waitingSince = now;
      await logEvent({ level: 'warn', source: 'evolution', message: `La instancia ${instance} no generó código; se recrea`, accountId: ch.account_id, channelId: ch.id });
      await evo.logout(instance).catch(() => undefined);
      await evo.deleteInstance(instance).catch(() => undefined);
      const created = await createOrWait(ch, number);
      if (!created) return preparing(0); // Evolution aún no libera el nombre: se reintenta en la siguiente consulta
      c = { base64: created?.qrcode?.base64, pairingCode: created?.qrcode?.pairingCode ?? undefined };
    }
    if (o.mode === 'code') {
      if (!c?.pairingCode) {
        throw new SessionError('WhatsApp no generó el código por número en este momento. Intenta de nuevo en un minuto o usa "Escanear código QR".');
      }
      t.waitingSince = now;
      await store.savePairingCode(ch.id, c.pairingCode, number);
      return { state: 'connecting', qr: null, pairingCode: c.pairingCode, expires_in: CODE_TTL_S };
    }
    if (!c?.base64) return preparing(now - t.waitingSince);
    t.waitingSince = now;
    await store.saveQr(ch.id, dataUrl(c.base64));
    return { state: 'connecting', qr: dataUrl(c.base64), pairingCode: null, expires_in: QR_TTL_S };
  } catch (e) {
    return friendly(ch, e);
  }
}

/**
 * Crea la instancia. Evolution tarda un momento en liberar el nombre después de borrarla (y dos pestañas
 * pueden intentar crearla a la vez): si responde "ya está en uso", se espera brevemente; si sigue ocupado,
 * devuelve null y el panel muestra "preparando" en vez de un error.
 */
async function createOrWait(ch: Channel, number: string) {
  const evo = evolutionFor(ch);
  for (let i = 0; i < 6; i++) {
    try {
      const created = await evo.createInstance(ch.config.instance, webhookUrl(ch), number || undefined);
      await logEvent({ level: 'info', source: 'evolution', message: `Instancia creada: ${ch.config.instance}`, accountId: ch.account_id, channelId: ch.id });
      return created;
    } catch (e: any) {
      if (e?.status !== 403 && e?.status !== 409) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return null;
}

/** Conectado: se guarda el número y el nombre de la cuenta vinculada, y se borra el QR. */
async function connected(ch: Channel): Promise<SessionResult> {
  attempts.delete(ch.id);
  await recordConnectionState(ch, 'open');
  const profile = await evolutionFor(ch).fetchInstance(ch.config.instance).catch(() => null);
  let warning: string | undefined;
  if (profile?.number) {
    const fresh = (await store.getChannel(ch.id))!;
    if (fresh.config.number !== profile.number || fresh.config.profile_name !== profile.profileName) {
      await store.updateChannel(ch.id, { config: { ...fresh.config, number: profile.number, profile_name: profile.profileName } });
    }
    const others = (await store.listChannels(ch.account_id)).filter(
      (c) => c.id !== ch.id && c.type === 'whatsapp' && c.config.number?.replace(/\D/g, '') === profile.number && c.connection_state === 'open',
    );
    if (others.length) warning = `Este número también está conectado en el canal "${others[0].name}". Cada canal debería usar un número distinto.`;
  }
  return { state: 'open', qr: null, pairingCode: null, expires_in: 0, profile: profile ? { number: profile.number, name: profile.profileName } : null, warning };
}
