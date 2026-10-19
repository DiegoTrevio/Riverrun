/** Servidor: lo carga index.ts después de validar la configuración. */
import { pollEmailChannels } from './channels/email.js';
import fs from 'node:fs';
import { KnowledgeMonitor } from './engine/knowledge-monitor.js';
import { OpenAiProvider } from './ai/provider.js';
import { buildApp } from './app.js';
import { bootstrapSuperadmin } from './auth.js';
import { config } from './config.js';
import { migrate } from './db.js';
import { startLifecycle } from './lifecycle.js';
import { startMonitor } from './monitor.js';
import { logEvent, pruneLogs } from './logs.js';
import { applyRetention } from './privacy.js';
import { pruneAiRunDetail, pruneAutomationData } from './automation/store.js';
import { KnowledgeWorker } from './engine/knowledge-preparation.js';
import { startWatchdog } from './watchdog.js';
import { startWhatsappWatch } from './whatsapp-watch.js';
import { startMetaTokenWatch } from './channels/meta-connect.js';
import { startSocialSync } from './social/engagement.js';

async function main() {
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  const applied = await migrate();
  if (applied.length) console.log(`Migraciones aplicadas: ${applied.join(', ')}`);
  await bootstrapSuperadmin();

  const ai = new OpenAiProvider();
  const { app, service } = await buildApp({ ai, logger: process.env.HTTP_LOG === 'true' });
  const knowledgeMonitor = new KnowledgeMonitor();
  app.addHook('onClose', async () => knowledgeMonitor.stop());
  const knowledgeWorker = new KnowledgeWorker(ai);
  app.addHook('onClose', async () => knowledgeWorker.stop());
  if(!['all','http','worker'].includes(config.queue.role)) throw new Error('PROCESS_ROLE debe ser all, http o worker.');
  if(config.queue.role!=='worker') {
    await app.listen({ port: config.port, host: config.host });
    await logEvent({ level: 'info', source: 'system', message: `Servidor iniciado en el puerto ${config.port}` });
  } else { await app.ready(); console.log('Worker PostgreSQL iniciado'); }

  if(config.queue.role!=='http') {
  service.scheduler.start(config.schedulerIntervalMs);
  service.startSweeper();
  knowledgeWorker.start();
  knowledgeMonitor.start();
  startLifecycle();
  startMonitor();
  startWhatsappWatch();
  startMetaTokenWatch();
  startSocialSync();
  const resumed = await service.resumePending();
  if (resumed) console.log(`Retomando ${resumed} conversaciones pendientes`);

  setInterval(() => void pollEmailChannels(service).catch((e) => logEvent({ level: 'error', source: 'channel', message: `Lectura de correo: ${e?.message ?? e}` })), config.emailPollSeconds * 1000).unref();

  setInterval(() => {
    applyRetention().catch((e) => logEvent({ level: 'error', source: 'system', message: `Retención de datos: ${e?.message ?? e}` }));
    pruneLogs(config.logRetentionDays).catch(() => undefined);
    pruneAutomationData(config.logRetentionDays).catch(() => undefined);
    pruneAiRunDetail(config.aiRunDetailDays).catch(() => undefined);
  }, 6 * 3600 * 1000).unref();
  }
  // Vigilante: si la cola, las recepciones o las tareas programadas dejan de avanzar, o el proceso se bloquea, sale para
  // que Docker lo reinicie (los mensajes y trabajos están en PostgreSQL y se retoman al arrancar).
  const watchdog = !config.watchdog.enabled ? null : startWatchdog({
      loops: config.queue.role === 'http' ? [] : ['queue', 'inbox', 'scheduler'],
      stallMs: config.watchdog.stallMs,
      blockMs: config.watchdog.blockMs,
      onStall: async (stalled) => {
        const detail = stalled.map((l) => `${l.name} (${Math.round(l.ms / 60000)} min)`).join(', ');
        console.error(`[vigilante] Sin avance: ${detail}. Se reinicia el proceso.`);
        await Promise.race([logEvent({ level: 'error', source: 'system', message: `Proceso reiniciado por el vigilante: sin avance en ${detail}` }), new Promise((r) => setTimeout(r, 3000))]).catch(() => undefined);
        process.exit(1);
      },
    });
  const workerKeepAlive=config.queue.role==='worker'?setInterval(()=>{},30_000):undefined;

  const shutdown = async () => {
    console.log('Cerrando...');
    watchdog?.stop();
    clearInterval(workerKeepAlive);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('unhandledRejection', (e) => {
    void logEvent({ level: 'error', source: 'system', message: `Promesa rechazada sin manejar: ${(e as any)?.message ?? e}`, details: e });
  });
}

main().catch((e) => {
  console.error('Error fatal al iniciar', e);
  process.exit(1);
});
