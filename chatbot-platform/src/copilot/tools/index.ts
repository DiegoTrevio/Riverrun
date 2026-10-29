/** Todas las herramientas del Copiloto, en orden fijo (así el prompt con herramientas se aprovecha de la caché). */
import type { ToolDef } from '../registry.js';
import { ACCOUNT_TOOLS } from './cuenta.js';
import { CONTACT_TOOLS } from './contactos.js';
import { CONVERSATION_TOOLS } from './conversaciones.js';

export const COPILOT_TOOLS: ToolDef[] = [...ACCOUNT_TOOLS, ...CONTACT_TOOLS, ...CONVERSATION_TOOLS];
