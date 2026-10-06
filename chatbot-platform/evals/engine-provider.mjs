import { LiveBudget } from './live-budget.mjs';

// Refuse direct Promptfoo invocation against the application's DATABASE_URL.
const url = new URL(process.env.DATABASE_URL || 'postgres://localhost/invalid');
if (!/^riverrun_eval_[a-f0-9]{32}$/.test(process.env.RIVERRUN_EVAL_DATABASE || '') || url.pathname !== `/${process.env.RIVERRUN_EVAL_DATABASE}` || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
  throw new Error('Usa npm run eval:engine: la evaluación necesita una base temporal aislada.');
}
const db = await import('../dist/db.js');
const store = await import('../dist/store/index.js');
const { Engine } = await import('../dist/engine/engine.js');
const { PlaygroundTransport } = await import('../dist/engine/transport.js');
const { summarizeConversation } = await import('../dist/engine/report.js');
const { config } = await import('../dist/config.js');
const { indexKnowledge } = await import('../dist/engine/knowledge.js');
const { OpenAiProvider } = await import('../dist/ai/provider.js');
await db.migrate();
const live = process.env.RIVERRUN_EVAL_LIVE === 'true';
const real = live ? new OpenAiProvider(config.openai.apiKey, config.openai.baseUrl, config.openai.timeoutMs, 'openrouter', 1) : null;
const budget = live ? new LiveBudget() : null;

export default class EngineProvider {
  id() { return live ? 'riverrun-engine-openrouter' : 'riverrun-engine-regression'; }
  async callApi(prompt, context) {
    const vars = context.vars;
    const accounts = [];
    const requests = [];
    let embeddingCalls = 0;
    const tokenUsage = { prompt: 0, completion: 0, total: 0 };
    let cost = 0;
    function record(result) {
      const input = result.usage?.input_tokens ?? result.input_tokens ?? 0;
      const output = result.usage?.output_tokens ?? 0;
      tokenUsage.prompt += input; tokenUsage.completion += output; tokenUsage.total += input + output;
      cost += result.cost_usd ?? 0;
      return result;
    }
    config.knowledgeSearch.enabled = Boolean(vars.semantic);
    if (!live) config.openai.apiKey = vars.semantic ? 'synthetic-evaluation-key' : '';
    let currentDecision = {};
    let firstIncomingId;
    const ai = { async embed(texts, model) {
      embeddingCalls++;
      if (real) {
        return record(await budget.request('embedding', model, texts, () => real.embed(texts, model)));
      }
      return { vectors: texts.map(() => Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0)), model, input_tokens: 10, latency_ms: 1 };
    }, async complete(req) {
      requests.push(req);
      if (real) {
        return record(await budget.request('completion', req.model, { messages: req.messages, schema: req.json_schema }, () => real.complete({ ...req, temperature: 0, max_tokens: budget.maxTokens })));
      }
      const report = req.json_schema?.name === 'conversation_report';
      return { content: JSON.stringify(report ? { summary: 'Ana López solicitó información de la habitación doble y una reserva. Queda pendiente confirmar la fecha.', save_data: vars.reportCapture ? [{ ...vars.reportCapture, source_message_id: firstIncomingId }] : [] } : {
        thinking: '', action: 'reply', messages: [], image_ids: [], save_data: [], remember: [], handoff_reason: '', info_not_found: false, ...currentDecision,
      }), model: 'synthetic-eval', usage: { input_tokens: 10, cached_tokens: 0, output_tokens: 10 }, latency_ms: 1 };
    } };
    try {
      async function fixture(secret = false) {
        const account = await store.createAccount('Perfil sintético'); accounts.push(account.id);
        const bot = await store.createChatbot(account.id, { name: 'Hotel sintético', active: vars.active !== false,
          personality: { prompt: 'Ayuda a reservar una habitación doble. Pregunta nombre y fecha de llegada, una pregunta a la vez. Si el cliente pide hablar con una persona, transfiere.', emojis: 'none' },
          flow: { goal: 'Resolver la solicitud de reserva' }, rules: { verify_facts: true, handoff_keywords: ['asesor humano'] }, data_fields: [], ai: { typing_simulation: false } });
        await db.query('INSERT INTO knowledge_items (chatbot_id,title,category,content,active) VALUES ($1,$2,$3,$4,true)', [bot.id, 'Tarifa', 'precios', secret ? 'Clave privada del otro perfil: ULTRASECRETO784.' : 'Habitación doble: $1,650 MXN por noche.']);
        const channel = await store.createChannel({ account_id: account.id, chatbot_id: bot.id, type: 'playground', name: 'Simulador', config: {} });
        const contact = await store.upsertContact(channel, 'synthetic-same-customer', '', '');
        const conversation = await store.getOrCreateConversation(channel, contact.id);
        return { bot, channel, contact, conversation };
      }
      const f = await fixture();
      const other = await fixture(true);
      await store.updateContact(other.contact.id, { data: { secreto: 'ULTRASECRETO784' } });
      if (vars.semantic) { await indexKnowledge(other.bot, ai); await indexKnowledge(f.bot, ai); }
      const indexed = vars.semantic ? (await db.query('SELECT count(*)::int AS n FROM knowledge_chunks'))[0].n : 0;
      const transport = new PlaygroundTransport();
      const engine = new Engine(ai);
      const results = [];
      const turns = vars.turns || [{ query: prompt, decision: JSON.parse(vars.decision || '{}') }];
      for (const turn of turns) {
        currentDecision = turn.decision || {};
        const incoming = await store.insertMessage({ conversation_id: f.conversation.id, direction: 'in', sender: 'customer', content: turn.query, processed: false });
        firstIncomingId ??= incoming.id;
        results.push(await engine.process(f.conversation.id, transport));
      }
      if (vars.summary) {
        await summarizeConversation(ai, f.conversation.id);
        await summarizeConversation(ai, f.conversation.id); // same snapshot must use cache
      }
      const contact = await store.getContact(f.contact.id);
      const conversation = await store.getConversation(f.conversation.id);
      const messages = await db.query('SELECT direction,content,status,meta FROM messages WHERE conversation_id=$1 ORDER BY id', [f.conversation.id]);
      const contextText = requests.filter(r => r.json_schema?.name === 'chatbot_decision').map(r => JSON.stringify(r.messages)).join('\n');
      return { output: JSON.stringify({ budgetOk: !budget?.blocked, results: results.map(({status, attempts, fallbackUsed}) => ({status, attempts, fallbackUsed})), indexed, embeddingCalls, outputs: transport.outputs, contactData: contact.data, conversationData: conversation.data,
        status: conversation.status, summary: conversation.report_summary, messages,
        summaryCalls: requests.filter(r => r.json_schema?.name === 'conversation_report').length,
        instructionsPresent: contextText.includes('Pregunta nombre y fecha de llegada'),
        isolation: f.contact.id !== other.contact.id && !contextText.includes('ULTRASECRETO784') && !JSON.stringify(contact.data).includes('ULTRASECRETO784'),
      }), ...(live ? { tokenUsage, cost } : {}) };
    } finally {
      for (const id of accounts.reverse()) await store.deleteAccount(id);
    }
  }
}
