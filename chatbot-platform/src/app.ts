import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { AiProvider } from './ai/provider.js';
import { config } from './config.js';
import { requireAuth } from './auth.js';
import { adminRoutes, sessionRoutes } from './routes/admin.js';
import { agendaRoutes, calendarRoutes } from './routes/agenda.js';
import { automationRoutes } from './routes/automation.js';
import { channelRoutes } from './routes/channels.js';
import { chatbotRoutes } from './routes/chatbots.js';
import { conversationRoutes } from './routes/conversations.js';
import { billingRoutes, billingWebhooks } from './routes/billing.js';
import { poolAdminRoutes, poolPublicRoutes } from './routes/pools.js';
import { googleLoginRoutes } from './routes/google-login.js';
import { brandAdminRoutes, brandPublicRoutes } from './routes/brands.js';
import { integrationRoutes, googleCallbackRoute } from './routes/integrations.js';
import { openApiRoutes } from './routes/openapi.js';
import { apiV1Routes } from './routes/api-v1.js';
import { exportRoutes } from './routes/export.js';
import { knowledgeImportRoutes } from './routes/import.js';
import { onboardingRoutes } from './routes/onboarding.js';
import { analyticsRoutes } from './routes/analytics.js';
import { attachmentRoutes } from './routes/attachments.js';
import { taskRoutes } from './routes/tasks.js';
import { publicRoutes } from './routes/public.js';
import { signupRoutes } from './routes/signup.js';
import { installErrorHandler } from './routes/util.js';
import { cachedChecks, runReadiness } from './monitor.js';
import { functionalReport, readinessReport } from './observability/health.js';
import { collectMetricsExtra, renderMetrics } from './observability/metrics.js';
import { ChatService, type TransportFactory } from './service.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Protege /health/functional y /metrics. Sin HEALTH_TOKEN el endpoint no existe (404), no "está abierto": así una
 * instalación nueva no expone su estado interno por omisión. La comparación va por SHA-256 para que no dependa de la longitud.
 */
function healthGate(req: FastifyRequest, reply: FastifyReply): boolean {
  const expected = config.monitor.healthToken;
  if (!expected) {
    reply.code(404).send({ error: 'No encontrado' });
    return false;
  }
  const auth = req.headers.authorization;
  const given = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : String(req.headers['x-health-token'] ?? '');
  const ok = timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());
  if (!ok) {
    reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'Token requerido' });
    return false;
  }
  return true;
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function buildApp(opts: { ai: AiProvider; transportFactory?: TransportFactory; logger?: boolean }) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024, trustProxy: (_addr: string, hop: number) => hop < config.trustProxyHops });
  const service = new ChatService(opts.ai, opts.transportFactory);
  app.addHook('onClose', async () => {
    await service.inbox.stop();
    await service.scheduler.stop();
    service.stopSweeper();
    await service.queue.stop();
    await service.engine.settleBackground();
    await service.automator.settleAll();
  });

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

  // Liveness: el proceso responde. No consulta nada, así un fallo externo no reinicia el contenedor en bucle.
  app.get('/health', async () => ({ ok: true }));
  // Readiness: puede atender peticiones. Público y sin detalles; 503 solo si la base de datos o las tareas fallan.
  app.get('/health/ready', async (_req, reply) => {
    const { code, body } = readinessReport(await runReadiness());
    return reply.code(code).send(body);
  });
  // Funcional y métricas: requieren HEALTH_TOKEN. Sin token configurado, no existen (404).
  app.get('/health/functional', async (req, reply) => {
    if (!healthGate(req, reply)) return reply;
    return functionalReport(await cachedChecks());
  });
  app.get('/metrics', async (req, reply) => {
    if (!healthGate(req, reply)) return reply;
    const text = renderMetrics(await cachedChecks(), await collectMetricsExtra());
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(text);
  });
  await sessionRoutes(app);
  await signupRoutes(app);
  await publicRoutes(app, service);
  await calendarRoutes(app);
  await billingWebhooks(app);
  await poolPublicRoutes(app);
  await googleCallbackRoute(app);
  await brandPublicRoutes(app);
  await googleLoginRoutes(app);
  await openApiRoutes(app);
  await apiV1Routes(app, service);

  // Todo lo demás requiere sesión; cada ruta verifica además la cuenta y el rol.
  await app.register(async (api) => {
    api.addHook('preHandler', requireAuth);
    await adminRoutes(api, service);
    await chatbotRoutes(api, service);
    await channelRoutes(api);
    await conversationRoutes(api, service);
    await automationRoutes(api, service);
    await agendaRoutes(api, service);
    await onboardingRoutes(api);
    await analyticsRoutes(api);
    await attachmentRoutes(api);
    await taskRoutes(api);
    await knowledgeImportRoutes(api, opts.ai);
    await billingRoutes(api);
    await exportRoutes(api);
    await poolAdminRoutes(api);
    await integrationRoutes(api);
    await brandAdminRoutes(api);
  });

  return { app, service };
}
