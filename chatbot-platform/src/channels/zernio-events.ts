import crypto from 'node:crypto';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { recordConnectionState } from '../lifecycle.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import type { Channel } from '../types.js';
import { eventAccountId, eventProfileId, networkOf } from './zernio.js';

/**
 * Eventos del webhook único de Zernio. Cada evento se guarda una sola vez por su id: Zernio reintenta hasta 7 veces con
 * el mismo id y un evento capturado no se puede volver a meter (la firma no lleva hora). Los mensajes se guardan al
 * momento (solo escriben en la base); lo demás (conexión, entregado, leído, fallido) va a una cola que se procesa
 * después, para responder a Zernio en menos de 5 s.
 */

/** Más viejo que esto no se acepta (y los ids se conservan este tiempo). */
export const EVENT_RETENTION_DAYS = 35;
const MESSAGE_EVENTS = new Set(['message.received', 'message.sent']);
const QUEUED_EVENTS = new Set(['account.connected', 'account.disconnected', 'message.failed', 'message.delivered', 'message.read']);
const MAX_ATTEMPTS = 6;

/** Id del evento: el de Zernio (cabecera o cuerpo) o, si no viene, la huella del cuerpo firmado. */
export function eventIdOf(headers: Record<string, unknown>, body: any, rawBody?: Buffer): string {
  const id = headers['x-zernio-event-id'] ?? headers['x-late-event-id'] ?? body?.id;
  if (id != null && String(id).trim()) return String(id).slice(0, 200);
  return `sha256:${crypto.createHash('sha256').update(rawBody ?? JSON.stringify(body ?? {})).digest('hex')}`;
}

/** Hora del evento según Zernio (null si no la trae). */
function eventTime(body: any): number | null {
  const t = Date.parse(String(body?.timestamp ?? body?.createdAt ?? body?.message?.sentAt ?? ''));
  return Number.isNaN(t) ? null : t;
}

/** Canales del evento: los de la cuenta de Zernio y, si el evento dice su perfil, solo los de ese perfil. */
export async function channelsForEvent(body: any): Promise<{ channels: Channel[]; otherProfile: boolean }> {
  const accountId = eventAccountId(body);
  if (!accountId) return { channels: [], otherProfile: false };
  const found = await query<{ id: string; profile: string }>(`SELECT id, coalesce(config->>'profile_id', '') AS profile FROM channels WHERE type = 'zernio' AND config->>'account_id' = $1`, [accountId]);
  const profile = eventProfileId(body);
  const rows = profile ? found.filter((r) => !r.profile || r.profile === profile) : found;
  const channels = (await Promise.all(rows.map((r) => store.getChannel(r.id)))).filter((c): c is Channel => !!c);
  return { channels, otherProfile: found.length > 0 && rows.length === 0 };
}

/** Negocio dueño del evento: por su canal, por la cuenta conectada o por el perfil de Zernio. */
async function tenantOf(body: any, channels: Channel[]): Promise<string | null> {
  if (channels[0]) return channels[0].account_id;
  const byAccount = await queryOne<{ account_id: string }>(`SELECT account_id FROM social_accounts WHERE zernio_account_id = $1`, [eventAccountId(body)]);
  if (byAccount) return byAccount.account_id;
  const profile = eventProfileId(body);
  if (!profile) return null;
  const byProfile = await queryOne<{ account_id: string }>(
    `SELECT account_id FROM zernio_profiles WHERE profile_id = $1 UNION SELECT id FROM accounts WHERE zernio_profile_id = $1 LIMIT 1`, [profile]);
  return byProfile?.account_id ?? null;
}

