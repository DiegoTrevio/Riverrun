import crypto from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../access.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { detectRisk } from '../engine/safety.js';
import { logEvent } from '../logs.js';
import { clientFor, eventAccountId, eventProfileId, listOf, NETWORKS, networkOf, ZernioError, zernioEnabled, type ZernioClient } from '../channels/zernio.js';
import { ZernioBusyError, type ZernioPriority } from '../channels/zernio-budget.js';

/**
 * Comentarios y reseñas de las redes conectadas por Zernio. Llegan por el webhook de la plataforma (comment.received,
 * review.new, review.updated) o por la revisión diaria; el negocio los ve en "Comentarios" y los contesta, oculta, borra
 * o responde en privado. La IA sugiere respuestas y, si el negocio lo activa, contesta sola lo positivo (nunca lo
 * negativo, lo riesgoso ni lo viejo).
 */

export interface SocialAccountRow {
  id: string;
  account_id: string;
  zernio_account_id: string;
  profile_id: string;
  platform: string;
  username: string;
  display_name: string;
  status: string;
  chatbot_id: string | null;
  comment_settings: Record<string, unknown>;
  engagement_synced_at: string | null;
}

export interface CommentRow {
  id: string;
  account_id: string;
  social_account_id: string;
  post_id: string | null;
  platform: string;
  platform_post_id: string;
  comment_id: string;
  parent_id: string;
  author: { id?: string; name?: string; username?: string; picture?: string };
  is_own: boolean;
  text: string;
  created_at_platform: string | null;
  status: 'nuevo' | 'respondido' | 'oculto' | 'eliminado' | 'ignorado';
  sentiment: string;
  needs_human: boolean;
  ai_suggestion: string;
  reply_text: string;
  reply_comment_id: string;
  reply_source: string;
  replied_by: string | null;
  replied_at: string | null;
  private_reply_at: string | null;
  private_reply_message_id: string;
  liked: boolean;
  meta: Record<string, any>;
  notified_at: string | null;
  received_at: string;
}

export interface ReviewRow {
  id: string;
  account_id: string;
  social_account_id: string;
  platform: string;
  review_id: string;
  author: { id?: string; name?: string; picture?: string };
  rating: number | null;
  recommendation: string;
  location_name: string;
  url: string;
  text: string;
  created_at_platform: string | null;
  status: 'nuevo' | 'respondido' | 'ignorado';
  sentiment: string;
  needs_human: boolean;
  ai_suggestion: string;
  reply_text: string;
  reply_source: string;
  replied_by: string | null;
  replied_at: string | null;
  notified_at: string | null;
  received_at: string;
}

export type Kind = 'comment' | 'review';

/* ------------------------------ Ajustes por cuenta ------------------------------ */

export const CommentSettingsSchema = z.object({
  /** off = solo se guardan; suggest = la IA sugiere al pedirlo; auto = contesta sola lo positivo. */
  mode: z.enum(['off', 'suggest', 'auto']).default('suggest'),
  /** Agente cuyo conocimiento y personalidad se usan (vacío: el de la cuenta o el primero activo). */
  chatbot_id: z.string().uuid().nullable().default(null),
  /** Tope de respuestas automáticas por hora en la cuenta. */
  max_per_hour: z.number().int().min(1).max(30).default(10),
  /** Aviso al equipo: un resumen cada 15 minutos como máximo, o ninguno (las reseñas malas siempre avisan). */
  alerts: z.enum(['digest', 'off']).default('digest'),
});
export type CommentSettings = z.infer<typeof CommentSettingsSchema>;
export const settingsOf = (sa: Pick<SocialAccountRow, 'comment_settings'>): CommentSettings => CommentSettingsSchema.parse(sa.comment_settings ?? {});

/** Valida datos del panel: un dato inválido es un 400 con su motivo (no un error interno). */
function valid<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new HttpError(400, r.error.issues[0]?.message || 'Datos inválidos', r.error.issues.map((i) => `${i.path.join('.') || 'valor'}: ${i.message}`));
  return r.data;
}

/* ------------------------------ Dependencias (las pone ChatService) ------------------------------ */

