import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { AiProvider } from './ai/provider.js';
import { config } from './config.js';
import { requireAuth } from './auth.js';
import { adminRoutes, sessionRoutes } from './routes/admin.js';
import { channelRoutes } from './routes/channels.js';
import { chatbotRoutes } from './routes/chatbots.js';
import { conversationRoutes } from './routes/conversations.js';
import { publicRoutes } from './routes/public.js';
import { installErrorHandler } from './routes/util.js';
import { ChatService, type TransportFactory } from './service.js';

const here = path.dirname(fileURLToPath(import.meta.url));

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function buildApp(opts: { ai: AiProvider; transportFactory?: TransportFactory; logger?: boolean }) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024, trustProxy: (_addr: string, hop: number) => hop < config.trustProxyHops });
  const service = new ChatService(opts.ai, opts.transportFactory);

  // JSON conservando el cuerpo original: Meta firma los webhooks sobre los bytes exactos.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    req.rawBody = body;
    if (!body.length) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      const err: any = new Error('JSON inválido');
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  installErrorHandler(app);
  await app.register(cookie);
  await app.register(multipart);
  await app.register(fastifyStatic, { root: path.resolve(here, '..', 'public'), prefix: '/' });

  app.get('/health', async () => ({ ok: true }));
  await sessionRoutes(app);
  await publicRoutes(app, service);

  // Todo lo demás requiere sesión; cada ruta verifica además la cuenta y el rol.
  await app.register(async (api) => {
    api.addHook('preHandler', requireAuth);
    await adminRoutes(api, service);
    await chatbotRoutes(api, service);
    await channelRoutes(api);
    await conversationRoutes(api, service);
  });

  return { app, service };
}
