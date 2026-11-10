/**
 * Cotizador escrito: el negocio escribe sus productos, precios y reglas; el sistema lo entiende, muestra cotizaciones de
 * ejemplo calculadas con esas reglas y, al activarlo, el agente cotiza con eso. Nada se guarda hasta «Activar».
 */
import { api, confirmAction, h, toast } from './core.js';
import { icon } from './icons.js';
import { aiLock } from './session.js';

const PLACEHOLDER = `Ejemplo:
Para cotizar pide: metros lineales, producto (Recta o Clásica), altura (1.50 o 2.00 m) y fijación (con placa o cimentado).
Paneles = metros ÷ 2.50, hacia arriba. Postes = paneles + 1. Una placa por poste solo si es con placa.
Escalones: A menos de 15 m; B de 15 a menos de 50; de 50 m o más lo atiende un asesor.
Precios (más IVA):
Panel Clásica 2.00 m: A $1,050, B $1,000
Poste 2.00 m: A $420, B $400
Placa: A $90, B $80
Instalación solo si la piden: $598 por metro. Siempre aclara que es aproximado.`;

const sameText = (a, b) => (a ?? '').trim() === (b ?? '').trim();

const MAX_TEXT = 20000;
/**
 * La parte de las instrucciones que sirve para cotizar. Si caben completas, van completas (el sistema ignora lo demás
 * al armar); si son muy largas, solo los párrafos con precios, cantidades o reglas de cotización.
 */
function quotePart(prompt) {
  const text = prompt.trim();
  if (text.length <= MAX_TEXT) return text;
  const useful = text.split(/\n\s*\n/).filter((p) => /\$\s?\d|cotiz|precio|escal[oó]n|mayoreo|asesor|iva|metro|pieza|instalaci|flete|m²|por persona|por hora/i.test(p));
  return useful.join('\n\n').slice(0, MAX_TEXT);
}

/**
 * Tarjeta del cotizador escrito para un agente. `calculator` es la calculadora que ya tiene (con su texto), si hay.
 * `onApplied(calculator)` conecta la calculadora guardada al agente y recarga la pestaña.
 */