type AlertTeam = (accountId: string, o: { title: string; body: string; link?: string; kind?: string }) => Promise<void>;
type ScheduleJob = (j: { account_id: string; type: string; payload: Record<string, unknown>; run_at: Date; dedupe_key: string; keepExisting?: boolean }) => Promise<unknown>;
const deps: { alertTeam: AlertTeam; schedule: ScheduleJob } = {
  alertTeam: async () => undefined,
  schedule: async (j) =>
    // Sin pisar el que ya espera: el resumen no se pospone cada vez que llega otro comentario.
    query(`INSERT INTO jobs (account_id, type, payload, run_at, dedupe_key) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [j.account_id, j.type, JSON.stringify(j.payload), j.run_at, j.dedupe_key]),
};
export function configureEngagement(o: { alertTeam: AlertTeam }) {
  deps.alertTeam = o.alertTeam;
}

/* ------------------------------ Lo que permite cada red ------------------------------ */

/** Acciones sobre comentarios según la red (Zernio responde 400 PLATFORM_LIMITATION en las demás). */
const HIDE = new Set(['facebook', 'instagram', 'threads', 'twitter', 'tiktok']);
const LIKE = new Set(['facebook', 'twitter', 'bluesky', 'reddit', 'linkedin']);
export const commentCapabilities = (platform: string) => {
  const n = networkOf(platform);
  return {
    reply: !!n?.comments,
    hide: HIDE.has(platform),
    like: LIKE.has(platform),
    delete: !!n?.comments,
    privateReply: !!n?.privateReply,
  };
};
/** Días tras el comentario en los que Instagram y Facebook aceptan la respuesta privada. */
const PRIVATE_REPLY_DAYS = 7;
/** Más viejo que esto no se contesta solo. */
const AUTO_MAX_DAYS = 7;

/* ------------------------------ Llamadas a Zernio ------------------------------ */

const enc = encodeURIComponent;
const NETWORK_IDS: string[] = NETWORKS.map((n) => n.id);
const zclient = (priority: ZernioPriority = 'interactive') => clientFor(null, priority);

/** Un error de Zernio llega como un aviso claro para el panel. */
function explain(e: unknown): never {
  if (e instanceof ZernioError) {
    const code = String(e.data?.error?.code ?? e.data?.code ?? '');
    if (e.status === 403 && /add.?on|inbox/i.test(JSON.stringify(e.data ?? {}))) {
      throw new HttpError(403, 'La cuenta de Zernio de la plataforma no tiene la bandeja de comentarios (Inbox add-on). Pide al administrador que la active.');
    }
    if (code === 'PLATFORM_LIMITATION' || code === 'PLATFORM_BETA_RESTRICTED') throw new HttpError(400, 'Esta red no permite esa acción.');
    if (e.status === 404) throw new HttpError(404, 'La red ya no tiene ese comentario o publicación.');
    throw new HttpError(502, `La red no aceptó la acción: ${e.message}`);
  }
  throw e;
}

/* ------------------------------ Dueño de un evento ------------------------------ */

/**
 * Cuenta conectada a la que pertenece el evento. Se exige que el perfil (y su externalId, si viene) sea del mismo negocio:
 * un evento con la cuenta de un negocio y el perfil de otro se descarta. Nunca se adopta una cuenta por un comentario.
 */
export async function ownerOf(body: any): Promise<SocialAccountRow | null> {
  const zid = eventAccountId(body);
  if (!zid) return null;
  const sa = await queryOne<SocialAccountRow>(`SELECT * FROM social_accounts WHERE zernio_account_id = $1 AND status <> 'disconnected'`, [zid]);
  if (!sa) return null;
  const profile = eventProfileId(body);
  if (profile && profile !== sa.profile_id) {
    const own = await queryOne(
      `SELECT 1 FROM zernio_profiles WHERE profile_id = $1 AND account_id = $2 UNION ALL SELECT 1 FROM accounts WHERE id = $2 AND zernio_profile_id = $1 LIMIT 1`,
      [profile, sa.account_id]);
    if (!own) return null;
  }
  const external = (Array.isArray(body?.profiles) ? body.profiles : []).map((p: any) => String(p?.externalId ?? '')).filter(Boolean);
  if (external.length && !external.some((x: string) => x === sa.account_id || x.startsWith(`${sa.account_id}:`))) return null;
  return sa;
}

/* ------------------------------ Guardar lo que llega ------------------------------ */

const str = (v: unknown, max = 4000) => (v == null ? '' : String(v)).slice(0, max);
const when = (v: unknown) => {
  const t = Date.parse(String(v ?? ''));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

interface PostInput { platformPostId: string; url?: string; caption?: string; thumbnail?: string; commentCount?: number | null; createdAt?: string | null }

async function upsertPost(sa: SocialAccountRow, p: PostInput): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO social_posts (account_id, social_account_id, platform_post_id, url, caption, thumbnail, comment_count, created_at_platform)
     VALUES ($1, $2, $3, $4, $5, $6, coalesce($7::int, 0), $8)
     ON CONFLICT (social_account_id, platform_post_id) DO UPDATE SET
       url = coalesce(nullif(EXCLUDED.url, ''), social_posts.url), caption = coalesce(nullif(EXCLUDED.caption, ''), social_posts.caption),
       thumbnail = coalesce(nullif(EXCLUDED.thumbnail, ''), social_posts.thumbnail), comment_count = coalesce($7::int, social_posts.comment_count),
       created_at_platform = coalesce(social_posts.created_at_platform, EXCLUDED.created_at_platform), updated_at = now()
     RETURNING id`,
    [sa.account_id, sa.id, str(p.platformPostId, 500), str(p.url, 2000), str(p.caption, 2000), str(p.thumbnail, 2000), p.commentCount ?? null, p.createdAt ?? null]);
  return row!.id;
}

interface CommentInput {
  commentId: string;
  platformPostId: string;
  parentId: string;
  author: CommentRow['author'];
  ownFlag: boolean;
  text: string;
  createdAt: string | null;
  meta: Record<string, unknown>;
}

/**
 * Guarda un comentario (una sola vez por red y comentario). Lo que ya se respondió, ocultó o ignoró no cambia: una nueva
 * llegada solo actualiza el texto, el autor y los datos de la red. Devuelve la fila y si es nueva.
 */
async function storeComment(sa: SocialAccountRow, postId: string, c: CommentInput, o: { notified: boolean }): Promise<{ row: CommentRow; inserted: boolean }> {
  const own = c.ownFlag
    || (!!c.author.username && !!sa.username && c.author.username.toLowerCase() === sa.username.toLowerCase())
    || !!(await queryOne(`SELECT 1 FROM social_comments WHERE social_account_id = $1 AND reply_comment_id = $2`, [sa.id, c.commentId]));
  const row = await queryOne<CommentRow & { inserted: boolean }>(
    `INSERT INTO social_comments (account_id, social_account_id, post_id, platform, platform_post_id, comment_id, parent_id, author, is_own, text, created_at_platform, meta, notified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $13::boolean THEN now() END)
     ON CONFLICT (social_account_id, comment_id) DO UPDATE SET
       text = EXCLUDED.text, author = EXCLUDED.author, meta = social_comments.meta || EXCLUDED.meta,
       is_own = social_comments.is_own OR EXCLUDED.is_own, updated_at = now()
     RETURNING *, (xmax = 0) AS inserted`,
    [sa.account_id, sa.id, postId, sa.platform, str(c.platformPostId, 500), str(c.commentId, 500), str(c.parentId, 500), JSON.stringify(c.author), own, str(c.text),
      c.createdAt, JSON.stringify(c.meta), o.notified]);
  return { row: row!, inserted: row!.inserted };
}

const authorOf = (a: any): CommentRow['author'] => ({
  id: str(a?.id, 200), name: str(a?.name ?? a?.displayName, 200), username: str(a?.username, 200), picture: str(a?.picture ?? a?.profileImage ?? a?.profilePicture, 1000),
});

/** comment.received: comment{ id, platformPostId, text, author{…, isOwnAccount}, createdAt, isReply, parentCommentId }, post{…}. */
export async function handleCommentEvent(body: any) {
  const sa = await ownerOf(body);
  if (!sa) {
    await logEvent({ level: 'warn', source: 'webhook', message: `Zernio: comentario de una cuenta que no es de este negocio o no está conectada (${eventAccountId(body)}); se ignora` });
    return;
  }
  const c = body?.comment ?? {};
  const platformPostId = str(c.platformPostId ?? body?.post?.platformPostId ?? c.postId, 500);
  if (!c.id || !platformPostId) return;
  const postId = await upsertPost(sa, {
    platformPostId, url: body?.post?.permalink, caption: body?.post?.content, thumbnail: body?.post?.imageUrl, createdAt: null,
  });
  const { row, inserted } = await storeComment(sa, postId, {
    commentId: String(c.id), platformPostId, parentId: c.isReply ? str(c.parentCommentId, 500) : '', author: authorOf(c.author),
    ownFlag: !!c.author?.isOwnAccount, text: str(c.text), createdAt: when(c.createdAt),
    meta: { ...(c.ad ? { ad: true } : {}), ...(c.attachment ? { attachment: c.attachment } : {}) },
  }, { notified: false });
  // También en un reintento del evento si lo de después no terminó (los avisos y tareas no se repiten: llevan su marca).
  if (inserted || !row.notified_at) await afterComment(sa, row, { synced: false });
}

