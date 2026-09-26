import { describeInbound, type InboundMessage } from '../channels/types.js';

/**
 * Normaliza el payload del webhook de Evolution API (evento messages.upsert)
 * a una estructura simple e independiente de la versión.
 */
export interface IncomingMessage extends InboundMessage {
  instance: string;
}

export function normalizeEventName(e: unknown): string {
  return String(e ?? '').toLowerCase().replace(/_/g, '.');
}

export function parseWebhook(payload: any): { event: string; instance: string; messages: IncomingMessage[] } {
  const event = normalizeEventName(payload?.event);
  const instance = String(payload?.instance ?? payload?.instanceName ?? '');
  const out: IncomingMessage[] = [];
  if (event !== 'messages.upsert') return { event, instance, messages: out };
  const items = Array.isArray(payload?.data) ? payload.data : payload?.data?.messages ?? [payload?.data];
  for (const d of items) {
    const m = parseOne(d, instance);
    if (m) out.push(m);
  }
  return { event, instance, messages: out };
}

function unwrap(message: any): any {
  let m = message ?? {};
  for (let i = 0; i < 4; i++) {
    const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.documentWithCaptionMessage?.message ?? m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

function digits(s: string) {
  return (s || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function parseOne(d: any, instance: string): IncomingMessage | null {
  const key = d?.key;
  if (!key?.remoteJid || !key?.id) return null;
  const jid: string = key.remoteJid;
  // Ignorar grupos, estados y canales.
  if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return null;

  // WhatsApp puede usar identificadores @lid; el número real llega en campos alternos.
  const alt: string = key.remoteJidAlt || key.senderPn || d?.senderPn || '';
  const phone = jid.endsWith('@s.whatsapp.net') ? digits(jid) : digits(alt);

  const msg = unwrap(d.message);
  let type: IncomingMessage['type'] = 'other';
  let text = '';
  if (typeof msg.conversation === 'string') {
    type = 'text';
    text = msg.conversation;
  } else if (msg.extendedTextMessage) {
    type = 'text';
    text = msg.extendedTextMessage.text ?? '';
  } else if (msg.imageMessage) {
    type = 'image';
    text = msg.imageMessage.caption ?? '';
  } else if (msg.audioMessage) {
    type = 'audio';
  } else if (msg.videoMessage) {
    type = 'video';
    text = msg.videoMessage.caption ?? '';
  } else if (msg.documentMessage) {
    type = 'document';
    text = msg.documentMessage.caption ?? msg.documentMessage.fileName ?? '';
  } else if (msg.stickerMessage) {
    type = 'sticker';
  } else if (msg.locationMessage) {
    type = 'location';
    const l = msg.locationMessage;
    text = [l.name, l.address, l.degreesLatitude && `${l.degreesLatitude},${l.degreesLongitude}`].filter(Boolean).join(' - ');
  } else if (msg.contactMessage) {
    type = 'contact';
    text = msg.contactMessage.displayName ?? '';
  } else if (msg.reactionMessage) {
    type = 'reaction';
    text = msg.reactionMessage.text ?? '';
  } else if (msg.buttonsResponseMessage || msg.listResponseMessage || msg.templateButtonReplyMessage) {
    type = 'text';
    text =
      msg.buttonsResponseMessage?.selectedDisplayText ??
      msg.listResponseMessage?.title ??
      msg.templateButtonReplyMessage?.selectedDisplayText ??
      '';
  } else if (msg.protocolMessage || msg.senderKeyDistributionMessage) {
    return null; // mensajes de sistema (borrados, llaves, etc.)
  }

  return {
    instance,
    messageId: key.id,
    externalId: jid,
    phone,
    displayName: d.pushName ?? '',
    fromMe: !!key.fromMe,
    type,
    text: String(text ?? '').trim(),
    timestamp: Number(d.messageTimestamp ?? Math.floor(Date.now() / 1000)),
  };
}

/** Compatibilidad: representación textual de un mensaje entrante. */
export const describeIncoming = describeInbound;
