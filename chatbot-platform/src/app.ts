import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { AiProvider } from './ai/provider.js';
import { adminRoutes } from './routes/admin.js';
import { webhookRoutes } from './routes/webhook.js';
import { ChatService, type TransportFactory } from './service.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp(opts: { ai: AiProvider; transportFactory?: TransportFactory; logger?: boolean }) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024, trustProxy: true });
  const service = new ChatService(opts.ai, opts.transportFactory);

  await app.register(cookie);
  await app.register(multipart);
  await app.register(fastifyStatic, { root: path.resolve(here, '..', 'public'), prefix: '/' });

  app.get('/health', async () => ({ ok: true }));
  await webhookRoutes(app, service);
  await adminRoutes(app, service);

  return { app, service };
}