export function quoteBuilderCard(bot, { calculator = null, onApplied } = {}) {
  const id = `qb-${bot.id}`;
  const fromText = calculator?.template_key === 'texto';
  let busy = false;
  /** El último borrador armado y el texto del que salió (para no activar uno que ya no corresponde al texto). */
  let built = null;
  const ta = h('textarea', { id, rows: 12, maxlength: 20000, placeholder: PLACEHOLDER, spellcheck: 'true' });
  ta.value = fromText ? calculator.source_text || '' : '';
  const go = h('button', { type: 'button', class: 'primary ai-go', onclick: () => build() }, icon('wand', 16), h('span', {}, fromText ? 'Volver a armar' : 'Armar cotizador'));
  const status = h('p', { class: 'ai-status small', role: 'status', 'aria-live': 'polite' });
  const result = h('div', { class: 'ai-slot' });
  const say = (text, kind = '') => { status.textContent = text; status.className = `ai-status small${kind ? ` ${kind}` : ''}`; };
  // Plantillas por giro: un texto de ejemplo para empezar (se cambian precios y reglas por los propios).
  const templatesRow = h('div', { class: 'row qb-templates' }, h('span', { class: 'small muted' }, 'Empezar con un ejemplo:'));
  /** Qué ejemplo quedó en el cuadro (para no olvidar cambiar sus precios por los propios). */
  const templateNote = h('p', { class: 'small muted qb-template-note' });
  // Muchos negocios ya escribieron sus precios y reglas en las instrucciones del agente, donde la IA no puede hacer las
  // cuentas: un botón los pasa al cuadro (el sistema toma solo lo que sirve para cotizar).
  const prompt = bot.personality?.prompt || '';
  const pricedPrompt = (prompt.match(/\$\s?\d/g) || []).length >= 3;
  const fromPromptRow = pricedPrompt
    ? h('div', { class: 'row qb-from-prompt' },
        h('button', { type: 'button', class: 'small', onclick: () => usePrompt() }, 'Usar los precios y reglas de las instrucciones del agente'))
    : null;
  async function usePrompt() {
    if (busy) return;
    const text = quotePart(prompt);
    if (ta.value.trim() && ta.value.trim() !== text.trim() && !(await confirmAction('Esto reemplaza lo que escribiste en el cuadro con lo de las instrucciones del agente. ¿Continuar?', 'Reemplazar'))) return;
    ta.value = text;
    ta.dataset.template = 'instrucciones';
    templateNote.textContent = 'Copié las instrucciones del agente: al armarlo, el sistema toma solo productos, precios y reglas. Cuando lo actives, quita de las instrucciones la parte que le pide calcular precios.';
    built = null; result.replaceChildren();
    say('Revisa el texto (puedes borrar lo que no sea de precios) y luego arma el cotizador.');
    ta.focus();
  }
  api('GET', '/api/quote-calculators/text-templates').then((list) => {
    templatesRow.append(...list.map((t) => h('button', { type: 'button', class: 'small', onclick: () => useTemplate(t) }, t.label)));
  }).catch(() => templatesRow.remove());
  async function useTemplate(t) {
    if (busy) return;
    if (ta.value.trim() && ta.value.trim() !== t.text.trim() && !(await confirmAction('El ejemplo reemplaza lo que escribiste en el cuadro. ¿Continuar?', 'Reemplazar'))) return;
    ta.value = t.text;
    ta.dataset.template = t.key;
    templateNote.textContent = `Usando el ejemplo «${t.label}»: sus precios son de muestra.`;
    built = null; result.replaceChildren();
    say(`Ejemplo de «${t.label}»: cambia los precios y las reglas por los tuyos y luego arma el cotizador.`);
    ta.focus();
  }
  const box = h('div', { class: 'card quote-builder' },
    h('h3', {}, 'Productos, precios y reglas'),
    h('p', { class: 'small muted' },
      'Escribe tus productos con su precio y las reglas para calcular (qué datos pedir, cómo sacar las cantidades, escalones, extras y cuándo lo atiende un asesor). ',
      'El sistema lo entiende una vez y te muestra cotizaciones de ejemplo; al activarlo, el agente cotiza solo con tus reglas y precios: la IA nunca hace las cuentas.'),
    templatesRow,
    fromPromptRow,
    templateNote,
    h('label', { for: id, class: 'sr-only' }, 'Productos, precios y reglas'),
    ta,
    h('div', { class: 'row ai-actions' }, aiLock(go)),
    status,
    result);
  if (fromText) say(`Activo en este agente (versión ${calculator.version}). Si cambias el texto, vuelve a armarlo y actívalo.`);

  function setBusy(on, text = '') {
    busy = on;
    box.setAttribute('aria-busy', String(on));
    go.disabled = on; ta.readOnly = on;
    result.querySelectorAll('button, input, select').forEach((b) => { b.disabled = on; });
    say(text, on ? 'busy' : '');
  }

  async function build() {
    if (busy) return;
    const text = ta.value.trim();
    if (!text) { say('Escribe tus productos, precios y reglas.', 'err'); ta.focus(); return; }
    setBusy(true, 'Leyendo tus precios y reglas, y probando cotizaciones de ejemplo… (puede tardar uno o dos minutos)');
    try {
      const r = await api('POST', '/api/quote-calculators/from-text', { text, chatbot_id: bot.id });
      setBusy(false);
      built = { text, r };
      show();
    } catch (e) {
      setBusy(false);
      say(e.message || 'No se pudo armar el cotizador. Intenta de nuevo.', 'err');
    }
  }

  function show() {
    const { r } = built;
    const def = r.draft.definition;
    const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: r.currency || 'MXN' });
    const price = (p) => (p.price_mode === 'tbd' ? 'Por confirmar' : p.price_mode === 'range' ? `${money.format(p.price_min / 100)} a ${money.format(p.price_max / 100)}` : `${p.price_mode === 'from' ? 'desde ' : ''}${money.format(p.price_min / 100)}`);
    const advisor = [...(def.values || []).flatMap((v) => (v.tiers?.otherwise?.stop ? [v.tiers.otherwise.stop] : [])), ...(def.stops || []).map((s) => s.message)];
    const parts = [h('p', { class: 'ai-result-head' }, icon('wand', 16), h('strong', {}, r.ready ? 'Así lo entendí' : 'Falta corregir algo')), r.summary ? h('p', { class: 'ai-result-text' }, r.summary) : null];
    if (r.problems.length) parts.push(h('div', { class: 'banner err', role: 'alert' }, h('strong', {}, 'No se puede activar todavía. '), 'Aclara esto en el texto y vuelve a armarlo:', h('ul', {}, r.problems.map((p) => h('li', {}, p)))));
    if (r.unclear.length) parts.push(h('div', { class: 'banner warn' }, h('strong', {}, 'No quedó claro: '), 'esto lo atenderá un asesor hasta que lo aclares.', h('ul', {}, r.unclear.map((p) => h('li', {}, p)))));
    if (r.warnings.length) parts.push(h('div', { class: 'banner warn' }, h('strong', {}, 'Combinaciones sin precio: '), 'si un cliente las pide, pasa con un asesor.', h('ul', {}, r.warnings.map((p) => h('li', {}, p)))));
    if (r.ready) {
      parts.push(
        h('h4', {}, 'Lo que el agente pedirá'),
        h('ol', {}, def.inputs.map((d) => h('li', {}, d.label, d.type === 'option' ? `: ${d.options.map((o) => o.label).join(', ')}` : d.type === 'boolean' ? ' (sí o no)' : d.unit ? ` (${d.unit})` : '', d.required ? '' : ' — solo si lo menciona'))),
        advisor.length ? h('div', {}, h('h4', {}, 'Lo atiende un asesor'), h('ul', {}, advisor.map((m) => h('li', {}, m)))) : null,
        h('details', { open: r.draft.price_items.length <= 12 },
          h('summary', {}, `Precios (${r.draft.price_items.length})`),
          h('div', { class: 'table-wrap' }, h('table', { class: 'table small' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Concepto'), h('th', {}, 'Para'), h('th', {}, 'Precio'), h('th', {}, 'Unidad'))),
            h('tbody', {}, r.draft.price_items.map((p) => h('tr', {},
              h('td', {}, p.name), h('td', { class: 'muted' }, Object.entries(p.attributes || {}).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'),
              h('td', {}, price(p), p.iva_mode === 'included' ? ' (IVA incluido)' : p.iva_mode === 'exempt' ? ' (sin IVA)' : ' + IVA'), h('td', {}, p.unit))))))),
        h('h4', {}, 'Cotizaciones de ejemplo'),
        r.examples.length ? h('div', { class: 'qb-examples' }, r.examples.map((ex) => exampleView(ex, def))) : h('p', { class: 'small muted' }, 'Sin ejemplos: pruébalo con tus propios datos abajo.'),
        tryForm(def),
      );
    }
    const activate = h('button', { type: 'button', class: 'primary', disabled: !r.ready, onclick: () => apply() }, 'Activar en este agente');
    parts.push(h('div', { class: 'row ai-actions' }, activate,
      h('button', { type: 'button', class: 'small', onclick: () => { built = null; result.replaceChildren(); say('Descartado. No se guardó nada.'); } }, 'Descartar')));
    result.replaceChildren(h('div', { class: 'ai-proposal' }, ...parts.filter(Boolean)));
    say(r.ready ? 'Revisa los ejemplos. Aún no se guarda nada: actívalo cuando estén bien.' : 'Corrige el texto y vuelve a armarlo.', r.ready ? '' : 'err');
  }

  /** Un ejemplo: los datos, y el desglose o por qué lo atiende un asesor. */
  function exampleView(ex, def) {
    const label = (k) => def.inputs.find((d) => d.key === k)?.label || k;
    const shown = (k, v) => {
      const d = def.inputs.find((x) => x.key === k);
      if (d?.type === 'option') return d.options.find((o) => o.value === v)?.label || v;
      if (d?.type === 'boolean') return /^(true|s[ií]|1)$/i.test(v) ? 'sí' : 'no';
      return d?.unit ? `${v} ${d.unit}` : v;
    };
    return h('div', { class: 'qb-example' },
      ex.description ? h('p', { class: 'small' }, h('strong', {}, ex.description)) : null,
      h('p', { class: 'small muted' }, Object.entries(ex.inputs).map(([k, v]) => `${label(k)}: ${shown(k, v)}`).join(' · ')),
      ex.ok ? breakdown(ex.lines, ex.totals) : h('p', { class: 'small' }, '→ ', ex.message, ex.detail ? h('span', { class: 'muted' }, ` (${ex.detail})`) : null));
  }

  function breakdown(rows, totals) {
    return h('div', { class: 'table-wrap' }, h('table', { class: 'table small' },
      h('tbody', {}, rows.map((l) => h('tr', {}, h('td', {}, `${l.qty} ×`), h('td', {}, l.name), h('td', {}, l.unit_price), h('td', { class: 'num' }, l.amount)))),
      h('tfoot', {},
        h('tr', {}, h('td', { colspan: 3 }, 'Subtotal'), h('td', { class: 'num' }, totals.subtotal)),
        h('tr', {}, h('td', { colspan: 3 }, 'IVA'), h('td', { class: 'num' }, totals.iva)),
        h('tr', {}, h('th', { colspan: 3 }, 'Total'), h('th', { class: 'num' }, totals.total)))));
  }

  /** Probar el borrador con otros datos (el sistema cotiza con los precios aún sin guardar). */
  function tryForm(def) {
    const values = {};
    const out = h('div', { 'aria-live': 'polite' });
    const fields = def.inputs.map((d) => {
      const fid = `${id}-t-${d.key}`;
      let control;
      if (d.type === 'option') control = h('select', { id: fid, onchange: (e) => { values[d.key] = e.target.value; } }, h('option', { value: '' }, '—'), d.options.map((o) => h('option', { value: o.value }, o.label)));
      else if (d.type === 'boolean') control = h('input', { id: fid, type: 'checkbox', onchange: (e) => { values[d.key] = e.target.checked; } });
      else control = h('input', { id: fid, type: d.type === 'number' ? 'number' : 'text', step: 'any', inputmode: d.type === 'number' ? 'decimal' : 'text', oninput: (e) => { values[d.key] = e.target.value; } });
      return h('div', { class: 'field' }, h('label', { for: fid }, d.label, d.unit ? ` (${d.unit})` : ''), control);
    });
    const calc = h('button', { type: 'button', onclick: async () => {
      calc.disabled = true;
      try {
        const r = await api('POST', `/api/quote-calculators/preview?account_id=${bot.account_id}`, { definition: built.r.draft.definition, price_items: built.r.draft.price_items, inputs: values });
        // El servidor ya escribe cada renglón como lo verá el cliente (rangos, «desde», por confirmar).
        out.replaceChildren(r.ok
          ? breakdown(r.rows, r.totals)
          : h('p', { class: 'small' }, '→ ', r.message));
      } catch (e) { out.replaceChildren(h('p', { class: 'small err' }, e.message)); } finally { calc.disabled = false; }
    } }, 'Calcular');
    return h('details', {}, h('summary', {}, 'Probar con otros datos'), h('div', { class: 'grid2' }, fields), calc, out);
  }

  async function apply() {
    if (!built || busy) return;
    if (!sameText(ta.value, built.text)) { say('Cambiaste el texto después de armarlo: vuelve a armarlo para ver cómo queda.', 'err'); return; }
    setBusy(true, 'Activando…');
    try {
      const r = await api('POST', '/api/quote-calculators/from-text/apply', { text: built.text, chatbot_id: bot.id, draft: built.r.draft });
      // Conectarlo al agente es un cambio de su configuración: queda en su historial de versiones.
      await onApplied?.(r.calculator);
      setBusy(false);
      toast(`Cotizador activo (versión ${r.calculator.version}): ${r.created} precios nuevos, ${r.updated} actualizados${r.deactivated ? `, ${r.deactivated} apagados` : ''}.`);
      built = null;
    } catch (e) {
      setBusy(false);
      say(e.message || 'No se pudo activar. Intenta de nuevo.', 'err');
    }
  }

  return box;
}
