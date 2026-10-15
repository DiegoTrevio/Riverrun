import { evolutionFor } from './channels/whatsapp.js';
import { query } from './db.js';
import { notifyDisconnected, recordConnectionState } from './lifecycle.js';
import { logEvent } from './logs.js';
import * as store from './store/index.js';

/**
 * Vigila los WhatsApp vinculados aunque Evolution no avise (webhook perdido o reinicio):
 * - Lee el estado real de cada sesión y lo guarda; un WhatsApp que se cae avisa a los administradores.
 * - Si una sesión que estaba conectada se cayó ("close"), intenta reconectarla cada 15 minutos durante 24 horas.
 * - Si sigue desconectado, vuelve a avisar cada 6 horas durante 7 días.
 * Solo cuenta lo que estaba conectado y se cayó (down_since): una desconexión hecha desde el panel no se toca. Un estado
 * distinto de "open" debe repetirse en dos revisiones (tres si es "connecting", que Evolution usa al reconectar solo).
 * Los avisos se reclaman con una actualización atómica: con varios procesos, cada aviso sale una sola vez.
 */
const misses = new Map<string, number>();
const lastReconnect = new Map<string, number>();
export const WATCH = { reconnectEveryMs: 15 * 60_000, reconnectForHours: 24, renotifyHours: 6, renotifyForDays: 7, freshCodeSeconds: 180 };

const ageS = (at: unknown, now: number) => (at ? (now - new Date(String(at)).getTime()) / 1000 : Infinity);

export async function watchWhatsapp(now = Date.now()): Promise<{ checked: number; down: number; reconnected: number; notified: number }> {
  const rows = await query<{ id: string }>(`SELECT id FROM channels WHERE type = 'whatsapp' AND active AND coalesce(config->>'instance','') <> ''
    AND (connection_state = 'open' OR down_since > now() - interval '7 days') ORDER BY created_at LIMIT 300`);
  const r = { checked: 0, down: 0, reconnected: 0, notified: 0 };
  for (const { id } of rows) {
    const ch = await store.getChannel(id);
    if (!ch) continue;
    let state: string;
    try {
      state = await evolutionFor(ch).connectionState(ch.config.instance);
    } catch {
      continue; // Evolution no responde o la instancia no existe: lo reporta el monitor; aquí no se cambia nada.
    }
    r.checked++;
    if (state === 'open') {
      misses.delete(id);
      if (ch.connection_state !== 'open') await recordConnectionState(ch, 'open');
      continue;
    }
    const n = (misses.get(id) ?? 0) + 1;
    misses.set(id, n);
    if (n < (state === 'connecting' ? 3 : 2)) continue;
    r.down++;
    if (ch.connection_state !== 'close') await recordConnectionState(ch, 'close');
    const fresh = (await query<{ down_since: string | null; qr_at: string | null; pairing_at: string | null }>(
      `SELECT down_since, qr_at, pairing_at FROM channels WHERE id = $1`, [id]))[0];
    if (!fresh?.down_since) continue;
    const downMs = now - new Date(fresh.down_since).getTime();
    // Reconectar solo una sesión cerrada, no una que ya se está reconectando, y nunca encima de un QR o código que alguien
    // esté escaneando en el panel (pedir otro lo invalidaría).
    const codeInUse = Math.min(ageS(fresh.qr_at, now), ageS(fresh.pairing_at, now)) < WATCH.freshCodeSeconds;
    if (state === 'close' && !codeInUse && downMs <= WATCH.reconnectForHours * 3600_000 && now - (lastReconnect.get(id) ?? 0) >= WATCH.reconnectEveryMs) {
      lastReconnect.set(id, now);
      try {
        const res = await evolutionFor(ch).connect(ch.config.instance);
        const after = res?.state === 'open' ? 'open' : await evolutionFor(ch).connectionState(ch.config.instance).catch(() => 'close');
        if (after === 'open') {
          misses.delete(id);
          await recordConnectionState(ch, 'open');
          await logEvent({ level: 'info', source: 'evolution', message: `WhatsApp reconectado automáticamente: ${ch.name}`, accountId: ch.account_id, channelId: ch.id });
          r.reconnected++;
          continue;
        }
      } catch (e: any) {
        await logEvent({ level: 'warn', source: 'evolution', message: `No se pudo reconectar WhatsApp automáticamente (${ch.name}): ${e?.message ?? e}`, accountId: ch.account_id, channelId: ch.id });
      }
    }
    // Primer aviso de esta caída (si el webhook no lo dio, p. ej. pasó por "connecting") o recordatorio cada 6 horas.
    const claimed = await query(`UPDATE channels SET disconnect_notified_at = now() WHERE id = $1 AND down_since IS NOT NULL
        AND down_since > now() - make_interval(days => $2)
        AND (disconnect_notified_at IS NULL OR disconnect_notified_at < down_since OR disconnect_notified_at < now() - make_interval(hours => $3))
      RETURNING id`, [id, WATCH.renotifyForDays, WATCH.renotifyHours]);
    if (claimed.length) {
      await notifyDisconnected(ch, Math.floor(downMs / 3600_000));
      r.notified++;
    }
  }
  return r;
}

export function startWhatsappWatch(intervalMs = 5 * 60_000) {
  const run = () => void watchWhatsapp().catch((e) => logEvent({ level: 'error', source: 'evolution', message: `Vigilancia de WhatsApp: ${e?.message ?? e}` }));
  setTimeout(run, 60_000).unref();
  setInterval(run, intervalMs).unref();
}
