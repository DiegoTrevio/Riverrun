import { api, field, fill, h, state, toast } from './core.js';

/* ------------------------------ Conectar WhatsApp (QR o código por número) ------------------------------ */

/**
 * Conector de WhatsApp: se pone en marcha solo, muestra un QR que se renueva solo (con cuenta regresiva)
 * o un código para "Vincular con número de teléfono" (lo más fácil si el panel está abierto en el mismo celular).
 */
export function whatsappConnector(channelId, { onConnected, onState } = {}) {
  const st = {
    mode: 'qr',
    os: /iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'ios' : 'android',
    number: (state.me?.user?.phone || '').replace(/\D/g, ''),
    expiresAt: 0,
    ttl: 30,
    codeRequested: false,
    done: false,
    error: '',
    data: null,
  };
  const root = h('div', { class: 'wa-connect' });
  const tabs = h('div', { class: 'wa-tabs' });
  const main = h('div', { class: 'wa-main' });
  const steps = h('div', { class: 'wa-steps' });
  root.append(tabs, main, steps);
  let poller = null;
  let ticker = null;
  let inflight = false;
  let drawnMode = '';
  let drawnOs = '';
  let screenSignature = '';

  const stop = () => { clearInterval(poller); clearInterval(ticker); poller = ticker = null; };
  const start = () => {
    stop();
    poller = setInterval(() => { if (!document.body.contains(root)) return stop(); if (!document.hidden) poll(); }, 3000);
    ticker = setInterval(() => { if (!document.body.contains(root)) return stop(); if (!document.hidden) drawCountdown(); }, 1000);
    state.timers.push(poller, ticker);
  };

  async function poll(refresh = false) {
    if (st.done || inflight) return;
    if (st.mode === 'code' && !st.codeRequested) return;
    inflight = true;
    const mode = st.mode;
    const number = st.number;
    try {
      const body = { mode, refresh, ...(mode === 'code' ? { number } : {}) };
      const r = await api('POST', `/api/channels/${channelId}/whatsapp/session`, body);
      if (mode !== st.mode || (mode === 'code' && number !== st.number)) return;
      st.error = '';
      st.data = r;
      st.ttl = st.mode === 'qr' ? 30 : 120;
      st.expiresAt = Date.now() + (r.expires_in || 0) * 1000;
      onState?.(r.state);
      if (!root.isConnected) return;
      if (r.state === 'open') { st.done = true; stop(); onConnected?.(r); }
    } catch (e) {
      if (mode === st.mode) st.error = e.message;
    } finally {
      inflight = false;
      draw();
      if (mode !== st.mode) poll();
    }
  }

  function drawCountdown() {
    const ring = root.querySelector('.wa-ring');
    if (!ring || !st.expiresAt) return;
    const left = Math.max(0, Math.round((st.expiresAt - Date.now()) / 1000));
    ring.style.setProperty('--p', String(Math.round((left / st.ttl) * 100)));
    ring.querySelector('span').textContent = left ? `${left}s` : '…';
    if (!left && document.body.contains(root)) poll(); // venció: se pide el siguiente
  }

  function drawTabs() {
    if (drawnMode === st.mode) return;
    drawnMode = st.mode;
    const tab = (mode, label, sub) => h('button', {
      class: `wa-tab ${st.mode === mode ? 'active' : ''}`,
      'aria-pressed': st.mode === mode ? 'true' : 'false',
      onclick: () => { if (st.mode === mode) return; st.mode = mode; st.data = null; st.error = ''; st.expiresAt = 0; draw(); if (mode === 'qr') poll(); },
    }, h('strong', {}, label), h('small', {}, sub));
    fill(tabs, tab('qr', '📷 Escanear código QR', 'Escanea desde WhatsApp en tu teléfono'), tab('code', '🔢 Con mi número', 'Si estás en el mismo celular'));
  }

  function drawSteps() {
    if (drawnOs === `${st.os}:${st.mode}`) return;
    drawnOs = `${st.os}:${st.mode}`;
    const path = st.os === 'ios' ? ['Abre WhatsApp', 'Configuración', 'Dispositivos vinculados', 'Vincular un dispositivo'] : ['Abre WhatsApp', '⋮ (arriba a la derecha)', 'Dispositivos vinculados', 'Vincular un dispositivo'];
    const last = st.mode === 'qr' ? 'Apunta la cámara a este código' : 'Toca "Vincular con el número de teléfono" y escribe el código';
    fill(steps,
      h('div', { class: 'row', style: 'gap:6px;margin-bottom:6px' }, h('span', { class: 'small muted' }, 'Tu teléfono:'),
        ['android', 'ios'].map((os) => h('button', { class: `small ${st.os === os ? 'primary' : ''}`, onclick: () => { st.os = os; drawSteps(); } }, os === 'ios' ? 'iPhone' : 'Android'))),
      h('ol', {}, [...path, last].map((x) => h('li', {}, x))));
  }

  function draw() {
    if (st.done) {
      const p = st.data?.profile;
      fill(tabs);
      fill(steps);
      return fill(main,
        h('div', { class: 'wa-done' }, h('div', { class: 'wa-check' }, '✓'),
          h('h2', {}, '¡WhatsApp conectado!'),
          p?.number ? h('p', {}, 'Conectado como ', h('strong', {}, p.name || 'tu cuenta'), ` · +${p.number}`) : null,
          st.data?.warning ? h('p', { class: 'banner warn' }, st.data.warning) : null,
          h('p', { class: 'small muted', role: 'status' }, 'Teléfono conectado. El agente responderá cuando esté encendido, el perfil esté activo y se cumplan sus reglas de activación.')));
    }
    drawTabs();
    drawSteps();
    const signature = JSON.stringify([st.mode, st.error, st.data?.qr, st.data?.pairingCode, st.codeRequested, st.data?.waited_s > 60]);
    if (signature === screenSignature) return void drawCountdown();
    screenSignature = signature;
    const err = st.error ? h('div', { class: 'banner danger' }, st.error, ' ', h('button', { class: 'small', onclick: () => { st.error = ''; draw(); poll(true); } }, 'Reintentar')) : null;
    if (st.mode === 'qr') {
      const qr = st.data?.qr;
      fill(main, err,
        qr ? h('div', { class: 'wa-qr' }, h('img', { class: 'qr', src: qr, alt: 'Código QR para vincular WhatsApp' }),
              h('div', { class: 'wa-ring', title: 'El código se renueva solo' }, h('span', {}, ''))) 
           : h('div', { class: 'wa-qr wa-loading' }, h('div', { class: 'spinner' }), h('p', { class: 'muted' }, 'Generando tu código… (unos segundos)'),
               (st.data?.waited_s ?? 0) > 60 ? h('p', { class: 'small muted', style: 'max-width:360px;text-align:center' }, 'Está tardando más de lo normal. Puedes probar "Con mi número" o esperar: seguimos intentando solos.') : null),
        qr ? h('p', { class: 'small muted', style: 'text-align:center' }, 'El código se renueva solo; no tienes que hacer nada más que escanearlo.') : null);
      return void drawCountdown();
    }
    // Modo número
    const code = st.data?.pairingCode;
    const getCode = async (refresh = true) => {
      st.number = st.number.replace(/\D/g, '');
      if (st.number.length < 10 || st.number.length > 15) { st.error = 'Escribe tu número de WhatsApp con lada (10 dígitos en México).'; return draw(); }
      st.codeRequested = true;
      st.data = null;
      draw();
      await poll(refresh);
    };
    const input = h('input', { type: 'tel', inputmode: 'numeric', autocomplete: 'tel', value: st.number, placeholder: '81 1234 5678', oninput: (e) => (st.number = e.target.value) });
    fill(main, err,
      code
        ? h('div', { class: 'wa-code-box' },
            h('p', { class: 'small muted' }, `Tu código para +${st.number.length === 10 ? `52${st.number}` : st.number}:`),
            h('div', { class: 'wa-code' }, code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code),
            h('div', { class: 'row', style: 'justify-content:center' },
              h('button', { class: 'small', onclick: async () => { try { await navigator.clipboard.writeText(code); toast('Código copiado'); } catch { toast('Cópialo a mano', true); } } }, 'Copiar código'),
              h('button', { class: 'small', onclick: () => getCode(true) }, 'Pedir otro'),
              h('button', { class: 'small', onclick: () => { st.codeRequested = false; st.data = null; draw(); } }, 'Cambiar número')),
            h('p', { class: 'small muted' }, 'Esperando a que escribas el código en WhatsApp… esta pantalla avanza sola.'))
        : st.codeRequested
          ? h('div', { class: 'wa-qr wa-loading' }, h('div', { class: 'spinner' }), h('p', { class: 'muted' }, 'Pidiendo tu código…'))
          : h('div', { class: 'wa-code-box' },
              field('Tu número de WhatsApp', input, 'El número del teléfono donde está el WhatsApp del negocio, con lada (México: 10 dígitos).'),
              h('button', { class: 'primary', onclick: () => getCode() }, 'Obtener código')));
  }

  draw();
  poll();
  start();
  return root;
}
