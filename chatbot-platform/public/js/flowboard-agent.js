import { api, field, fill, h, select, toast } from './core.js';
import { icon } from './icons.js';
import { newId } from './flowboard-templates.js';

/*
 * Instrucciones del agente desde el lienzo: el texto con el que atiende («Cómo debe atender») partido en bloques, para
 * cambiar, quitar, agregar u ordenar solo lo necesario sin entrar a toda la configuración del agente. Al aplicar, el
 * cambio llega a todas sus conexiones y queda en su historial de versiones (se puede volver atrás desde el agente).
 */

const blocksOf = (prompt) => String(prompt || '').split(/\n[ \t]*\n/).map((b) => b.trim()).filter(Boolean);
const joinBlocks = (list) => list.filter((b) => !b.removed && b.text.trim()).map((b) => b.text.trim()).join('\n\n');
const fresh = (prompt) => blocksOf(prompt).map((text) => ({ id: newId('p'), text, orig: text, removed: false }));

/** Una instrucción sugerida a partir del flujo: que el agente sepa que existe y no repita lo que el flujo ya dice. */
function suggestion(board, name) {
  const t = board.nodes.find((n) => n.type === 'trigger')?.data.trigger;
  const first = board.nodes.find((n) => n.type === 'message' && n.data.text.trim())?.data.text.replace(/\{\{[^}]+\}\}/g, '').replace(/\s+/g, ' ').replace(/^[\s,;:.¡!]+/, '').trim().slice(0, 120);
  const about = first ? ` (empieza con: "${first}")` : '';
  if (t?.type === 'message_received' && t.match !== 'any' && t.keywords.length) {
    const words = t.keywords.slice(0, 3).map((k) => `«${k}»`).join(' o ');
    return `Cuando el cliente escriba ${words}, el flujo «${name}» le contesta con mensajes y botones${about}. No repitas esa información; si pregunta algo más, contéstale con normalidad.`;
  }
  if (t?.type === 'new_contact') return `A los clientes nuevos los recibe el flujo «${name}» con un menú de opciones${about}. No repitas el saludo; ayúdales con lo que elijan.`;
  return `Algunos clientes reciben el flujo «${name}»${about}. Si responden a esos mensajes, continúa la conversación con normalidad y usa la información de ese flujo.`;
}