/** review.new / review.updated (Google): review{ id, rating, text, reviewer{…}, createdAt, hasReply, reply{ text } }. */
export async function handleReviewEvent(body: any) {
  const sa = await ownerOf(body);
  if (!sa) {
    await logEvent({ level: 'warn', source: 'webhook', message: `Zernio: reseña de una cuenta que no es de este negocio o no está conectada (${eventAccountId(body)}); se ignora` });
    return;
  }
  const r = body?.review ?? {};
  if (!r.id) return;
  const { row, inserted } = await storeReview(sa, {
    id: String(r.id), author: authorOf(r.reviewer), rating: r.rating, text: r.text, createdAt: when(r.createdAt), reply: r.hasReply ? str(r.reply?.text) : '',
    recommendation: '', locationName: '', url: '',
  }, { notified: false });
  if (inserted || !row.notified_at) await afterReview(sa, row, { synced: false });
}

interface ReviewInput { id: string; author: ReviewRow['author']; rating: unknown; text: unknown; createdAt: string | null; reply: string; recommendation: string; locationName: string; url: string }

async function storeReview(sa: SocialAccountRow, r: ReviewInput, o: { notified: boolean }): Promise<{ row: ReviewRow; inserted: boolean }> {
  const rating = Number(r.rating);
  const row = await queryOne<ReviewRow & { inserted: boolean }>(
    `INSERT INTO social_reviews (account_id, social_account_id, platform, review_id, author, rating, recommendation, location_name, url, text, created_at_platform, notified_at,
       status, reply_text, reply_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $12::boolean THEN now() END,
       CASE WHEN $13 <> '' THEN 'respondido' ELSE 'nuevo' END, $13, CASE WHEN $13 <> '' THEN 'external' ELSE '' END)
     ON CONFLICT (social_account_id, review_id) DO UPDATE SET
       text = EXCLUDED.text, author = EXCLUDED.author, rating = EXCLUDED.rating, updated_at = now(),
       -- Respondida fuera de la plataforma (o eco de la nuestra): se marca, sin borrar quién la respondió aquí.
       status = CASE WHEN $13 <> '' AND social_reviews.status = 'nuevo' THEN 'respondido' ELSE social_reviews.status END,
       reply_text = CASE WHEN $13 <> '' AND social_reviews.reply_text = '' THEN $13 ELSE social_reviews.reply_text END,
       reply_source = CASE WHEN $13 <> '' AND social_reviews.reply_source = '' THEN 'external' ELSE social_reviews.reply_source END
     RETURNING *, (xmax = 0) AS inserted`,
    [sa.account_id, sa.id, sa.platform, str(r.id, 500), JSON.stringify(r.author), Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
      str(r.recommendation, 40), str(r.locationName, 300), str(r.url, 2000), str(r.text), r.createdAt, o.notified, str(r.reply)]);
  return { row: row!, inserted: row!.inserted };
}

/* ------------------------------ Después de guardar: avisos y respuesta automática ------------------------------ */

const label = (platform: string) => networkOf(platform)?.label ?? platform;
const who = (a: { name?: string; username?: string }) => a.name || (a.username ? `@${a.username}` : 'Alguien');
const ageDays = (iso: string | null, fallback: string) => (Date.now() - Date.parse(iso ?? fallback)) / 86400_000;

async function afterComment(sa: SocialAccountRow, row: CommentRow, o: { synced: boolean }) {
  if (row.is_own) {
    // Respuesta del negocio desde la red (o desde Zernio): el comentario al que contesta queda respondido.
    if (row.parent_id) {
      await query(
        `UPDATE social_comments SET status = 'respondido', reply_text = $3, reply_comment_id = $4, reply_source = 'external', replied_at = now(), updated_at = now()
          WHERE social_account_id = $1 AND comment_id = $2 AND status = 'nuevo' AND reply_comment_id = ''`,
        [sa.id, row.parent_id, row.text, row.comment_id]);
    }
    return;
  }
  const risk = detectRisk(row.text);
  if (risk) {
    await query(`UPDATE social_comments SET needs_human = true, updated_at = now() WHERE id = $1`, [row.id]);
    if (await claimNotice('social_comments', row.id)) {
      await deps.alertTeam(sa.account_id, {
        title: `⚠️ Comentario delicado en ${label(sa.platform)}`, body: `${who(row.author)}: "${row.text.slice(0, 200)}". Revísalo y contesta en persona.`, link: '#/comentarios', kind: 'safety',
      });
    }
    return;
  }
  await afterNew(sa, 'comment', row.id, o.synced);
}

async function afterReview(sa: SocialAccountRow, row: ReviewRow, o: { synced: boolean }) {
  if (row.status !== 'nuevo') return;
  const bad = row.rating !== null && row.rating <= 3;
  const risk = detectRisk(row.text);
  if (bad || risk) {
    if (risk) await query(`UPDATE social_reviews SET needs_human = true, updated_at = now() WHERE id = $1`, [row.id]);
    // Una reseña mala avisa al momento (también las que trae la revisión diaria: nadie las había visto).
    if (await claimNotice('social_reviews', row.id)) {
      await deps.alertTeam(sa.account_id, {
        title: `⭐ Reseña de ${row.rating ?? '?'} estrellas en ${label(sa.platform)}`,
        body: `${who(row.author)}: "${(row.text || 'sin texto').slice(0, 200)}". Contéstala desde Comentarios.`, link: '#/comentarios?tipo=review', kind: risk ? 'safety' : 'social_alert',
      });
    }
    return;
  }
  await afterNew(sa, 'review', row.id, o.synced);
}

/** Marca el aviso como dado (una sola vez aunque el evento se procese de nuevo). */
async function claimNotice(table: 'social_comments' | 'social_reviews', id: string) {
  return (await query(`UPDATE ${table} SET notified_at = now() WHERE id = $1 AND notified_at IS NULL RETURNING id`, [id])).length > 0;
}

async function afterNew(sa: SocialAccountRow, kind: Kind, id: string, synced: boolean) {
  const settings = settingsOf(sa);
  if (settings.alerts === 'digest' && !(synced && !sa.engagement_synced_at)) {
    // La primera revisión (al conectar) no avisa de todo lo viejo; después, un resumen cada 15 minutos como máximo.
    await deps.schedule({ account_id: sa.account_id, type: 'social_digest', payload: { account_id: sa.account_id }, run_at: new Date(Date.now() + 15 * 60_000), dedupe_key: `social_digest:${sa.account_id}` });
  }
  // Solo lo que llega en el momento se contesta solo (lo de la revisión diaria ya no es reciente).
  if (settings.mode === 'auto' && !synced) {
    await deps.schedule({ account_id: sa.account_id, type: 'social_autoreply', payload: { kind, id }, run_at: new Date(), dedupe_key: `social_autoreply:${id}` });
  }
}

