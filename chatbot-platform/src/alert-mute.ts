/**
 * ALERT_MUTE: componentes cuyos avisos no salen (la incidencia sí se registra).
 *
 *   ALERT_MUTE=backup,disk                       silencia sin fecha de fin (así funcionaba antes)
 *   ALERT_MUTE=backup=2026-10-12T18:00:00Z       silencia hasta esa fecha; después vuelven los avisos solos
 *
 * Sin módulos ni configuración: lo usan config.ts (para el monitor) y config-check.ts (para avisar de lo que no se
 * entiende o no vence). Una entrada inválida no silencia nada: el aviso sale, que es el lado seguro.
 */
export interface AlertMute {
  name: string;
  /** Milisegundos desde 1970 en que termina el silencio; null = sin fecha de fin. */
  until: number | null;
}

export interface ParsedAlertMute {
  mutes: AlertMute[];
  /** Entradas que no se entienden (se ignoran). */
  invalid: string[];
  /** Silencios sin fecha de fin: no vuelven a avisar solos. */
  forever: string[];
}

export function parseAlertMute(value: string): ParsedAlertMute {
  const out: ParsedAlertMute = { mutes: [], invalid: [], forever: [] };
  for (const entry of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf('=');
    if (eq < 0) {
      out.mutes.push({ name: entry, until: null });
      out.forever.push(entry);
      continue;
    }
    const name = entry.slice(0, eq).trim();
    const until = Date.parse(entry.slice(eq + 1).trim());
    if (!name || !Number.isFinite(until)) {
      out.invalid.push(entry);
      continue;
    }
    out.mutes.push({ name, until });
  }
  return out;
}

/** ¿Está silenciado el componente en ese momento? */
export const isMuted = (mutes: AlertMute[], name: string, now = Date.now()): boolean =>
  mutes.some((m) => m.name === name && (m.until === null || now < m.until));
