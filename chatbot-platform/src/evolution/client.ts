import { config } from '../config.js';
import type { Chatbot } from '../types.js';

export class EvolutionError extends Error {
  constructor(message: string, public status?: number, public body?: unknown) {
    super(message);
  }
}

/**
 * Cliente mínimo para Evolution API v2.
 * Documentación: https://doc.evolution-api.com/v2
 */
export class EvolutionClient {
  constructor(private baseUrl: string, private apiKey: string, private timeoutMs = 30000) {}

  static forChatbot(bot: Pick<Chatbot, 'evolution_url' | 'evolution_api_key'>) {
    return new EvolutionClient(bot.evolution_url || config.evolution.url, bot.evolution_api_key || config.evolution.apiKey);
  }

  async request<T = any>(method: string, path: string, body?: unknown, retries = 1): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(this.baseUrl.replace(/\/$/, '') + path, {
          method,
          headers: { apikey: this.apiKey, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
        });
        const text = await res.text();
        let data: any = text;
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          /* respuesta no JSON */
        }
        if (res.ok) return data as T;
        const msg = typeof data === 'object' ? JSON.stringify(data?.response?.message ?? data?.message ?? data).slice(0, 400) : String(text).slice(0, 400);
        const err = new EvolutionError(`Evolution ${method} ${path} → HTTP ${res.status}: ${msg}`, res.status, data);
        if (res.status >= 500 && attempt < retries) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw err;
      } catch (e: any) {
        if (e instanceof EvolutionError) throw e;
        lastErr = new EvolutionError(e?.name === 'AbortError' ? `Evolution ${path}: tiempo de espera agotado` : `Evolution ${path}: ${e?.message ?? e}`);
        if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  /** Envía texto. `delay` (ms) muestra "escribiendo..." antes de enviar. Devuelve el ID del mensaje. */
  async sendText(instance: string, number: string, text: string, delay = 0): Promise<string | null> {
    const res = await this.request('POST', `/message/sendText/${encodeURIComponent(instance)}`, { number, text, delay: delay || undefined });
    return res?.key?.id ?? null;
  }

  /** Envía una imagen (base64 sin prefijo data: o URL pública). */
  async sendImage(instance: string, number: string, media: string, mimeType: string, fileName: string, caption = '', delay = 0): Promise<string | null> {
    const res = await this.request('POST', `/message/sendMedia/${encodeURIComponent(instance)}`, {
      number,
      mediatype: 'image',
      mimetype: mimeType,
      caption: caption || undefined,
      media,
      fileName,
      delay: delay || undefined,
    });
    return res?.key?.id ?? null;
  }

  /** Descarga un medio recibido (p.ej. nota de voz) como base64. */
  async getMediaBase64(instance: string, messageId: string): Promise<{ base64: string; mimetype: string }> {
    const res = await this.request('POST', `/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`, {
      message: { key: { id: messageId } },
      convertToMp4: false,
    });
    return { base64: res?.base64 ?? '', mimetype: res?.mimetype ?? 'audio/ogg' };
  }

  async createInstance(instance: string, webhookUrl: string, number?: string) {
    return this.request('POST', '/instance/create', {
      instanceName: instance,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
      number: number || undefined,
      webhook: { url: webhookUrl, byEvents: false, base64: false, events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'] },
    }, 0);
  }

  async setWebhook(instance: string, webhookUrl: string) {
    return this.request('POST', `/webhook/set/${encodeURIComponent(instance)}`, {
      webhook: { enabled: true, url: webhookUrl, byEvents: false, base64: false, events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'] },
    });
  }

  async connect(instance: string): Promise<{ base64?: string; code?: string; pairingCode?: string; state?: string }> {
    const res = await this.request('GET', `/instance/connect/${encodeURIComponent(instance)}`);
    return { base64: res?.base64, code: res?.code, pairingCode: res?.pairingCode, state: res?.instance?.state };
  }

  async connectionState(instance: string): Promise<string> {
    const res = await this.request('GET', `/instance/connectionState/${encodeURIComponent(instance)}`, undefined, 0);
    return res?.instance?.state ?? res?.state ?? 'unknown';
  }

  async logout(instance: string) {
    return this.request('DELETE', `/instance/logout/${encodeURIComponent(instance)}`, undefined, 0);
  }
}
