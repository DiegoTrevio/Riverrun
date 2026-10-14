/**
 * Agenda del equipo: disponibilidad de cada persona (horario semanal y días libres) y a quién le toca cada cita, por
 * turnos (round robin) o por porcentajes.
 */
import { z } from 'zod';
import { query } from '../db.js';
import { toMinutes } from './time.js';
import { WeeklyHoursSchema, type Service, type WeeklyHours } from './types.js';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato AAAA-MM-DD');
export const TimeOffSchema = z
  .object({ from: DateStr, to: DateStr, note: z.string().trim().max(120).default('') })
  .refine((t) => t.from <= t.to, 'El día final debe ser igual o posterior al inicial');
export type TimeOff = z.infer<typeof TimeOffSchema>;

export const StaffScheduleBodySchema = z.object({
  /** Horario semanal de la persona (null = el horario del negocio). */
  hours: WeeklyHoursSchema.nullable().default(null),
  /** Días libres: vacaciones, permisos… (inclusive). */
  time_off: z.array(TimeOffSchema).max(100).default([]),
});

export interface StaffInfo {
  id: string;
  hours: WeeklyHours | null;
  time_off: TimeOff[];
}

/** Horario y días libres de esas personas (las que no tienen nada guardado siguen el horario del negocio). */
export async function staffInfo(userIds: string[]): Promise<StaffInfo[]> {
  if (!userIds.length) return [];
  const rows = await query<{ user_id: string; hours: WeeklyHours | null; time_off: TimeOff[] }>(
    'SELECT user_id, hours, time_off FROM staff_schedules WHERE user_id = ANY($1::uuid[])',
    [userIds],
  );
  return userIds.map((id) => {
    const r = rows.find((x) => x.user_id === id);
    return { id, hours: r?.hours ?? null, time_off: r?.time_off ?? [] };
  });
}

export async function saveSchedule(accountId: string, userId: string, body: z.infer<typeof StaffScheduleBodySchema>) {
  await query(
    `INSERT INTO staff_schedules (user_id, account_id, hours, time_off) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET hours = $3, time_off = $4, updated_at = now()`,
    [userId, accountId, body.hours === null ? null : JSON.stringify(body.hours), JSON.stringify(body.time_off)],
  );
}

/** ¿Está de días libres esa fecha (hora local del negocio)? */
export const isOff = (s: StaffInfo | undefined, date: string) => !!s?.time_off.some((o) => date >= o.from && date <= o.to);

/** ¿Su horario cubre de `startMin` a `endMin` ese día? Sin horario propio, no se limita aquí (manda el del servicio). */
export function worksDuring(s: StaffInfo | undefined, day: keyof WeeklyHours, startMin: number, endMin: number): boolean {
  if (!s?.hours) return true;
  return (s.hours[day] ?? []).some(([a, b]) => toMinutes(a) <= startMin && endMin <= toMinutes(b));
}

export interface AssignmentStat {
  /** Última cita que se le asignó en este servicio (null = nunca). */
  last: Date | null;
  /** Citas de este servicio en los últimos 30 días (sin contar canceladas). */
  count: number;
}

/** Historial de asignaciones del servicio, para repartir por turnos o por porcentajes. */
export async function assignmentStats(
  serviceId: string,
  userIds: string[],
  client?: { query: (q: string, p: unknown[]) => Promise<{ rows: any[] }> },
): Promise<Map<string, AssignmentStat>> {
  const sql = `SELECT assigned_user_id AS user_id, max(created_at) AS last,
                      count(*) FILTER (WHERE status <> 'cancelled' AND created_at > now() - interval '30 days')::int AS count
                 FROM appointments
                WHERE service_id = $1 AND assigned_user_id = ANY($2::uuid[]) AND source <> 'simulador'
                GROUP BY assigned_user_id`;
  const rows = (client ? (await client.query(sql, [serviceId, userIds])).rows : await query(sql, [serviceId, userIds])) as { user_id: string; last: Date; count: number }[];
  return new Map(userIds.map((id) => {
    const r = rows.find((x) => x.user_id === id);
    return [id, { last: r?.last ? new Date(r.last) : null, count: r?.count ?? 0 }];
  }));
}

/** Peso de cada persona: su porcentaje, o partes iguales si no se le puso. */
export const weightOf = (service: Pick<Service, 'assigned_user_ids' | 'user_weights'>, userId: string) =>
  service.user_weights?.[userId] ?? 100 / Math.max(1, service.assigned_user_ids.length);

/**
 * A quién le toca entre los que están libres en ese horario.
 * - Por turnos: a quien hace más tiempo no se le asigna una cita de este servicio (o nunca).
 * - Por porcentajes: a quien más se ha quedado atrás respecto a su porcentaje ((citas + 1) / porcentaje más bajo). Con
 *   el tiempo el reparto se acerca a los porcentajes. Quien tiene 0 % solo recibe citas si nadie más está libre.
 */
export function pickStaff(service: Pick<Service, 'assigned_user_ids' | 'user_weights' | 'assignment_mode'>, candidates: string[], stats: Map<string, AssignmentStat>): string | null {
  if (!candidates.length) return null;
  const order = (u: string) => service.assigned_user_ids.indexOf(u);
  const lastOf = (u: string) => stats.get(u)?.last?.getTime() ?? -Infinity;
  const byTurn = (a: string, b: string) => lastOf(a) - lastOf(b) || order(a) - order(b);
  if (service.assignment_mode === 'weighted') {
    const weighted = candidates.filter((u) => weightOf(service, u) > 0);
    if (weighted.length) {
      const need = (u: string) => ((stats.get(u)?.count ?? 0) + 1) / weightOf(service, u);
      return [...weighted].sort((a, b) => need(a) - need(b) || weightOf(service, b) - weightOf(service, a) || byTurn(a, b))[0];
    }
  }
  return [...candidates].sort(byTurn)[0];
}