/** Resumen de lo nuevo sin avisar (cada 15 minutos como máximo por negocio). */
export async function runDigest(p: { account_id?: string }) {
  const accountId = String(p.account_id ?? '');
  if (!accountId) return;
  const rows = await query<{ kind: string; n: number }>(
    `WITH c AS (UPDATE social_comments SET notified_at = now() WHERE account_id = $1 AND notified_at IS NULL AND NOT is_own AND status = 'nuevo' RETURNING 1),
          r AS (UPDATE social_reviews SET notified_at = now() WHERE account_id = $1 AND notified_at IS NULL AND status = 'nuevo' RETURNING 1)
     SELECT 'comment' AS kind, count(*)::int AS n FROM c UNION ALL SELECT 'review', count(*)::int FROM r`, [accountId]);
  const comments = rows.find((r) => r.kind === 'comment')?.n ?? 0;
  const reviews = rows.find((r) => r.kind === 'review')?.n ?? 0;
  if (!comments && !reviews) return;
  const parts = [comments ? `${comments} comentario${comments === 1 ? '' : 's'}` : '', reviews ? `${reviews} reseña${reviews === 1 ? '' : 's'}` : ''].filter(Boolean);
  await deps.alertTeam(accountId, { title: `💬 ${parts.join(' y ')} nuevo${comments + reviews === 1 ? '' : 's'} en tus redes`, body: 'Revísalos y contéstalos desde Comentarios.', link: '#/comentarios', kind: 'social' });
}

/* ------------------------------ Revisión (al conectar y una vez al día) ------------------------------ */

/**
 * Trae lo de los últimos 30 días: las publicaciones con comentarios (solo se abren las que cambiaron, hasta 5) y las
 * reseñas. Lo que ya estaba no cambia de estado. X no avisa de comentarios por webhook: solo llegan por aquí.
 */
export async function syncEngagement(socialAccountId: string, opts: { first?: boolean } = {}) {
  const sa = await queryOne<SocialAccountRow & { messages_days: string | null }>(
    `SELECT s.*, a.settings->'retention'->>'messages_days' AS messages_days FROM social_accounts s JOIN accounts a ON a.id = s.account_id WHERE s.id = $1`, [socialAccountId]);
  if (!sa || sa.status === 'disconnected') return;
  const net = networkOf(sa.platform);
  if (!net || (!net.comments && !net.reviews)) return;
  // La primera revisión (al conectar) no avisa de lo viejo.
  const first = opts.first ?? !sa.engagement_synced_at;
  if (first) sa.engagement_synced_at = null;
  // Lo que la retención del negocio ya borró no se vuelve a traer.
  const keepDays = Math.min(30, Number(sa.messages_days) > 0 ? Number(sa.messages_days) : 30);
  const since = new Date(Date.now() - keepDays * 86400_000);
  const client = zclient('background');
  const zid = enc(sa.zernio_account_id);
  try {
    if (net.comments) {
      const posts = listOf(await client.call('GET', `/inbox/comments?accountId=${zid}&since=${enc(since.toISOString())}&limit=50`), 'data');
      let opened = 0;
      for (const p of posts) {
        // Los anuncios (complemento de Ads de Zernio) no son publicaciones que se abran aquí.
        if (p?.isAd) continue;
        const platformPostId = str(p?.platformPostId ?? p?.id, 500);
        if (!platformPostId) continue;
        const count = Number(p?.commentCount ?? 0);
        const before = await queryOne<{ comment_count: number }>(`SELECT comment_count FROM social_posts WHERE social_account_id = $1 AND platform_post_id = $2`, [sa.id, platformPostId]);
        // El número de comentarios se guarda hasta que se trajeron: una publicación que no se abrió (tope o error) se
        // abre en la siguiente revisión.
        const postId = await upsertPost(sa, { platformPostId, url: p?.permalink, caption: p?.content, thumbnail: p?.picture, commentCount: before ? null : 0, createdAt: when(p?.createdTime) });
        if (!count || before?.comment_count === count || opened >= 5) continue;
        opened++;
        await syncPostComments(client, sa, postId, platformPostId, since);
        await query(`UPDATE social_posts SET comment_count = $2 WHERE id = $1`, [postId, count]);
      }
    }
    if (net.reviews) {
      const r = await client.call('GET', `/inbox/reviews?accountId=${zid}&limit=50`);
      for (const x of listOf(r, 'data')) {
        if (!x?.id) continue;
        if (when(x.created) && Date.parse(when(x.created)!) < since.getTime()) continue;
        const { row, inserted } = await storeReview(sa, {
        id: String(x.id), author: authorOf(x.reviewer), rating: x.rating, text: x.text, createdAt: when(x.created), reply: x.hasReply ? str(x.reply?.text) : '',
        recommendation: str(x.recommendationType, 40), locationName: str(x.locationName, 300), url: str(x.reviewUrl, 2000),
        }, { notified: first });
        if (inserted) await afterReview(sa, row, { synced: true });
      }
    }
  } catch (e) {
    // Sin el complemento Inbox en Zernio no hay comentarios ni reseñas: se avisa sin reintentar cada hora.
    if (e instanceof ZernioError && e.status === 403) {
      await query(`UPDATE social_accounts SET engagement_synced_at = now() WHERE id = $1`, [sa.id]);
      await logEvent({ level: 'warn', source: 'channel', message: 'Zernio no permite leer comentarios ni reseñas (¿falta el complemento Inbox en la cuenta de Zernio de la plataforma?)', accountId: sa.account_id });
      return;
    }
    throw e;
  }
  await query(`UPDATE social_accounts SET engagement_synced_at = now() WHERE id = $1`, [sa.id]);
}

async function syncPostComments(client: ZernioClient, sa: SocialAccountRow, postId: string, platformPostId: string, since: Date) {
  const r = await client.call<any>('GET', `/inbox/comments/${enc(platformPostId)}?accountId=${enc(sa.zernio_account_id)}&limit=100`);
  const post = r?.post ?? {};
  if (post.permalink || post.text || post.thumbnailUrl) await upsertPost(sa, { platformPostId, url: post.permalink, caption: post.text, thumbnail: post.thumbnailUrl });
  const flat: any[] = [];
  for (const c of listOf(r, 'comments')) {
    flat.push(c);
    for (const reply of Array.isArray(c?.replies) ? c.replies : []) flat.push({ ...reply, parentId: reply?.parentId ?? c.id });
  }
  for (const c of flat) {
    if (!c?.id) continue;
    const created = when(c.createdTime);
    if (created && Date.parse(created) < since.getTime()) continue;
    const { row, inserted } = await storeComment(sa, postId, {
      commentId: String(c.id), platformPostId, parentId: str(c.parentId, 500), author: authorOf(c.from), ownFlag: !!c.from?.isOwner, text: str(c.message ?? c.text),
      createdAt: when(c.createdTime), meta: {
        ...(c.cid ? { cid: c.cid } : {}), ...(c.rootUri ? { rootUri: c.rootUri } : {}), ...(c.rootCid ? { rootCid: c.rootCid } : {}), ...(c.likeUri ? { likeUri: c.likeUri } : {}),
        ...(c.isHidden ? { hidden: true } : {}),
      },
    }, { notified: !sa.engagement_synced_at });
    if (inserted && c.isHidden) await query(`UPDATE social_comments SET status = 'oculto' WHERE id = $1 AND status = 'nuevo'`, [row.id]);
    if (inserted) await afterComment(sa, row, { synced: true });
  }
}

