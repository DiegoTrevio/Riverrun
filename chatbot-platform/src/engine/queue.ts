/**
 * Cola por conversación:
 *  - Agrupa mensajes seguidos del cliente (debounce) para responder una sola vez.
 *  - Garantiza que una conversación se procese de a una (sin respuestas cruzadas).
 * Pensada para un solo proceso en un VPS (sin dependencias externas).
 */
export type Runner = (conversationId: string, attempt: { restarts: number }) => Promise<{ status: string }>;

interface Slot {
  timer?: NodeJS.Timeout;
  running: boolean;
  rerun: boolean;
  restarts: number;
  errors: number;
}

export class ConversationQueue {
  private slots = new Map<string, Slot>();

  constructor(private runner: Runner, private maxRestarts = 2, private errorRetryMs = 60_000) {}

  private slot(id: string): Slot {
    let s = this.slots.get(id);
    if (!s) {
      s = { running: false, rerun: false, restarts: 0, errors: 0 };
      this.slots.set(id, s);
    }
    return s;
  }

  schedule(conversationId: string, delayMs: number) {
    const s = this.slot(conversationId);
    if (s.running) {
      s.rerun = true;
      return;
    }
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => void this.fire(conversationId), delayMs);
  }

  /** Ejecuta una función con exclusión mutua para la conversación (p.ej. el simulador). */
  async exclusive<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const s = this.slot(conversationId);
    while (s.running) await new Promise((r) => setTimeout(r, 100));
    s.running = true;
    try {
      return await fn();
    } finally {
      s.running = false;
      this.cleanup(conversationId);
    }
  }

  private async fire(conversationId: string) {
    const s = this.slot(conversationId);
    s.timer = undefined;
    if (s.running) {
      s.rerun = true;
      return;
    }
    s.running = true;
    s.rerun = false;
    let status = 'error';
    try {
      status = (await this.runner(conversationId, { restarts: s.restarts })).status;
    } catch (e) {
      console.error('Error procesando conversación', conversationId, e);
    } finally {
      s.running = false;
    }
    if (status === 'restart') {
      s.restarts++;
      this.schedule(conversationId, 500);
      return;
    }
    s.restarts = 0;
    if (status === 'error') {
      s.errors++;
      if (s.errors <= 1) {
        this.schedule(conversationId, this.errorRetryMs);
        return;
      }
    }
    s.errors = 0;
    if (s.rerun) {
      s.rerun = false;
      this.schedule(conversationId, 300);
      return;
    }
    this.cleanup(conversationId);
  }

  canRestart(restarts: number) {
    return restarts < this.maxRestarts;
  }

  private cleanup(id: string) {
    const s = this.slots.get(id);
    if (s && !s.running && !s.timer && !s.rerun && !s.errors) this.slots.delete(id);
  }

  get size() {
    return this.slots.size;
  }
}
