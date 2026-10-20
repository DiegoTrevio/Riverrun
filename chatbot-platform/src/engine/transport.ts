import path from 'node:path';
import { config } from '../config.js';
import type { ChannelType, ImageAsset } from '../types.js';

/** Archivo listo para enviar (PDF, Word, audio, video…). La ruta ya se comprobó contra la cuenta. */
export interface OutgoingFile {
  id: string;
  name: string;
  mime: string;
  kind: 'image' | 'document' | 'audio' | 'video';
  absPath: string;
}

/** Canal de salida. El mismo motor funciona para todas las plataformas y para el simulador. */
export interface Transport {
  kind: ChannelType;
  /** Adapters/tests that do not simulate typing can explicitly opt out of artificial waits. */
  typingSimulation?: boolean;
  startTyping?(): Promise<void>;
  setDispatchGuard?(guard:()=>Promise<void>):void;
  /** Envía texto. `delayMs` = tiempo de "escribiendo…" sugerido (cada plataforma lo aplica si puede). */
  sendText(text: string, delayMs: number): Promise<string | null>;
  sendImage(image: ImageAsset, caption: string, delayMs: number): Promise<string | null>;
  /** Envía un archivo (PDF, audio, video…). Opcional: los canales que no lo admiten no lo implementan y el envío falla con un aviso claro. */
  sendFile?(file: OutgoingFile, caption: string, delayMs: number): Promise<string | null>;
  /** Plantilla aprobada de WhatsApp oficial (lo único que se puede enviar fuera de las 24 h). Solo WhatsApp por Zernio. */
  sendTemplate?(template: OutgoingTemplate): Promise<string | null>;
  /**
   * Texto con botones nativos (Telegram, Messenger, Instagram, WhatsApp oficial, chat web y simulador). Qué botones y
   * con qué texto lo decide src/automation/buttons.ts según el canal; los demás canales los reciben numerados en el texto.
   */
  sendButtons?(text: string, buttons: OutgoingButton[], delayMs: number): Promise<string | null>;
  /** Aviso interno (p.ej. al encargado cuando hay transferencia). */
  notify(number: string, text: string): Promise<void>;
}

/** Botón de un mensaje: de respuesta (al tocarlo regresa `payload`) o de enlace (abre `url`). */
export interface OutgoingButton {
  kind: 'reply' | 'url';
  label: string;
  payload?: string;
  url?: string;
}

/** Plantilla de WhatsApp lista para enviar: nombre, idioma y componentes con sus variables (forma de la Cloud API de Meta). */
export interface OutgoingTemplate {
  name: string;
  language: string;
  components: unknown[];
}

/**
 * Largo máximo de un texto que va como pie de foto (Telegram y WhatsApp rechazan pies de más de 1024 caracteres).
 * Un texto más largo se envía aparte, antes de la foto.
 */
export const CAPTION_MAX = 1024;

export function imageAbsolutePath(img: Pick<ImageAsset, 'file_path'>) {
  return path.isAbsolute(img.file_path) ? img.file_path : path.join(config.uploadsDir, img.file_path);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PlaygroundOutput {
  type: 'text' | 'image' | 'notify';
  text: string;
  image?: { id: string; code: string; name: string };
  buttons?: OutgoingButton[];
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

  async sendFile(file: OutgoingFile, caption: string) {
    this.outputs.push({ type: 'text', text: `${caption ? `${caption}\n` : ''}📎 ${file.name}` });
    return `playground-${Date.now()}-${this.n++}`;
  }

  async sendButtons(text: string, buttons: OutgoingButton[]) {
    this.outputs.push({ type: 'text', text, buttons });
    return `playground-${Date.now()}-${this.n++}`;
  }

  async notify(number: string, text: string) {
    this.outputs.push({ type: 'notify', text: `(aviso a ${number}) ${text}` });
  }
}
