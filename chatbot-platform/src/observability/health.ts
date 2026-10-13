/**
 * Tres niveles de salud:
 *  - liveness (/health): el proceso responde. No consulta nada.
 *  - readiness (/health/ready): puede atender peticiones (base de datos y tareas). Público, sin detalles; 503 si falla.
 *  - funcional (/health/functional y /metrics): estado de cada componente con sus acciones. Requiere HEALTH_TOKEN.
 * Un canal opcional caído (WhatsApp, IA) no hace que la readiness falle: sí aparece en el funcional como degradado o
 * no disponible.
 */
import { config } from '../config.js';
import type { CheckResult } from '../monitor.js';
import { ACTIONS, overallState, stateOf, type Component } from './status.js';

/** Nombre visible de cada comprobación. Los nombres técnicos (id) no cambian: los usan el script y las alertas. */
export const LABELS: Record<string, string> = {
  database: 'Base de datos',
  whatsapp: 'Servicio de WhatsApp (Evolution)',
  whatsapp_sessions: 'WhatsApp: sesiones y entregas',
  scheduler: 'Tareas programadas',
  ai: 'IA (OpenRouter)',
  models: 'Modelos de IA',
  backup: 'Respaldos',
  disk: 'Espacio en disco',
  queue: 'Cola de mensajes y trabajos',
  resources: 'Recursos del proceso',
};

export function toComponents(checks: CheckResult[]): Component[] {
  return checks.map((c) => {
    const state = stateOf(c);
    const problem = state !== 'operativo' && state !== 'no_configurado';
    return {
      // id y state van primero: el script de actualización los busca por ese orden en el JSON.
      id: c.name,
      state,
      label: LABELS[c.name] ?? c.label,
      detail: c.detail,
      verified: state !== 'no_verificado',
      actions: problem ? (ACTIONS[c.name] ?? []) : [],
      ...(c.metrics ? { metrics: c.metrics } : {}),
    };
  });
}

export function functionalReport(checks: CheckResult[], now = new Date()) {
  const components = toComponents(checks);
  return {
    status: overallState(components),
    version: config.monitor.version,
    checked_at: now.toISOString(),
    components,
  };
}

/** Lo imprescindible para atender peticiones. Va aquí (no en quien llama) para que nadie añada WhatsApp sin querer. */
export const READINESS = ['database', 'scheduler'];

/**
 * Forma heredada de /health/ready (name/status): los monitores externos y ./riverrun la leen así. Solo incluye las
 * comprobaciones de READINESS.
 */
export function readinessReport(checks: CheckResult[]) {
  const statuses = checks.filter((c) => READINESS.includes(c.name)).map((c) => ({ name: c.name, status: c.status }));
  const failed = statuses.some((c) => c.status === 'fail');
  const warned = statuses.some((c) => c.status === 'warn');
  return {
    code: failed ? 503 : 200,
    body: { status: failed ? 'fail' : warned ? 'warn' : 'ok', version: config.monitor.version, checks: statuses },
  };
}
