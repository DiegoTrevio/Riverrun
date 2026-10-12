/**
 * Historial de incidencias. Una incidencia abierta por componente: si el mismo componente sigue fallando, se actualiza
 * (última vez vista, detalle, severidad) en vez de crear otra. Los avisos (correo, webhook) los decide monitor.ts; aquí
 * solo se guarda qué pasó, cuándo, si ya se escaló y cuándo salió el último aviso.
 */
import { query } from '../db.js';

export type Severity = 'critica' | 'alta' | 'media' | 'baja';
/** 'fail' = falla confirmada (puede avisar y escalar); 'warn' = degradado (solo se anota, severidad baja). */
export type IncidentStatus = 'fail' | 'warn';
export interface Incident {
  id: number;
  component: string;
  severity: Severity;
  state: 'abierto' | 'resuelto';
  title: string;
  detail: string;
  opened_at: string;
  last_seen_at: string;
  escalated_at: string | null;
  resolved_at: string | null;
  alerted_at: string | null;
}

/** Componentes cuya falla afecta a todos los clientes: se registran como críticas. */
const CRITICAL = new Set(['database', 'scheduler', 'whatsapp']);
export const severityFor = (component: string, status: IncidentStatus = 'fail'): Severity =>
  status === 'warn' ? 'baja' : CRITICAL.has(component) ? 'critica' : 'alta';

/**
 * Abre la incidencia o, si ya hay una abierta para el componente, actualiza su detalle, su severidad (la del último
 * estado visto) y la última vez vista. Devuelve también cuándo salió su último aviso, para no repetirlo tras un reinicio.
 */
export async function openIncident(
  component: string,
  title: string,
  detail: string,
  now = new Date(),
  status: IncidentStatus = 'fail',
): Promise<{ id: number; created: boolean; alerted_at: Date | null }> {
  const [row] = await query<{ id: number; created: boolean; alerted_at: Date | null }>(
    `INSERT INTO incidents (component, severity, state, title, detail, opened_at, last_seen_at)
     VALUES ($1, $2, 'abierto', $3, $4, $5, $5)
     ON CONFLICT (component) WHERE state = 'abierto'
     DO UPDATE SET detail = EXCLUDED.detail, last_seen_at = EXCLUDED.last_seen_at, severity = EXCLUDED.severity
     RETURNING id, (xmax = 0) AS created, alerted_at`,
    [component, severityFor(component, status), title, detail.slice(0, 1000), now],
  );
  return row;
}

/**
 * Cierra la incidencia abierta del componente, si la hay. Devuelve cuándo salió su último aviso (null si el componente
 * no tenía incidencia abierta).
 */
export async function resolveIncident(component: string, now = new Date()): Promise<{ alerted_at: Date | null } | null> {
  const [row] = await query<{ alerted_at: Date | null }>(
    `UPDATE incidents SET state = 'resuelto', resolved_at = $2 WHERE component = $1 AND state = 'abierto' RETURNING alerted_at`,
    [component, now],
  );
  return row ?? null;
}

/** Anota cuándo salió el último aviso de la incidencia (así sobrevive a un reinicio). */
export async function markAlerted(id: number, now = new Date()): Promise<void> {
  await query(`UPDATE incidents SET alerted_at = $2 WHERE id = $1`, [id, now]);
}

/**
 * Abiertas desde hace más de `minutes`, que todavía no se han escalado. Los degradados (baja) nunca escalan: no son un
 * aviso externo.
 */
export async function dueEscalations(minutes: number, now = new Date()): Promise<Pick<Incident, 'id' | 'component' | 'title' | 'detail'>[]> {
  return query(
    `SELECT id, component, title, detail FROM incidents
      WHERE state = 'abierto' AND escalated_at IS NULL AND severity <> 'baja' AND opened_at <= $1
      ORDER BY opened_at`,
    [new Date(now.getTime() - minutes * 60_000)],
  );
}

/**
 * Marca una incidencia como escalada. Es atómico: solo gana quien la marca primero, así dos procesos no envían
 * el mismo aviso dos veces. Devuelve false si ya estaba escalada o cerrada.
 */
export async function markEscalated(id: number, now = new Date()): Promise<boolean> {
  const rows = await query(`UPDATE incidents SET escalated_at = $2 WHERE id = $1 AND escalated_at IS NULL AND state = 'abierto' RETURNING id`, [id, now]);
  return rows.length > 0;
}

export async function listIncidents(limit = 50): Promise<Incident[]> {
  return query<Incident>(
    `SELECT id, component, severity, state, title, detail, opened_at, last_seen_at, escalated_at, resolved_at, alerted_at
       FROM incidents ORDER BY opened_at DESC LIMIT $1`,
    [Math.min(Math.max(1, limit), 500)],
  );
}

/** Cantidad de incidencias abiertas por severidad (para /metrics). */
export async function openBySeverity(): Promise<Record<Severity, number>> {
  const out: Record<Severity, number> = { critica: 0, alta: 0, media: 0, baja: 0 };
  for (const r of await query<{ severity: Severity; n: number }>(`SELECT severity, count(*)::int AS n FROM incidents WHERE state = 'abierto' GROUP BY 1`)) out[r.severity] = r.n;
  return out;
}

/** Borra incidencias cerradas hace más de `days` días. Las abiertas nunca se borran. */
export async function pruneIncidents(days = 180): Promise<number> {
  const rows = await query(`DELETE FROM incidents WHERE state = 'resuelto' AND resolved_at < now() - make_interval(days => $1) RETURNING id`, [days]);
  return rows.length;
}