/** Cuentas por revisar (una vez al día cada una), pocas a la vez para no gastar el límite de la llave. */
export async function syncDue(limit = 20) {
  const platforms = networkIds((n) => n.comments || n.reviews);
  // Se apartan antes de revisarlas: varias réplicas no revisan las mismas cuentas.
  const rows = await query<{ id: string; prev: string | null }>(
    `WITH due AS (
       SELECT id, engagement_synced_at AS prev FROM social_accounts
        WHERE status = 'active' AND platform = ANY($1::text[]) AND (engagement_synced_at IS NULL OR engagement_synced_at < now() - interval '24 hours')
        ORDER BY engagement_synced_at NULLS FIRST LIMIT $2 FOR UPDATE SKIP LOCKED)
     UPDATE social_accounts s SET engagement_synced_at = now() FROM due WHERE s.id = due.id RETURNING s.id, due.prev`, [platforms, limit]);
  for (const r of rows) {
    await syncEngagement(r.id, { first: r.prev === null }).catch((e) =>
      logEvent({ level: 'warn', source: 'channel', message: `Zernio: no se pudieron revisar comentarios y reseñas: ${e?.message ?? e}` }));
  }
}
const networkIds = (pick: (n: NonNullable<ReturnType<typeof networkOf>>) => boolean) => NETWORK_IDS.filter((id) => pick(networkOf(id)!));

/**
 * Revisión de cada hora: unas cuantas cuentas a la vez, cada una una vez al día. El webhook de la plataforma (y sus
 * eventos nuevos) lo pone al día la revisión de salud, que además avisa si Zernio lo había apagado.
 */
export function startSocialSync(intervalMs = 3600_000) {
  const run = () => {
    if (!zernioEnabled()) return;
    void syncDue().catch((e) => logEvent({ level: 'error', source: 'channel', message: `Revisión de comentarios y reseñas: ${e?.message ?? e}` }));
  };
  setTimeout(run, 10 * 60_000).unref();
  setInterval(run, intervalMs).unref();
}

/* ------------------------------ Acciones del panel ------------------------------ */

async function loadComment(accountId: string, id: string) {
  const row = await queryOne<CommentRow & { sa_status: string; zernio_account_id: string }>(
    `SELECT c.*, s.status AS sa_status, s.zernio_account_id FROM social_comments c JOIN social_accounts s ON s.id = c.social_account_id WHERE c.id = $1 AND c.account_id = $2`,
    [id, accountId]);
  if (!row) throw new HttpError(404, 'Comentario no encontrado');
  if (row.sa_status === 'disconnected') throw new HttpError(409, 'La cuenta de esta red ya no está conectada');
  return row;
}

async function loadReview(accountId: string, id: string) {
  const row = await queryOne<ReviewRow & { sa_status: string; zernio_account_id: string }>(
    `SELECT r.*, s.status AS sa_status, s.zernio_account_id FROM social_reviews r JOIN social_accounts s ON s.id = r.social_account_id WHERE r.id = $1 AND r.account_id = $2`,
    [id, accountId]);
  if (!row) throw new HttpError(404, 'Reseña no encontrada');
  if (row.sa_status === 'disconnected') throw new HttpError(409, 'La cuenta de esta red ya no está conectada');
  return row;
}

/** En modo de prueba (OUTBOUND_MODE=sandbox) nada se publica en las redes. */
export function assertLive() {
  if (config.outbound.mode !== 'live') throw new HttpError(403, 'OUTBOUND_MODE=sandbox: en modo de prueba no se publica nada en las redes.');
}

const ReplyText = z.string().trim().min(1, 'Escribe la respuesta').max(2000, 'La respuesta es muy larga (máximo 2000 caracteres)');
/**
 * ¿La red seguro no publicó? Un rechazo (4xx) o el límite propio (no se llamó). Con un error del servidor o sin respuesta
 * no se sabe: la respuesta queda apartada hasta que llegue su eco o pasen 10 minutos (reintentarla podría duplicarla).
 */
const surelyNotSent = (e: unknown) => e instanceof ZernioBusyError || (e instanceof ZernioError && e.status >= 400 && e.status < 500);
const UNCERTAIN = 'La red no confirmó si se publicó. Si salió, aparecerá como respondido en unos minutos; si no, podrás intentarlo de nuevo en 10 minutos.';
const keyOf = (prefix: string, id: string, text: string) => `${prefix}-${id}-${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}`;

/** Responde un comentario en público (una sola respuesta por comentario; dos clics no la duplican). */
export async function replyComment(accountId: string, id: string, text: string, source: 'human' | 'suggested' | 'auto', userId: string | null) {
  const message = valid(ReplyText, text);
  const c = await loadComment(accountId, id);
  if (c.is_own) throw new HttpError(400, 'Es un comentario del propio negocio');
  if (!commentCapabilities(c.platform).reply) throw new HttpError(400, 'Esta red no permite responder comentarios');
  if (c.status === 'eliminado') throw new HttpError(409, 'El comentario se eliminó');
  assertLive();
  // Se aparta antes de llamar a la red: otra respuesta al mismo tiempo (o un reintento) no sale dos veces.
  const claimed = await query(
    `UPDATE social_comments SET replied_at = now(), meta = meta - 'reply_uncertain' WHERE id = $1 AND reply_comment_id = ''
        AND (replied_at IS NULL OR replied_at < now() - CASE WHEN meta ? 'reply_uncertain' THEN interval '10 minutes' ELSE interval '2 minutes' END) RETURNING id`, [c.id]);
  if (!claimed.length) throw new HttpError(409, 'Este comentario ya se respondió');
  try {
    const r = await zclient().call<any>('POST', `/inbox/comments/${enc(c.platform_post_id)}`, {
      accountId: c.zernio_account_id, message, commentId: c.comment_id,
      ...(c.meta?.cid ? { parentCid: c.meta.cid, rootUri: c.meta.rootUri ?? undefined, rootCid: c.meta.rootCid ?? undefined } : {}),
    }, { idempotencyKey: keyOf('comment-reply', c.id, message) });
    const replyId = str(r?.data?.commentId ?? r?.commentId ?? r?.data?.id ?? r?.id, 500) || `sent:${c.id}`;
    await query(
      `UPDATE social_comments SET status = CASE WHEN status = 'oculto' THEN status ELSE 'respondido' END, reply_text = $2, reply_comment_id = $3, reply_source = $4,
         replied_by = $5, replied_at = now(), updated_at = now() WHERE id = $1`, [c.id, message, replyId, source, userId]);
  } catch (e) {
    if (!surelyNotSent(e)) {
      await query(`UPDATE social_comments SET meta = meta || '{"reply_uncertain": true}'::jsonb WHERE id = $1`, [c.id]);
      throw new HttpError(502, UNCERTAIN);
    }
    await query(`UPDATE social_comments SET replied_at = NULL WHERE id = $1 AND reply_comment_id = ''`, [c.id]);
    explain(e);
  }
  return getComment(accountId, c.id);
}