const seen = async (eventId: string) => !!(await queryOne(`SELECT 1 FROM zernio_events WHERE event_id = $1`, [eventId]));
const record = (eventId: string, body: any, accountId: string | null, state: 'pending' | 'done' | 'ignored', reason: string | null = null) =>
  query(`INSERT INTO zernio_events (event_id, event, zernio_account_id, account_id, payload, state, reason) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [eventId, String(body?.event ?? '').slice(0, 80), eventAccountId(body).slice(0, 200), accountId, JSON.stringify(state === 'pending' ? body : {}), state, reason]);

/**
 * Recibe un evento ya firmado. `deliverMessage` guarda los mensajes del canal (solo escribe en la base). Devuelve el
 * código HTTP para Zernio: si algo falla lanza el error y la ruta responde 503 (Zernio reintenta con el mismo id).
 */
export async function receiveZernioEvent(
  req: { headers: Record<string, unknown>; body: any; rawBody?: Buffer },
  deliverMessage: (channel: Channel) => Promise<void>,
  wake: () => void,
): Promise<number> {
  const body = req.body;
  const eventId = eventIdOf(req.headers, body, req.rawBody);
  if (await seen(eventId)) return 200;
  const event = String(body?.event ?? '');
  const at = eventTime(body);
  if (at !== null && Date.now() - at > EVENT_RETENTION_DAYS * 86400_000) {
    await logEvent({ level: 'warn', source: 'webhook', message: `Zernio: evento ${event} de hace más de ${EVENT_RETENTION_DAYS} días; se ignora (posible repetición)` });
    return 200;
  }
  const { channels, otherProfile } = await channelsForEvent(body);
  if (otherProfile) {
    await logEvent({ level: 'warn', source: 'webhook', message: `Zernio: evento ${event} de otro perfil (${eventProfileId(body)}) para la cuenta ${eventAccountId(body)}; se ignora` });
    await record(eventId, body, null, 'ignored', 'other_profile');
    return 200;
  }
  if (MESSAGE_EVENTS.has(event)) {
    if (!channels.length) {
      await logEvent({ level: 'info', source: 'webhook', message: `Zernio: evento ${event} de una cuenta sin canal (${eventAccountId(body)})` });
      await record(eventId, body, await tenantOf(body, channels), 'ignored', 'no_channel');
      return 200;
    }
    // Primero se guardan los mensajes; el id del evento se anota después (si falla, Zernio reintenta y la recepción
    // tampoco se duplica: inbound_receipts es único por mensaje).
    for (const channel of channels) await deliverMessage(channel);
    await record(eventId, body, channels[0].account_id, 'done');
    return 200;
  }
  if (!QUEUED_EVENTS.has(event)) {
    await record(eventId, body, await tenantOf(body, channels), 'ignored', 'unhandled');
    return 200;
  }
  await record(eventId, body, await tenantOf(body, channels), 'pending');
  wake();
  return 200;
}

/* ------------------------------ Lo que se procesa después ------------------------------ */

/** Conectada o desconectada. Una cuenta conectada fuera del panel (en Zernio) se adopta si su perfil es de un negocio. */
async function handleAccount(body: any, connected: boolean) {
  const { channels } = await channelsForEvent(body);
  const zid = eventAccountId(body);
  for (const ch of channels) {
    await recordConnectionState(ch, connected ? 'open' : 'close');
    const why = !connected && body?.account?.reason ? `: ${String(body.account.reason).slice(0, 200)}` : '';
    await logEvent({ level: connected ? 'info' : 'warn', source: 'channel', message: connected ? 'Zernio: la cuenta quedó conectada' : `Zernio: la cuenta se desconectó${why}; hay que volver a conectarla`, accountId: ch.account_id, channelId: ch.id });
  }
  const updated = await query(`UPDATE social_accounts SET status = $2, updated_at = now() WHERE zernio_account_id = $1 RETURNING id`, [zid, connected ? 'active' : 'needs_reconnect']);
  if (!connected || updated.length || channels.length) return;
  const tenant = await tenantOf(body, channels);
  const platform = String(body?.account?.platform ?? '');
  if (!tenant || !networkOf(platform)) {
    await logEvent({ level: 'info', source: 'webhook', message: `Zernio: se conectó una cuenta (${zid}) de un perfil que no es de ningún negocio; no se adopta` });
    return;
  }
  const adopted = await query(
    `INSERT INTO social_accounts (account_id, zernio_account_id, profile_id, platform, username, display_name, picture)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (zernio_account_id) DO NOTHING RETURNING id`,
    [tenant, zid, eventProfileId(body), platform, String(body?.account?.username ?? ''), String(body?.account?.displayName ?? body?.account?.name ?? ''), String(body?.account?.profilePicture ?? '')]);
  if (adopted.length) await logEvent({ level: 'info', source: 'channel', message: `Zernio: ${networkOf(platform)!.label} conectada desde Zernio${body?.account?.username ? ` (@${body.account.username})` : ''}; ya aparece en Redes sociales`, accountId: tenant });
}

/** Ids con los que el evento nombra al mensaje (el de Zernio y el de la red). */
const messageIds = (body: any): string[] =>
  [...new Set([body?.message?.id, body?.message?.platformMessageId, body?.message?.messageId, body?.messageId, body?.data?.messageId].filter((x) => x != null && String(x)).map(String))];

/** Entregado, leído o fallido: se marca en nuestro mensaje enviado (de los canales de ese negocio). */
async function handleMessageStatus(body: any, event: string) {
  const ids = messageIds(body);
  const { channels } = await channelsForEvent(body);
  if (!ids.length || !channels.length) return;
  const channelIds = channels.map((c) => c.id);
  if (event === 'message.failed') {
    const e = body?.error ?? body?.message?.error ?? {};
    const code = String(e?.code ?? e?.type ?? '').slice(0, 80);
    const why = String(e?.message ?? e?.title ?? '').slice(0, 300);
    await query(
      `UPDATE messages m SET status = 'failed', meta = coalesce(m.meta, '{}'::jsonb) || jsonb_build_object('error_code', $3::text, 'error', $4::text)
         FROM conversations c WHERE c.id = m.conversation_id AND c.channel_id = ANY($1::uuid[]) AND m.direction = 'out' AND m.external_message_id = ANY($2::text[])`,
      [channelIds, ids, code, why]);
    for (const ch of channels) {
      await logEvent({ level: 'warn', source: 'channel', message: `Zernio: un mensaje no se pudo entregar${why ? `: ${why}` : ''}${code ? ` (${code})` : ''}`, accountId: ch.account_id, channelId: ch.id });
    }
    return;
  }
  const column = event === 'message.read' ? 'read_at' : 'delivered_at';
  await query(
    `UPDATE messages m SET ${column} = coalesce(m.${column}, now())${column === 'read_at' ? ', delivered_at = coalesce(m.delivered_at, now())' : ''}
       FROM conversations c WHERE c.id = m.conversation_id AND c.channel_id = ANY($1::uuid[]) AND m.direction = 'out' AND m.external_message_id = ANY($2::text[])`,
    [channelIds, ids]);
}

export async function handleZernioEvent(event: string, body: any) {
  if (event === 'account.connected' || event === 'account.disconnected') return handleAccount(body, event === 'account.connected');
  if (event === 'message.failed' || event === 'message.delivered' || event === 'message.read') return handleMessageStatus(body, event);
}

/** Cola de los eventos que no son mensajes: varios procesos no toman el mismo (SKIP LOCKED) y lo que falla se reintenta. */
export class ZernioEventQueue {
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private again = false;

  constructor(private handle = handleZernioEvent) {
    if (config.queue.role !== 'http') {
      this.timer = setInterval(() => this.wake(), config.queue.pollMs);
      this.timer.unref();
    }
  }

  wake() {
    if (this.stopped || config.queue.role === 'http') return;
    if (this.running) { this.again = true; return; }
    this.running = this.runDue()
      .catch((e) => console.warn(`[zernio] Eventos pendientes conservados: ${e?.message ?? e}`))
      .finally(() => { this.running = undefined; if (this.again) { this.again = false; this.wake(); } });
  }

  async runDue() {
    while (!this.stopped) {
      const rows = await query<{ event_id: string; event: string; payload: any; attempts: number; account_id: string | null }>(
        `UPDATE zernio_events SET state = 'running', lease_until = now() + interval '5 minutes', attempts = attempts + 1
          WHERE event_id IN (SELECT event_id FROM zernio_events
                              WHERE (state = 'pending' AND run_at <= now()) OR (state = 'running' AND lease_until < now())
                              ORDER BY received_at LIMIT 20 FOR UPDATE SKIP LOCKED)
          RETURNING event_id, event, payload, attempts, account_id`);
      if (!rows.length) return;
      for (const row of rows) {
        if (this.stopped) return;
        try {
          await this.handle(row.event, row.payload);
          await query(`UPDATE zernio_events SET state = 'done', payload = '{}', lease_until = NULL, reason = NULL WHERE event_id = $1`, [row.event_id]);
        } catch (e: any) {
          const dead = row.attempts >= MAX_ATTEMPTS;
          const why = String(e?.message ?? e).slice(0, 300);
          await query(`UPDATE zernio_events SET state = $2, reason = $3, lease_until = NULL, run_at = now() + $4 * interval '1 second' WHERE event_id = $1`,
            [row.event_id, dead ? 'dead' : 'pending', why, Math.min(3600, 10 * 2 ** row.attempts)]);
          if (dead) await logEvent({ level: 'error', source: 'webhook', message: `Zernio: no se pudo procesar el evento ${row.event} tras ${row.attempts} intentos: ${why}`, accountId: row.account_id }).catch(() => undefined);
        }
      }
    }
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }

  get size() {
    return this.running ? 1 : 0;
  }
}
