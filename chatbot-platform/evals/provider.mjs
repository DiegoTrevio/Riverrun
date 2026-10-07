// Component evaluations use exactly the application's prompt builder, schema and validator.
// Synthetic fixtures only: no database, transports, contacts, notifications or customer exports.
import { LiveBudget } from './live-budget.mjs';
import { hydrateChatbot } from '../dist/types.js';
import { buildContext } from '../dist/engine/context.js';
import { validateDecision } from '../dist/engine/validator.js';
import { DECISION_JSON_SCHEMA } from '../dist/engine/decision.js';
import { OpenAiProvider } from '../dist/ai/provider.js';
import { config } from '../dist/config.js';
const liveBudget = process.env.RIVERRUN_EVAL_LIVE === 'true' ? new LiveBudget() : null;
if (liveBudget && (!process.env.OPENROUTER_API_KEY || config.openai.baseUrl !== 'https://openrouter.ai/api/v1')) throw new Error('La evaluación real requiere OPENROUTER_API_KEY y el endpoint oficial de OpenRouter.');

export default class RiverrunProvider {
  id() { return 'riverrun-context-validator'; }
  async callApi(prompt, context) {
    const vars = context.vars;
    const bot = hydrateChatbot({ id: 'fixture-bot', account_id: 'fixture-profile', name: 'Hotel de pruebas', active: true,
      personality: { prompt: 'Ayuda a reservar. Pregunta nombre y fecha de llegada, una pregunta a la vez.', emojis: 'none' },
      rules: { verify_facts: true }, data_fields: [], flow: {}, ai: {}, created_at: new Date(), updated_at: new Date() });
    const msg = { id: 1, direction: 'in', sender: 'customer', content: prompt, status: 'ok', created_at: new Date() };
    const knowledge = [{ id: 'fixture-knowledge', chatbot_id: bot.id, title: 'Tarifa', category: 'precios', content: 'Habitación doble: $1,650 MXN por noche.', active: true, always_include: false, sort_order: 0 }];
    const contact = { name: '', data: {}, notes: [] };
    const conversation = { summary: '', summary_until_id: 0, flow_step: 0, agent_state: {}, data: {} };
    const ctx = buildContext({ bot, knowledge, images: [], contact, conversation, history: [msg], pending: [msg], sentImageIds: [], imagesById: new Map(), now: new Date('2026-10-06T12:00:00Z') });
    let raw;
    let tokenUsage;
    let cost;
    if (process.env.RIVERRUN_EVAL_LIVE === 'true') {
      if (!config.openai.apiKey) throw new Error('La evaluación real requiere OPENROUTER_API_KEY.');
      const client = new OpenAiProvider(config.openai.apiKey, config.openai.baseUrl, config.openai.timeoutMs, 'openrouter', 1);
      const req = { model: config.openai.defaultModel, messages: ctx.messages, temperature: 0, max_tokens: liveBudget.maxTokens, json_schema: { name: 'chatbot_decision', schema: DECISION_JSON_SCHEMA } };
      const completion = await liveBudget.request('completion', req.model, req, () => client.complete(req));
      raw = JSON.parse(completion.content);
      cost = completion.cost_usd;
      tokenUsage = { prompt: completion.usage.input_tokens, completion: completion.usage.output_tokens, total: completion.usage.input_tokens + completion.usage.output_tokens };
    } else {
      raw = { thinking: '', action: 'reply', messages: [], image_ids: [], save_data: [], remember: [], handoff_reason: '', info_not_found: false, ...JSON.parse(vars.decision) };
    }
    const result = validateDecision({ raw, bot, images: [], sentImageIds: [], groundingSources: ctx.groundingSources, customerSources: ctx.customerSources, customerDataSources: [prompt], customerText: prompt, knownData: {}, final: true });
    return { output: JSON.stringify(result), ...(tokenUsage ? { tokenUsage, cost } : {}) };
  }
}
