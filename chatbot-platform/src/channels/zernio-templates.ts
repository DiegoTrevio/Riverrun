import { z } from 'zod';
import { HttpError } from '../access.js';
import { notifyUsers } from '../automation/store.js';
import { query, queryOne } from '../db.js';
import type { OutgoingTemplate } from '../engine/transport.js';
import { logEvent } from '../logs.js';
import type { Channel } from '../types.js';
import { clientFor, ZernioError } from './zernio.js';

/**
 * Plantillas de WhatsApp (API oficial por Zernio). Meta las revisa y son lo único que se puede enviar cuando el cliente
 * no ha escrito en las últimas 24 h. Cada plantilla es de un número conectado del negocio; aquí se crean, se traen de
 * Meta, se borran y se arman para enviar con las variables de cada contacto.
 */

export interface WaTemplate {
  id: string;
  account_id: string;
  social_account_id: string;
  zernio_template_id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: any[];
  rejection_reason: string;
  updated_at: string;
}

const upper = (s: unknown) => String(s ?? '').toUpperCase();
/** Texto del cuerpo de la plantilla ("Hola {{1}}, tu cita es el {{2}}"). */
export const templateBody = (components: any[]) => String((components ?? []).find((c) => upper(c?.type) === 'BODY')?.text ?? '');
/** Cuántas variables tiene el cuerpo ({{1}}…{{n}}). */
export function templateVarCount(components: any[]): number {
  const nums = [...templateBody(components).matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}
/**
 * ¿Se puede enviar desde el panel? Aprobada, con encabezado de texto fijo (sin foto, video o documento, ni variables) y
 * variables numeradas en el cuerpo. Las demás se usan desde Meta o Zernio.
 */
export function templateSendable(t: Pick<WaTemplate, 'status' | 'components'>): boolean {
  if (t.status !== 'APPROVED') return false;
  const header = (t.components ?? []).find((c) => upper(c?.type) === 'HEADER');
  if (header && (upper(header.format || 'TEXT') !== 'TEXT' || /\{\{/.test(String(header.text ?? '')))) return false;
  return !/\{\{\s*[a-z_]/i.test(templateBody(t.components));
}
/** El cuerpo con sus variables puestas (lo que se guarda en la conversación). */
export const fillBody = (body: string, params: string[]) => body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => params[Number(n) - 1] ?? '');

/** Plantilla lista para Meta: nombre, idioma y el cuerpo con sus variables. */
export function outgoingTemplate(t: Pick<WaTemplate, 'name' | 'language' | 'components'>, params: string[]): OutgoingTemplate {
  const n = templateVarCount(t.components);
  return { name: t.name, language: t.language, components: n ? [{ type: 'body', parameters: params.slice(0, n).map((text) => ({ type: 'text', text })) }] : [] };
}

/** Lo que ve el panel de cada plantilla. */
export const publicTemplate = (t: WaTemplate) => ({
  id: t.id, social_account_id: t.social_account_id, name: t.name, language: t.language, category: t.category, status: t.status,
  rejection_reason: t.rejection_reason, body: templateBody(t.components), variables: templateVarCount(t.components), sendable: templateSendable(t),
  updated_at: t.updated_at,
});

/**
 * Plantilla que se puede usar en esta conversación: del negocio, del mismo número de WhatsApp y aprobada. Si no, el
 * motivo (en palabras del panel).
 */
export async function templateForChannel(accountId: string, channel: Channel, templateId: string): Promise<WaTemplate | string> {
  if (channel.type !== 'zernio' || channel.config.platform !== 'whatsapp') return 'las plantillas solo son para WhatsApp (API oficial)';
  const row = await queryOne<WaTemplate & { zernio_account_id: string }>(
    `SELECT t.*, s.zernio_account_id FROM wa_templates t JOIN social_accounts s ON s.id = t.social_account_id WHERE t.id = $1 AND t.account_id = $2`, [templateId, accountId]);
  if (!row) return 'la plantilla ya no existe';
  if (row.zernio_account_id !== channel.config.account_id) return 'la plantilla es de otro número de WhatsApp';
  if (row.status !== 'APPROVED') return 'la plantilla todavía no está aprobada por Meta';
  if (!templateSendable(row)) return 'esa plantilla no se puede enviar desde aquí (tiene foto o variables en el encabezado)';
  return row;
}

/** Número de WhatsApp del negocio (cuenta conectada por Zernio). */
async function waAccount(accountId: string, socialAccountId: string) {
  const row = await queryOne<{ id: string; zernio_account_id: string; platform: string }>(
    `SELECT id, zernio_account_id, platform FROM social_accounts WHERE id = $1 AND account_id = $2`, [socialAccountId, accountId]);
  if (!row) throw new HttpError(404, 'Número de WhatsApp no encontrado');
  if (row.platform !== 'whatsapp') throw new HttpError(400, 'Las plantillas solo son para WhatsApp');
  return row;
}

export async function listTemplates(accountId: string, socialAccountId?: string) {
  const rows = await query<WaTemplate>(
    `SELECT * FROM wa_templates WHERE account_id = $1 AND ($2::uuid IS NULL OR social_account_id = $2) ORDER BY name, language`, [accountId, socialAccountId ?? null]);
  return rows.map(publicTemplate);
}

/** Trae de Meta (por Zernio) las plantillas del número: agrega las nuevas, actualiza su estado y quita las borradas. */
export async function syncTemplates(accountId: string, socialAccountId: string): Promise<number> {
  const wa = await waAccount(accountId, socialAccountId);
  const r = await clientFor().call<any>('GET', `/whatsapp/templates?accountId=${encodeURIComponent(wa.zernio_account_id)}`);
  if (!Array.isArray(r?.templates)) throw new HttpError(502, 'Zernio no devolvió las plantillas');
  const keep: string[] = [];
  for (const t of r.templates) {
    const name = String(t?.name ?? '');
    const language = String(t?.language ?? '');
    if (!name || !language) continue;
    keep.push(`${name}|${language}`);
    await query(
      `INSERT INTO wa_templates (account_id, social_account_id, zernio_template_id, name, language, category, status, components)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (social_account_id, name, language) DO UPDATE SET zernio_template_id = $3, category = $6, status = $7, components = $8,
         rejection_reason = CASE WHEN $7 = 'REJECTED' THEN wa_templates.rejection_reason ELSE '' END, updated_at = now()`,
      [accountId, wa.id, String(t.id ?? ''), name, language, upper(t.category) || 'UTILITY', upper(t.status) || 'PENDING', JSON.stringify(Array.isArray(t.components) ? t.components : [])]);
  }
  await query(`DELETE FROM wa_templates WHERE social_account_id = $1 AND NOT ((name || '|' || language) = ANY($2::text[]))`, [wa.id, keep]);
  return keep.length;
}

const ButtonSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('quick_reply'), text: z.string().trim().min(1).max(25) }),
  z.object({ type: z.literal('url'), text: z.string().trim().min(1).max(25), url: z.string().url().max(2000).refine((u) => u.startsWith('https://'), 'El enlace debe empezar con https://') }),
]);
export const TemplateInputSchema = z.object({
  social_account_id: z.string().uuid(),
  name: z.string().trim().regex(/^[a-z][a-z0-9_]{0,99}$/, 'El nombre va en minúsculas, sin espacios ni acentos (letras, números y _), y empieza con una letra'),
  category: z.enum(['MARKETING', 'UTILITY']),
  language: z.string().trim().regex(/^[a-z]{2}(_[A-Z]{2})?$/).default('es_MX'),
  header: z.string().trim().max(60).default(''),
  body: z.string().trim().min(1).max(1024),
  footer: z.string().trim().max(60).default(''),
  buttons: z.array(ButtonSchema).max(3).default([]),
  /** Un ejemplo por variable (Meta los pide para revisarla). */
  examples: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
});
export type TemplateInput = z.infer<typeof TemplateInputSchema>;

