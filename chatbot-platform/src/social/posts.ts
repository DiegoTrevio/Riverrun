import crypto from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../access.js';
import { identifyAttachment } from '../attachments.js';
import * as astore from '../automation/store.js';
import { zonedToUtc } from '../automation/time.js';
import { ZernioBusyError } from '../channels/zernio-budget.js';
import { clientFor, idOf, networkOf, ZernioError } from '../channels/zernio.js';
import { query, queryOne, withTransaction } from '../db.js';
import { logEvent } from '../logs.js';
import { hmac, safeEqual } from '../secret.js';
import { assertLive } from './engagement.js';

/**
 * Publicaciones en las redes (Zernio): el negocio escribe una vez, elige sus cuentas y publica ya o programa. Cada red
 * tiene su propio estado y enlace; Zernio avisa por el webhook (post.*) y, si no avisa, se le pregunta.
 */

/* ------------------------------ Reglas de cada red ------------------------------ */

export interface PostRule {
  /** Caracteres (grafemas) del texto. */
  max: number;
  /** Más que esto se avisa (X: 280 sin Premium). */
  warnAbove?: number;
  /** Foto o video obligatorio ('any') o un video ('video'). */
  mediaRequired?: 'any' | 'video';
  maxMedia?: number;
  noVideo?: boolean;
  /** Título propio de la red (YouTube, Pinterest, Reddit) y su largo. */
  title?: number;
  /** Enlace de destino (Pinterest). */
  link?: boolean;
}

/** Límites de la especificación de Zernio (v1.296.1); Zernio vuelve a validar al recibir la publicación. */
export const POST_RULES: Record<string, PostRule> = {
  twitter: { max: 25000, warnAbove: 280, maxMedia: 4 },
  bluesky: { max: 300, maxMedia: 4 },
  threads: { max: 500, maxMedia: 10 },
  instagram: { max: 2200, mediaRequired: 'any', maxMedia: 20 },
  facebook: { max: 63206, maxMedia: 10 },
  linkedin: { max: 3000, maxMedia: 20 },
  tiktok: { max: 2200, mediaRequired: 'any', maxMedia: 35 },
  youtube: { max: 5000, mediaRequired: 'video', maxMedia: 1, title: 100 },
  pinterest: { max: 800, mediaRequired: 'any', maxMedia: 1, title: 100, link: true },
  googlebusiness: { max: 1500, maxMedia: 1, noVideo: true },
  reddit: { max: 40000, title: 300 },
  telegram: { max: 4096, maxMedia: 10 },
};
/** Publicaciones por hora que Zernio acepta en una cuenta. */
const MAX_PER_HOUR = 25;
/** Lo programado no se cambia en sus últimos minutos (YouTube sube el video antes). */
const EDIT_MARGIN_MIN = (platform: string) => (platform === 'youtube' ? 20 : 2);

const graphemes = (t: string) => {
  try {
    return [...new Intl.Segmenter('es', { granularity: 'grapheme' }).segment(t)].length;
  } catch {
    return [...t].length;
  }
};

/* ------------------------------ Datos que llegan del panel ------------------------------ */

