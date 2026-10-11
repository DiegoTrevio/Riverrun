import { api, fill, fmtDate, h, run } from './core.js';

/* ------------------------------ Sistema → Configuración y servicios (superadmin) ------------------------------ */
// Muestra lo que valida el servidor: nunca valores de claves ni direcciones internas con credenciales.

const LEVEL = { critical: ['red', 'Crítico'], warning: ['orange', 'Aviso'], optional: ['', 'Opcional'] };
const STATUS = { ok: ['green', '✓ Bien'], warn: ['orange', '! Atención'], fail: ['red', '✕ Falla'], na: ['', '—'] };
const ENV = { production: 'producción', development: 'desarrollo', test: 'pruebas' };
const STEPS = [['configured', 'Configurado'], ['reachable', 'Accesible'], ['credentials', 'Credenciales válidas'], ['functional', 'Funcional'], ['ready', 'Listo para usarse']];
const COMPAT = { verified: 'green', unverified: 'orange', unknown: 'orange', incompatible: 'red' };
const badge = ([cls, text]) => h('span', { class: `badge ${cls}` }, text);
const step = (v) => (v === true ? '✓' : v === false ? '✕' : '—');

function probeRow(p) {
  return h('div', { style: 'padding:10px 0;border-top:1px solid var(--border)' },
    h('div', { class: 'row between' }, h('strong', {}, p.label), badge(STATUS[p.status] ?? STATUS.na)),
    // Cada nivel por separado: una variable presente o una respuesta HTTP no bastan para decir que funciona.
    h('p', { class: 'small', style: 'margin:4px 0' }, STEPS.map(([k, label], i) => [i ? ' · ' : '', h('span', { title: p[k] === null ? 'No verificado' : '' }, `${step(p[k])} ${label}`)])),
    p.detail ? h('p', { class: 'small muted', style: 'margin:0' }, p.detail) : null);
}

function issueRow(i) {
  return h('li', { style: 'margin-bottom:10px' },
    badge(LEVEL[i.level]), ' ', i.message,
    h('div', { class: 'small muted' }, '→ ', i.fix, i.vars.length ? [' (', i.vars.map((v, n) => [n ? ', ' : '', h('code', {}, v)]), ')'] : null));
}

function evolutionCard(e) {
  const s = e.sessions;
  return h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'WhatsApp (Evolution API)'),
    h('p', { class: 'small' }, 'Versión esperada: ', h('code', {}, e.expected.version)),
    h('p', { class: 'small' }, 'Imagen configurada: ', e.configured_image ? h('code', { style: 'word-break:break-all' }, e.configured_image) : 'no informada al panel',
      ' ', e.pinned === true ? badge(['green', 'fijada']) : e.pinned === false ? badge(['red', 'NO fijada']) : null),
    h('p', { class: 'small' }, 'Versión detectada: ', h('strong', {}, e.detected_version ?? 'No verificada'), ' ', badge([COMPAT[e.compatibility.status] ?? '', e.compatibility.label])),
    h('p', { class: 'small muted' }, e.compatibility.detail),
    h('p', { class: 'small' }, 'Servicio: ', e.reachable === null ? 'sin comprobar' : e.reachable ? 'responde' : h('span', { class: 'error' }, `no responde${e.error ? ` (${e.error})` : ''}`),
      e.auth === false ? h('span', { class: 'error' }, ' · llave rechazada') : e.auth ? ' · llave aceptada' : ''),
    s ? h('p', { class: 'small' }, `Sesiones: ${s.open} abiertas de ${s.total}`, s.connecting ? ` · ${s.connecting} conectando` : '', s.closed ? ` · ${s.closed} cerradas` : '',
      s.missing ? h('span', { class: 'error' }, ` · ${s.missing} perdidas`) : '', s.webhook_problems ? h('span', { class: 'error' }, ` · ${s.webhook_problems} con webhook incorrecto`) : '') : null,
    e.problems?.length ? h('ul', { class: 'small' }, e.problems.map((p) => h('li', {}, h('a', { href: `#/channel/${p.channel_id}` }, p.channel), ': ',
      p.state === 'not_found' ? 'la instancia ya no existe en Evolution (no la vuelvas a vincular sin revisar los respaldos)' : p.state === 'error' ? 'no se pudo consultar' : `webhook ${p.webhook === 'missing' ? 'ausente' : p.webhook === 'disabled' ? 'desactivado' : 'distinto al esperado'} (en el canal, "Reconfigurar webhook")`))) : null,
    e.version_change ? h('p', { class: 'small' }, `Cambio de versión: ${e.version_change.from ?? '?'} → ${e.version_change.to} (${fmtDate(e.version_change.at)})`) : null,
    h('p', { class: 'small muted' }, `Última verificación: ${e.last_checked_at ? fmtDate(e.last_checked_at) : 'todavía no'}. Para cambiar de versión: ./riverrun update (respaldo verificado, confirmación y vuelta atrás segura).`));
}

function render(box, d) {
  const c = d.config;
  const conn = d.connectivity;
  const optional = c.issues.filter((i) => i.level === 'optional');
  const important = c.issues.filter((i) => i.level !== 'optional');
  fill(box,
    h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, 'Configuración'), badge(STATUS[c.status])),
      d.started_with_critical ? h('div', { class: 'banner danger', style: 'margin-top:8px' }, 'El servidor arrancó con CONFIG_VALIDATION=warn a pesar de problemas críticos. Corrígelos y quita esa variable.') : null,
      h('p', { class: 'small' }, `Entorno: ${ENV[c.env] ?? c.env} · ${c.counts.critical} crítico(s) · ${c.counts.warning} aviso(s) · ${c.counts.optional} opcional(es) apagado(s) · revisada ${fmtDate(c.checked_at)}`),
      important.length ? h('ul', { style: 'padding-left:18px' }, important.map(issueRow)) : h('p', { class: 'small' }, '✓ Sin problemas críticos ni avisos.'),
      optional.length ? h('details', {}, h('summary', {}, `Servicios opcionales apagados (${optional.length})`), h('ul', { style: 'padding-left:18px' }, optional.map(issueRow))) : null),
    h('div', { class: 'grid' },
      h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, 'Servicios'),
          h('button', { onclick: async (ev) => { ev.target.disabled = true; const r = await run(() => api('POST', '/api/system/diagnostics/run'), 'Comprobación terminada'); if (r) render(box, r); else ev.target.disabled = false; } }, 'Comprobar ahora')),
        h('p', { class: 'small muted' }, conn ? `Última comprobación: ${fmtDate(conn.checked_at)} (se repite cada 15 min).` : 'Todavía no se han comprobado: pulsa "Comprobar ahora".'),
        conn ? conn.probes.map(probeRow) : null),
      evolutionCard(d.evolution)));
}

/** Sección que se agrega al final de Sistema. Si falla, no rompe el resto de la página. */
export async function configSection() {
  const box = h('div', { style: 'margin-top:24px' }, h('p', { class: 'small muted' }, 'Cargando configuración…'));
  api('GET', '/api/system/diagnostics').then((d) => render(box, d)).catch((e) => fill(box, h('p', { class: 'small error' }, `No se pudo cargar la configuración: ${e.message}`)));
  return box;
}
