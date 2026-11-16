// Panel de administración — módulos ES nativos (sin build ni dependencias).
// Estructura: js/core.js (utilidades y campos) · js/session.js · js/shell.js (menú y avisos) · js/main.js (router)
// y un módulo por área: auth, dashboard, bot, playground, conversations, channels, automation, agenda,
// agentwizard y agentstart (crear un agente en 3 pasos), billing, system, usage, admin, logs, whatsapp, importer.
// Primero el idioma (js/i18n.js): en inglés se carga su diccionario antes de dibujar, para no ver el panel en español un instante.
import { initI18n } from './js/i18n.js';

await initI18n();
await import('./js/main.js');