export function agentPanel({ bots, board, name }) {
  const root = h('div', { class: 'fb-agent' });
  if (!bots.length) {
    fill(root, h('p', { class: 'help' }, 'Aún no tienes un agente. Créalo en ', h('a', { href: '#/agentes/nuevo' }, 'Agentes'), ' y vuelve aquí para ajustar sus instrucciones.'));
    return root;
  }
  const choice = { bot: bots[0].id };
  const body = h('div', { class: 'fb-agent-body' });
  let current = null;

  async function load() {
    fill(body, h('p', { class: 'help', role: 'status' }, 'Cargando las instrucciones…'));
    try {
      const versions = await api('GET', `/api/chatbots/${choice.bot}/versions`);
      const personality = versions.draft_bot.personality;
      current = { revision: versions.draft.revision, personality, original: personality.prompt || '', blocks: fresh(personality.prompt) };
      draw();
    } catch (e) {
      fill(body, h('p', { class: 'banner danger', role: 'alert' }, e.message), h('button', { type: 'button', class: 'small', onclick: load }, 'Reintentar'));
    }
  }

  /** Cuántos bloques cambiaron, son nuevos o se quitan, y si cambió el orden de los que quedan. */
  function changes() {
    const c = { changed: 0, added: 0, removed: 0 };
    for (const b of current.blocks) {
      if (b.removed) { c.removed++; continue; }
      if (b.orig === null) { if (b.text.trim()) c.added++; } else if (b.text.trim() !== b.orig) c.changed++;
    }
    const kept = current.blocks.filter((b) => !b.removed && b.orig !== null).map((b) => b.orig);
    const before = blocksOf(current.original).filter((o) => kept.includes(o));
    const order = kept.join('\u0000') !== before.join('\u0000');
    return { ...c, order, any: c.changed + c.added + c.removed > 0 || order };
  }

  function draw() {
    const list = h('ol', { class: 'fb-pblocks' });
    const summary = h('p', { class: 'small fb-agent-summary', role: 'status' });
    const after = h('pre', { class: 'fb-diff-text' });
    const applyBtn = h('button', { type: 'button', class: 'primary', onclick: () => apply(applyBtn) }, 'Aplicar al agente');
    const resetBtn = h('button', { type: 'button', class: 'small', onclick: () => { current.blocks = fresh(current.original); draw(); } }, 'Descartar cambios');
    const update = () => {
      const c = changes();
      const parts = [c.changed && `${c.changed} cambiada${c.changed === 1 ? '' : 's'}`, c.added && `${c.added} nueva${c.added === 1 ? '' : 's'}`, c.removed && `${c.removed} quitada${c.removed === 1 ? '' : 's'}`, c.order && 'otro orden'].filter(Boolean);
      summary.textContent = parts.length ? `Sin aplicar: ${parts.join(', ')}.` : 'Sin cambios.';
      applyBtn.disabled = !c.any;
      resetBtn.hidden = !c.any;
      after.textContent = joinBlocks(current.blocks) || '—';
    };
    const grow = (ta) => { ta.style.height = '0px'; ta.style.height = `${ta.scrollHeight}px`; };
    const stateOf = (b) => (b.removed ? 'removed' : b.orig === null ? 'new' : b.text.trim() !== b.orig ? 'changed' : 'same');
    const TAG = { removed: 'Se quita', new: 'Nueva', changed: 'Cambiada', same: '' };
    const drawList = () => fill(list, current.blocks.map((b, i) => {
      const tag = h('span', { class: 'fb-pb-tag small' }, TAG[stateOf(b)]);
      const ta = h('textarea', { rows: 1, value: b.text, disabled: b.removed, 'aria-label': `Instrucción ${i + 1}`, placeholder: 'Escribe la instrucción…',
        oninput: (e) => { b.text = e.target.value; grow(e.target); e.target.closest('li').dataset.state = stateOf(b); tag.textContent = TAG[stateOf(b)]; update(); } });
      requestAnimationFrame(() => grow(ta));
      return h('li', { class: 'fb-pb', 'data-state': stateOf(b) },
        ta,
        h('div', { class: 'fb-pb-tools' },
          tag,
          h('span', { class: 'fb-pb-actions' },
            h('button', { type: 'button', class: 'fb-icon fb-up', 'aria-label': `Subir la instrucción ${i + 1}`, title: 'Subir', disabled: i === 0 || b.removed, onclick: () => { [current.blocks[i - 1], current.blocks[i]] = [current.blocks[i], current.blocks[i - 1]]; drawList(); update(); } }, icon('chevron', 16)),
            b.removed
              ? h('button', { type: 'button', class: 'small', onclick: () => { b.removed = false; drawList(); update(); } }, 'Deshacer')
              : h('button', { type: 'button', class: 'fb-icon', 'aria-label': `Quitar la instrucción ${i + 1}`, title: 'Quitar', onclick: () => { if (b.orig === null) current.blocks.splice(i, 1); else b.removed = true; drawList(); update(); } }, icon('trash', 16)))));
    }));
    const add = (text = '') => {
      current.blocks.push({ id: newId('p'), text, orig: null, removed: false });
      drawList();
      update();
      [...list.querySelectorAll('textarea')].at(-1)?.focus();
    };
    drawList();
    update();
    const bot = bots.find((b) => b.id === choice.bot);
    fill(body,
      h('p', { class: 'help' }, 'Cada bloque es un párrafo de «Cómo debe atender». Cambia, quita o agrega solo lo que necesites; lo demás queda igual.'),
      list,
      current.blocks.length ? null : h('p', { class: 'fb-empty' }, 'Este agente aún no tiene instrucciones. Agrega la primera.'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'small', onclick: () => add() }, icon('plus', 14), 'Agregar instrucción'),
        h('button', { type: 'button', class: 'small', onclick: () => add(suggestion(board, name)) }, icon('branch', 14), 'Sugerir una sobre este flujo')),
      h('details', { class: 'fb-agent-diff' }, h('summary', { class: 'small' }, 'Ver antes y después'),
        h('div', { class: 'fb-diff' },
          h('div', {}, h('div', { class: 'small muted' }, 'Antes'), h('pre', { class: 'fb-diff-text' }, current.original || '—')),
          h('div', {}, h('div', { class: 'small muted' }, 'Después'), after))),
      h('div', { class: 'fb-agent-apply' }, applyBtn, resetBtn, summary),
      h('p', { class: 'small muted' }, 'Se aplica de inmediato en todas sus conexiones y queda en el historial de versiones de ', h('a', { href: `#/bot/${bot.id}/instrucciones` }, bot.name), ', donde puedes volver atrás.'));
  }

  async function apply(button) {
    button.disabled = true;
    try {
      await api('POST', `/api/chatbots/${choice.bot}/version-apply`, { revision: current.revision, patch: { personality: { ...current.personality, prompt: joinBlocks(current.blocks) } } });
      toast('Instrucciones aplicadas: el agente ya atiende así');
      await load();
    } catch (e) {
      button.disabled = false;
      if (e.status === 409) fill(body, h('p', { class: 'banner warn', role: 'alert' }, e.message), h('button', { type: 'button', class: 'small', onclick: load }, 'Volver a cargar'));
      else toast(e.message, true);
    }
  }

  fill(root,
    bots.length > 1 ? field('Agente', select(choice, 'bot', bots.map((b) => [b.id, b.name]), () => load())) : h('p', { class: 'fb-agent-name' }, icon('bot', 16), h('strong', {}, bots[0].name)),
    body);
  load();
  return root;
}
