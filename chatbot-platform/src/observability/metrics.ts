/**
 * Métricas en formato Prometheus (texto), para /metrics con HEALTH_TOKEN.
 *
 * Privacidad: las etiquetas son solo valores fijos o agregados (nombre de componente, estado, tipo de canal, severidad,
 * modelo de IA). Nada de teléfonos, correos, nombres, IDs de canal o de cuenta, ni contenido de mensajes o prompts. El
 * texto de las comprobaciones (detail) no se exporta: solo cifras. Si una cifra es desconocida se omite; nunca se
 * publica un 0 inventado.
 */
import { config } from '../config.js';
import { pool, query } from '../db.js';
import type { CheckResult } from '../monitor.js';
import { openBySeverity } from './incidents.js';
import { STATES, stateOf } from './status.js';

export interface AiModelStats {
  model: string;
  runs: number;
  input: number;
  output: number;
  cost: number;
  p95: number;
}
export interface InboundStats {
  type: string;
  /** Canales activos de ese tipo sin mensajes entrantes en 24 h. */
  silent: number;
  /** Segundos desde el último mensaje entrante de cualquier canal de ese tipo (7 días); null si no hay ninguno. */
  lastAgeSeconds: number | null;
}

export interface MetricsExtra {
  incidents: Record<string, number>;
  channels: { type: string; connection: string; n: number }[];
  /** IA de los últimos 15 minutos, por modelo. */
  ai: AiModelStats[];
  /** Mensajes entrantes por tipo de canal. */
  inbound: InboundStats[];
  uptimeSeconds: number;
  rssBytes: number;
  pool: { total: number; idle: number; waiting: number };
}

/**
 * Valores de etiqueta acotados: letras, dígitos, guion, punto y guion bajo (basta para nombres, estados y versiones).
 * Lo demás (comillas, signos de igual, espacios, @) se agrupa como "otro": así un valor raro no puede abrir otra etiqueta
 * ni colar un dato personal.
 */
const label = (v: string) => (/^[A-Za-z0-9_.-]{1,40}$/.test(v) ? v : 'otro');
const escapeLabel = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
/** Los modelos de OpenRouter llevan "/" o ":", que no caben en una etiqueta: se cambian por "_". */
export const modelLabel = (m: string) => label(m.replace(/[/:]+/g, '_'));

/** Agregados de la base. Se cachean 30 s: /metrics se consulta a menudo y estas cifras no cambian por segundo. */
const AGG_TTL_MS = 30_000;
let agg: { at: number; ai: AiModelStats[]; inbound: InboundStats[] } | null = null;

async function aggregates() {
  if (agg && Date.now() - agg.at < AGG_TTL_MS) return agg;
  const [ai, inbound] = await Promise.all([
    query<{ model: string; runs: number; input: number; output: number; cost: number; p95: number }>(
      `SELECT model, count(*)::int AS runs, sum(input_tokens)::int AS input, sum(output_tokens)::int AS output,
              sum(cost_usd)::float AS cost, percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::int AS p95
         FROM ai_runs WHERE created_at > now() - interval '15 minutes'
        GROUP BY model ORDER BY count(*) DESC LIMIT 20`,
    ),
    query<{ type: string; silent: number; last_age: number | null }>(
      `SELECT ch.type,
              count(*) FILTER (WHERE li.last_in IS NULL OR li.last_in < now() - interval '24 hours')::int AS silent,
              extract(epoch FROM now() - max(li.last_in))::float AS last_age
         FROM channels ch
         LEFT JOIN LATERAL (
           SELECT max(m.created_at) AS last_in FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
            WHERE cv.channel_id = ch.id AND m.direction = 'in' AND m.created_at > now() - interval '7 days'
         ) li ON true
        WHERE ch.active GROUP BY ch.type`,
    ),
  ]);
  agg = {
    at: Date.now(),
    ai: ai.map((r) => ({ model: modelLabel(r.model), runs: r.runs, input: r.input, output: r.output, cost: r.cost, p95: r.p95 })),
    inbound: inbound.map((r) => ({ type: label(r.type), silent: r.silent, lastAgeSeconds: r.last_age == null ? null : Math.round(r.last_age) })),
  };
  return agg;
}

export async function collectMetricsExtra(): Promise<MetricsExtra> {
  const [incidents, channels, a] = await Promise.all([
    openBySeverity(),
    query<{ type: string; connection: string; n: number }>(
      `SELECT type, CASE WHEN type = 'whatsapp' THEN coalesce(nullif(connection_state, ''), 'sin_conectar') ELSE 'no_aplica' END AS connection, count(*)::int AS n
         FROM channels WHERE active GROUP BY 1, 2`,
    ),
    // Si estas consultas fallan, /metrics sigue funcionando sin esas familias: no se publica un dato inventado.
    aggregates().catch((e: any) => {
      console.error('No se pudieron calcular las métricas de IA y de canales', e?.message ?? e);
      return { at: 0, ai: [] as AiModelStats[], inbound: [] as InboundStats[] };
    }),
  ]);
  return {
    incidents,
    channels: channels.map((c) => ({ type: label(c.type), connection: label(c.connection), n: c.n })),
    ai: a.ai,
    inbound: a.inbound,
    uptimeSeconds: process.uptime(),
    rssBytes: process.memoryUsage().rss,
    pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
  };
}

