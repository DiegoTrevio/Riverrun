/**
 * Punto de entrada. Valida la configuración antes de cargar el resto: config.ts interpreta las variables al
 * importarse, así que un valor crítico se reporta aquí completo (todos los problemas juntos y cómo corregirlos)
 * en vez de detener el proceso con el primer error.
 */
import { checkConfigAtStartup } from './config-check.js';

if (!checkConfigAtStartup()) process.exit(1);
await import('./server.js');
