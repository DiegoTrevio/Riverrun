import { statusBadge } from './admin.js';
import { api, h, num, run, state, text } from './core.js';
import { render } from './main.js';
import { withAcct } from './session.js';

/* ------------------------------ Consumo de IA ------------------------------ */

export const usd = (n) => `US$${(n || 0).toFixed(n < 1 ? 4 : 2)}`;

const KIND_LABEL = { embedding: 'Búsqueda de conocimiento', decision: 'Respuestas', summary: 'Resúmenes de memoria', transcription: 'Notas de voz' };

export async function viewUsage(root, params) {
  const month = params.get('month') || new Date().toISOString().slice(0, 7);
  const months = [...Array(6)].map((_, i) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); return d.toISOString().slice(0, 7); });
  const pick = h('select', { 'aria-label': 'Mes de consumo (UTC)', style: 'width:auto', onchange: (e) => (location.hash = `#/consumo?month=${e.target.value}`) }, months.map((m) => h('option', { value: m, selected: m === month }, m)));
  const u = await api('GET', withAcct(`/api/usage?month=${month}`));
  root.append(h('div', { class: 'row between' }, h('h1', {}, 'Consumo de IA'), pick), h('p', { class: 'help' }, 'Periodo mensual en UTC. Los importes registrados pueden diferir de la factura del proveedor; Estadísticas permite consultar otros periodos.'));
  if (u.accounts) {
    root.append(
      h('div', { class: 'card' }, h('div', { class: 'kpi' }, usd(u.total_usd)), h('div', { class: 'muted small' }, `Consumo de IA en ${month}`)),
      h('div', { class: 'card' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Cuenta'), h('th', {}, 'Estado'), h('th', { class: 'num' }, 'Gasto'), h('th', { class: 'num' }, 'Llamadas'), h('th', { class: 'num' }, 'Tokens entrada'), h('th', { class: 'num' }, 'Tokens salida'), h('th', { class: 'num' }, 'Audio (min)'))),
        h('tbody', {}, u.accounts.map((a) => h('tr', { class: 'click', onclick: () => { state.accountId = a.id; try { localStorage.setItem('cp-account', a.id); } catch { /* */ } render(); } },
          h('td', {}, a.name), h('td', {}, statusBadge(a)), h('td', { class: 'num' }, usd(a.cost_usd)), h('td', { class: 'num' }, a.calls),
          h('td', { class: 'num' }, Number(a.input_tokens).toLocaleString()), h('td', { class: 'num' }, Number(a.output_tokens).toLocaleString()), h('td', { class: 'num' }, (a.audio_seconds / 60).toFixed(1))))))),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Precios por modelo (USD)'), h('p', { class: 'small muted' }, 'Verifica las tarifas del proveedor y modelo configurados (OpenRouter u otro). Los importes reportados o estimados conservan su valor histórico; un cambio de tarifas aplica a las llamadas nuevas.'), await pricesEditor()),
    );
    return;
  }
  const max = Math.max(...u.days.map((d) => d.cost_usd), 0.000001);
  root.append(
    h('div', { class: 'grid' },
      h('div', { class: 'card' }, h('div', { class: 'kpi' }, usd(u.total_usd)), h('div', { class: 'muted small' }, `Gasto de IA en ${month}`)),
      h('div', { class: 'card' }, h('div', { class: 'kpi' }, u.conversations), h('div', { class: 'muted small' }, 'conversaciones atendidas por la IA')),
      h('div', { class: 'card' }, h('div', { class: 'kpi' }, usd(u.cost_per_conversation)), h('div', { class: 'muted small' }, 'costo promedio por conversación'))),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Por día'),
      u.days.length ? h('div', { class: 'bars' }, u.days.map((d) => h('div', { class: 'bar', title: `${d.day}: ${usd(d.cost_usd)} (${d.calls} llamadas)` }, h('span', { style: `height:${Math.max(2, (d.cost_usd / max) * 100)}%` }), h('small', {}, d.day.slice(8)))))
        : h('p', { class: 'muted' }, 'Sin consumo este mes.')),
    h('div', { class: 'grid' },
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Por tipo'), h('table', {}, h('tbody', {}, u.kinds.map((k) => h('tr', {}, h('td', {}, KIND_LABEL[k.kind] || k.kind), h('td', { class: 'num' }, k.calls), h('td', { class: 'num' }, usd(k.cost_usd))))))),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Por modelo'), h('table', {}, h('tbody', {}, u.models.map((m) => h('tr', {}, h('td', {}, m.model), h('td', { class: 'num' }, `${Number(m.input_tokens).toLocaleString()} / ${Number(m.output_tokens).toLocaleString()} tokens`), h('td', { class: 'num' }, usd(m.cost_usd)))))))),
  );
}

async function pricesEditor() {
  const prices = await api('GET', '/api/ai-prices');
  const row = (p) => {
    const f = { input_per_mtok: Number(p.input_per_mtok), cached_per_mtok: Number(p.cached_per_mtok), output_per_mtok: Number(p.output_per_mtok), per_audio_minute: Number(p.per_audio_minute) };
    return h('tr', {}, h('td', {}, p.model),
      ...['input_per_mtok', 'cached_per_mtok', 'output_per_mtok', 'per_audio_minute'].map((k) => h('td', {}, num(f, k, { step: 0.001, min: 0 }))),
      h('td', {}, h('button', { class: 'small', onclick: () => run(() => api('PUT', `/api/ai-prices/${encodeURIComponent(p.model)}`, f), 'Precio guardado') }, 'Guardar')));
  };
  const n = { model: '' };
  return h('div', {},
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Modelo (prefijo)'), h('th', {}, 'Entrada / 1M'), h('th', {}, 'En caché / 1M'), h('th', {}, 'Salida / 1M'), h('th', {}, 'Audio / min'), h('th', {}, 'Acciones'))),
      h('tbody', {}, prices.map(row))),
    h('div', { class: 'row', style: 'margin-top:8px' }, text(n, 'model', { placeholder: 'gpt-5.1' }),
      h('button', { class: 'small', onclick: async () => { if (n.model && await run(() => api('PUT', `/api/ai-prices/${encodeURIComponent(n.model)}`, {}), 'Modelo agregado')) render(); } }, 'Agregar modelo')));
}
