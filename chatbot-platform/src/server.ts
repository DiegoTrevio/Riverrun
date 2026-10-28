/** Servidor: lo carga index.ts después de validar la configuración. */
import { pollEmailChannels } from './channels/email.js';
import fs from 'node:fs';
import { KnowledgeMonitor } from './engine/knowledge-monitor.js';
import { OpenAiProvider } from './ai/provider.js';
import { buildApp } from './app.js';
import { bootstrapSuperadmin } from './auth.js';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { gracefulShutdown } from './shutdown.js';
import { startLifecycle } from './lifecycle.js';
import { startMonitor } from './monitor.js';
import { logEvent } from './logs.js';
import { advanceQuietReminders } from './automation/agenda.js';
import { runMaintenance } from './maintenance.js';
import { KnowledgeWorker } from './engine/knowledge-preparation.js';
import { startWatchdog } from './watchdog.js';
import { startWhatsappWatch } from './whatsapp-watch.js';
import { startMetaTokenWatch } from './channels/meta-connect.js';
import { startSocialSync } from './social/engagement.js';
import { startZernioHealthWatch } from './social/health.js';
import { startSocialStats } from './social/stats.js';

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
  // Las señales se atienden desde ya: un SIGTERM mientras arranca (retomando conversaciones) también cierra en orden.
  let watchdog: ReturnType<typeof startWatchdog> | null = null;
  let workerKeepAlive: ReturnType<typeof setInterval> | undefined;
  // Primero termina lo que está en curso (respuestas, trabajos), luego cierra la base; con plazo, para no quedarse colgado.
  const shutdown = gracefulShutdown({
    timeoutMs: config.shutdownTimeoutMs,
    exit: (code) => process.exit(code),
    steps: [
      { name: 'vigilante', run: () => { watchdog?.stop(); clearInterval(workerKeepAlive); } },
      { name: 'servidor y trabajos en curso', run: () => app.close() },
      { name: 'base de datos', run: () => pool.end() },
    ],
  });
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  if(!['all','http','worker'].includes(config.queue.role)) throw new Error('PROCESS_ROLE debe ser all, http o worker.');
  // Una señal mientras arranca (migraciones, retomar conversaciones): no se sigue arrancando lo que ya se está cerrando.
  if (shutdown.started) return;
  if(config.queue.role!=='worker') {
    await app.listen({ port: config.port, host: config.host });
    await logEvent({ level: 'info', source: 'system', message: `Servidor iniciado en el puerto ${config.port}` });
    if (config.quotes.pdfBackend === 'soffice') {
      void import('./quotes/pdf.js').then(async ({ sofficeAvailable }) => {
        if (!(await sofficeAvailable())) await logEvent({ level: 'warn', source: 'system', message: 'LibreOffice no está instalado: las cotizaciones no podrán generar su PDF. Usa la imagen de Docker del proyecto, instala libreoffice-writer o configura QUOTE_PDF_URL (Gotenberg).' });
      });
    }
  } else { await app.ready(); console.log('Worker PostgreSQL iniciado'); }

  if (shutdown.started) return;
  if(config.queue.role!=='http') {
  // Recordatorios de cita programados antes del horario para mensajes programados: se adelantan antes de que corran.
  await advanceQuietReminders().catch((e: any) => logEvent({ level: 'warn', source: 'system', message: `No se pudieron acomodar los recordatorios nocturnos: ${e?.message ?? e}` }));
  service.scheduler.start(config.schedulerIntervalMs);
  service.startSweeper();
  knowledgeWorker.start();
  knowledgeMonitor.start();
  startLifecycle();
  startMonitor();
  startWhatsappWatch();
  startMetaTokenWatch();
  startSocialSync();
  startZernioHealthWatch();
  startSocialStats();
  const resumed = await service.resumePending();
  if (resumed) console.log(`Retomando ${resumed} conversaciones pendientes`);

  // Pagos recurrentes: el cobro de cada periodo se crea unos días antes de que venza (cada hora; no se duplica).
  const plans = () => void import('./receivables/plans.js').then(({ runPlans }) => runPlans(service.receivables))
    .catch((e) => logEvent({ level: 'error', source: 'system', message: `Pagos recurrentes: ${e?.message ?? e}` }));
  plans();
  setInterval(plans, 3600 * 1000).unref();

  setInterval(() => void pollEmailChannels(service).catch((e) => logEvent({ level: 'error', source: 'channel', message: `Lectura de correo: ${e?.message ?? e}` })), config.emailPollSeconds * 1000).unref();

  setInterval(() => {
    // Retención y limpieza en lotes, en una sola instancia (las demás se saltan esta vuelta).
    runMaintenance().catch((e) => logEvent({ level: 'error', source: 'system', message: `Mantenimiento de la base: ${e?.message ?? e}` }));
    // Cotizaciones cuya vigencia ya pasó (con la fecha de cada negocio).
    void import('./quotes/agent.js').then(({ expireDueQuotes }) => expireDueQuotes()).catch((e) => logEvent({ level: 'error', source: 'system', message: `Vencimiento de cotizaciones: ${e?.message ?? e}` }));
  }, 6 * 3600 * 1000).unref();
  }
  // Vigilante: si la cola, las recepciones o las tareas programadas dejan de avanzar, o el proceso se bloquea, sale para
  // que Docker lo reinicie (los mensajes y trabajos están en PostgreSQL y se retoman al arrancar).
  watchdog = !config.watchdog.enabled ? null : startWatchdog({
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
  workerKeepAlive=config.queue.role==='worker'?setInterval(()=>{},30_000):undefined;

  process.on('unhandledRejection', (e) => {
    void logEvent({ level: 'error', source: 'system', message: `Promesa rechazada sin manejar: ${(e as any)?.message ?? e}`, details: e });
  });
}

main().catch((e) => {
  console.error('Error fatal al iniciar', e);
  process.exit(1);
});