/**
 * Respuesta privada (mensaje directo a quien comentó): Instagram y Facebook, una por comentario y hasta 7 días después.
 * Si la red dice que ya se usó (o no se sabe si salió), queda gastada: repetirla podría mandar dos mensajes.
 */
export async function privateReply(accountId: string, id: string, text: string) {
  const message = valid(ReplyText, text);
  const c = await loadComment(accountId, id);
  if (c.is_own) throw new HttpError(400, 'Es un comentario del propio negocio');
  if (!commentCapabilities(c.platform).privateReply) throw new HttpError(400, 'Esta red no permite responder en privado a un comentario');
  if (ageDays(c.created_at_platform, c.received_at) > PRIVATE_REPLY_DAYS) throw new HttpError(409, `La red solo permite responder en privado durante ${PRIVATE_REPLY_DAYS} días después del comentario`);
  assertLive();
  const claimed = await query(
    `UPDATE social_comments SET private_reply_at = now(), meta = meta || jsonb_build_object('private_reply_text', $2::text) WHERE id = $1 AND private_reply_at IS NULL RETURNING id`, [c.id, message]);
  if (!claimed.length) throw new HttpError(409, 'Ya se respondió en privado a este comentario (la red permite una sola vez)');
  try {
    const r = await zclient().call<any>('POST', `/inbox/comments/${enc(c.platform_post_id)}/${enc(c.comment_id)}/private-reply`, { accountId: c.zernio_account_id, message });
    await query(`UPDATE social_comments SET private_reply_message_id = $2, updated_at = now() WHERE id = $1`, [c.id, str(r?.messageId ?? r?.data?.messageId, 500)]);
  } catch (e: any) {
    const spent = e instanceof ZernioError && (e.data?.details?.privateReplyConsumed === true || e.data?.error?.details?.privateReplyConsumed === true
      || e.data?.details?.privateReplyOutcome === 'unknown' || e.data?.error?.details?.privateReplyOutcome === 'unknown');
    if (spent || !surelyNotSent(e)) throw new HttpError(409, 'La red indica que la respuesta privada de este comentario ya se usó (o no se sabe si salió); no se volvió a enviar.');
    await query(`UPDATE social_comments SET private_reply_at = NULL WHERE id = $1 AND private_reply_message_id = ''`, [c.id]);
    explain(e);
  }
  return getComment(accountId, c.id);
}

/** ¿Este mensaje directo enviado es una respuesta privada a un comentario (la mandó la plataforma, no una persona)? */
export async function isPrivateReplyEcho(accountId: string, messageId: string, text: string): Promise<boolean> {
  if (messageId && (await queryOne(`SELECT 1 FROM social_comments WHERE account_id = $1 AND private_reply_message_id = $2 LIMIT 1`, [accountId, messageId]))) return true;
  // Por el texto (el eco puede llegar con el id de la red): una sola vez, para no confundir después a una persona que
  // escribe lo mismo desde el teléfono.
  const hit = await query(
    `UPDATE social_comments SET meta = meta - 'private_reply_text'
      WHERE id = (SELECT id FROM social_comments WHERE account_id = $1 AND private_reply_at > now() - interval '1 day' AND meta->>'private_reply_text' = $2 LIMIT 1)
      RETURNING id`, [accountId, text.trim()]);
  return hit.length > 0;
}

export async function setHidden(accountId: string, id: string, hidden: boolean) {
  const c = await loadComment(accountId, id);
  if (!commentCapabilities(c.platform).hide) throw new HttpError(400, 'Esta red no permite ocultar comentarios');
  if (c.status === 'eliminado') throw new HttpError(409, 'El comentario se eliminó');
  assertLive();
  const path = `/inbox/comments/${enc(c.platform_post_id)}/${enc(c.comment_id)}/hide`;
  try {
    if (hidden) await zclient().call('POST', path, { accountId: c.zernio_account_id });
    else await zclient().call('DELETE', `${path}?accountId=${enc(c.zernio_account_id)}`);
  } catch (e) {
    explain(e);
  }
  await query(
    `UPDATE social_comments SET status = CASE WHEN $2::boolean THEN 'oculto' WHEN reply_comment_id <> '' THEN 'respondido' ELSE 'nuevo' END, updated_at = now() WHERE id = $1`,
    [c.id, hidden]);
  return getComment(accountId, c.id);
}

export async function setLiked(accountId: string, id: string, liked: boolean) {
  const c = await loadComment(accountId, id);
  if (!commentCapabilities(c.platform).like) throw new HttpError(400, 'Esta red no permite dar me gusta a comentarios desde aquí');
  assertLive();
  const path = `/inbox/comments/${enc(c.platform_post_id)}/${enc(c.comment_id)}/like`;
  let likeUri = String(c.meta?.likeUri ?? '');
  try {
    if (liked) {
      const r = await zclient().call<any>('POST', path, { accountId: c.zernio_account_id, ...(c.meta?.cid ? { cid: c.meta.cid } : {}) });
      likeUri = str(r?.likeUri ?? r?.data?.likeUri ?? likeUri, 1000);
    } else {
      await zclient().call('DELETE', `${path}?accountId=${enc(c.zernio_account_id)}${likeUri ? `&likeUri=${enc(likeUri)}` : ''}`);
    }
  } catch (e) {
    explain(e);
  }
  await query(`UPDATE social_comments SET liked = $2, meta = meta || jsonb_build_object('likeUri', $3::text), updated_at = now() WHERE id = $1`, [c.id, liked, likeUri]);
  return getComment(accountId, c.id);
}

