import { evolutionFor } from './channels/whatsapp.js';
import { query } from './db.js';
import { notifyDisconnected, recordConnectionState } from './lifecycle.js';
import { logEvent } from './logs.js';
import * as store from './store/index.js';

/**
 * Vigila los WhatsApp vinculados aunque Evolution no avise (webhook perdido o reinicio):
 * - Lee el estado real de cada sesión y lo guarda; un WhatsApp que se cae avisa a los administradores.
 * - Si una sesión vinculada está caída, intenta reconectarla (cada 15 minutos).
 * - Si sigue desconectado, vuelve a avisar cada 6 horas durante 7 días.
 * Un estado distinto de "open" debe repetirse en dos revisiones seguidas antes de darlo por caído (Evolution reconecta
 * solo en segundos y no se debe alarmar por eso).
 */
const misses = new Map<string, number>();
const lastReconnect = new Map<string, number>();
export const WATCH = { reconnectEveryMs: 15 * 60_000, renotifyHours: 6, renotifyForDays: 7 };

export async function watchWhatsapp(now = Date.now()): Promise<{ checked: number; down: number; reconnected: number; renotified: number }> {
  const rows = await query<{ id: string }>(`SELECT id FROM channels WHERE type = 'whatsapp' AND active AND coalesce(config->>'instance','') <> ''
    AND (coalesce(config->>'number','') <> '' OR connection_state IN ('open','close')) ORDER BY created_at LIMIT 300`);
  const r = { checked: 0, down: 0, reconnected: 0, renotified: 0 };
  for (const { id } of rows) {
    const ch = await store.getChannel(id);
    if (!ch) continue;
    let state: string;
    try {
      state = await evolutionFor(ch).connectionState(ch.config.instance);
    } catch {
      continue; // Evolution no responde: lo reporta el monitor; aquí no se cambia nada.
    }
    r.checked++;
    if (state === 'open') {
      misses.delete(id);
      if (ch.connection_state !== 'open') await recordConnectionState(ch, 'open');
      continue;
    }
    const n = (misses.get(id) ?? 0) + 1;
    misses.set(id, n);
    if (n < 2) continue;
    r.down++;
    if (ch.connection_state !== 'close') await recordConnectionState(ch, 'close');
    if (now - (lastReconnect.get(id) ?? 0) >= WATCH.reconnectEveryMs) {
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
    const fresh = (await query<{ since: string; notified: string | null }>(`SELECT connection_state_at AS since, disconnect_notified_at AS notified FROM channels WHERE id = $1`, [id]))[0];
    const since = fresh?.since ? new Date(fresh.since).getTime() : now;
    const notified = fresh?.notified ? new Date(fresh.notified).getTime() : since;
    const hours = Math.floor((now - since) / 3600_000);
    if (hours >= WATCH.renotifyHours && now - notified >= WATCH.renotifyHours * 3600_000 && now - since <= WATCH.renotifyForDays * 86400_000) {
      await notifyDisconnected(ch, hours);
      r.renotified++;
    }
  }
  return r;
}

export function startWhatsappWatch(intervalMs = 5 * 60_000) {
  const run = () => void watchWhatsapp().catch((e) => logEvent({ level: 'error', source: 'evolution', message: `Vigilancia de WhatsApp: ${e?.message ?? e}` }));
  setTimeout(run, 60_000).unref();
  setInterval(run, intervalMs).unref();
}
