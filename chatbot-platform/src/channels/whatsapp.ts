import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { imageAbsolutePath, type Transport } from '../engine/transport.js';
import { EvolutionClient } from '../evolution/client.js';
import { parseWebhook } from '../evolution/parse.js';
import { logEvent } from '../logs.js';
import { ChannelConfigSchemas, type Channel, type Contact, type ImageAsset } from '../types.js';
import type { ChannelAdapter } from './types.js';

/**
 * Cliente de Evolution del canal. Un servidor propio (solo lo define el superadmin) exige su propia llave:
 * la llave global nunca se envía a otra URL.
 */
export function evolutionFor(channel: Channel) {
  const url = String(channel.config.url ?? '').replace(/\/$/, '');
  if (url && url !== config.evolution.url) {
    if (!channel.config.api_key) throw new Error('El servidor de Evolution propio del canal no tiene API key');
    return new EvolutionClient(url, channel.config.api_key);
  }
  return new EvolutionClient(config.evolution.url, channel.config.api_key || config.evolution.apiKey);
}

/** Nombre de instancia único generado por el servidor (el cliente no lo elige). */
export function newInstanceName(accountId: string) {
  return `acc${accountId.replace(/-/g, '').slice(0, 8)}_${crypto.randomBytes(3).toString('hex')}`;
}

/** Cierra y elimina la instancia de Evolution del canal (sin bloquear si Evolution no responde). */
export async function releaseWhatsapp(ch: Channel) {
  if (ch.type !== 'whatsapp' || !ch.config.instance) return;
  try {
    const evo = evolutionFor(ch);
    await evo.logout(ch.config.instance).catch(() => undefined);
    await evo.deleteInstance(ch.config.instance);
    await logEvent({ level: 'info', source: 'evolution', message: `Instancia eliminada: ${ch.config.instance}`, accountId: ch.account_id });
  } catch (e: any) {
    if (e?.status === 404) return;
    await logEvent({ level: 'warn', source: 'evolution', message: `No se pudo eliminar la instancia ${ch.config.instance}: ${e?.message ?? e}`, accountId: ch.account_id });
  }
}

export class WhatsappTransport implements Transport {
  kind = 'whatsapp' as const;
  private client: EvolutionClient;
  private instance: string;

  constructor(channel: Channel, private number: string) {
    if (!channel.config.instance) throw new Error('El canal de WhatsApp no tiene instancia de Evolution configurada');
    this.client = evolutionFor(channel);
    this.instance = channel.config.instance;
  }

  static forContact(channel: Channel, contact: Contact) {
    // Con identificadores @lid se envía al JID completo; si no, al número.
    return new WhatsappTransport(channel, contact.phone || contact.external_id);
  }

  sendText(text: string, delayMs: number) {
    return this.client.sendText(this.instance, this.number, text, delayMs);
  }

  async sendImage(image: ImageAsset, caption: string, delayMs: number) {
    const buf = await fs.readFile(imageAbsolutePath(image));
    const ext = image.mime_type.split('/')[1] ?? 'jpg';
    return this.client.sendImage(this.instance, this.number, buf.toString('base64'), image.mime_type, `${image.code}.${ext}`, caption, delayMs);
  }

  async notify(number: string, text: string) {
    await this.client.sendText(this.instance, number.replace(/\D/g, ''), text, 0);
  }
}

export const whatsappAdapter: ChannelAdapter = {
  type: 'whatsapp',
  label: 'WhatsApp',
  configSchema: ChannelConfigSchemas.whatsapp,

  parse({ channel, body }) {
    const { event, instance, messages } = parseWebhook(body);
    const notices: { level: 'info' | 'warn'; message: string }[] = [];
    const expected = channel.config.instance;
    if (expected && instance && instance !== expected) {
      notices.push({ level: 'warn', message: `Webhook de la instancia "${instance}" no coincide con la del canal ("${expected}"); se ignora` });
      return { messages: [], notices };
    }
    if (event === 'qrcode.updated') {
      const b64 = body?.data?.qrcode?.base64 ?? body?.data?.base64;
      return { messages: [], qr: typeof b64 === 'string' && b64 ? (b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`) : undefined };
    }
    let connection: string | undefined;
    if (event === 'connection.update') {
      connection = String(body?.data?.state ?? '') || undefined;
      notices.push({ level: connection === 'open' ? 'info' : 'warn', message: `Estado de conexión de WhatsApp: ${connection}` });
    }
    return { messages, notices, connection };
  },

  transport: (channel, contact) => WhatsappTransport.forContact(channel, contact),

  async downloadAudio(channel, msg) {
    const media = await evolutionFor(channel).getMediaBase64(channel.config.instance, msg.messageId);
    return media.base64 ? { buffer: Buffer.from(media.base64, 'base64'), mimeType: media.mimetype } : null;
  },

  async setup(channel, webhookUrl) {
    if (!channel.config.instance) return { ok: false, message: 'Define el nombre de la instancia de Evolution' };
    await evolutionFor(channel).setWebhook(channel.config.instance, webhookUrl);
    return { ok: true, message: 'Webhook configurado en Evolution' };
  },

  async status(channel) {
    if (!channel.config.instance) return { state: 'not_configured' };
    try {
      return { state: await evolutionFor(channel).connectionState(channel.config.instance) };
    } catch (e: any) {
      if (e?.status === 404) return { state: 'not_found' };
      throw e;
    }
  },
};
