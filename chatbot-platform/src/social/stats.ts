import { sleep } from '../engine/transport.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import { ZernioBusyError } from '../channels/zernio-budget.js';
import { clientFor, listOf, NETWORKS, networkOf, ZernioError, zernioEnabled, type ZernioClient } from '../channels/zernio.js';
import { publicHealth } from './health.js';

/**
 * Estadísticas diarias de las redes (Zernio, complemento Analytics): seguidores, alcance, impresiones e interacción por
 * cuenta y día (UTC, como las da Zernio). Se traen de a pocas cuentas cada hora, una vez al día cada una, con prioridad
 * baja y espaciadas (las estadísticas tienen un límite por segundo más estricto).
 */

export interface DayStat { followers?: number | null; impressions?: number | null; reach?: number | null; engagement?: number | null; views?: number | null; clicks?: number | null; posts?: number | null; raw?: Record<string, unknown> }

const ANALYTICS = NETWORKS.filter((n) => n.analytics).map((n) => n.id) as string[];
/** Espacio entre llamadas de estadísticas. */
let SPACING_MS = 300;
export const setStatsSpacing = (ms: number) => { SPACING_MS = ms; };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const dayOf = (v: unknown) => (/^\d{4}-\d{2}-\d{2}/.test(String(v ?? '')) ? String(v).slice(0, 10) : null);
const utcDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);

/** ¿Falta el complemento de estadísticas en la cuenta de Zernio de la plataforma? */
const addonMissing = (e: unknown) => e instanceof ZernioError && (e.status === 402 || (e.status === 403 && (e.data?.requiresAddon === true || /addon|add-on/i.test(JSON.stringify(e.data ?? {})))));

async function analyticsAvailable() {
  const row = await queryOne<{ value: any; updated_at: string }>(`SELECT value, updated_at FROM system_state WHERE key = 'zernio_analytics'`);
  // Sin el complemento se vuelve a probar al día siguiente.
  return !(row?.value?.available === false && Date.now() - Date.parse(row.updated_at) < 24 * 3600_000);
}
async function setAnalytics(available: boolean) {
  const prev = (await queryOne<{ value: any }>(`SELECT value FROM system_state WHERE key = 'zernio_analytics'`))?.value;
  await query(`INSERT INTO system_state (key, value, updated_at) VALUES ('zernio_analytics', $1, now()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`, [{ available }]);
  if (prev?.available !== available) {
    await logEvent({ level: available ? 'info' : 'warn', source: 'channel', message: available ? 'Zernio: las estadísticas de las redes están disponibles' : 'Zernio: la cuenta de Zernio de la plataforma no tiene el complemento de estadísticas (Analytics); no se traen estadísticas' });
  }
}

interface DueRow { id: string; account_id: string; zernio_account_id: string; platform: string; prev: string | null }

