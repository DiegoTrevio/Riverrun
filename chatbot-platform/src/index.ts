import fs from 'node:fs';
import { OpenAiProvider } from './ai/provider.js';
import { buildApp } from './app.js';
import { bootstrapSuperadmin } from './auth.js';
import { assertProductionConfig, config } from './config.js';
import { migrate } from './db.js';
import { logEvent, pruneLogs } from './logs.js';

async function main() {
  for (const p of assertProductionConfig()) console.warn(`⚠️  ${p}`);
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  const applied = await migrate();
  if (applied.length) console.log(`Migraciones aplicadas: ${applied.join(', ')}`);
  await bootstrapSuperadmin();

  const { app, service } = await buildApp({ ai: new OpenAiProvider(), logger: process.env.HTTP_LOG === 'true' });
  await app.listen({ port: config.port, host: config.host });
  await logEvent({ level: 'info', source: 'system', message: `Servidor iniciado en el puerto ${config.port}` });

  const resumed = await service.resumePending();
  if (resumed) console.log(`Retomando ${resumed} conversaciones pendientes`);

  setInterval(() => pruneLogs(config.logRetentionDays).catch(() => undefined), 6 * 3600 * 1000).unref();

  const shutdown = async () => {
    console.log('Cerrando...');
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