export async function deleteComment(accountId: string, id: string) {
  const c = await loadComment(accountId, id);
  if (!commentCapabilities(c.platform).delete) throw new HttpError(400, 'Esta red no permite eliminar comentarios');
  if (c.status === 'eliminado') return getComment(accountId, c.id);
  assertLive();
  try {
    await zclient().call('DELETE', `/inbox/comments/${enc(c.platform_post_id)}?accountId=${enc(c.zernio_account_id)}&commentId=${enc(c.comment_id)}`);
  } catch (e) {
    explain(e);
  }
  await query(`UPDATE social_comments SET status = 'eliminado', updated_at = now() WHERE id = $1`, [c.id]);
  return getComment(accountId, c.id);
}

/** Sin respuesta y fuera de la lista de pendientes (no se llama a la red). */
export async function ignore(accountId: string, kind: Kind, id: string, ignored = true) {
  if (kind === 'comment') {
    const c = await loadComment(accountId, id);
    await query(`UPDATE social_comments SET status = CASE WHEN $2::boolean THEN 'ignorado' WHEN reply_comment_id <> '' THEN 'respondido' ELSE 'nuevo' END, updated_at = now()
                  WHERE id = $1 AND status IN ('nuevo', 'ignorado')`, [c.id, ignored]);
    return getComment(accountId, c.id);
  }
  const r = await loadReview(accountId, id);
  await query(`UPDATE social_reviews SET status = CASE WHEN $2::boolean THEN 'ignorado' WHEN reply_text <> '' THEN 'respondido' ELSE 'nuevo' END, updated_at = now()
                WHERE id = $1 AND status IN ('nuevo', 'ignorado')`, [r.id, ignored]);
  return getReview(accountId, r.id);
}

/** Responde una reseña (Google o Facebook). Google acepta cambiar la respuesta; aquí se responde una vez. */
export async function replyReview(accountId: string, id: string, text: string, source: 'human' | 'suggested' | 'auto', userId: string | null) {
  const message = valid(ReplyText, text);
  const r = await loadReview(accountId, id);
  assertLive();
  // Sin columna de "no se sabe": una respuesta sin confirmar queda apartada 10 minutos (review.updated la confirma).
  const claimed = await query(
    `UPDATE social_reviews SET replied_at = now() WHERE id = $1 AND reply_text = '' AND (replied_at IS NULL OR replied_at < now() - interval '10 minutes') RETURNING id`, [r.id]);
  if (!claimed.length) throw new HttpError(409, 'Esta reseña ya se respondió');
  try {
    // Los ids de Google llevan "/": van codificados.
    await zclient().call('POST', `/inbox/reviews/${enc(r.review_id)}/reply`, { accountId: r.zernio_account_id, message }, { idempotencyKey: keyOf('review-reply', r.id, message) });
  } catch (e) {
    if (!surelyNotSent(e)) throw new HttpError(502, UNCERTAIN);
    await query(`UPDATE social_reviews SET replied_at = NULL WHERE id = $1 AND reply_text = ''`, [r.id]);
    explain(e);
  }
  await query(`UPDATE social_reviews SET status = 'respondido', reply_text = $2, reply_source = $3, replied_by = $4, replied_at = now(), updated_at = now() WHERE id = $1`,
    [r.id, message, source, userId]);
  return getReview(accountId, r.id);
}

/* ------------------------------ Lectura para el panel ------------------------------ */

/** Lo que ve el panel: sin ids de Zernio ni de la red. */
function publicComment(c: CommentRow & { post_url?: string; post_caption?: string; post_thumbnail?: string; username?: string; replied_by_name?: string | null }) {
  return {
    kind: 'comment' as const, id: c.id, social_account_id: c.social_account_id, platform: c.platform, account_username: c.username ?? '',
    author: { name: c.author?.name ?? '', username: c.author?.username ?? '', picture: c.author?.picture ?? '' }, text: c.text, is_reply: !!c.parent_id,
    created_at: c.created_at_platform ?? c.received_at, status: c.status, sentiment: c.sentiment, needs_human: c.needs_human, suggestion: c.ai_suggestion,
    reply_text: c.reply_text, reply_source: c.reply_source, replied_at: c.reply_comment_id ? c.replied_at : null, replied_by: c.replied_by_name ?? null,
    private_reply_at: c.private_reply_at, liked: c.liked,
    post: { url: c.post_url ?? '', caption: (c.post_caption ?? '').slice(0, 300), thumbnail: c.post_thumbnail ?? '' },
    can: commentCapabilities(c.platform),
  };
}

function publicReview(r: ReviewRow & { username?: string; replied_by_name?: string | null }) {
  return {
    kind: 'review' as const, id: r.id, social_account_id: r.social_account_id, platform: r.platform, account_username: r.username ?? '',
    author: { name: r.author?.name ?? '', username: '', picture: r.author?.picture ?? '' }, text: r.text, rating: r.rating, recommendation: r.recommendation,
    location: r.location_name, url: r.url, created_at: r.created_at_platform ?? r.received_at, status: r.status, sentiment: r.sentiment, needs_human: r.needs_human,
    suggestion: r.ai_suggestion, reply_text: r.reply_text, reply_source: r.reply_source, replied_at: r.reply_text ? r.replied_at : null, replied_by: r.replied_by_name ?? null,
  };
}

const COMMENT_SELECT = `SELECT c.*, p.url AS post_url, p.caption AS post_caption, p.thumbnail AS post_thumbnail, s.username, u.name AS replied_by_name
  FROM social_comments c JOIN social_accounts s ON s.id = c.social_account_id LEFT JOIN social_posts p ON p.id = c.post_id LEFT JOIN users u ON u.id = c.replied_by`;
const REVIEW_SELECT = `SELECT r.*, s.username, u.name AS replied_by_name FROM social_reviews r JOIN social_accounts s ON s.id = r.social_account_id LEFT JOIN users u ON u.id = r.replied_by`;

export async function getComment(accountId: string, id: string) {
  const row = await queryOne<any>(`${COMMENT_SELECT} WHERE c.id = $1 AND c.account_id = $2`, [id, accountId]);
  if (!row) throw new HttpError(404, 'Comentario no encontrado');
  return publicComment(row);
}

export async function getReview(accountId: string, id: string) {
  const row = await queryOne<any>(`${REVIEW_SELECT} WHERE r.id = $1 AND r.account_id = $2`, [id, accountId]);
  if (!row) throw new HttpError(404, 'Reseña no encontrada');
  return publicReview(row);
}