/** Componentes en la forma de Meta. Las variables del cuerpo deben ir seguidas ({{1}}, {{2}}…) y con su ejemplo. */
export function templateComponents(t: TemplateInput): any[] {
  const n = templateVarCount([{ type: 'BODY', text: t.body }]);
  const used = new Set([...t.body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])));
  for (let i = 1; i <= n; i++) if (!used.has(i)) throw new HttpError(400, `Las variables van seguidas: falta {{${i}}}`);
  if (/\{\{\s*[^\d\s}]/.test(t.body)) throw new HttpError(400, 'Las variables se escriben con números: {{1}}, {{2}}…');
  if (t.examples.length < n) throw new HttpError(400, `Escribe un ejemplo para cada variable (${n})`);
  if (/\{\{/.test(t.header) || /\{\{/.test(t.footer)) throw new HttpError(400, 'El encabezado y el pie no llevan variables');
  return [
    ...(t.header ? [{ type: 'HEADER', format: 'TEXT', text: t.header }] : []),
    { type: 'BODY', text: t.body, ...(n ? { example: { body_text: [t.examples.slice(0, n)] } } : {}) },
    ...(t.footer ? [{ type: 'FOOTER', text: t.footer }] : []),
    ...(t.buttons.length ? [{ type: 'BUTTONS', buttons: t.buttons.map((b) => (b.type === 'url' ? { type: 'URL', text: b.text, url: b.url } : { type: 'QUICK_REPLY', text: b.text })) }] : []),
  ];
}

/** Crea la plantilla en Meta (por Zernio); queda en revisión (hasta 24 h) y avisa al cambiar de estado. */
export async function createTemplate(accountId: string, input: TemplateInput) {
  const wa = await waAccount(accountId, input.social_account_id);
  const components = templateComponents(input);
  let r: any;
  try {
    r = await clientFor().call<any>('POST', '/whatsapp/templates', { accountId: wa.zernio_account_id, name: input.name, category: input.category, language: input.language, components });
  } catch (e) {
    if (e instanceof ZernioError && e.status < 500) throw new HttpError(400, `Meta no aceptó la plantilla: ${String(e.data?.error?.message ?? e.data?.message ?? e.data?.error ?? e.message).slice(0, 300)}`);
    throw e;
  }
  const t = r?.template ?? r ?? {};
  const row = await queryOne<WaTemplate>(
    `INSERT INTO wa_templates (account_id, social_account_id, zernio_template_id, name, language, category, status, components)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (social_account_id, name, language) DO UPDATE SET zernio_template_id = $3, category = $6, status = $7, components = $8, rejection_reason = '', updated_at = now()
     RETURNING *`,
    [accountId, wa.id, String(t.id ?? ''), input.name, input.language, input.category, upper(t.status) || 'PENDING', JSON.stringify(components)]);
  await logEvent({ level: 'info', source: 'admin', message: `WhatsApp: plantilla "${input.name}" enviada a revisión de Meta`, accountId });
  return publicTemplate(row!);
}

/** Borra la plantilla en Meta (solo ese idioma). Meta no deja reusar el nombre por 30 días. */
export async function deleteTemplate(accountId: string, id: string) {
  const row = await queryOne<WaTemplate & { zernio_account_id: string }>(
    `SELECT t.*, s.zernio_account_id FROM wa_templates t JOIN social_accounts s ON s.id = t.social_account_id WHERE t.id = $1 AND t.account_id = $2`, [id, accountId]);
  if (!row) throw new HttpError(404, 'Plantilla no encontrada');
  await clientFor().call('DELETE', `/whatsapp/templates/${encodeURIComponent(row.name)}?accountId=${encodeURIComponent(row.zernio_account_id)}&language=${encodeURIComponent(row.language)}`).catch((e) => {
    if (!(e instanceof ZernioError && e.status === 404)) throw e;
  });
  await query(`DELETE FROM wa_templates WHERE id = $1 AND account_id = $2`, [id, accountId]);
}

/** PIN de verificación en dos pasos del número: si el número tiene uno propio, sin él Meta no deja enviar mensajes. */
export async function registerWhatsappPin(accountId: string, socialAccountId: string, pin: string) {
  const wa = await waAccount(accountId, socialAccountId);
  try {
    await clientFor().call('POST', `/accounts/${encodeURIComponent(wa.zernio_account_id)}/whatsapp/register`, { pin });
  } catch (e) {
    if (e instanceof ZernioError && (e.status === 422 || e.status === 400)) throw new HttpError(400, 'Meta no aceptó el PIN. Revisa el PIN de verificación en dos pasos de tu número (6 dígitos) e inténtalo de nuevo.');
    throw e;
  }
  await logEvent({ level: 'info', source: 'admin', message: 'WhatsApp: número registrado con su PIN de verificación en dos pasos', accountId });
}

const STATUS_TEXT: Record<string, string> = {
  APPROVED: 'Meta la aprobó: ya puedes usarla para escribir fuera de las 24 h.',
  REJECTED: 'Meta la rechazó.',
  PAUSED: 'Meta la pausó por quejas o baja calidad; no se puede enviar por ahora.',
  DISABLED: 'Meta la desactivó; ya no se puede enviar.',
};

/** Aviso de Zernio: Meta revisó una plantilla. Se actualiza su estado y se avisa al negocio. */
export async function handleTemplateStatus(body: any) {
  const zid = String(body?.account?.accountId ?? body?.account?.id ?? '');
  const t = body?.template ?? {};
  const status = upper(t.status);
  const reason = String(t.reason ?? '');
  const rows = await query<{ account_id: string; name: string }>(
    `UPDATE wa_templates w SET status = $4, rejection_reason = CASE WHEN $4 = 'REJECTED' AND $5 <> 'NONE' THEN $5 ELSE '' END,
       zernio_template_id = coalesce(nullif($6, ''), w.zernio_template_id), updated_at = now()
       FROM social_accounts s WHERE s.id = w.social_account_id AND s.zernio_account_id = $1 AND w.name = $2 AND w.language = $3
     RETURNING w.account_id, w.name`,
    [zid, String(t.name ?? ''), String(t.language ?? ''), status, reason.slice(0, 500), String(t.templateId ?? '')]);
  for (const r of rows) {
    const text = STATUS_TEXT[status];
    if (!text) continue;
    const admins = await query<{ id: string }>(`SELECT id FROM users WHERE account_id = $1 AND role = 'admin' AND active`, [r.account_id]);
    await notifyUsers(r.account_id, admins.map((a) => a.id), {
      title: `Plantilla de WhatsApp "${r.name}"`,
      body: `${text}${status === 'REJECTED' && reason && reason !== 'NONE' ? ` Motivo: ${reason.slice(0, 300)}` : ''}`,
      link: '#/redes',
      kind: 'channel',
    });
  }
}
