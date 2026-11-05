/**
 * Archivos que la persona adjunta a un pedido del Copiloto (migración 118): una foto de la cámara, un PDF, un CSV… Viven
 * 24 horas, son de esa persona en esa conversación y se borran con la conversación, con los datos de un cliente y con la
 * cuenta. Las herramientas solo reciben su id (`archivo_id`) y el servidor sube los bytes a la ruta del panel que toque
 * (`call.upload`); el modelo nunca ve una ruta de disco.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../access.js';
import { attachmentAbsolutePath } from '../attachments.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import type { UploadFile } from '../routes/util.js';
import type { Ctx } from './registry.js';

export interface CopilotFile {
  id: string; account_id: string; thread_id: string; user_id: string; name: string; mime: string; kind: 'image' | 'document';
  size_bytes: number; sha256: string; file_path: string; created_at: Date; expires_at: Date;
}

/** Topes: por conversación (archivos vigentes) y por cuenta (megas vigentes). */
export const FILE_LIMITS = { perThread: 20, accountBytes: 200 * 1024 * 1024, perMessage: 4 };

const hours = () => Math.max(1, config.copilot.fileHours);

/** Guarda el archivo subido (ya revisado por `readUpload`: el tipo sale de los bytes). */
export async function saveCopilotFile(o: { accountId: string; threadId: string; userId: string; file: UploadFile }): Promise<CopilotFile> {
  const { file } = o;
  if (file.kind !== 'image' && file.kind !== 'document') throw new HttpError(400, 'Adjunta una foto o un documento (PDF, Word, Excel, CSV o texto)');
  const live = await queryOne<{ n: number; bytes: string }>(
    `SELECT count(*) FILTER (WHERE thread_id = $2)::int AS n, coalesce(sum(size_bytes), 0)::bigint AS bytes
       FROM copilot_files WHERE account_id = $1 AND expires_at > now()`,
    [o.accountId, o.threadId],
  );
  if ((live?.n ?? 0) >= FILE_LIMITS.perThread) throw new HttpError(429, `Esta conversación ya tiene ${FILE_LIMITS.perThread} archivos; empieza una nueva para adjuntar más`);
  if (Number(live?.bytes ?? 0) + file.buffer.length > FILE_LIMITS.accountBytes) throw new HttpError(429, 'La cuenta llegó al tope de archivos del Copiloto por hoy; intenta mañana');
  const id = crypto.randomUUID();
  const rel = path.posix.join(o.accountId, 'copilot', `${id}${file.ext}`);
  const abs = attachmentAbsolutePath(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, file.buffer, { flag: 'wx' });
  try {
    return (await queryOne<CopilotFile>(
      `INSERT INTO copilot_files (id, account_id, thread_id, user_id, name, mime, kind, size_bytes, sha256, file_path, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(hours => $11)) RETURNING *`,
      [id, o.accountId, o.threadId, o.userId, file.fileName || `archivo${file.ext}`, file.mime, file.kind, file.buffer.length, file.sha256, rel, hours()],
    ))!;
  } catch (e) {
    await fs.rm(abs, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** Archivos vigentes de esa persona en esa conversación, en el orden pedido; los que no lo son, no vienen. */
export async function ownFiles(ids: string[], threadId: string, userId: string): Promise<CopilotFile[]> {
  if (!ids.length) return [];
  const rows = await query<CopilotFile>(
    `SELECT * FROM copilot_files WHERE id = ANY($1::uuid[]) AND thread_id = $2 AND user_id = $3 AND expires_at > now()`,
    [ids, threadId, userId],
  );
  return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is CopilotFile => !!r);
}

/** Todos los archivos de la conversación (también los vencidos, para describirlos en el historial). */
export async function threadFiles(threadId: string): Promise<CopilotFile[]> {
  return query<CopilotFile>(`SELECT * FROM copilot_files WHERE thread_id = $1 ORDER BY created_at`, [threadId]);
}

export async function getOwnFile(id: string, userId: string, accountId: string): Promise<CopilotFile | null> {
  return queryOne<CopilotFile>(`SELECT * FROM copilot_files WHERE id = $1 AND user_id = $2 AND account_id = $3`, [id, userId, accountId]);
}

const removeDisk = (rels: string[]) => Promise.all(rels.map((r) => fs.rm(attachmentAbsolutePath(r), { force: true }).catch(() => undefined)));

export async function deleteFile(id: string) {
  const rows = await query<{ file_path: string }>(`DELETE FROM copilot_files WHERE id = $1 RETURNING file_path`, [id]);
  await removeDisk(rows.map((r) => r.file_path));
}

/** Al borrar una conversación: sus archivos, del disco también. */
export async function deleteThreadFiles(threadId: string) {
  const rows = await query<{ file_path: string }>(`DELETE FROM copilot_files WHERE thread_id = $1 RETURNING file_path`, [threadId]);
  await removeDisk(rows.map((r) => r.file_path));
}

/**
 * Limpieza periódica: los vencidos (fila y disco) y, por si quedó alguno sin fila (se borró la conversación o la persona),
 * los archivos de cada carpeta `copilot/` más viejos que su vigencia.
 */
export async function sweepCopilotFiles(now = new Date()) {
  const rows = await query<{ file_path: string }>(`DELETE FROM copilot_files WHERE expires_at < $1 RETURNING file_path`, [now]);
  await removeDisk(rows.map((r) => r.file_path));
  const cutoff = now.getTime() - hours() * 3600_000;
  const root = path.resolve(config.uploadsDir);
  let accounts: string[] = [];
  try { accounts = (await fs.readdir(root)).filter((d) => /^[0-9a-f-]{36}$/i.test(d)); } catch { return; }
  for (const a of accounts) {
    const dir = path.join(root, a, 'copilot');
    let names: string[] = [];
    try { names = await fs.readdir(dir); } catch { continue; }
    for (const n of names) {
      const abs = path.join(dir, n);
      const st = await fs.stat(abs).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fs.rm(abs, { force: true }).catch(() => undefined);
    }
  }
}

/** Para una herramienta: los bytes de un archivo adjunto a esta conversación y todavía vigente. */
export async function fileForTool(ctx: Ctx, id: string): Promise<{ buffer: Buffer; name: string; mime: string; kind: CopilotFile['kind'] }> {
  const f = ctx.files?.get(id);
  if (!f || new Date(f.expires_at).getTime() < Date.now()) throw new HttpError(404, 'Ese archivo ya no está: pídele a la persona que lo adjunte otra vez');
  return { buffer: await fs.readFile(attachmentAbsolutePath(f.file_path)), name: f.name, mime: f.mime, kind: f.kind };
}

/** Una línea para el modelo: «archivo_id … · «menu.jpg» (foto, 1.2 MB)». El nombre lo escribió alguien: va limpio. */
export function fileLine(f: Pick<CopilotFile, 'id' | 'name' | 'kind' | 'size_bytes' | 'expires_at'>): string {
  const name = String(f.name).replace(/[\r\n\t«»"`<>{}[\]]+/g, ' ').trim().slice(0, 80);
  const size = f.size_bytes >= 1024 * 1024 ? `${(f.size_bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size_bytes / 1024))} KB`;
  const expired = new Date(f.expires_at).getTime() < Date.now();
  return `- archivo_id ${f.id} · «${name}» (${f.kind === 'image' ? 'foto' : 'documento'}, ${size}${expired ? ', ya venció' : ''})`;
}
