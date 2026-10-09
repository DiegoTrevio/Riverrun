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
  finished?: Promise<void>;
  rerun: boolean;
  restarts: number;
  errors: number;
}

export class ConversationQueue {
  private slots = new Map<string, Slot>();
  private stopped = false;

  /**
   * @param onGiveUp se llama cuando el reintento también falló (p.ej. la IA no responde): el mensaje queda
   * pendiente (se contestará cuando el cliente vuelva a escribir) y alguien del equipo debe enterarse.
   */
  constructor(
    private runner: Runner,
    private maxRestarts = 2,
    private errorRetryMs = 60_000,
    private onGiveUp?: (conversationId: string) => void,
  ) {}

  private slot(id: string): Slot {
    let s = this.slots.get(id);
    if (!s) {
      s = { running: false, rerun: false, restarts: 0, errors: 0 };
      this.slots.set(id, s);
    }
    return s;
  }

  schedule(conversationId: string, delayMs: number) {
    if (this.stopped) return;
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
    if (this.stopped) throw new Error('La cola está cerrada');
    let s = this.slot(conversationId);
    while (s.running) {
      await s.finished;
      if (this.stopped) throw new Error('La cola está cerrada');
      s = this.slot(conversationId);
    }
    if (this.stopped) throw new Error('La cola está cerrada');
    s.running = true;
    let finish!: () => void;
    s.finished = new Promise<void>(resolve => { finish = resolve; });
    try {
      return await fn();
    } finally {
      s.running = false;
      finish();
      this.cleanup(conversationId);
    }
  }

  private async fire(conversationId: string) {
    if (this.stopped) return;
    const s = this.slot(conversationId);
    s.timer = undefined;
    if (s.running) {
      s.rerun = true;
      return;
    }
    s.running = true;
    let finish!: () => void;
    s.finished = new Promise<void>(resolve => { finish = resolve; });
    s.rerun = false;
    let status = 'error';
    try {
      status = (await this.runner(conversationId, { restarts: s.restarts })).status;
    } catch (e) {
      console.error('Error procesando conversación', conversationId, e);
    } finally {
      s.running = false;
      finish();
    }
    if (this.stopped) { this.slots.delete(conversationId); return; }
    if (status === 'busy') {
      // Otro proceso la está atendiendo: se vuelve a intentar sin contar como reinicio ni como error.
      this.schedule(conversationId, 2000);
      return;
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
      this.onGiveUp?.(conversationId);
    }
    s.errors = 0;
    if (s.rerun) {
      s.rerun = false;
      this.schedule(conversationId, 300);
      return;
    }
    this.cleanup(conversationId);
  }

  /** ¿Este proceso ya tiene la conversación programada o en curso? */
  has(conversationId: string) {
    return this.slots.has(conversationId);
  }

  canRestart(restarts: number) {
    return restarts < this.maxRestarts;
  }

  private cleanup(id: string) {
    const s = this.slots.get(id);
    if (s && !s.running && !s.timer && !s.rerun && !s.errors) this.slots.delete(id);
  }

  /** Cancel timers and drain writes before the database or process closes. */
  async stop() {
    this.stopped = true;
    const active: Promise<void>[] = [];
    for (const slot of this.slots.values()) {
      clearTimeout(slot.timer);
      if (slot.running && slot.finished) active.push(slot.finished);
    }
    await Promise.all(active);
    this.slots.clear();
  }

  get size() {
    return this.slots.size;
  }
}
