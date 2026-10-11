/**
 * Diario de incidencias pendientes. Mientras PostgreSQL no responde, una incidencia no se puede guardar en el historial:
 * en vez de perderla, se anota aquí (un JSON por línea, en el volumen de respaldos) y se vuelca en orden cuando la base
 * vuelve. Los avisos no dependen de este diario: salen igual.
 *
 * Solo se anotan cambios de estado (abrir, cerrar), no cada minuto: repetir el mismo estado reemplaza la última entrada
 * del componente, así el archivo no crece mientras dura la caída.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { query } from '../db.js';
import { openIncident, resolveIncident, type IncidentStatus } from './incidents.js';

export type JournalEntry =
  | { op: 'open'; component: string; title: string; detail: string; status: IncidentStatus; at: string }
  | { op: 'resolve'; component: string; at: string };

const MAX_ENTRIES = 500;

export const journalPath = () => path.join(config.monitor.backupDir, 'incidencias-pendientes.jsonl');

const readLines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

/** Añade una entrada (o reemplaza la última del mismo componente si el estado es el mismo). Nunca lanza. */
export function appendJournal(entry: JournalEntry, file = journalPath()): void {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) {
      console.error('No hay carpeta de respaldos (BACKUP_DIR): la incidencia no se pudo anotar en el diario pendiente');
      return;
    }
    const lines = readLines(file);
    const same = (line: string) => {
      const e = JSON.parse(line) as JournalEntry;
      return e.component === entry.component && e.op === entry.op && (e.op === 'resolve' || e.status === (entry as any).status);
    };
    // Último registro del mismo componente: si es el mismo estado, se reemplaza; si no, se añade.
    const idx = lines.map((l) => { try { return JSON.parse(l).component; } catch { return null; } }).lastIndexOf(entry.component);
    if (idx >= 0 && same(lines[idx])) lines[idx] = JSON.stringify(entry);
    else lines.push(JSON.stringify(entry));
    fs.writeFileSync(`${file}.tmp`, lines.slice(-MAX_ENTRIES).join('\n') + '\n');
    fs.renameSync(`${file}.tmp`, file);
  } catch (e: any) {
    console.error('No se pudo anotar la incidencia pendiente', e?.message ?? e);
  }
}

const databaseUp = async () => {
  try {
    await query('SELECT 1');
    return true;
  } catch {
    return false;
  }
};

/**
 * Vuelca el diario a la base, en orden. Si la base sigue caída, se detiene y deja en el archivo lo que falta. Si la base
 * responde pero una entrada no se puede aplicar, esa entrada se descarta y se sigue con las demás. Devuelve cuántas se
 * aplicaron.
 */
export async function flushJournal(file = journalPath()): Promise<number> {
  const lines = readLines(file);
  if (lines.length === 0) return 0;
  let applied = 0;
  for (let i = 0; i < lines.length; i++) {
    let entry: JournalEntry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // línea dañada: no se puede aplicar nunca
    }
    try {
      const at = new Date(entry.at);
      if (entry.op === 'open') await openIncident(entry.component, entry.title, entry.detail, at, entry.status);
      else await resolveIncident(entry.component, at);
      applied++;
    } catch {
      if (!(await databaseUp())) {
        fs.writeFileSync(`${file}.tmp`, lines.slice(i).join('\n') + '\n');
        fs.renameSync(`${file}.tmp`, file);
        return applied; // la base sigue caída: se conserva lo que falta, sin repetir lo ya aplicado
      }
      // La base responde y esta entrada sí falla: no se reintenta para siempre.
      console.error('Se descartó una incidencia pendiente que no se pudo aplicar');
    }
  }
  fs.rmSync(file, { force: true });
  return applied;
}
