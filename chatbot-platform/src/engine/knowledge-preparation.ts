import type { AiProvider } from '../ai/provider.js';
import { config } from '../config.js';
import { query } from '../db.js';
import * as store from '../store/index.js';
import { hydrateChatbot, type ChatbotRow } from '../types.js';
import { indexKnowledge, knowledgeIndexStatus, vectorAvailable } from './knowledge.js';

export type KnowledgeScope = { all: true } | { accountId: string } | { chatbotId: string };
export type PreparationResult = Awaited<ReturnType<typeof knowledgeIndexStatus>> & { chatbot_id: string; account_id: string; processed_items: number; failed: boolean };

/** Server operator entry point. HTTP callers must authorize scope before using it. */
export async function prepareKnowledge(scope: KnowledgeScope, options: { apply?: boolean; ai?: AiProvider; onProgress?: (result: PreparationResult) => void } = {}) {
  const bots = 'chatbotId' in scope ? [await store.getChatbot(scope.chatbotId)].filter((b) => b !== null) : await store.listChatbots('accountId' in scope ? scope.accountId : null);
  if (('chatbotId' in scope && !bots.length) || ('accountId' in scope && !await store.getAccount(scope.accountId))) throw new Error('Alcance no encontrado.');
  if (options.apply && (!config.knowledgeSearch.enabled || !options.ai?.embed || !await vectorAvailable())) throw new Error('La búsqueda semántica no está lista para preparar documentos.');
  const results: PreparationResult[] = [];
  for (const bot of bots) {
    const before = await knowledgeIndexStatus(bot);
    let processed = 0;
    let failed = false;
    if (options.apply) {
      try { processed = await indexKnowledge(bot, options.ai!); }
      catch { failed = true; } // Preserve successful documents; continue with other agents and retry later.
    }
    const status = options.apply ? await knowledgeIndexStatus(bot) : before;
    if (failed) processed = Math.max(0,status.indexed_items-before.indexed_items);
    const result = { ...status, chatbot_id: bot.id, account_id: bot.account_id, processed_items: processed, failed };
    results.push(result);
    options.onProgress?.(result);
  }
  return { applied: !!options.apply, complete: results.every((r) => r.complete && !r.failed), agents: results.length, pending_items: results.reduce((n,r) => n+r.pending_items,0), processed_items: results.reduce((n,r) => n+r.processed_items,0), failed_agents: results.filter((r) => r.failed).length, results };
}

/** Bounded round-robin maintenance: at most four documents of one eligible agent per pass. */
export class KnowledgeWorker {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = true;
  private cursor = 0;
  constructor(private ai: AiProvider) {}
  async runOnce() {
    if (!config.knowledgeSearch.enabled || !this.ai.embed || !await vectorAvailable()) return;
    const rows = await query<ChatbotRow>(`SELECT b.* FROM chatbots b JOIN accounts a ON a.id=b.account_id
      WHERE a.active AND a.status IN ('active','trial') AND (a.status <> 'trial' OR a.trial_ends_at > now()) ORDER BY b.id`);
    for (let scanned = 0; scanned < rows.length; scanned++) {
      const bot = hydrateChatbot(rows[this.cursor++ % rows.length]);
      if (!(await knowledgeIndexStatus(bot)).pending_items) continue;
      try { await indexKnowledge(bot,this.ai,4); }
      catch { console.warn('[knowledge] Preparación pendiente; se volverá a intentar sin perder documentos.'); }
      return;
    }
  }
  start() {
    if (!this.stopped || !config.knowledgeSearch.enabled || !config.openai.apiKey || !this.ai.embed) return;
    this.stopped = false;
    const schedule = () => {
      if (this.stopped) return;
      this.timer = setTimeout(() => {
        this.running = this.runOnce().catch(() => console.warn('[knowledge] No se pudo revisar el conocimiento pendiente.'));
        void this.running.finally(schedule);
      },30_000);
      this.timer.unref();
    };
    schedule();
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.running; }
}