const MediaSchema = z.object({
  url: z.string().url().max(2000),
  type: z.enum(['image', 'video']),
  name: z.string().max(200).default(''),
  size: z.number().int().nonnegative().default(0),
  /** Firma del servidor: solo valen archivos subidos por este negocio. */
  token: z.string().max(200),
});
const TargetSchema = z.object({
  social_account_id: z.string().uuid(),
  /** Texto propio para esta red (vacío o null: el general). */
  text: z.string().max(63206).nullable().optional(),
  options: z.object({ title: z.string().trim().max(300).optional(), link: z.string().trim().url().max(2000).optional().or(z.literal('')) }).default({}),
});
export const PublicationInputSchema = z.object({
  client_ref: z.string().uuid().optional(),
  text: z.string().max(63206).default(''),
  media: z.array(MediaSchema).max(35).default([]),
  targets: z.array(TargetSchema).min(1, 'Elige al menos una red').max(20),
  mode: z.enum(['draft', 'now', 'schedule']).default('draft'),
  /** Fecha y hora en el horario del negocio. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Elige la fecha').optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'Elige la hora').optional(),
  version: z.number().int().optional(),
});
export type PublicationInput = z.infer<typeof PublicationInputSchema>;

function valid<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new HttpError(400, r.error.issues[0]?.message || 'Datos inválidos', r.error.issues.map((i) => `${i.path.join('.') || 'valor'}: ${i.message}`));
  return r.data;
}

interface TargetAccount { id: string; platform: string; username: string; display_name: string; zernio_account_id: string }

/** Revisa la publicación contra las reglas de cada red elegida (sin llamar a Zernio). */
export function validatePublication(input: Pick<PublicationInput, 'text' | 'media' | 'targets'>, accounts: TargetAccount[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const videos = input.media.filter((m) => m.type === 'video').length;
  for (const t of input.targets) {
    const a = accounts.find((x) => x.id === t.social_account_id);
    if (!a) continue;
    const rule = POST_RULES[a.platform] ?? { max: 2200 };
    const name = `${networkOf(a.platform)?.label ?? a.platform}${a.username ? ` (@${a.username})` : ''}`;
    const text = (t.text ?? '').trim() ? t.text! : input.text;
    const n = graphemes(text.trim());
    if (!n && !input.media.length) errors.push(`${name}: escribe el texto o agrega una foto o video`);
    if (n > rule.max) errors.push(`${name}: el texto tiene ${n} caracteres y el máximo es ${rule.max}`);
    else if (rule.warnAbove && n > rule.warnAbove) warnings.push(`${name}: más de ${rule.warnAbove} caracteres solo se publica con una cuenta de pago de la red`);
    if (rule.mediaRequired === 'any' && !input.media.length) errors.push(`${name}: necesita una foto o un video`);
    if (rule.mediaRequired === 'video' && !videos) errors.push(`${name}: necesita un video`);
    if (rule.noVideo && videos) errors.push(`${name}: no acepta videos`);
    if (rule.maxMedia !== undefined && input.media.length > rule.maxMedia) errors.push(`${name}: acepta hasta ${rule.maxMedia} archivo${rule.maxMedia === 1 ? '' : 's'}`);
    if (videos > 1 && a.platform !== 'tiktok') errors.push(`${name}: solo un video por publicación`);
    const title = t.options?.title ?? '';
    if (rule.title && graphemes(title) > rule.title) errors.push(`${name}: el título tiene más de ${rule.title} caracteres`);
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

/* ------------------------------ Dependencias ------------------------------ */

type AlertTeam = (accountId: string, o: { title: string; body: string; link?: string; kind?: string }) => Promise<void>;
const deps: { alertTeam: AlertTeam } = { alertTeam: async () => undefined };
export function configurePosts(o: { alertTeam: AlertTeam }) {
  deps.alertTeam = o.alertTeam;
}

/* ------------------------------ Archivos ------------------------------ */

const mediaToken = (accountId: string, url: string, type: string) => hmac(`social-media:${accountId}:${url}:${type}`);

/** Sube una foto o un video a Zernio (con la extensión de su tipo real) y devuelve su dirección firmada para este negocio. */
export async function uploadMedia(accountId: string, buffer: Buffer, fileName: string) {
  const type = identifyAttachment(buffer, fileName);
  // HEIC y AVIF también empiezan con "ftyp": no son video, y las redes no los aceptan.
  const brand = buffer.subarray(8, 12).toString('latin1');
  const okVideo = type?.kind === 'video' && !/^(heic|heix|hevc|mif1|msf1|avif|avis)$/.test(brand);
  if (!type || !(['image/jpeg', 'image/png', 'image/webp'].includes(type.mime) || okVideo)) throw new HttpError(400, 'Sube una foto (JPG, PNG o WEBP) o un video (MP4)');
  const url = await clientFor(null).upload(buffer, `publicacion-${crypto.randomUUID()}${type.ext}`, type.mime);
  const kind = type.kind as 'image' | 'video';
  return { url, type: kind, name: fileName.slice(0, 200), size: buffer.length, token: mediaToken(accountId, url, kind) };
}

/* ------------------------------ Lectura ------------------------------ */

interface PublicationRow {
  id: string; account_id: string; client_ref: string | null; status: string; text: string; media: any[]; scheduled_for: string | null; timezone: string;
  zernio_post_id: string | null; send_seq: number; sent_at: string | null; busy_until: string | null; version: number; error: string;
  notified_at: string | null; published_at: string | null; created_by: string | null; created_at: string; updated_at: string;
}
interface TargetRow {
  id: string; publication_id: string; social_account_id: string | null; zernio_account_id: string; platform: string; username: string;
  text_override: string | null; options: Record<string, string>; status: string; platform_post_id: string; url: string; error: string; published_at: string | null; status_at: string | null;
}

const FINAL = ['publicada', 'parcial', 'fallida', 'cancelada'];
const httpUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : '');

/** Lo que ve el panel (sin ids de Zernio ni de la red) y qué se puede hacer con ella. */
function publicView(p: PublicationRow, targets: TargetRow[]) {
  const soon = p.scheduled_for ? Date.parse(p.scheduled_for) - Date.now() : Infinity;
  const margin = Math.max(...targets.map((t) => EDIT_MARGIN_MIN(t.platform)), 2) * 60_000;
  return {
    id: p.id, status: p.status, text: p.text, media: (p.media ?? []).map((m) => ({ url: m.url, type: m.type, name: m.name ?? '', size: m.size ?? 0, token: m.token ?? '' })),
    scheduled_for: p.scheduled_for, published_at: p.published_at, created_at: p.created_at, error: p.error, version: p.version,
    targets: targets.map((t) => ({
      id: t.id, social_account_id: t.social_account_id, platform: t.platform, username: t.username, status: t.status, url: httpUrl(t.url), error: t.error,
      text: t.text_override, options: t.options ?? {}, published_at: t.published_at,
    })),
    can: {
      edit: p.status === 'borrador' || (p.status === 'programada' && soon > margin),
      cancel: p.status === 'borrador' || (p.status === 'programada' && soon > margin),
      retry: (p.status === 'fallida' || p.status === 'parcial') && !!p.zernio_post_id,
      delete: p.status === 'borrador' || FINAL.includes(p.status),
    },
  };
}

async function loadPublication(accountId: string, id: string) {
  const p = await queryOne<PublicationRow>(`SELECT * FROM social_publications WHERE id = $1 AND account_id = $2`, [id, accountId]);
  if (!p) throw new HttpError(404, 'Publicación no encontrada');
  const targets = await query<TargetRow>(`SELECT * FROM social_publication_targets WHERE publication_id = $1 ORDER BY created_at, platform`, [p.id]);
  return { p, targets };
}

export async function getPublication(accountId: string, id: string) {
  const { p, targets } = await loadPublication(accountId, id);
  return publicView(p, targets);
}

/** Cuentas del negocio donde se puede publicar (conectadas y de una red con publicaciones). */
async function postableAccounts(accountId: string, ids?: string[]): Promise<TargetAccount[]> {
  const rows = await query<TargetAccount & { picture: string }>(
    `SELECT id, platform, username, display_name, picture, zernio_account_id FROM social_accounts
      WHERE account_id = $1 AND status = 'active' ${ids ? 'AND id = ANY($2::uuid[])' : ''} ORDER BY connected_at`, ids ? [accountId, ids] : [accountId]);
  return rows.filter((r) => networkOf(r.platform)?.posts);
}

export const ListFilterSchema = z.object({
  /** Mes a mostrar (YYYY-MM, en el horario del negocio); sin él, lo próximo y lo reciente. */
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

export async function listPublications(accountId: string, f: z.infer<typeof ListFilterSchema>) {
  const tz = (await astore.getSettings(accountId)).timezone;
  const params: unknown[] = [accountId];
  let where = '';
  if (f.month) {
    const [y, m] = f.month.split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    params.push(zonedToUtc(`${f.month}-01`, '00:00', tz), zonedToUtc(`${next}-01`, '00:00', tz));
    where = `AND coalesce(scheduled_for, published_at, created_at) >= $2 AND coalesce(scheduled_for, published_at, created_at) < $3`;
  }
  const pubs = await query<PublicationRow>(
    `SELECT * FROM social_publications WHERE account_id = $1 ${where} ORDER BY coalesce(scheduled_for, published_at, created_at) DESC LIMIT 300`, params);
  const targets = pubs.length ? await query<TargetRow>(`SELECT * FROM social_publication_targets WHERE publication_id = ANY($1::uuid[]) ORDER BY created_at, platform`, [pubs.map((p) => p.id)]) : [];
  const accounts = await postableAccounts(accountId);
  return {
    timezone: tz,
    items: pubs.map((p) => publicView(p, targets.filter((t) => t.publication_id === p.id))),
    accounts: accounts.map((a: any) => ({ id: a.id, platform: a.platform, username: a.username, display_name: a.display_name, picture: httpUrl(a.picture ?? '') })),
    rules: POST_RULES,
  };
}

/* ------------------------------ Crear, cambiar, cancelar ------------------------------ */

/** Un negocio suspendido o en pausa no publica (como con los mensajes). */
async function assertActiveAccount(accountId: string) {
  const a = await queryOne<{ active: boolean; status: string }>(`SELECT active, status FROM accounts WHERE id = $1`, [accountId]);
  if (!a?.active || a.status === 'paused') throw new HttpError(403, 'Tu cuenta está en pausa: no se puede publicar en las redes');
}

/** Valida todo lo que no depende de Zernio y devuelve lo necesario para guardar. */
async function prepare(accountId: string, input: PublicationInput) {
  const accounts = await postableAccounts(accountId, input.targets.map((t) => t.social_account_id));
  const missing = input.targets.filter((t) => !accounts.some((a) => a.id === t.social_account_id));
  if (missing.length) throw new HttpError(400, 'Una de las redes elegidas no está conectada o no permite publicaciones');
  if (new Set(input.targets.map((t) => t.social_account_id)).size !== input.targets.length) throw new HttpError(400, 'Elegiste la misma cuenta dos veces');
  for (const m of input.media) {
    if (!safeEqual(m.token, mediaToken(accountId, m.url, m.type))) throw new HttpError(400, 'Un archivo no se subió desde aquí: vuelve a subirlo');
  }
  const { errors, warnings } = validatePublication(input, accounts);
  // Un borrador puede quedar incompleto; publicar o programar no.
  if (errors.length && input.mode !== 'draft') throw new HttpError(400, errors[0], errors);
  const tz = (await astore.getSettings(accountId)).timezone;
  let scheduledFor: Date | null = null;
  if (input.mode === 'schedule' || (input.mode === 'draft' && input.date && input.time)) {
    if (!input.date || !input.time) throw new HttpError(400, 'Elige la fecha y la hora');
    scheduledFor = zonedToUtc(input.date, input.time, tz);
    // "31 de febrero" o "25:00" no se corren al día siguiente: la fecha debe existir tal cual en el horario del negocio.
    const back = Number.isNaN(scheduledFor.getTime()) ? '' : new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(scheduledFor).replace(', ', 'T');
    if (back !== `${input.date}T${input.time}`) throw new HttpError(400, 'Fecha u hora no válida');
    const margin = Math.max(...accounts.map((a) => EDIT_MARGIN_MIN(a.platform))) * 60_000;
    if (input.mode === 'schedule' && scheduledFor.getTime() < Date.now() + margin) throw new HttpError(400, `Programa al menos ${margin / 60_000} minutos después de ahora`);
    if (scheduledFor.getTime() > Date.now() + 366 * 86400_000) throw new HttpError(400, 'Se puede programar hasta un año adelante');
  }
  if (input.mode !== 'draft') {
    // Zernio acepta 25 publicaciones por hora en cada cuenta.
    const busy = await query<{ social_account_id: string; n: number }>(
      `SELECT t.social_account_id, count(*)::int AS n FROM social_publication_targets t JOIN social_publications p ON p.id = t.publication_id
        WHERE t.social_account_id = ANY($1::uuid[]) AND p.status NOT IN ('borrador', 'cancelada') AND coalesce(p.sent_at, p.created_at) > now() - interval '1 hour'
        GROUP BY t.social_account_id`, [accounts.map((a) => a.id)]);
    const full = busy.find((b) => b.n >= MAX_PER_HOUR);
    if (full) throw new HttpError(429, `Una de tus cuentas ya tiene ${MAX_PER_HOUR} publicaciones en la última hora (el máximo de la red); espera un poco.`);
  }
  return { accounts, warnings, scheduledFor, tz };
}

async function insertTargets(client: { query: (sql: string, params: unknown[]) => Promise<unknown> }, accountId: string, pubId: string, input: PublicationInput, accounts: TargetAccount[]) {
  for (const t of input.targets) {
    const a = accounts.find((x) => x.id === t.social_account_id)!;
    const options = Object.fromEntries(Object.entries(t.options ?? {}).filter(([, v]) => typeof v === 'string' && v.trim()));
    await client.query(
      `INSERT INTO social_publication_targets (publication_id, account_id, social_account_id, zernio_account_id, platform, username, text_override, options)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [pubId, accountId, a.id, a.zernio_account_id, a.platform, a.username, (t.text ?? '').trim() ? t.text : null, JSON.stringify(options)]);
  }
}

export async function createPublication(accountId: string, userId: string | null, raw: unknown) {
  const input = valid(PublicationInputSchema, raw);
  await assertActiveAccount(accountId);
  if (input.mode !== 'draft') assertLive();
  const { accounts, warnings, scheduledFor, tz } = await prepare(accountId, input);
  const created = await withTransaction(async (client) => {
    const row = await client.query<{ id: string }>(
      `INSERT INTO social_publications (account_id, client_ref, text, media, scheduled_for, timezone, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (account_id, client_ref) DO NOTHING RETURNING id`,
      [accountId, input.client_ref ?? null, input.text, JSON.stringify(input.media), scheduledFor, tz, userId]);
    if (!row.rows[0]) return null;
    await insertTargets(client, accountId, row.rows[0].id, input, accounts);
    return row.rows[0].id;
  });
  if (!created) {
    const existing = (await queryOne<PublicationRow>(`SELECT * FROM social_publications WHERE account_id = $1 AND client_ref = $2`, [accountId, input.client_ref]))!;
    // El mismo formulario otra vez después de que la red lo rechazó (y quizá con cambios): se guarda y se envía de nuevo.
    if (existing.status === 'borrador' && existing.error && !existing.busy_until) return updatePublication(accountId, userId, existing.id, { ...input, version: existing.version });
    // Si no, es el mismo envío dos veces: la misma publicación.
    return { ...(await getPublication(accountId, existing.id)), warnings };
  }
  await logEvent({ level: 'info', source: 'admin', message: `Publicación ${input.mode === 'draft' ? 'guardada como borrador' : input.mode === 'now' ? 'enviada a publicar' : 'programada'} (${accounts.length} red${accounts.length === 1 ? '' : 'es'})`, accountId });
  if (input.mode !== 'draft') await send(accountId, created, input.mode === 'now');
  return { ...(await getPublication(accountId, created)), warnings };
}

/** Destinos tal como se mandan a Zernio, a partir de lo que llegó del panel. */
const inputTargets = (input: PublicationInput, accounts: TargetAccount[]): BodyTarget[] => input.targets.map((t) => {
  const a = accounts.find((x) => x.id === t.social_account_id)!;
  return { platform: a.platform, zernio_account_id: a.zernio_account_id, text_override: (t.text ?? '').trim() ? t.text! : null, options: Object.fromEntries(Object.entries(t.options ?? {}).filter(([, v]) => typeof v === 'string' && v.trim())) as Record<string, string> };
});

/**
 * Cambia una publicación. Si ya está en Zernio (programada, o borrador que estuvo programado), primero se cambia allá
 * (PUT con todo: texto, archivos, redes y hora, o "publicar ya", o pasarla a borrador) y solo si Zernio la acepta se
 * guarda aquí: si falla, la publicación queda como estaba en los dos lados. No se borra para volver a crearla (Zernio
 * borraría también sus archivos).
 */
export async function updatePublication(accountId: string, userId: string | null, id: string, raw: unknown) {
  const input = valid(PublicationInputSchema, raw);
  const { p, targets } = await loadPublication(accountId, id);
  if (input.version !== undefined && input.version !== p.version) throw new HttpError(409, 'Alguien más cambió esta publicación: recarga la página');
  if (!publicView(p, targets).can.edit) throw new HttpError(409, p.status === 'programada' ? 'Ya está por publicarse: no se puede cambiar' : 'Esta publicación ya no se puede cambiar');
  await assertActiveAccount(accountId);
  if (input.mode !== 'draft' || p.zernio_post_id) assertLive();
  const { accounts, warnings, scheduledFor, tz } = await prepare(accountId, input);
  // Apartada mientras se cambia: dos cambios a la vez (o un cambio y un envío) no se pisan.
  const claimed = await queryOne<PublicationRow>(
    `UPDATE social_publications SET busy_until = now() + interval '3 minutes'
      WHERE id = $1 AND version = $2 AND status IN ('borrador', 'programada') AND (busy_until IS NULL OR busy_until < now()) RETURNING *`, [p.id, p.version]);
  if (!claimed) throw new HttpError(409, 'Esta publicación se está enviando o alguien más la cambió: recarga la página');
  const saveLocal = () => withTransaction(async (client) => {
    await client.query(`UPDATE social_publications SET text = $2, media = $3, scheduled_for = $4, timezone = $5, error = '', version = version + 1, updated_at = now() WHERE id = $1`,
      [p.id, input.text, JSON.stringify(input.media), scheduledFor, tz]);
    await client.query(`DELETE FROM social_publication_targets WHERE publication_id = $1`, [p.id]);
    await insertTargets(client, accountId, p.id, input, accounts);
  });
  let sendAfter = false;
  try {
    if (claimed.zernio_post_id) {
      const when = input.mode === 'now' ? 'now' : input.mode === 'schedule' ? 'schedule' : 'draft';
      const body = { ...bodyOf({ ...claimed, text: input.text, media: input.media, scheduled_for: scheduledFor, timezone: tz }, inputTargets(input, accounts), when), isDraft: when === 'draft' };
      const r = await zcall(() => clientFor(null).call<any>('PUT', `/posts/${enc(claimed.zernio_post_id!)}`, body, { timeoutMs: 120_000, scopedLimits: true }));
      await saveLocal();
      await applyPost(p.id, r?.post ?? r, { event: 'update' });
      if (when === 'draft') await query(`UPDATE social_publications SET status = 'borrador' WHERE id = $1`, [p.id]);
    } else {
      await saveLocal();
      sendAfter = input.mode !== 'draft';
    }
  } finally {
    await query(`UPDATE social_publications SET busy_until = NULL WHERE id = $1`, [p.id]);
  }
  if (sendAfter) await send(accountId, p.id, input.mode === 'now');
  else await scheduleFollowUp(p.id);
  return { ...(await getPublication(accountId, p.id)), warnings };
}

export async function cancelPublication(accountId: string, id: string) {
  const { p, targets } = await loadPublication(accountId, id);
  if (!publicView(p, targets).can.cancel) throw new HttpError(409, 'Ya no se puede cancelar: está publicándose o ya salió');
  // Se vuelve a revisar el estado al apartarla: un envío que terminó entre medio no se cancela solo aquí.
  const claimed = await queryOne<PublicationRow>(
    `UPDATE social_publications SET busy_until = now() + interval '3 minutes'
      WHERE id = $1 AND status IN ('borrador', 'programada') AND (busy_until IS NULL OR busy_until < now()) RETURNING *`, [p.id]);
  if (!claimed) throw new HttpError(409, 'Esta publicación se está enviando; inténtalo en un momento');
  try {
    if (claimed.zernio_post_id) {
      await zcall(() => clientFor(null).call('DELETE', `/posts/${enc(claimed.zernio_post_id!)}`).catch((e) => { if (!(e instanceof ZernioError && e.status === 404)) throw e; }));
    }
    await query(`UPDATE social_publications SET status = 'cancelada', updated_at = now(), version = version + 1 WHERE id = $1`, [p.id]);
    await query(`UPDATE social_publication_targets SET status = 'cancelada', updated_at = now() WHERE publication_id = $1 AND status IN ('pendiente', 'publicando')`, [p.id]);
  } finally {
    await query(`UPDATE social_publications SET busy_until = NULL WHERE id = $1`, [p.id]);
  }
  return getPublication(accountId, p.id);
}

/** Vuelve a intentar las redes que fallaron (Zernio reintenta la publicación completa). */
export async function retryPublication(accountId: string, id: string) {
  const { p } = await loadPublication(accountId, id);
  if (!['fallida', 'parcial'].includes(p.status) || !p.zernio_post_id) throw new HttpError(409, 'Solo se reintenta una publicación que falló');
  await assertActiveAccount(accountId);
  assertLive();
  const claimed = await query(`UPDATE social_publications SET busy_until = now() + interval '3 minutes', notified_at = NULL WHERE id = $1 AND status IN ('fallida', 'parcial') AND (busy_until IS NULL OR busy_until < now()) RETURNING id`, [p.id]);
  if (!claimed.length) throw new HttpError(409, 'Ya se está reintentando');
  try {
    const r = await zcall(() => clientFor(null).call<any>('POST', `/posts/${enc(p.zernio_post_id!)}/retry`, {}, { timeoutMs: 120_000, scopedLimits: true }));
    await applyPost(p.id, r?.post ?? r, { event: 'retry' });
  } finally {
    await query(`UPDATE social_publications SET busy_until = NULL WHERE id = $1`, [p.id]);
  }
  await scheduleCheck(p.id, new Date(Date.now() + 10 * 60_000));
  return getPublication(accountId, p.id);
}

/** Quita la publicación de la lista (lo programado primero se cancela; un borrador que estuvo en Zernio se quita allá). */
export async function deletePublication(accountId: string, id: string) {
  const { p, targets } = await loadPublication(accountId, id);
  if (!publicView(p, targets).can.delete) throw new HttpError(409, p.status === 'programada' ? 'Primero cancélala' : 'Espera a que termine de publicarse');
  if (p.status === 'borrador' && p.zernio_post_id) {
    await zcall(() => clientFor(null).call('DELETE', `/posts/${enc(p.zernio_post_id!)}`).catch((e) => { if (!(e instanceof ZernioError && e.status === 404)) throw e; }));
  }
  const gone = await query(`DELETE FROM social_publications WHERE id = $1 AND account_id = $2 AND status IN ('borrador', 'publicada', 'parcial', 'fallida', 'cancelada') AND (busy_until IS NULL OR busy_until < now()) RETURNING id`, [p.id, accountId]);
  if (!gone.length) throw new HttpError(409, 'Esta publicación se está enviando; inténtalo en un momento');
  return { ok: true };
}

/* ------------------------------ Envío a Zernio ------------------------------ */

const enc = encodeURIComponent;

interface BodyTarget { platform: string; zernio_account_id: string; text_override: string | null; options: Record<string, string> }

/**
 * Cuerpo de Zernio: texto, archivos, una entrada por cuenta (con su texto y opciones), la hora (o "ya") y en metadata el
 * id de la publicación con su número de envío (así un evento de un envío anterior no se confunde con el actual).
 */
function bodyOf(p: { id: string; text: string; media: any[]; scheduled_for: string | Date | null; timezone: string; send_seq: number }, targets: BodyTarget[], when: 'now' | 'schedule' | 'draft') {
  return {
    content: p.text,
    mediaItems: (p.media ?? []).map((m) => ({ url: m.url, type: m.type })),
    platforms: targets.map((t) => {
      const data: Record<string, unknown> = {};
      if (t.options?.title && POST_RULES[t.platform]?.title) data.title = t.options.title;
      if (t.options?.link && POST_RULES[t.platform]?.link) data.link = t.options.link;
      // TikTok: va a la bandeja de la cuenta (Creator Inbox) y se termina en la app; publicar directo pide permisos y
      // datos de privacidad de cada creador.
      if (t.platform === 'tiktok') data.draft = true;
      return { platform: t.platform, accountId: t.zernio_account_id, ...(t.text_override ? { customContent: t.text_override } : {}), ...(Object.keys(data).length ? { platformSpecificData: data } : {}) };
    }),
    metadata: { publication_id: p.id, send_seq: p.send_seq },
    ...(when === 'now' ? { publishNow: true } : when === 'schedule' && p.scheduled_for ? { scheduledFor: new Date(p.scheduled_for).toISOString(), timezone: p.timezone || 'UTC' } : {}),
  };
}

async function buildBody(pubId: string, now: boolean) {
  const p = (await queryOne<PublicationRow>(`SELECT * FROM social_publications WHERE id = $1`, [pubId]))!;
  const targets = await query<TargetRow>(`SELECT * FROM social_publication_targets WHERE publication_id = $1 AND status <> 'cancelada' ORDER BY created_at`, [pubId]);
  return bodyOf(p, targets, now || !p.scheduled_for ? 'now' : 'schedule');
}

/** ¿La red seguro no recibió la publicación? (un rechazo claro o el límite propio, que no llamó). */
const surelyNotSent = (e: unknown) =>
  e instanceof ZernioBusyError || (e instanceof ZernioError && e.status >= 400 && e.status < 500 && !(e.status === 409 && /idempotency/i.test(JSON.stringify(e.data ?? {}))));

/** Un error de Zernio llega como un aviso claro para el panel. */
function explain(e: unknown): HttpError | unknown {
  if (e instanceof ZernioBusyError) return new HttpError(503, 'Zernio está ocupado en este momento; inténtalo de nuevo en un minuto.');
  if (e instanceof ZernioError) {
    const code = String(e.data?.error?.code ?? e.data?.code ?? '');
    if (e.status === 409 && e.data?.details?.existingPostId) return new HttpError(409, 'Ya publicaste lo mismo en esa cuenta en las últimas 24 horas');
    if (code === 'ACCOUNT_DISCONNECTED') return new HttpError(409, 'Una de las cuentas está desconectada: vuelve a conectarla en Redes sociales');
    if (e.status === 429) return new HttpError(429, 'La red no acepta más publicaciones por ahora en esa cuenta; inténtalo más tarde');
    return new HttpError(e.status >= 400 && e.status < 500 ? 400 : 502, `La red no aceptó la publicación: ${String(e.data?.error?.message ?? e.data?.message ?? e.data?.error ?? e.message).slice(0, 300)}`);
  }
  return e;
}
async function zcall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw explain(e);
  }
}

/**
 * Envía a Zernio. Se aparta primero (dos clics o dos réplicas no la envían dos veces), se deja anotada la revisión antes
 * de llamar (si el proceso se reinicia a medio envío, la revisión lo retoma) y lleva Idempotency-Key: si la respuesta no
 * llega, queda "enviando" y la revisión la vuelve a mandar con la misma llave, que Zernio reconoce y no duplica.
 */
async function send(accountId: string, pubId: string, now: boolean, resend = false) {
  const claimed = await queryOne<PublicationRow>(
    `UPDATE social_publications SET busy_until = now() + interval '3 minutes', status = 'enviando', error = '',
        send_seq = CASE WHEN $2::boolean THEN send_seq ELSE send_seq + 1 END, sent_at = CASE WHEN $2::boolean THEN sent_at ELSE now() END,
        scheduled_for = CASE WHEN $3::boolean THEN NULL ELSE scheduled_for END, updated_at = now()
      WHERE id = $1 AND status = CASE WHEN $2::boolean THEN 'enviando' ELSE 'borrador' END AND zernio_post_id IS NULL AND (busy_until IS NULL OR busy_until < now()) RETURNING *`,
    [pubId, resend, now]);
  if (!claimed) throw new HttpError(409, 'Esta publicación ya se está enviando');
  await scheduleCheck(pubId, new Date(Date.now() + 5 * 60_000));
  try {
    const body = await buildBody(pubId, now);
    const r = await clientFor(null).call<any>('POST', '/posts', body, { idempotencyKey: `pub-${pubId}-${claimed.send_seq}`, timeoutMs: 120_000, scopedLimits: true });
    await applyPost(pubId, r?.post ?? r, { event: 'create' });
  } catch (e) {
    await query(`UPDATE social_publications SET busy_until = NULL WHERE id = $1`, [pubId]);
    if (surelyNotSent(e)) {
      const why = String((e as any)?.data?.error?.message ?? (e as any)?.data?.error ?? (e as any)?.message ?? e).slice(0, 500);
      await query(`UPDATE social_publications SET status = 'borrador', error = $2 WHERE id = $1`, [pubId, why]);
      // Lo rechazó la red sin que nadie esté mirando (reenvío de la revisión): se avisa al equipo.
      if (resend) {
        await deps.alertTeam(accountId, { title: '⚠️ Una publicación no salió', body: `La red la rechazó: ${why}. Quedó como borrador en Publicaciones para corregirla.`, link: '#/publicaciones', kind: 'social_alert' });
      }
      throw explain(e);
    }
    // No se sabe si llegó: la revisión lo confirma o lo vuelve a mandar con la misma llave.
    await scheduleCheck(pubId, new Date(Date.now() + 2 * 60_000));
    await logEvent({ level: 'warn', source: 'channel', message: `Zernio no confirmó una publicación; se revisará en unos minutos: ${(e as any)?.message ?? e}`, accountId });
    return;
  }
  await query(`UPDATE social_publications SET busy_until = NULL WHERE id = $1`, [pubId]);
  await scheduleFollowUp(pubId);
}

/** Lo que sigue en Zernio (programado o publicándose) se revisa después de su hora, por si el webhook no avisa. */
async function scheduleFollowUp(pubId: string) {
  const p = await queryOne<{ status: string; scheduled_for: string | null }>(`SELECT status, scheduled_for FROM social_publications WHERE id = $1`, [pubId]);
  if (p && ['programada', 'publicando', 'enviando'].includes(p.status)) {
    await scheduleCheck(pubId, new Date(Math.max(Date.now(), p.scheduled_for ? Date.parse(p.scheduled_for) : 0) + 10 * 60_000));
  }
}

const POST_STATUS: Record<string, string> = { draft: 'borrador', scheduled: 'programada', publishing: 'publicando', published: 'publicada', partial: 'parcial', failed: 'fallida', cancelled: 'cancelada' };
const TARGET_STATUS: Record<string, string> = { pending: 'pendiente', processing: 'publicando', uploading: 'publicando', published: 'publicada', failed: 'fallida', cancelled: 'cancelada', deleted: 'eliminada' };

/**
 * Guarda lo que dice Zernio de la publicación (respuesta o evento). Un evento no regresa una publicación terminada a
 * "programada" o "publicando" (llegó tarde); una respuesta a un envío, cambio o reintento sí manda.
 */
async function applyPost(pubId: string, post: any, o: { event: string; at?: string | null }) {
  if (!post || typeof post !== 'object') return;
  const zid = idOf(post);
  const status = POST_STATUS[String(post.status ?? '')];
  const fromResponse = ['create', 'update', 'retry', 'check'].includes(o.event);
  await query(
    `UPDATE social_publications SET zernio_post_id = coalesce(zernio_post_id, nullif($2, '')),
        status = CASE WHEN $3::text IS NULL THEN status
                      WHEN NOT $4::boolean AND status IN ('publicada', 'parcial', 'fallida') AND $3 IN ('programada', 'publicando', 'borrador') THEN status
                      ELSE $3 END,
        published_at = CASE WHEN $3 IN ('publicada', 'parcial') THEN coalesce(published_at, now()) ELSE published_at END, updated_at = now()
      WHERE id = $1 AND status <> 'cancelada'`, [pubId, zid, status ?? null, fromResponse]);
  for (const t of Array.isArray(post.platforms) ? post.platforms : []) {
    await applyTarget(pubId, String(t?.platform ?? ''), idOf(t?.accountId) || String(t?.accountId ?? ''), {
      status: TARGET_STATUS[String(t?.status ?? '')], url: t?.platformPostUrl ?? t?.publishedUrl, postId: t?.platformPostId, error: t?.errorMessage ?? t?.error,
    }, { downgrade: false, at: o.at ?? null });
  }
  await afterStatus(pubId);
}

/**
 * Estado de una red. La hora del evento ordena los eventos entre sí (uno más viejo no cambia lo guardado); las
 * respuestas a nuestras llamadas no la mueven. Una red publicada solo pasa a fallida o eliminada si Zernio lo dice
 * después (post.platform.failed o deleted).
 */
async function applyTarget(pubId: string, platform: string, zernioAccountId: string, v: { status?: string; url?: unknown; postId?: unknown; error?: unknown }, o: { downgrade: boolean; at: string | null }) {
  if (!v.status) return;
  const err = typeof v.error === 'string' ? v.error : v.error ? JSON.stringify(v.error) : '';
  await query(
    `UPDATE social_publication_targets SET
        status = CASE WHEN status = 'publicada' AND $4 IN ('fallida', 'pendiente', 'publicando') AND NOT $9::boolean THEN status ELSE $4 END,
        url = coalesce(nullif($5, ''), url), platform_post_id = coalesce(nullif($6, ''), platform_post_id), error = CASE WHEN $4 = 'fallida' THEN $7 ELSE '' END,
        published_at = CASE WHEN $4 = 'publicada' THEN coalesce(published_at, now()) ELSE published_at END,
        status_at = coalesce($8::timestamptz, status_at), updated_at = now()
      WHERE publication_id = $1 AND platform = $2 AND ($3 = '' OR zernio_account_id = $3)
        AND ($8::timestamptz IS NULL OR status_at IS NULL OR status_at <= $8::timestamptz)`,
    [pubId, platform, zernioAccountId, v.status, String(v.url ?? '').slice(0, 2000), String(v.postId ?? '').slice(0, 500), err.slice(0, 500), o.at, o.downgrade]);
}

/** Si falló alguna red, un solo aviso al equipo. */
async function afterStatus(pubId: string) {
  const p = await queryOne<{ account_id: string; status: string; text: string }>(
    `UPDATE social_publications SET notified_at = now() WHERE id = $1 AND status IN ('fallida', 'parcial') AND notified_at IS NULL RETURNING account_id, status, text`, [pubId]);
  if (!p) return;
  const failed = await query<{ platform: string; error: string }>(`SELECT platform, error FROM social_publication_targets WHERE publication_id = $1 AND status = 'fallida'`, [pubId]);
  await deps.alertTeam(p.account_id, {
    title: p.status === 'fallida' ? '⚠️ Una publicación no salió' : '⚠️ Una publicación no salió en todas tus redes',
    body: `"${p.text.slice(0, 80)}${p.text.length > 80 ? '…' : ''}" falló en ${failed.map((f) => networkOf(f.platform)?.label ?? f.platform).join(', ') || 'una red'}${failed[0]?.error ? `: ${failed[0].error.slice(0, 160)}` : ''}. Puedes reintentarla en Publicaciones.`,
    link: '#/publicaciones', kind: 'social_alert',
  });
}

/* ------------------------------ Lo que avisa Zernio ------------------------------ */

/**
 * post.* del webhook. No traen la cuenta arriba: se ubica la publicación por el id de Zernio (o, si la respuesta aún no
 * llega, por metadata con el mismo número de envío) y se exige que el perfil del evento sea del mismo negocio.
 */
export async function handlePostEvent(event: string, body: any) {
  const post = body?.post ?? {};
  const zid = idOf(post);
  let p = zid ? await queryOne<PublicationRow>(`SELECT * FROM social_publications WHERE zernio_post_id = $1`, [zid]) : null;
  const meta = post?.metadata ?? {};
  if (!p && /^[0-9a-f-]{36}$/i.test(String(meta.publication_id ?? '')) && Number.isInteger(Number(meta.send_seq))) {
    p = await queryOne<PublicationRow>(`SELECT * FROM social_publications WHERE id = $1 AND zernio_post_id IS NULL AND status = 'enviando' AND send_seq = $2`,
      [String(meta.publication_id), Number(meta.send_seq)]);
  }
  if (!p) return;
  const external = (Array.isArray(body?.profiles) ? body.profiles : []).map((x: any) => String(x?.externalId ?? '')).filter(Boolean);
  if (external.length && !external.some((x: string) => x === p!.account_id || x.startsWith(`${p!.account_id}:`))) {
    await logEvent({ level: 'warn', source: 'webhook', message: `Zernio: evento ${event} de una publicación con un perfil de otro negocio; se ignora` });
    return;
  }
  const at = typeof body?.timestamp === 'string' && !Number.isNaN(Date.parse(body.timestamp)) ? new Date(body.timestamp).toISOString() : null;
  if (event.startsWith('post.platform.')) {
    const pl = body?.platform ?? {};
    const kind = event.slice('post.platform.'.length);
    await applyTarget(p.id, String(pl.name ?? pl.platform ?? ''), String(body?.account?.accountId ?? body?.account?.id ?? ''), {
      status: kind === 'published' ? 'publicada' : kind === 'failed' ? 'fallida' : kind === 'deleted' ? 'eliminada' : undefined,
      url: pl.publishedUrl ?? pl.platformPostUrl, postId: pl.platformPostId, error: pl.error,
    }, { downgrade: kind === 'failed' || kind === 'deleted', at });
    if (zid) await query(`UPDATE social_publications SET zernio_post_id = coalesce(zernio_post_id, $2) WHERE id = $1`, [p.id, zid]);
    await afterStatus(p.id);
    return;
  }
  await applyPost(p.id, post, { event, at });
}

/* ------------------------------ Revisión (si el webhook no llega) ------------------------------ */

async function scheduleCheck(pubId: string, at: Date) {
  const p = await queryOne<{ account_id: string }>(`SELECT account_id FROM social_publications WHERE id = $1`, [pubId]);
  if (!p) return;
  await astore.scheduleJob({ account_id: p.account_id, type: 'social_post_check', payload: { publication_id: pubId }, run_at: at, dedupe_key: `social_post_check:${pubId}` });
}

/**
 * Revisión de una publicación: reenvía lo que no se confirmó (misma llave) o pregunta a Zernio cómo va. Nunca se rinde
 * en silencio: si algo falla, se vuelve a anotar (hasta un día después de su hora).
 */
export async function checkPublication(payload: { publication_id?: string }) {
  const p = await queryOne<PublicationRow>(`SELECT * FROM social_publications WHERE id = $1`, [String(payload.publication_id ?? '')]);
  if (!p || FINAL.includes(p.status) || p.status === 'borrador') return;
  const until = (p.scheduled_for ? Date.parse(p.scheduled_for) : Date.parse(p.sent_at ?? p.created_at)) + 24 * 3600_000;
  const again = () => (Date.now() < until ? scheduleCheck(p.id, new Date(Date.now() + 10 * 60_000)) : Promise.resolve());
  try {
    if (p.status === 'enviando' && !p.zernio_post_id) {
      // Zernio recuerda la llave 24 h: dentro de ese plazo, reenviar no duplica.
      if (p.sent_at && Date.now() - Date.parse(p.sent_at) < 23 * 3600_000) {
        if (p.busy_until && Date.parse(p.busy_until) > Date.now()) return again();
        await send(p.account_id, p.id, !p.scheduled_for, true);
      } else {
        await query(`UPDATE social_publications SET status = 'fallida', error = 'Zernio no confirmó la publicación: revisa en tus redes antes de volver a publicarla' WHERE id = $1 AND status = 'enviando'`, [p.id]);
        await afterStatus(p.id);
      }
      return;
    }
    if (!p.zernio_post_id) return;
    const r = await clientFor(null, 'background').call<any>('GET', `/posts/${enc(p.zernio_post_id)}`);
    await applyPost(p.id, r?.post ?? r, { event: 'check' });
  } catch (e) {
    if (e instanceof ZernioError && e.status === 404) {
      await query(`UPDATE social_publications SET status = 'cancelada' WHERE id = $1 AND status <> 'publicada'`, [p.id]);
      return;
    }
    // Rechazada al reenviar: ya quedó como borrador y se avisó.
    if (e instanceof HttpError && e.statusCode < 500 && e.statusCode !== 409) return;
    await logEvent({ level: 'warn', source: 'channel', message: `Zernio: no se pudo revisar una publicación; se reintentará: ${(e as any)?.message ?? e}`, accountId: p.account_id });
    return again();
  }
  const after = await queryOne<{ status: string; scheduled_for: string | null }>(`SELECT status, scheduled_for FROM social_publications WHERE id = $1`, [p.id]);
  if (after && !FINAL.includes(after.status) && after.status !== 'borrador' && Date.now() < until) {
    await scheduleCheck(p.id, new Date(Math.max(Date.now() + 10 * 60_000, after.scheduled_for ? Date.parse(after.scheduled_for) + 5 * 60_000 : 0)));
  }
}
