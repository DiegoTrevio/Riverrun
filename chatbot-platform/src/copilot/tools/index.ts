/** Todas las herramientas del Copiloto, en orden fijo (así el prompt con herramientas se aprovecha de la caché). */
import type { ToolDef } from '../registry.js';
import { AGENT_TOOLS } from './agente.js';
import { AUTOMATION_TOOLS } from './automatizacion.js';
import { ACCOUNT_TOOLS } from './cuenta.js';
import { CONTACT_TOOLS } from './contactos.js';
import { CONVERSATION_TOOLS } from './conversaciones.js';
import { OPERATION_TOOLS } from './operacion.js';

export const COPILOT_TOOLS: ToolDef[] = [...ACCOUNT_TOOLS, ...CONTACT_TOOLS, ...CONVERSATION_TOOLS, ...OPERATION_TOOLS, ...AGENT_TOOLS, ...AUTOMATION_TOOLS];
