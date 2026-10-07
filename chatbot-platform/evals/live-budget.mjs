import { writeFileSync } from 'node:fs';

function limit(value, fallback, max, integer = false) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n <= 0 || n > max || (integer && !Number.isInteger(n))) throw new Error('Límite de evaluación inválido.');
  return n;
}

// This is a conservative reservation, not an OpenRouter spending guarantee.
// A dedicated OpenRouter key with a provider-enforced credit limit is required.
export class LiveBudget {
  constructor(env = process.env) {
    this.maxUsd = limit(env.RIVERRUN_EVAL_MAX_USD, 1, 10);
    this.maxCalls = limit(env.RIVERRUN_EVAL_MAX_CALLS, 40, 40, true);
    this.maxTokens = limit(env.RIVERRUN_EVAL_MAX_OUTPUT_TOKENS, 2000, 2000, true);
    this.path = env.RIVERRUN_EVAL_USAGE_FILE;
    this.calls = 0; this.reportedUsd = 0; this.reservedUsd = 0; this.unknownCostCalls = 0; this.blocked = false;
    this.inputTokens = 0; this.outputTokens = 0;
  }
  snapshot() {
    return { max_usd: this.maxUsd, max_calls: this.maxCalls, calls: this.calls, reported_usd: this.reportedUsd,
      reserved_usd: this.reservedUsd, unknown_cost_calls: this.unknownCostCalls, blocked: this.blocked,
      input_tokens: this.inputTokens, output_tokens: this.outputTokens };
  }
  save() { if (this.path) writeFileSync(this.path, JSON.stringify(this.snapshot(), null, 2) + '\n', { mode: 0o600 }); }
  async request(kind, model, input, execute) {
    const expected = kind === 'embedding' ? 'text-embedding-3-small' : 'gpt-4.1-mini';
    // Unsupported models need a reviewed price/reservation policy before use.
    const validModel = model === expected || model === `openai/${expected}`;
    const bytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
    const reserve = (bytes + 4096) * (kind === 'embedding' ? 1 : 5) / 1e6 + (kind === 'embedding' ? 0 : this.maxTokens * 20 / 1e6);
    if (this.blocked || !validModel || bytes > 100000 || this.calls >= this.maxCalls || this.reportedUsd + this.reservedUsd + reserve > this.maxUsd) {
      this.blocked = true; this.save(); throw new Error('Evaluación detenida por límites de consumo o modelo no permitido.');
    }
    this.calls++; this.reservedUsd += reserve; this.save();
    try {
      const result = await execute();
      this.inputTokens += result.usage?.input_tokens ?? result.input_tokens ?? 0;
      this.outputTokens += result.usage?.output_tokens ?? 0;
      if (typeof result.cost_usd !== 'number' || !Number.isFinite(result.cost_usd) || result.cost_usd < 0) {
        this.unknownCostCalls++; this.blocked = true;
        throw new Error('El proveedor no reportó un costo válido; no se enviarán más solicitudes.');
      }
      this.reservedUsd -= reserve;
      this.reportedUsd += result.cost_usd;
      if (result.cost_usd > reserve || this.reportedUsd + this.reservedUsd > this.maxUsd) {
        this.blocked = true;
        throw new Error('El costo reportado superó el presupuesto o la reserva; no se enviarán más solicitudes.');
      }
      return result;
    } catch (error) {
      // Failed requests may have been charged: never reuse their reservation.
      this.blocked = true;
      throw error;
    } finally { this.save(); }
  }
}
