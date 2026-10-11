/**
 * Métricas en formato Prometheus (texto), para /metrics con HEALTH_TOKEN.
 *
 * Privacidad: las etiquetas son solo valores fijos (nombre de componente, estado, tipo de canal, severidad). Nada de
 * teléfonos, correos, nombres, IDs de cuenta ni contenido de mensajes o prompts. El texto de las comprobaciones
 * (detail) no se exporta: solo cifras. Si una cifra es desconocida se omite; nunca se publica un 0 inventado.
 */
import { config } from '../config.js';
import { pool, query } from '../db.js';
import type { CheckResult } from '../monitor.js';
import { openBySeverity } from './incidents.js';
import { STATES, stateOf } from './status.js';

export interface MetricsExtra {
  incidents: Record<string, number>;
  channels: { type: string; connection: string; n: number }[];
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

export async function collectMetricsExtra(): Promise<MetricsExtra> {
  const [incidents, channels] = await Promise.all([
    openBySeverity(),
    query<{ type: string; connection: string; n: number }>(
      `SELECT type, CASE WHEN type = 'whatsapp' THEN coalesce(nullif(connection_state, ''), 'sin_conectar') ELSE 'no_aplica' END AS connection, count(*)::int AS n
         FROM channels WHERE active GROUP BY 1, 2`,
    ),
  ]);
  return {
    incidents,
    channels: channels.map((c) => ({ type: label(c.type), connection: label(c.connection), n: c.n })),
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
    'Incidencias abiertas por severidad.',
    Object.entries(extra.incidents).map(([severity, n]) => [{ severity: label(severity) }, n] as [Record<string, string>, number]),
  );
  family(
    'riverrun_channels',
    'Canales activos por tipo y estado de conexión (WhatsApp: open, close, connecting, sin_conectar).',
    extra.channels.map((c) => [{ type: c.type, connection: c.connection }, c.n] as [Record<string, string>, number]),
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
