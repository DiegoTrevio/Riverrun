import { field, fill, h } from './core.js';

/**
 * WhatsApp oficial (por Zernio) solo deja escribir durante las 24 h posteriores al último mensaje del cliente; después,
 * solo con una plantilla aprobada por Meta. Este campo elige esa plantilla y el texto de cada variable para un mensaje
 * de una regla, una secuencia o una campaña: `holder.wa_template = { template_id, params } | null`.
 * Sin plantillas que se puedan enviar no se muestra.
 */
export function waTemplateField(holder, templates) {
  const usable = (templates || []).filter((t) => t.sendable);
  holder.wa_template ??= null;
  if (!usable.length && !holder.wa_template) return null;
  const box = h('div');
  const draw = () => {
    const cur = holder.wa_template;
    const t = usable.find((x) => x.id === cur?.template_id);
    const pick = h('select', { onchange: (e) => { holder.wa_template = e.target.value ? { template_id: e.target.value, params: [] } : null; draw(); } },
      h('option', { value: '' }, 'Ninguna'),
      usable.map((x) => h('option', { value: x.id, selected: x.id === cur?.template_id }, `${x.name} (${x.language})`)),
      cur && !t ? h('option', { value: cur.template_id, selected: true }, '⚠ Plantilla borrada o sin aprobar: elige otra') : null);
    fill(box,
      field('Plantilla de WhatsApp si pasaron 24 h (opcional)', pick, 'Solo para WhatsApp oficial: si el cliente no ha escrito en las últimas 24 h, se envía esta plantilla aprobada en lugar del mensaje.'),
      t ? h('p', { class: 'small muted', style: 'white-space:pre-wrap;margin:4px 0 8px' }, t.body) : null,
      t && t.variables ? h('div', { class: 'grid' }, Array.from({ length: t.variables }, (_, i) => field(`Variable {{${i + 1}}}`,
        h('input', { value: cur.params[i] ?? '', placeholder: '{{nombre}} o un texto', oninput: (e) => { cur.params[i] = e.target.value; } })))) : null);
  };
  draw();
  return box;
}
