/**
 * Código que se inyecta en cada página antes que el panel (context.addInitScript). Anota, para cada elemento, qué
 * manejadores recibió y desde qué archivo:línea del panel (la pila de la llamada a addEventListener), y ofrece a la
 * auditoría la lista de controles visibles con una llave estable para volver a encontrarlos.
 *
 * Va como texto: tsx transformaría una función (agrega __name) y la página no tiene esos ayudantes.
 */
export const INIT_SCRIPT = String.raw`(() => {
  if (window.__audit) return;
  const ACTION = /^(click|change|submit|toggle)$/;
  const TRACKED = /^(click|change|submit|toggle|dragstart|dragover|drop|dragend|pointerdown|keydown)$/;
  const listeners = new WeakMap();
  // Cualquier script del mismo servidor: /js/bot.js (el panel, como «bot.js»), /reservar.js, o el de una página .html.
  const frameRe = /at (?:(\S+) \()?[a-z]+:\/\/[^/]+\/([^\s?:)]+\.(?:js|html))(?:\?[^:)]*)?:(\d+):\d+\)?\s*$/;
  const frames = (stack) => String(stack || '').split('\n').slice(1).map((l) => { const m = l.match(frameRe); return m ? { fn: m[1] || '', file: m[2].replace(/^js\//, ''), line: +m[3] } : null; }).filter(Boolean);
  const original = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (this instanceof Element && TRACKED.test(type)) {
      const f = frames(new Error().stack);
      // Los manejadores de h() se agregan dentro de h (core.js): el sitio es quien llamó a h().
      const i = f[0] && f[0].fn === 'h' && f[0].file === 'core.js' ? 1 : 0;
      if (f[i]) {
        const list = listeners.get(this) || [];
        list.push({ event: type, site: f[i].file + ':' + f[i].line, chain: f.slice(i, i + 4).map((x) => x.file + ':' + x.line) });
        listeners.set(this, list);
      }
    }
    return original.call(this, type, fn, opts);
  };
  // Manejadores asignados como propiedad (boton.onclick = …): también se anotan con su sitio.
  for (const prop of ['onclick', 'onchange', 'onsubmit', 'ontoggle']) {
    const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    if (!d || !d.set) continue;
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, enumerable: d.enumerable, get: d.get, set(fn) {
      const f = typeof fn === 'function' ? frames(new Error().stack) : [];
      if (f[0]) { const list = listeners.get(this) || []; list.push({ event: prop.slice(2), site: f[0].file + ':' + f[0].line, chain: f.slice(0, 4).map((x) => x.file + ':' + x.line) }); listeners.set(this, list); }
      d.set.call(this, fn);
    } });
  }
  const audit = window.__audit = { clipboard: [], opened: [], printed: 0, mutations: 0, noisy: new Set(), observing: false };
  // Lo que un botón hace fuera de la página: se anota y no se ejecuta (copiar, abrir otra ventana, imprimir).
  // En otra prueba (coverage-probe.mts) solo se anota qué controles usa: su página se comporta como siempre.
  if (!window.__auditProbe) {
    try {
      const clip = navigator.clipboard || {};
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { ...clip, writeText: async (t) => { audit.clipboard.push(String(t)); }, write: async () => { audit.clipboard.push('[blob]'); } } });
    } catch {}
    window.open = (url) => { audit.opened.push(String(url)); return null; };
    window.print = () => { audit.printed++; };
  }

  const visible = (el) => {
    if (!el.isConnected || el.closest('[inert]')) return false;
    const dlg = el.closest('dialog'); if (dlg && !dlg.open) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  };
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  const nameOf = (el) => {
    const label = el.getAttribute('aria-label'); if (label) return clean(label);
    const by = el.getAttribute('aria-labelledby'); if (by) return clean(by.split(' ').map((id) => document.getElementById(id)?.textContent || '').join(' '));
    if (el.labels && el.labels[0]) return clean(el.labels[0].textContent);
    return clean(el.innerText || el.textContent) || clean(el.title) || clean(el.value) || clean(el.querySelector('img')?.alt);
  };
  const actionSites = (el) => (listeners.get(el) || []).filter((l) => ACTION.test(l.event));
  /** El manejador que atiende un clic en el control: el propio, el del formulario (botón de envío) o el de un contenedor. */
  const handlerOf = (el) => {
    const own = actionSites(el); if (own.length) return { via: 'propio', sites: own };
    if (el.matches('button:not([type=button]),input[type=submit]') && el.form) {
      const s = actionSites(el.form).filter((l) => l.event === 'submit'); if (s.length) return { via: 'formulario', sites: s };
      // Un formulario del servidor (con action) se envía solo, sin JavaScript.
      if (el.form.getAttribute('action') !== null || (el.form.method || '').toLowerCase() === 'post') return { via: 'formulario nativo', sites: [] };
    }
    if (el.matches('summary')) { const s = actionSites(el.parentElement).filter((l) => l.event === 'toggle'); return { via: 'desplegable', sites: s }; }
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = actionSites(p).filter((l) => l.event === 'click' || l.event === 'change'); if (s.length) return { via: 'contenedor', sites: s }; }
    return { via: '', sites: [] };
  };
  const roleOf = (el) => el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', SUMMARY: 'summary', SELECT: 'select' })[el.tagName] || (el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : el.tagName.toLowerCase());
  const areaOf = (el) => el.closest('#copilot') ? 'copiloto' : el.closest('dialog') ? 'dialogo' : el.closest('.sidebar,.topbar,.nav-backdrop') ? 'menu' : el.closest('.main,main') ? 'pagina' : 'global';
  const SELECTOR = 'a[href],button,summary,select,input[type=checkbox],input[type=radio],input[type=file],[role=button],[role=tab],[role=switch],[role=menuitem],[role=link],[role=checkbox],[role=option]';

  const walk = (root, visit) => {
    const seen = new Map();
    const candidates = new Set(root.querySelectorAll(SELECTOR));
    // Elementos con un manejador de clic que no parecen controles (una tarjeta, una celda): también se presionan.
    for (const el of root.querySelectorAll('*')) if ((listeners.get(el) || []).some((l) => l.event === 'click') && !el.closest(SELECTOR)) candidates.add(el);
    for (const el of candidates) {
      if (!visible(el)) continue;
      if (el.matches('input[type=checkbox],input[type=radio]') && el.closest('label') && candidates.has(el.closest('label'))) continue;
      const handler = handlerOf(el);
      const href = el.tagName === 'A' ? el.getAttribute('href') || '' : '';
      const area = areaOf(el);
      const name = nameOf(el);
      // Sin números en la llave: «hace 1 min» pasa a «hace 2 min» y el control debe seguir siendo el mismo.
      const base = area + '|' + (handler.sites[0]?.site || (href ? 'href=' + href.replace(/[0-9a-f-]{36}/g, 'id') : el.tagName.toLowerCase())) + '|' + name.replace(/\d+/g, '#');
      const n = seen.get(base) || 0; seen.set(base, n + 1);
      if (visit(el, base + '|' + n, { handler, href, area, name }) === false) return;
    }
  };
  /** Controles visibles, con llave estable: área|sitio-o-destino|nombre|n-ésimo con esa misma llave. */
  audit.controls = () => {
    const out = [];
    walk(document, (el, key, { handler, href, area, name }) => { out.push({
      key, area, role: roleOf(el), tag: el.tagName.toLowerCase(), type: el.type || '', name, href,
      target: el.getAttribute('target') || '', disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      via: handler.via, sites: handler.sites.map((s) => s.site), chain: handler.sites[0]?.chain || [],
      dialogTitle: el.closest('dialog')?.querySelector('h2,h1')?.textContent?.trim() || '',
    }); });
    return out;
  };
  /** Marca el control de esa llave para que Playwright lo presione; devuelve false si ya no está. */
  audit.mark = (key) => {
    document.querySelectorAll('[data-audit-target]').forEach((e) => e.removeAttribute('data-audit-target'));
    let found = false;
    walk(document, (el, k) => { if (k === key) { el.setAttribute('data-audit-target', ''); found = true; return false; } });
    return found;
  };
  // Cada uso real de un control (del recorrido o de una prueba por área) cuenta como presionado para la cobertura.
  audit.pressed = new Set();
  const usedEvent = (e) => {
    for (let el = e.target; el && el !== document; el = el.parentElement) {
      const s = actionSites(el).filter((l) => l.event === e.type || (e.type === 'click' && l.event === 'submit' && el.tagName === 'FORM'));
      // Se avisa también a la prueba (exposeBinding), para no perderlo si el clic carga otro documento.
      if (s.length) { s.forEach((l) => { audit.pressed.add(l.site); try { window.__auditPressed?.(l.site); } catch {} }); return; }
    }
  };
  for (const type of ['click', 'change', 'submit', 'toggle']) document.addEventListener(type, usedEvent, true);
  audit.pressedSites = () => [...audit.pressed];
  /** Todos los sitios con manejador que existen ahora en la página (visibles o no). */
  audit.allSites = () => { const out = new Set(); for (const el of document.querySelectorAll('*')) for (const l of listeners.get(el) || []) out.add(l.event + '@' + l.site); return [...out]; };

  // Observación de un clic: qué cambió en la página fuera de lo que ya cambiaba solo (relojes, sondeos).
  let observer;
  audit.startNoise = () => {
    audit.noisy = new Set(); audit.observing = false; observer?.disconnect();
    observer = new MutationObserver((list) => { for (const m of list) {
      const node = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (!audit.observing) { if (node) audit.noisy.add(node); continue; }
      if (node && node.hasAttribute && node.hasAttribute('data-audit-target') && m.type === 'attributes' && m.attributeName === 'data-audit-target') continue;
      if (![...audit.noisy].some((n) => n.contains(node))) audit.mutations++;
    } });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  };
  audit.startClick = () => {
    audit.mutations = 0; audit.clipboard = []; audit.opened = []; audit.printed = 0; audit.observing = true;
    const t = document.querySelector('[data-audit-target]');
    audit.before = { focus: document.activeElement, scroll: scrollY, dialogs: document.querySelectorAll('dialog[open]').length, checked: t?.checked, value: t?.value, open: t?.closest('details')?.open, look: lookOf(t), errors: errorTexts() };
  };
  const errorTexts = () => [...document.querySelectorAll('.form-error, .field-error, [aria-invalid=true], .main [role=alert], dialog[open] [role=alert], .banner.danger')]
    .filter((e) => visible(e) && e.id !== 'toast-alert').map((e) => clean(e.textContent) || '(campo marcado: ' + (e.getAttribute('name') || e.id) + ')');
  // Estado propio del control: una pestaña o un interruptor que ya estaba elegido no cambia al tocarlo otra vez.
  const lookOf = (t) => t ? ['aria-pressed', 'aria-selected', 'aria-expanded', 'aria-current', 'aria-checked', 'class'].map((a) => t.getAttribute(a) || '').join('|') : '';
  const isActive = (t) => !!t && ((t.type === 'radio' && t.checked) || !!t.querySelector?.('input[type=radio]:checked') || ['true', 'page', 'step'].includes(t.getAttribute('aria-pressed') || t.getAttribute('aria-selected') || t.getAttribute('aria-current') || '') || /(^|\s)(active|is-active|selected|on)(\s|$)/.test(t.className || ''));
  audit.endClick = () => {
    // El clic cargó otro documento (un enlace a otra página): de esta página solo se sabe dónde quedó.
    if (!audit.before) return { hash: location.hash, h1: clean(document.querySelector('.main h1, main h1')?.textContent), reloaded: true };
    audit.observing = false; observer?.disconnect();
    const t = document.querySelector('[data-audit-target]');
    // Mensajes de error nuevos a la vista: el de la tarjeta, el de cada campo y los avisos de error de la página
    // (un aviso que ya estaba, como el de la cuenta, no cuenta).
    const errorBox = errorTexts().filter((t) => !audit.before.errors.includes(t)).slice(0, 3);
    const toastText = clean((document.getElementById('toast-alert')?.textContent || '') + ' ' + (document.getElementById('toast')?.textContent || ''));
    const dialogs = [...document.querySelectorAll('dialog[open]')];
    return {
      // Presionar un botón le da el foco: solo cuenta si el foco se fue a otro lado (un campo, un diálogo, un título).
      mutations: audit.mutations, focusMoved: document.activeElement !== audit.before.focus && document.activeElement !== t && document.activeElement !== document.body, scrolled: Math.abs(scrollY - audit.before.scroll) > 4,
      stateChanged: !!t && (t.checked !== audit.before.checked || t.value !== audit.before.value || t.closest('details')?.open !== audit.before.open || lookOf(t) !== audit.before.look),
      alreadyActive: !!t && lookOf(t) === audit.before.look && isActive(t),
      dialogOpened: dialogs.length > audit.before.dialogs, dialogTitle: dialogs.at(-1)?.querySelector('h1,h2')?.textContent?.trim() || '',
      dialogButtons: dialogs.at(-1) ? [...dialogs.at(-1).querySelectorAll('button')].map((b) => clean(b.textContent || b.getAttribute('aria-label'))) : [],
      clipboard: audit.clipboard.length, opened: [...audit.opened], printed: audit.printed, toast: toastText, errors: errorBox,
      h1: clean(document.querySelector('.main h1, main h1')?.textContent), hash: location.hash,
    };
  };
})();`;