export function renderMetrics(checks: CheckResult[], extra: MetricsExtra): string {
  const out: string[] = [];
  // La garantía de privacidad vive aquí: cualquier etiqueta que llegue se valida, venga de donde venga.
  const safe = (labels: Record<string, string>) => Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, label(v)]));
  const family = (name: string, help: string, samples: [Record<string, string>, number | null | undefined][]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, value] of samples) {
      if (value === null || value === undefined || !Number.isFinite(value)) continue;
      const pairs = Object.entries(safe(labels)).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',');
      out.push(`${name}${pairs ? `{${pairs}}` : ''} ${value}`);
    }
  };

  family('riverrun_build_info', 'Versión de la aplicación.', [[{ version: config.monitor.version.slice(0, 40) }, 1]]);
  family(
    'riverrun_component_state',
    'Estado de cada componente: 1 en el estado actual, 0 en los demás.',
    checks.flatMap((c) => {
      const current = stateOf(c);
      return STATES.map((s) => [{ component: c.name, state: s }, current === s ? 1 : 0] as [Record<string, string>, number]);
    }),
  );
  family(
    'riverrun_check_value',
    'Cifras de cada comprobación (ver docs/observabilidad.md para su significado).',
    checks.flatMap((c) => Object.entries(c.metrics ?? {}).map(([metric, value]) => [{ component: c.name, metric: label(metric) }, value] as [Record<string, string>, number | null])),
  );
  family(
    'riverrun_incidents_open',
    'Incidencias abiertas por severidad (baja = degradado).',
    Object.entries(extra.incidents).map(([severity, n]) => [{ severity: label(severity) }, n] as [Record<string, string>, number]),
  );
  family(
    'riverrun_channels',
    'Canales activos por tipo y estado de conexión (WhatsApp: open, close, connecting, sin_conectar).',
    extra.channels.map((c) => [{ type: c.type, connection: c.connection }, c.n] as [Record<string, string>, number]),
  );
  family(
    'riverrun_channels_silent_24h',
    'Canales activos sin mensajes entrantes en las últimas 24 horas, por tipo.',
    extra.inbound.map((i) => [{ type: i.type }, i.silent] as [Record<string, string>, number]),
  );
  family(
    'riverrun_channel_last_inbound_age_seconds',
    'Segundos desde el último mensaje entrante de cualquier canal de ese tipo (ventana de 7 días).',
    extra.inbound.map((i) => [{ type: i.type }, i.lastAgeSeconds] as [Record<string, string>, number | null]),
  );
  family(
    'riverrun_ai_runs_15m',
    'Llamadas a la IA en los últimos 15 minutos, por modelo.',
    extra.ai.map((m) => [{ model: m.model }, m.runs] as [Record<string, string>, number]),
  );
  family(
    'riverrun_ai_tokens_15m',
    'Tokens de la IA en los últimos 15 minutos, por modelo y sentido (input u output).',
    extra.ai.flatMap((m) => [
      [{ model: m.model, kind: 'input' }, m.input] as [Record<string, string>, number],
      [{ model: m.model, kind: 'output' }, m.output] as [Record<string, string>, number],
    ]),
  );
  family(
    'riverrun_ai_cost_usd_15m',
    'Costo de la IA en USD en los últimos 15 minutos, por modelo.',
    extra.ai.map((m) => [{ model: m.model }, m.cost] as [Record<string, string>, number]),
  );
  family(
    'riverrun_ai_latency_p95_ms_15m',
    'Latencia p95 de la IA en milisegundos, últimos 15 minutos, por modelo.',
    extra.ai.map((m) => [{ model: m.model }, m.p95] as [Record<string, string>, number]),
  );
  family('riverrun_db_pool_connections', 'Conexiones a PostgreSQL del proceso.', [
    [{ state: 'total' }, extra.pool.total],
    [{ state: 'idle' }, extra.pool.idle],
    [{ state: 'waiting' }, extra.pool.waiting],
  ]);
  family('riverrun_process_resident_memory_bytes', 'Memoria residente del proceso.', [[{}, extra.rssBytes]]);
  family('riverrun_process_uptime_seconds', 'Segundos desde que arrancó el proceso.', [[{}, Math.round(extra.uptimeSeconds)]]);
  return out.join('\n') + '\n';
}

/** Para pruebas: la siguiente lectura vuelve a consultar la base. */
export function resetMetricsCache() {
  agg = null;
}
