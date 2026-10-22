/**
 * Sesión de conexión de WhatsApp: lo que el panel pide cada pocos segundos mientras la persona vincula su teléfono.
 * Crea la instancia al instante, mantiene un QR vigente (sin reiniciar la vinculación en cada consulta),
 * ofrece el código para "Vincular con número de teléfono" y se recupera sola si la instancia quedó trabada.
 * Nunca borra por su cuenta una sesión ya vinculada que se está recuperando sola: eso solo pasa a pedido ("Vincular de nuevo").
 *
 * Cómo se comporta Evolution 2.3.7 (leído de su código): `connect` con la instancia esperando escaneo ("connecting")
 * devuelve el QR vigente y no hace caso del número; el número solo cuenta al crear la instancia o al conectar una cerrada.
 * Con número, Evolution pide un código nuevo con cada QR (cada 45 s) y solo el último sirve.
 */
import { recreateBlockedReason } from '../evolution/status.js';
import { NEEDS_RELINK, recordConnectionState } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import type { Channel } from '../types.js';
import { webhookUrl } from './index.js';
import { evolutionFor } from './whatsapp.js';

/** Vida útil de un QR de WhatsApp (se renueva antes de que venza). */
export const QR_TTL_S = 30;
/** El código por número se reutiliza menos de lo que tarda Evolution en cambiarlo (45 s): siempre se muestra el último. */
export const CODE_TTL_S = 40;

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
  /** El teléfono ya estaba vinculado y la sesión se está recuperando sola: no hace falta escanear nada. */
  reconnecting?: boolean;
}

export class SessionError extends Error {}

/** Cada cuánto, como máximo, se pide a Evolution una vinculación nueva mientras no hay código. */
export const CONNECT_EVERY_MS = 15_000;
/** Tiempo sin código a partir del cual la instancia se considera trabada y se recrea. */
export const STUCK_AFTER_MS = 45_000;
/** Como máximo una recreación automática cada 2 minutos por canal. */
export const RECREATE_EVERY_MS = 120_000;
/** Reinicios pedidos por la persona (otro número, "Vincular de nuevo"): como máximo uno cada 15 s por canal. */
export const RESTART_EVERY_MS = 15_000;

/** Intentos en curso por canal (en memoria: el backend corre en un solo proceso). */
export const attempts = new Map<string, { connectAt: number; recreateAt: number; waitingSince: number }>();

/** Aún no hay código: el panel muestra "preparando" y vuelve a consultar. */
const preparing = (waitedMs: number): SessionResult => ({ state: 'connecting', qr: null, pairingCode: null, expires_in: 0, preparing: true, waited_s: Math.round(waitedMs / 1000) });
const reconnecting = (waitedMs: number): SessionResult => ({ ...preparing(waitedMs), reconnecting: true });

/**
 * Un WhatsApp que estaba conectado y se cayó sin que nadie cerrara la sesión (ni desde el teléfono ni desde el panel):
 * Evolution lo reconecta solo con la sesión guardada. Borrarlo obligaría a escanear otra vez sin necesidad.
 */
export function recoverable(ch: Pick<Channel, 'down_since' | 'disconnect_reason'>) {
  return !!ch.down_since && !NEEDS_RELINK.includes(String(ch.disconnect_reason ?? ''));
}

/** Número para vincular: solo dígitos, con lada de país (10 dígitos = México, se agrega 52). */
export function normalizePairingNumber(raw: string): string {
  let d = raw.replace(/\D/g, '');
  if (d.length === 10) d = `52${d}`;
  if (d.length < 11 || d.length > 15) throw new SessionError('Escribe tu número de WhatsApp con lada de país, por ejemplo 52 81 1234 5678.');
  return d;
}

