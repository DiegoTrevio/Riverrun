/**
 * Vocabulario común de la observabilidad. Un estado describe lo que se ha comprobado, no lo que se supone:
 *  - operativo: la función se comprobó y funciona.
 *  - degradado: funciona, con errores o demoras que conviene revisar.
 *  - no_disponible: no funciona o no responde.
 *  - no_configurado: la función no está activada en esta instalación. No es un fallo.
 *  - no_verificado: debería funcionar, pero no hay forma de comprobarlo ahora (p. ej. la consulta falló).
 * Que una variable esté definida o que un endpoint responda 200 no basta para declarar "operativo".
 */
export type ServiceState = 'operativo' | 'degradado' | 'no_disponible' | 'no_configurado' | 'no_verificado';

export const STATES: ServiceState[] = ['operativo', 'degradado', 'no_disponible', 'no_configurado', 'no_verificado'];

export const STATE_LABEL: Record<ServiceState, string> = {
  operativo: 'Operativo',
  degradado: 'Degradado',
  no_disponible: 'No disponible',
  no_configurado: 'No configurado',
  no_verificado: 'No verificado',
};

/** Resultado de una comprobación tal como lo produce monitor.ts (ok/warn/fail/na). */
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'na';

/** Estado por defecto de cada resultado. Una comprobación que no pudo medir se marca `no_verificado` explícitamente. */
const STATE_OF_STATUS: Record<CheckStatus, ServiceState> = { ok: 'operativo', warn: 'degradado', fail: 'no_disponible', na: 'no_configurado' };

export function stateOf(check: { status: CheckStatus; state?: ServiceState }): ServiceState {
  return check.state ?? STATE_OF_STATUS[check.status];
}

export interface Component {
  id: string;
  state: ServiceState;
  label: string;
  /** Lo que se midió, en una frase. Sin secretos, teléfonos ni contenido de mensajes. */
  detail: string;
  /** false cuando el estado es "no verificado": se sabe que no se pudo comprobar. */
  verified: boolean;
  /** Qué hacer cuando el estado no es operativo. */
  actions: string[];
  metrics?: Record<string, number | null>;
}

/** Peor estado que cuenta para la salud general. Lo no configurado o no verificado no tumba el conjunto. */
export function overallState(components: Pick<Component, 'state'>[]): ServiceState {
  if (components.some((c) => c.state === 'no_disponible')) return 'no_disponible';
  if (components.some((c) => c.state === 'degradado')) return 'degradado';
  return 'operativo';
}

/** Acciones por componente, con los comandos reales de ./riverrun. Se muestran solo cuando el estado no es operativo. */
export const ACTIONS: Record<string, string[]> = {
  database: ['Revisa PostgreSQL: ./riverrun logs postgres', 'Si acaba de reiniciarse, espera un minuto y vuelve a comprobar con ./riverrun status'],
  scheduler: ['Revisa el backend: ./riverrun logs backend', 'Si las tareas siguen atrasadas, reinicia con ./riverrun restart'],
  whatsapp: ['Revisa la llave de Evolution (EVOLUTION_API_KEY en .env) y ./riverrun logs evolution', 'Si Evolution pide licencia o rechaza la versión, vuelve a la versión verificada (docs/evolution-api.md)'],
  whatsapp_sessions: ['Vuelve a vincular los WhatsApp desconectados desde el panel', 'Si una instancia ya no existe en Evolution, no la recrees antes de revisar los respaldos'],
  ai: ['Revisa OPENROUTER_API_KEY y el saldo de la cuenta de OpenRouter', 'Revisa ./riverrun logs backend por errores del proveedor'],
  models: ['Cambia el modelo que ya no existe (OPENROUTER_MODEL) antes de que deje de responder'],
  backup: ['Ejecuta ./riverrun backup y luego ./riverrun status', 'Si la copia en la nube falla, revisa sus credenciales en .env'],
  disk: ['Libera espacio o amplía el disco antes de que los respaldos y las subidas fallen'],
  queue: ['Espera unos minutos: la cola se vacía sola si el backend funciona', 'Si los trabajos siguen atascados, reinicia con ./riverrun restart'],
  resources: ['Revisa el consumo con ./riverrun status y docker stats', 'Si la memoria no baja, reinicia el backend en una ventana de poco uso'],
};