export const InboxFilterSchema = z.object({
  type: z.enum(['all', 'comment', 'review']).default('all'),
  platform: z.string().max(40).optional(),
  social_account_id: z.string().uuid().optional(),
  /** pendientes = nuevo; todos = cualquier estado. */
  status: z.enum(['pendientes', 'nuevo', 'respondido', 'oculto', 'eliminado', 'ignorado', 'todos']).default('pendientes'),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Bandeja: comentarios (sin los del propio negocio) y reseñas, lo más reciente primero. */
export async function listInbox(accountId: string, f: z.infer<typeof InboxFilterSchema>) {
  const status = f.status === 'pendientes' ? 'nuevo' : f.status;
  const args = (alias: string): [string, unknown[]] => {
    const params: unknown[] = [accountId];
    const where = [`${alias}.account_id = $1`];
    if (status !== 'todos') { params.push(status); where.push(`${alias}.status = $${params.length}`); }
    if (f.platform) { params.push(f.platform); where.push(`${alias}.platform = $${params.length}`); }
    if (f.social_account_id) { params.push(f.social_account_id); where.push(`${alias}.social_account_id = $${params.length}`); }
    if (f.before) { params.push(f.before); where.push(`coalesce(${alias}.created_at_platform, ${alias}.received_at) < $${params.length}`); }
    params.push(f.limit);
    return [where.join(' AND '), params];
  };
  const out: any[] = [];
  if (f.type !== 'review') {
    const [w, params] = args('c');
    out.push(...(await query<any>(`${COMMENT_SELECT} WHERE ${w} AND NOT c.is_own ORDER BY coalesce(c.created_at_platform, c.received_at) DESC LIMIT $${params.length}`, params)).map(publicComment));
  }
  if (f.type !== 'comment') {
    const [w, params] = args('r');
    out.push(...(await query<any>(`${REVIEW_SELECT} WHERE ${w} ORDER BY coalesce(r.created_at_platform, r.received_at) DESC LIMIT $${params.length}`, params)).map(publicReview));
  }
  out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const counts = await queryOne<{ comments: number; reviews: number }>(
    `SELECT (SELECT count(*)::int FROM social_comments WHERE account_id = $1 AND status = 'nuevo' AND NOT is_own) AS comments,
            (SELECT count(*)::int FROM social_reviews WHERE account_id = $1 AND status = 'nuevo') AS reviews`, [accountId]);
  return { items: out.slice(0, f.limit), pending: counts };
}

/** Guarda los ajustes de respuestas de una cuenta conectada (el agente debe ser del negocio). */
export async function saveCommentSettings(accountId: string, socialAccountId: string, input: unknown) {
  const s = valid(CommentSettingsSchema, input ?? {});
  if (s.chatbot_id && !(await queryOne(`SELECT 1 FROM chatbots WHERE id = $1 AND account_id = $2`, [s.chatbot_id, accountId]))) throw new HttpError(400, 'El agente pertenece a otro negocio');
  const row = await queryOne<SocialAccountRow>(`UPDATE social_accounts SET comment_settings = $3, updated_at = now() WHERE id = $1 AND account_id = $2 RETURNING *`,
    [socialAccountId, accountId, JSON.stringify(s)]);
  if (!row) throw new HttpError(404, 'Cuenta no encontrada');
  return s;
}

/* ------------------------------ Respuesta automática ------------------------------ */

/**
 * Contesta solo si todo se cumple: la cuenta está en automático y en vivo, el comentario no es del negocio ni tiene
 * respuesta, es reciente, no es riesgoso ni negativo, la reseña tiene 4 o 5 estrellas y no se pasó el tope por hora.
 * `suggest` genera la respuesta con la IA (y dice si la debe ver una persona).
 */
export async function runAutoReply(p: { kind?: string; id?: string }, suggest: (accountId: string, kind: Kind, id: string) => Promise<{ reply: string; sentiment: string; needs_human: boolean; unverified: string[] }>) {
  const kind: Kind = p.kind === 'review' ? 'review' : 'comment';
  const id = String(p.id ?? '');
  const table = kind === 'comment' ? 'social_comments' : 'social_reviews';
  const row = await queryOne<any>(
    `SELECT x.*, s.comment_settings, s.status AS sa_status, a.active AS account_active, a.status AS account_status
       FROM ${table} x JOIN social_accounts s ON s.id = x.social_account_id JOIN accounts a ON a.id = x.account_id WHERE x.id = $1`, [id]);
  if (!row || row.sa_status !== 'active' || row.status !== 'nuevo' || row.needs_human) return;
  // Un negocio suspendido o en pausa no publica (ni gasta IA), como con los mensajes.
  if (!row.account_active || row.account_status === 'paused') return;
  const settings = settingsOf(row);
  if (settings.mode !== 'auto' || config.outbound.mode !== 'live') return;
  if (kind === 'comment' && (row.is_own || row.reply_comment_id || !commentCapabilities(row.platform).reply)) return;
  // Solo comentarios a la publicación o respuestas a un comentario del negocio (no conversaciones entre clientes, ni
  // un eco propio que no se reconoció: eso haría una cadena de respuestas a sí mismo).
  if (kind === 'comment' && row.parent_id && !(await queryOne(`SELECT 1 FROM social_comments WHERE social_account_id = $1 AND comment_id = $2 AND is_own`, [row.social_account_id, row.parent_id]))) return;
  if (kind === 'review' && (row.reply_text || row.rating === null || row.rating < 4)) return;
  if (ageDays(row.created_at_platform, row.received_at) > AUTO_MAX_DAYS || detectRisk(row.text)) return;
  const recent = await queryOne<{ n: number }>(
    `SELECT (SELECT count(*) FROM social_comments WHERE social_account_id = $1 AND reply_source = 'auto' AND replied_at > now() - interval '1 hour')
          + (SELECT count(*) FROM social_reviews WHERE social_account_id = $1 AND reply_source = 'auto' AND replied_at > now() - interval '1 hour') AS n`,
    [row.social_account_id]);
  if (Number(recent?.n ?? 0) >= settings.max_per_hour) {
    await logEvent({ level: 'info', source: 'channel', message: `Comentarios: se llegó al tope de ${settings.max_per_hour} respuestas automáticas por hora; el resto espera a una persona`, accountId: row.account_id });
    return;
  }
  // La IA también tiene tope: muchas quejas seguidas no gastan una sugerencia automática cada una sin fin (cuenta esta).
  const tried = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM jobs WHERE account_id = $1 AND type = 'social_autoreply' AND started_at > now() - interval '1 hour'`, [row.account_id]);
  if ((tried?.n ?? 0) > settings.max_per_hour * 3) return;
  const s = await suggest(row.account_id, kind, id);
  if (!s.reply || s.needs_human || s.sentiment !== 'positive' || s.unverified.length) return;
  try {
    if (kind === 'comment') await replyComment(row.account_id, id, s.reply, 'auto', null);
    else await replyReview(row.account_id, id, s.reply, 'auto', null);
  } catch (e: any) {
    // Ya respondido por una persona (409) o la red no lo aceptó: no se reintenta solo.
    await logEvent({ level: 'warn', source: 'channel', message: `Comentarios: la respuesta automática no salió: ${e?.message ?? e}`, accountId: row.account_id });
  }
}
