import { query } from './db.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSource = 'webhook' | 'evolution' | 'ai' | 'validator' | 'engine' | 'admin' | 'system';

export interface LogInput {
  level: LogLevel;
  source: LogSource;
  message: string;
  chatbotId?: string | null;
  conversationId?: string | null;
  details?: unknown;
}

/** Registra actividad/errores en PostgreSQL y en consola. Nunca lanza excepciones. */
export async function logEvent(input: LogInput): Promise<void> {
  const line = `[${input.level}] [${input.source}] ${input.message}`;
  if (input.level === 'error') console.error(line, input.details ?? '');
  else if (input.level === 'warn') console.warn(line);
  else if (process.env.LOG_DEBUG === 'true' || input.level === 'info') console.log(line);
  try {
    await query(
      `INSERT INTO event_logs (chatbot_id, conversation_id, level, source, message, details) VALUES ($1,$2,$3,$4,$5,$6)`,
      [input.chatbotId ?? null, input.conversationId ?? null, input.level, input.source, input.message.slice(0, 2000), JSON.stringify(serialize(input.details ?? {}))],
    );
  } catch (e) {
    console.error('No se pudo guardar el log', e);
  }
}

function serialize(d: unknown): unknown {
  if (d instanceof Error) return { name: d.name, message: d.message, stack: d.stack?.split('\n').slice(0, 5).join('\n') };
  return d;
}

export async function pruneLogs(days: number) {
  await query(`DELETE FROM event_logs WHERE created_at < now() - ($1 || ' days')::interval`, [String(days)]);
}