const ageS = (at: Date | null | undefined) => (at ? (Date.now() - new Date(at).getTime()) / 1000 : Infinity);
const dataUrl = (b64: string) => (b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`);
const attempt = (id: string, now = Date.now()) => {
  const t = attempts.get(id) ?? { connectAt: 0, recreateAt: 0, waitingSince: now };
  attempts.set(id, t);
  return t;
};

/** Errores de Evolution → mensaje entendible (el detalle técnico queda en Registros). */
async function friendly(ch: Channel, e: any): Promise<never> {
  if (e instanceof SessionError) throw e;
  await logEvent({ level: 'error', source: 'evolution', message: `Conexión de WhatsApp: ${e?.message ?? e}`, accountId: ch.account_id, channelId: ch.id });
  const status = e?.status as number | undefined;
  if (!status || status >= 500) throw new SessionError('No pudimos comunicarnos con el servidor de WhatsApp. Intenta de nuevo en unos segundos.');
  throw new SessionError('WhatsApp no aceptó la solicitud. Vuelve a intentarlo; si sigue fallando, avísanos.');
}

const sessionLocks = new Map<string, Promise<void>>();
/** `relink`: "Vincular de nuevo" pulsado por la persona (descarta la sesión anterior aunque pudiera recuperarse). */
type SessionOptions = { mode: 'qr' | 'code'; number?: string; refresh?: boolean; relink?: boolean };

/** Serializa las consultas del mismo canal; otros canales conectan independientemente. */
export async function whatsappSession(ch: Channel, o: SessionOptions): Promise<SessionResult> {
  const previous = sessionLocks.get(ch.id) ?? Promise.resolve();
  let release!: () => void;
  const lock = new Promise<void>((resolve) => { release = resolve; });
  sessionLocks.set(ch.id, lock);
  await previous;
  try {
    const fresh = await store.getChannel(ch.id);
    if (!fresh) throw new SessionError('El canal ya no está disponible.');
    return await prepareSession(fresh, o);
  } finally {
    release();
    if (sessionLocks.get(ch.id) === lock) sessionLocks.delete(ch.id);
  }
}

async function prepareSession(ch: Channel, o: SessionOptions): Promise<SessionResult> {
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

    // "Vincular de nuevo": la persona decidió empezar de cero (otro teléfono o una sesión que no vuelve).
    if (o.relink && state !== 'not_found') {
      if (Date.now() - attempt(ch.id).recreateAt < RESTART_EVERY_MS) return preparing(0);
      return await restartLinking(ch, o.mode, number, 'se vincula de nuevo a pedido del panel', true);
    }
    // Sin instancia no queda sesión que esperar: la vinculación nueva ya no cuenta como una caída que se recupera sola.
    if (o.relink) await store.setConnectionStateQuiet(ch.id, 'close');

    // Instancia nueva: se crea ya con su webhook y su primer QR (sin otro clic).
    if (state === 'not_found') {
      const created = await createOrWait(ch, number);
      if (!created) return preparing(0); // otra pestaña la está creando en este momento
      const r = await fromCreated(ch, created, o.mode, number);
      if (!r.preparing) return r;
      // Recién creada sin código todavía: llega en segundos (por webhook o en la siguiente consulta).
      const t = attempt(ch.id);
      t.connectAt = Date.now();
      t.waitingSince = t.connectAt;
      return r;
    }

    const now = Date.now();
    const t = attempt(ch.id, now);
    const comeback = recoverable(ch);
    // ¿La instancia ya está vinculando con este número? (Evolution solo genera códigos para el número con que empezó.)
    const ours = !number || ch.pairing_number === number;

    // Mientras la persona escanea, se reutiliza el QR vigente: pedir uno nuevo reiniciaría la vinculación.
    if (o.mode === 'qr' && !o.refresh && ch.qr_code && ageS(ch.qr_at) < QR_TTL_S) {
      return { state: 'connecting', qr: ch.qr_code, pairingCode: null, expires_in: Math.max(1, Math.round(QR_TTL_S - ageS(ch.qr_at))) };
    }
    if (o.mode === 'code' && !o.refresh && ours && ch.pairing_code && ageS(ch.pairing_at) < CODE_TTL_S) {
      return { state: 'connecting', qr: null, pairingCode: ch.pairing_code, expires_in: Math.max(1, Math.round(CODE_TTL_S - ageS(ch.pairing_at))) };
    }
    // Por número con una instancia que espera un QR (o que vincula otro número): Evolution no haría caso del número,
    // así que la vinculación empieza de nuevo con él. Nunca encima de una sesión vinculada que se recupera sola.
    if (o.mode === 'code' && !ours && state !== 'close') {
      if (comeback) return reconnecting(now - t.waitingSince);
      if (now - t.recreateAt < RESTART_EVERY_MS) return preparing(now - t.waitingSince);
      return await restartLinking(ch, o.mode, number, 'vincula por número');
    }
    // Pedir la vinculación en cada consulta la reiniciaría y el código nunca alcanzaría a salir:
    // como máximo una vez cada 15 s (sin `await` entre la revisión y la marca: dos pestañas no la duplican).
    if (!o.refresh && now - t.connectAt < CONNECT_EVERY_MS) return comeback ? reconnecting(now - t.waitingSince) : preparing(now - t.waitingSince);
    t.connectAt = now;

    await evo.setWebhook(instance, webhookUrl(ch));
    let c;
    try {
      c = await evo.connect(instance, number || undefined);
    } catch (e) {
      t.connectAt = 0;
      throw e;
    }
    if (c.state === 'open') return await connected(ch);
    const got = o.mode === 'qr' ? c?.base64 : c?.pairingCode;
    // Una sesión vinculada que se recupera sola no da QR: se espera (Evolution y la vigilancia la reconectan).
    if (!got && comeback) return reconnecting(now - t.waitingSince);
    if (!got && now - t.waitingSince > STUCK_AFTER_MS && now - t.recreateAt > RECREATE_EVERY_MS) {
      // El escaneo pudo completarse mientras esperábamos el código.
      if (await evo.connectionState(instance) === 'open') return await connected(ch);
      // Lleva rato sin generar código (instancia trabada o QR agotados): se recrea una vez con el mismo nombre.
      return await restartLinking(ch, o.mode, number, 'no generó código');
    }
    if (o.mode === 'code') {
      if (!c?.pairingCode) {
        // Con la instancia cerrada, conectar con el número la dejó vinculando con él: el código llega en segundos.
        if (state === 'close' || !ch.pairing_number) await store.savePairingCode(ch.id, null, number);
        if (now - t.waitingSince > STUCK_AFTER_MS) {
          throw new SessionError('WhatsApp no generó el código por número en este momento. Intenta de nuevo en un minuto o usa "Escanear código QR".');
        }
        return preparing(now - t.waitingSince);
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

/** Lo que devolvió Evolution al crear la instancia: su primer QR o, con número, su código. */
async function fromCreated(ch: Channel, created: any, mode: SessionOptions['mode'], number: string): Promise<SessionResult> {
  const qr = created?.qrcode;
  // Se recuerda con qué número vincula esta instancia, aunque el código todavía no llegue (llega por webhook).
  if (number) await store.savePairingCode(ch.id, qr?.pairingCode || null, number);
  if (mode === 'qr' && qr?.base64) {
    await store.saveQr(ch.id, dataUrl(qr.base64));
    return { state: 'connecting', qr: dataUrl(qr.base64), pairingCode: null, expires_in: QR_TTL_S };
  }
  if (mode === 'code' && qr?.pairingCode) return { state: 'connecting', qr: null, pairingCode: qr.pairingCode, expires_in: CODE_TTL_S };
  return preparing(0);
}

/**
 * Empieza la vinculación desde cero con el mismo nombre de instancia: cierra la sesión, la borra y la crea de nuevo (con
 * el número, si se vincula por código). Solo para instancias sin una sesión que valga la pena conservar, o a pedido
 * (`requested`: la caída que provoca no se avisa como desconexión, igual que "Desconectar").
 */
async function restartLinking(ch: Channel, mode: SessionOptions['mode'], number: string, why: string, requested = false): Promise<SessionResult> {
  const instance = ch.config.instance;
  const evo = evolutionFor(ch);
  const t = attempt(ch.id);
  t.recreateAt = t.waitingSince = t.connectAt = Date.now();
  // Salvo justo después de actualizar Evolution (o con una versión incompatible): recrear borraría una sesión ya
  // vinculada que quizá se recupera corrigiendo la versión. Se informa en vez de borrar.
  const blocked = await recreateBlockedReason(ch);
  if (blocked) {
    await logEvent({ level: 'warn', source: 'evolution', message: `La instancia ${instance} ${why} y no se recrea automáticamente (${blocked}). Revisa Sistema antes de volver a vincular.`, accountId: ch.account_id, channelId: ch.id });
    throw new SessionError('El servidor de WhatsApp se actualizó hace poco y esta conexión no respondió. Para no perder tu sesión no la reiniciamos automáticamente: avisa a soporte.');
  }
  await logEvent({ level: 'warn', source: 'evolution', message: `La instancia ${instance} ${why}; se recrea`, accountId: ch.account_id, channelId: ch.id });
  if (requested) await store.setConnectionStateQuiet(ch.id, 'close');
  await evo.logout(instance).catch(() => undefined);
  await evo.deleteInstance(instance).catch(() => undefined);
  await store.clearConnectionCodes(ch.id);
  const created = await createOrWait(ch, number);
  if (!created) return preparing(0); // Evolution aún no libera el nombre: se reintenta en la siguiente consulta
  return fromCreated(ch, created, mode, number);
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
      const message = JSON.stringify(e?.body?.response?.message ?? e?.body?.message ?? '');
      const nameConflict = e?.status === 409 || (e?.status === 403 && /already (?:in use|exists)/i.test(message));
      if (!nameConflict) throw e;
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
