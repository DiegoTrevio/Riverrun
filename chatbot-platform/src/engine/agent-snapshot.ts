import { AsyncLocalStorage } from 'node:async_hooks';
import type { Chatbot, ImageAsset } from '../types.js';

// Server-only evaluation scope: no shared live row is ever changed for a test.
const evaluation = new AsyncLocalStorage<{bot:Chatbot;images?:ImageAsset[]}>();
export function evaluatedChatbot(id: string): Chatbot | undefined {
  const bot = evaluation.getStore()?.bot;
  return bot?.id === id ? bot : undefined;
}
export function evaluatedImages(id:string) { const scope=evaluation.getStore();return scope?.bot.id===id?scope.images:undefined; }
export function withAgentSnapshot<T>(bot: Chatbot, fn: () => Promise<T>,images?:ImageAsset[]): Promise<T> {
  return evaluation.run({bot,images}, fn);
}
