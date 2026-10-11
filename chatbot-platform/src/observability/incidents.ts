/**
 * Historial de incidencias. Una incidencia abierta por componente: si el mismo componente sigue fallando, se actualiza
 * (última vez vista, detalle) en vez de crear otra. Los avisos (correo, webhook) los decide monitor.ts; aquí solo se guarda
 * qué pasó, cuándo y si ya se escaló.
 */
import { query } from '../db.js';

export type Severity = 'critica' | 'alta' | 'media' | 'baja';
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
}

/** Componentes cuya falla afecta a todos los clientes: se registran como críticas. */
const CRITICAL = new Set(['database', 'scheduler', 'whatsapp']);
export const severityFor = (component: string): Severity => (CRITICAL.has(component) ? 'critica' : 'alta');

/** Abre la incidencia o, si ya hay una abierta para el componente, actualiza su detalle y la última vez vista. */
export async function openIncident(component: string, title: string, detail: string, now = new Date()): Promise<{ id: number; created: boolean }> {
  const [row] = await query<{ id: number; created: boolean }>(
    `INSERT INTO incidents (component, severity, state, title, detail, opened_at, last_seen_at)
     VALUES ($1, $2, 'abierto', $3, $4, $5, $5)
     ON CONFLICT (component) WHERE state = 'abierto'
     DO UPDATE SET detail = EXCLUDED.detail, last_seen_at = EXCLUDED.last_seen_at
     RETURNING id, (xmax = 0) AS created`,
    [component, severityFor(component), title, detail.slice(0, 1000), now],
  );
  return { id: row.id, created: row.created };
}

/** Cierra la incidencia abierta del componente, si la hay. Devuelve true si había una. */
export async function resolveIncident(component: string, now = new Date()): Promise<boolean> {
  const rows = await query(`UPDATE incidents SET state = 'resuelto', resolved_at = $2 WHERE component = $1 AND state = 'abierto' RETURNING id`, [component, now]);
  return rows.length > 0;
}

/** Abiertas desde hace más de `minutes` y que todavía no se han escalado. */
export async function dueEscalations(minutes: number, now = new Date()): Promise<Pick<Incident, 'id' | 'component' | 'title' | 'detail'>[]> {
  return query(
    `SELECT id, component, title, detail FROM incidents
      WHERE state = 'abierto' AND escalated_at IS NULL AND opened_at <= $1
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
    `SELECT id, component, severity, state, title, detail, opened_at, last_seen_at, escalated_at, resolved_at
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
