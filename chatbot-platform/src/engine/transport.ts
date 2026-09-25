import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { EvolutionClient } from '../evolution/client.js';
import type { Chatbot, Contact, ImageAsset } from '../types.js';

/** Canal de salida. Permite usar el mismo motor para WhatsApp y para el simulador del panel. */
export interface Transport {
  kind: 'whatsapp' | 'playground';
  sendText(text: string, delayMs: number): Promise<string | null>;
  sendImage(image: ImageAsset, caption: string, delayMs: number): Promise<string | null>;
  /** Aviso interno (p.ej. al encargado cuando hay transferencia). */
  notify(number: string, text: string): Promise<void>;
}

export function imageAbsolutePath(img: Pick<ImageAsset, 'file_path'>) {
  return path.isAbsolute(img.file_path) ? img.file_path : path.join(config.uploadsDir, img.file_path);
}

export class EvolutionTransport implements Transport {
  kind = 'whatsapp' as const;
  private client: EvolutionClient;
  private number: string;

  constructor(private bot: Chatbot, contact: Contact) {
    if (!bot.evolution_instance) throw new Error('El chatbot no tiene instancia de Evolution configurada');
    this.client = EvolutionClient.forChatbot(bot);
    // Con identificadores @lid se envía al JID completo; si no, al número.
    this.number = contact.phone || contact.jid;
  }

  sendText(text: string, delayMs: number) {
    return this.client.sendText(this.bot.evolution_instance!, this.number, text, delayMs);
  }

  async sendImage(image: ImageAsset, caption: string, delayMs: number) {
    const buf = await fs.readFile(imageAbsolutePath(image));
    const ext = image.mime_type.split('/')[1] ?? 'jpg';
    return this.client.sendImage(this.bot.evolution_instance!, this.number, buf.toString('base64'), image.mime_type, `${image.code}.${ext}`, caption, delayMs);
  }

  async notify(number: string, text: string) {
    await this.client.sendText(this.bot.evolution_instance!, number.replace(/\D/g, ''), text, 0);
  }
}

export interface PlaygroundOutput {
  type: 'text' | 'image' | 'notify';
  text: string;
  image?: { id: string; code: string; name: string };
}

export class PlaygroundTransport implements Transport {
  kind = 'playground' as const;
  outputs: PlaygroundOutput[] = [];
  private n = 0;

  async sendText(text: string) {
    this.outputs.push({ type: 'text', text });
    return `playground-${Date.now()}-${this.n++}`;
  }

  async sendImage(image: ImageAsset, caption: string) {
    this.outputs.push({ type: 'image', text: caption, image: { id: image.id, code: image.code, name: image.name } });
    return `playground-${Date.now()}-${this.n++}`;
  }

  async notify(number: string, text: string) {
    this.outputs.push({ type: 'notify', text: `(aviso a ${number}) ${text}` });
  }
}
