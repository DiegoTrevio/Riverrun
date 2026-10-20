import crypto from 'node:crypto';
import { networkOf } from '../channels/zernio.js';
import type { OutgoingButton } from '../engine/transport.js';
import type { Channel } from '../types.js';
import { normalizeLabel, type FlowButton } from './types.js';

/**
 * Botones de los flujos: cómo sale un mensaje con botones en cada canal y cómo se reconoce la opción que tocó (o
 * escribió) el cliente. El texto final se arma aquí y no en el transporte: lo que se guarda es lo que se envió, así el
 * eco de la plataforma se reconoce como propio y no pausa al asistente.
 */

/** Botón listo para el transporte: uno de respuesta lleva el identificador que regresa al tocarlo. */
export type OutButton = OutgoingButton;

/** Identificador de un juego de botones (cambia en cada mensaje: un toque viejo no cuenta para uno nuevo). */
export const newButtonSet = () => crypto.randomBytes(5).toString('hex');
export const buttonPayload = (set: string, n: number) => `rr:${set}:${n}`;
export function parsePayload(payload: string | null | undefined) {
  const m = /^rr:([a-f0-9]{10}):([1-9])$/.exec(String(payload ?? '').trim());
  return m ? { set: m[1], n: Number(m[2]) } : null;
}

/** Límites de Meta: con botones (hasta 3, de respuesta o de enlace) el texto va en una sola burbuja de máximo 640. */
const META_TEMPLATE_TEXT = 640;
/** WhatsApp oficial: el texto de un mensaje con botones de respuesta tiene máximo 1024 caracteres. */
const WA_INTERACTIVE_TEXT = 1024;

type Plan = 'all' | 'meta' | 'replies' | 'numbered';

function planFor(channel: Pick<Channel, 'type' | 'config'>): Plan {
  if (['telegram', 'webchat', 'playground'].includes(channel.type)) return 'all';
  if (channel.type === 'messenger' || channel.type === 'instagram') return 'meta';
  if (channel.type === 'zernio') {
    const platform = String(channel.config.platform ?? '');
    if (!networkOf(platform)?.interactive) return 'numbered';
    if (platform === 'facebook' || platform === 'instagram') return 'meta';
    if (platform === 'whatsapp') return 'replies';
    return 'all';
  }
  return 'numbered';
}

/** Texto de los enlaces cuando el canal no los muestra como botón. */
const linkLines = (urls: FlowButton[]) => urls.map((b) => `🔗 ${b.label}: ${b.url}`).join('\n');

/**
 * Cómo sale un mensaje con botones en este canal: el texto final y los botones nativos (vacío = van numerados en el
 * texto). Telegram, el chat web y el simulador muestran todos; Messenger e Instagram, hasta 3 con el texto en una
 * burbuja (si no cabe, los de respuesta como respuestas rápidas y los enlaces en el texto); WhatsApp oficial, los de
 * respuesta (los enlaces en el texto). WhatsApp por QR, el correo y las demás redes los llevan numerados.
 */
export function composeButtons(channel: Pick<Channel, 'type' | 'config'>, text: string, buttons: FlowButton[], set: string) {
  const replies = buttons.filter((b) => b.kind === 'reply');
  const urls = buttons.filter((b) => b.kind === 'url');
  const native = (list: FlowButton[]): OutButton[] => list.map((b) => (b.kind === 'url'
    ? { kind: 'url', label: b.label, url: b.url }
    : { kind: 'reply', label: b.label, payload: buttonPayload(set, replies.indexOf(b) + 1) }));
  const withLinks = (t: string) => (urls.length ? `${t}${t ? '\n\n' : ''}${linkLines(urls)}` : t);
  let plan = planFor(channel);
  if (plan === 'replies' && (!replies.length || withLinks(text).length > WA_INTERACTIVE_TEXT)) plan = 'numbered';
  if (plan === 'meta' && buttons.length <= 3 && text.length <= META_TEMPLATE_TEXT && text.trim()) return { text, buttons: native(buttons) };
  if (plan === 'meta' && replies.length) return { text: withLinks(text), buttons: native(replies) };
  if (plan === 'all' && (text.trim() || replies.length)) return { text, buttons: native(buttons) };
  if (plan === 'replies') return { text: withLinks(text), buttons: native(replies) };
  // Numerados: el cliente contesta con el número o con el texto del botón.
  const list = replies.map((b, i) => `${i + 1}. ${b.label}`).join('\n');
  const parts = [text.trim(), list, linkLines(urls), replies.length ? 'Responde con el número de tu opción.' : ''].filter(Boolean);
  return { text: parts.join('\n\n'), buttons: [] as OutButton[] };
}

const NUMBER_WORDS: Record<string, number> = { uno: 1, una: 1, primer: 1, primero: 1, primera: 1, dos: 2, segundo: 2, segunda: 2, tres: 3, tercer: 3, tercero: 3, tercera: 3 };
const KEYCAPS: Record<string, number> = { '1️⃣': 1, '2️⃣': 2, '3️⃣': 3 };

/**
 * Qué opción eligió el cliente con lo que escribió (1 = la primera), o null si no es claro. Reconoce el texto exacto del
 * botón (sin importar acentos, mayúsculas ni emojis) y, si `numbers`, el número ("1", "1️⃣", "uno", "el primero",
 * "opción 2"…). Ante la duda no adivina: el mensaje sigue como cualquier otro.
 */
export function matchChoice(text: string, labels: string[], numbers: boolean): number | null {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > 60 || !labels.length) return null;
  if (KEYCAPS[raw] !== undefined) return numbers && KEYCAPS[raw] <= labels.length ? KEYCAPS[raw] : null;
  const t = normalizeLabel(raw);
  if (!t) return null;
  const byLabel = labels.findIndex((l) => normalizeLabel(l) === t);
  if (byLabel >= 0) return byLabel + 1;
  // "1. Sí" (copiado de la lista numerada): el número y el texto tienen que coincidir.
  const copied = /^(\d) (.+)$/.exec(t);
  if (copied) {
    const i = labels.findIndex((l) => normalizeLabel(l) === copied[2]);
    return i >= 0 && i + 1 === Number(copied[1]) ? i + 1 : null;
  }
  if (!numbers) return null;
  const m = /^(?:(?:la|el|opcion|numero|num|no|n) )*(\d|uno|una|dos|tres|primer[oa]?|segund[oa]|tercer[oa]?)$/.exec(t);
  if (!m) return null;
  const n = /^\d$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
  return n >= 1 && n <= labels.length ? n : null;
}
