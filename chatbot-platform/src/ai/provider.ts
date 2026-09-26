import { config } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Usage {
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
}

export interface CompletionResult {
  content: string;
  usage: Usage;
  model: string;
  latency_ms: number;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number | null;
  reasoning_effort?: string;
  /** Si se indica, la respuesta debe cumplir este JSON Schema (structured outputs, strict). */
  json_schema?: { name: string; schema: Record<string, unknown> };
  max_tokens?: number;
}

/** Interfaz mínima del proveedor de IA: permite cambiar de proveedor o simularlo en pruebas. */
export interface AiProvider {
  complete(req: CompletionRequest): Promise<CompletionResult>;
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}

export class AiError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message);
  }
}

/** Modelos de razonamiento (gpt-5*, o1/o3/o4*) no aceptan temperature. */
function isReasoningModel(model: string) {
  return /^(gpt-5|o\d)/i.test(model);
}

export class OpenAiProvider implements AiProvider {
  constructor(
    private apiKey = config.openai.apiKey,
    private baseUrl = config.openai.baseUrl,
    private timeoutMs = config.openai.timeoutMs,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.apiKey) throw new AiError('OPENAI_API_KEY no configurado');
    const reasoning = isReasoningModel(req.model);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_completion_tokens: req.max_tokens ?? (reasoning ? 6000 : 1200),
    };
    if (!reasoning && req.temperature !== null && req.temperature !== undefined) body.temperature = req.temperature;
    if (reasoning && req.reasoning_effort) body.reasoning_effort = req.reasoning_effort;
    if (req.json_schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: req.json_schema.name, strict: true, schema: req.json_schema.schema },
      };
    }
    const started = Date.now();
    const res = await this.post('/chat/completions', JSON.stringify(body), { 'content-type': 'application/json' });
    const data: any = await res.json();
    const choice = data.choices?.[0];
    if (choice?.message?.refusal) throw new AiError(`El modelo se negó a responder: ${choice.message.refusal}`);
    const content: string = choice?.message?.content ?? '';
    if (!content) throw new AiError(`Respuesta vacía del modelo (finish_reason=${choice?.finish_reason})`);
    return {
      content,
      model: data.model ?? req.model,
      latency_ms: Date.now() - started,
      usage: {
        input_tokens: data.usage?.prompt_tokens ?? 0,
        cached_tokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        output_tokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    if (!this.apiKey) throw new AiError('OPENAI_API_KEY no configurado');
    const form = new FormData();
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('mp4') ? 'm4a' : 'ogg';
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType.split(';')[0] }), `audio.${ext}`);
    form.append('model', config.openai.transcriptionModel);
    form.append('language', 'es');
    const res = await this.post('/audio/transcriptions', form);
    const data: any = await res.json();
    return String(data.text ?? '').trim();
  }

  private async post(path: string, body: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(this.baseUrl + path, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.apiKey}`, ...headers },
          body,
          signal: ctrl.signal,
        });
        if (res.ok) return res;
        const text = await res.text();
        // Reintentar solo errores transitorios.
        if (res.status === 429 || res.status >= 500) {
          lastErr = new AiError(`OpenAI HTTP ${res.status}`, res.status, text.slice(0, 1000));
          await sleep(800 * 2 ** attempt);
          continue;
        }
        throw new AiError(`OpenAI HTTP ${res.status}: ${text.slice(0, 500)}`, res.status, text.slice(0, 1000));
      } catch (e: any) {
        if (e instanceof AiError && e.status && e.status < 500 && e.status !== 429) throw e;
        lastErr = e?.name === 'AbortError' ? new AiError('Tiempo de espera agotado al llamar a OpenAI') : e;
        await sleep(800 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new AiError(String(lastErr));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