/** Aparta las cuentas que tocan (una vez al día cada una; todas repartidas en el día) y trae sus estadísticas. */
export async function syncStatsDue(limit?: number) {
  if (!zernioEnabled() || !(await analyticsAvailable())) return 0;
  const total = (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM social_accounts WHERE status = 'active' AND platform = ANY($1::text[])`, [ANALYTICS]))!.n;
  const take = limit ?? Math.max(10, Math.ceil(total / 20));
  const rows = await query<DueRow>(
    `WITH due AS (
       SELECT s.id, s.stats_synced_at AS prev FROM social_accounts s JOIN accounts a ON a.id = s.account_id
        WHERE s.status = 'active' AND a.active AND s.platform = ANY($1::text[]) AND coalesce(s.health->>'can_fetch_analytics', 'true') <> 'false'
          AND (s.stats_synced_at IS NULL OR s.stats_synced_at < now() - interval '23 hours')
        ORDER BY s.stats_synced_at NULLS FIRST LIMIT $2 FOR UPDATE OF s SKIP LOCKED)
     UPDATE social_accounts s SET stats_synced_at = now() FROM due WHERE s.id = due.id
     RETURNING s.id, s.account_id, s.zernio_account_id, s.platform, due.prev`, [ANALYTICS, take]);
  if (rows.length) await syncStatsBatch(rows);
  return rows.length;
}

/** Devuelve la marca de las cuentas que no se alcanzaron a traer (las retoma la siguiente vuelta). */
const giveBack = (rows: DueRow[]) => Promise.all(rows.map((r) => query(`UPDATE social_accounts SET stats_synced_at = $2 WHERE id = $1`, [r.id, r.prev])));

export async function syncStatsBatch(rows: DueRow[], client: ZernioClient = clientFor(null, 'background')) {
  const data = new Map<string, Map<string, DayStat>>(rows.map((r) => [r.id, new Map()]));
  const put = (id: string, day: string, v: DayStat) => {
    const m = data.get(id)!;
    m.set(day, { ...m.get(day), ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)), raw: { ...(m.get(day)?.raw ?? {}), ...(v.raw ?? {}) } });
  };
  // La primera vez, 35 días; después, desde la última vuelta (mínimo 7: las redes corrigen cifras unos días).
  const windowOf = (r: DueRow) => (r.prev ? Math.min(35, Math.max(7, Math.ceil((Date.now() - Date.parse(r.prev)) / 86400_000) + 2)) : 35);
  const done = new Set<string>();
  try {
    // Seguidores: varias cuentas por llamada (Google no tiene seguidores).
    const withFollowers = rows.filter((r) => r.platform !== 'googlebusiness');
    for (let i = 0; i < withFollowers.length; i += 50) {
      const chunk = withFollowers.slice(i, i + 50);
      const days = Math.max(...chunk.map(windowOf));
      let r: any;
      try {
        r = await client.call<any>('GET', `/accounts/follower-stats?accountIds=${chunk.map((x) => encodeURIComponent(x.zernio_account_id)).join(',')}&fromDate=${utcDay(-days)}&toDate=${utcDay(0)}&granularity=daily`);
      } catch (e) {
        // Una cuenta que Zernio rechaza no frena a las demás: esas cuentas quedan sin seguidores hoy y siguen con lo demás.
        if (e instanceof ZernioBusyError || addonMissing(e)) throw e;
        await logEvent({ level: 'warn', source: 'channel', message: `Estadísticas de redes: Zernio no dio los seguidores de ${chunk.length} cuenta(s): ${(e as any)?.message ?? e}` });
        continue;
      }
      for (const row of chunk) {
        for (const p of Array.isArray(r?.stats?.[row.zernio_account_id]) ? r.stats[row.zernio_account_id] : []) {
          const day = dayOf(p?.date);
          if (day) put(row.id, day, { followers: num(p?.followers) });
        }
      }
      await sleep(SPACING_MS);
    }
    // Alcance, impresiones e interacción: por cuenta.
    for (const row of rows) {
      const from = utcDay(-windowOf(row));
      try {
        if (row.platform === 'googlebusiness') {
          const r = await client.call<any>('GET', `/analytics/googlebusiness/performance?accountId=${encodeURIComponent(row.zernio_account_id)}&fromDate=${from}&toDate=${utcDay(0)}`);
          const metrics = r?.metrics ?? {};
          const byDay = new Map<string, { impressions: number; engagement: number }>();
          for (const [name, m] of Object.entries<any>(metrics)) {
            for (const v of Array.isArray(m?.values) ? m.values : []) {
              const day = dayOf(v?.date);
              if (!day) continue;
              const cur = byDay.get(day) ?? { impressions: 0, engagement: 0 };
              if (name.startsWith('BUSINESS_IMPRESSIONS')) cur.impressions += num(v?.value) ?? 0;
              if (['CALL_CLICKS', 'WEBSITE_CLICKS', 'BUSINESS_DIRECTION_REQUESTS'].includes(name)) cur.engagement += num(v?.value) ?? 0;
              byDay.set(day, cur);
            }
          }
          for (const [day, v] of byDay) put(row.id, day, { impressions: v.impressions, engagement: v.engagement });
        } else {
          const r = await client.call<any>('GET', `/analytics/daily-metrics?accountId=${encodeURIComponent(row.zernio_account_id)}&fromDate=${from}&toDate=${utcDay(0)}&attribution=received`);
          for (const d of listOf(r, 'dailyData')) {
            const day = dayOf(d?.date);
            if (!day) continue;
            const m = d?.metrics ?? {};
            // Sin ninguna de las cuatro cifras, la interacción queda vacía (no en cero: no pisa lo que ya estaba).
            const parts = ['likes', 'comments', 'shares', 'saves'].map((k) => num(m[k]));
            const engagement = parts.some((v) => v !== null) ? parts.reduce<number>((t, v) => t + (v ?? 0), 0) : null;
            put(row.id, day, { impressions: num(m.impressions), reach: num(m.reach), engagement, views: num(m.views), clicks: num(m.clicks), posts: num(d?.postCount) });
          }
        }
        await query(`UPDATE social_accounts SET stats_error = '' WHERE id = $1`, [row.id]);
      } catch (e) {
        if (e instanceof ZernioBusyError || addonMissing(e)) throw e;
        await query(`UPDATE social_accounts SET stats_error = $2 WHERE id = $1`, [row.id, String((e as any)?.message ?? e).slice(0, 300)]);
      }
      await upsertDays(row.id, row.account_id, data.get(row.id)!);
      done.add(row.id);
      await sleep(SPACING_MS);
    }
    await setAnalytics(true);
  } catch (e) {
    const pending = rows.filter((r) => !done.has(r.id));
    // Lo de seguidores que sí llegó se guarda igual.
    for (const r of pending) if (data.get(r.id)!.size) await upsertDays(r.id, r.account_id, data.get(r.id)!);
    if (addonMissing(e)) {
      await setAnalytics(false);
      await giveBack(pending);
      return;
    }
    await giveBack(pending);
    if (e instanceof ZernioBusyError) return;
    throw e;
  }
}

/** Guarda los días (lo que no vino en esta vuelta no borra lo que ya estaba). */
export async function upsertDays(socialAccountId: string, accountId: string, days: Map<string, DayStat>) {
  for (const [day, v] of days) {
    await query(
      `INSERT INTO social_account_stats (social_account_id, day, account_id, followers, impressions, reach, engagement, views, clicks, posts, raw)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (social_account_id, day) DO UPDATE SET
         followers = coalesce(EXCLUDED.followers, social_account_stats.followers), impressions = coalesce(EXCLUDED.impressions, social_account_stats.impressions),
         reach = coalesce(EXCLUDED.reach, social_account_stats.reach), engagement = coalesce(EXCLUDED.engagement, social_account_stats.engagement),
         views = coalesce(EXCLUDED.views, social_account_stats.views), clicks = coalesce(EXCLUDED.clicks, social_account_stats.clicks),
         posts = coalesce(EXCLUDED.posts, social_account_stats.posts), raw = social_account_stats.raw || EXCLUDED.raw, updated_at = now()`,
      [socialAccountId, day, accountId, v.followers ?? null, v.impressions ?? null, v.reach ?? null, v.engagement ?? null, v.views ?? null, v.clicks ?? null, v.posts ?? null, JSON.stringify(v.raw ?? {})]);
  }
}

/**
 * Lo que ve el negocio en Reportes → Redes sociales: por cuenta, seguidores y su cambio, totales del periodo y la serie
 * diaria (días UTC, como los da Zernio); y la salud de cada cuenta. Sin ids de Zernio.
 */
export async function socialStats(accountId: string, days: number) {
  const accounts = await query<{ id: string; platform: string; username: string; display_name: string; picture: string; status: string; health: any; token_expires_at: string | null; stats_synced_at: string | null; stats_error: string }>(
    `SELECT id, platform, username, display_name, picture, status, health, token_expires_at, stats_synced_at, stats_error FROM social_accounts
      WHERE account_id = $1 AND status IN ('active', 'needs_reconnect') ORDER BY connected_at, id`, [accountId]);
  const rows = await query<{ social_account_id: string; day: string; followers: number | null; impressions: string | null; reach: string | null; engagement: string | null; posts: number | null }>(
    `SELECT social_account_id, to_char(day, 'YYYY-MM-DD') AS day, followers, impressions, reach, engagement, posts FROM social_account_stats
      WHERE account_id = $1 AND day > (now() AT TIME ZONE 'UTC')::date - $2::int ORDER BY day`, [accountId, days]);
  const n = (v: string | number | null) => (v == null ? null : Number(v));
  const analytics = (await queryOne<{ value: any }>(`SELECT value FROM system_state WHERE key = 'zernio_analytics'`))?.value;
  return {
    days,
    analytics_available: analytics ? analytics.available !== false : null,
    accounts: accounts.map((a) => {
      const series = rows.filter((r) => r.social_account_id === a.id).map((r) => ({ day: r.day, followers: r.followers, impressions: n(r.impressions), reach: n(r.reach), engagement: n(r.engagement), posts: r.posts }));
      const withFollowers = series.filter((s) => s.followers != null);
      // Lo que la red no reporta (p. ej. el alcance de Google) queda vacío, no en cero.
      const sum = (k: 'impressions' | 'reach' | 'engagement' | 'posts') => (series.some((s) => s[k] != null) ? series.reduce((t, s) => t + (s[k] ?? 0), 0) : null);
      return {
        id: a.id, platform: a.platform, label: networkOf(a.platform)?.label ?? a.platform, username: a.username, display_name: a.display_name,
        picture: /^https:\/\//.test(a.picture || '') ? a.picture : '', analytics: !!networkOf(a.platform)?.analytics,
        followers: withFollowers.at(-1)?.followers ?? null,
        followers_change: withFollowers.length > 1 ? withFollowers.at(-1)!.followers! - withFollowers[0].followers! : null,
        totals: { impressions: sum('impressions'), reach: sum('reach'), engagement: sum('engagement'), posts: sum('posts') },
        series, updated_at: a.stats_synced_at, latest_day: series.at(-1)?.day ?? null, error: a.stats_error ? 'No se pudieron traer sus estadísticas en la última revisión' : '',
        health: publicHealth(a),
      };
    }),
  };
}

/** Cada hora, unas cuantas cuentas (todas quedan al día una vez por día). */
export function startSocialStats(intervalMs = 3600_000) {
  const run = () => void syncStatsDue().catch((e) => logEvent({ level: 'warn', source: 'channel', message: `Estadísticas de redes: ${e?.message ?? e}` }));
  setTimeout(run, 15 * 60_000).unref();
  setInterval(run, intervalMs).unref();
}
