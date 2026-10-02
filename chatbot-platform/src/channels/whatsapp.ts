import fs from 'node:fs/promises';
import { config } from '../config.js';
import { imageAbsolutePath, type Transport } from '../engine/transport.js';
import { EvolutionClient } from '../evolution/client.js';
import { parseWebhook } from '../evolution/parse.js';
import { ChannelConfigSchemas, type Channel, type Contact, type ImageAsset } from '../types.js';
import type { ChannelAdapter } from './types.js';

export function evolutionFor(channel: Channel) {
  return new EvolutionClient(channel.config.url || config.evolution.url, channel.config.api_key || config.evolution.apiKey);
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
    if (event === 'connection.update') {
      const state = body?.data?.state;
      notices.push({ level: state === 'open' ? 'info' : 'warn', message: `Estado de conexión de WhatsApp: ${state}` });
    }
    const expected = channel.config.instance;
    if (expected && instance && instance !== expected) {
      notices.push({ level: 'warn', message: `Webhook de la instancia "${instance}" no coincide con la del canal ("${expected}"); se ignora` });
      return { messages: [], notices };
    }
    return { messages, notices };
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
