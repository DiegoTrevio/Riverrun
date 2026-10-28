/*
 * Widget de chat web. Uso en cualquier sitio:
 *   <script src="https://TU-DOMINIO/widget.js" data-channel="TOKEN_DEL_CANAL" async></script>
 * Sin dependencias; se aísla en Shadow DOM para no chocar con los estilos del sitio.
 */
(function () {
  var script = document.currentScript;
  if (!script || !script.dataset.channel || window.__chatWidgetLoaded) return;
  window.__chatWidgetLoaded = true;
  var token = script.dataset.channel;
  var base = new URL(script.src).origin + '/webchat/' + encodeURIComponent(token);
  var storeKey = 'cw_session_' + token;

  var session = null;
  var lastId = 0;
  var rendered = {};
  var open = false;
  var unread = 0;
  var timer = null;
  var sending = false;

  function storage(get, value) {
    try {
      if (get) return localStorage.getItem(storeKey);
      localStorage.setItem(storeKey, value);
    } catch (e) { /* navegación privada */ }
    return null;
  }

  function api(method, path, body) {
    return fetch(base + path, {
      method: method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Error');
        return d;
      });
    });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /** Texto seguro con enlaces clicables (nunca se inserta HTML). */
  function richText(node, text) {
    var parts = String(text).split(/(https?:\/\/[^\s<>"']+)/g);
    parts.forEach(function (p, i) {
      if (i % 2) {
        var a = el('a', null, p);
        a.href = p;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        node.appendChild(a);
      } else if (p) node.appendChild(document.createTextNode(p));
    });
  }

  api('GET', '/config').then(function (cfg) {
    var host = document.createElement('div');
    host.style.cssText = 'position:fixed;z-index:2147483000;bottom:20px;right:20px;';
    document.body.appendChild(host);
    var root = host.attachShadow({ mode: 'open' });
    var color = /^#[0-9a-f]{6}$/i.test(cfg.color || '') ? cfg.color : '#128c7e';
    var rgb = [1, 3, 5].map(function (i) { var c = parseInt(color.slice(i, i + 2), 16) / 255; return c <= .04045 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4); });
    var luminance = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    var ink = luminance > .179 ? '#111111' : '#ffffff';
    // Un tono medio donde ni el texto blanco ni el oscuro llegan a 4.5:1 se oscurece hasta que el blanco llegue.
    if (Math.max(1.05 / (luminance + .05), (luminance + .05) / (lum('#111111') + .05)) < 4.5) {
      var brand = color;
      for (var k = .05; k <= 1 && 1.05 / (lum(color) + .05) < 4.5; k += .05) color = mixBlack(brand, k);
      ink = '#ffffff';
    }
    // Bordes (foco del campo y botones de opciones) sobre blanco: el color de marca si da 3:1; si no, más oscuro.
    var line = color;
    for (var t = 0; t <= 1 && (1.05 / (lum(line) + .05)) < 3; t += .1) line = mixBlack(color, t);
    function lum(hex) { var c = [1, 3, 5].map(function (i) { var v = parseInt(hex.slice(i, i + 2), 16) / 255; return v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; }
    // En oscuro, el mismo borde de marca se aclara hasta 3:1 contra el panel oscuro.
    var lineDark = color;
    for (var u = 0; u <= 1 && (lum(lineDark) + .05) / (lum('#161b26') + .05) < 3; u += .1) lineDark = mixWhite(color, u);
    function mixWhite(hex, k) { return '#' + [1, 3, 5].map(function (i) { var v = parseInt(hex.slice(i, i + 2), 16); return ('0' + Math.round(v + (255 - v) * k).toString(16)).slice(-2); }).join(''); }
    function mixBlack(hex, k) { return '#' + [1, 3, 5].map(function (i) { return ('0' + Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - k)).toString(16)).slice(-2); }).join(''); }
    var style = el('style');
    style.textContent =
      ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
      // Modo de color: «auto» sigue el dispositivo del visitante; «light» y «dark» lo fijan (según el canal).
      '.w{--w-panel:#fff;--w-list:#f4f5f7;--w-bubble:#fff;--w-text:#1c1f24;--w-border:#e5e7eb;--w-field:#6b7280;--w-err:#c0392b;--w-dot:#999;--w-line:' + line + ';color-scheme:light}.w.dark{--w-panel:#161b26;--w-list:#0c111d;--w-bubble:#1f2633;--w-text:#e4e7ec;--w-border:#2f3747;--w-field:#8b93a3;--w-err:#f97066;--w-dot:#8b93a3;--w-line:' + lineDark + ';color-scheme:dark}@media (prefers-color-scheme:dark){.w.auto{--w-panel:#161b26;--w-list:#0c111d;--w-bubble:#1f2633;--w-text:#e4e7ec;--w-border:#2f3747;--w-field:#8b93a3;--w-err:#f97066;--w-dot:#8b93a3;--w-line:' + lineDark + ';color-scheme:dark}}' +
      '.launcher{display:flex;align-items:center;gap:8px;background:' + color + ';color:' + ink + ';border:0;border-radius:999px;padding:12px 18px;font-size:15px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.2);position:relative}' + // taste-skill-ignore: botón y panel flotantes sobre el sitio del cliente
      '.badge{position:absolute;top:-6px;right:-6px;background:#b12e22;color:#fff;border-radius:999px;font-size:11px;min-width:20px;height:20px;display:flex;align-items:center;justify-content:center;padding:0 6px}' +
      '.panel{width:360px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - 100px);background:var(--w-panel);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden;margin-bottom:12px}' + // taste-skill-ignore: botón y panel flotantes sobre el sitio del cliente
      '.head{background:' + color + ';color:' + ink + ';padding:14px 16px;display:flex;justify-content:space-between;align-items:flex-start}' +
      '.title{font-weight:700;font-size:16px}.sub{font-size:12px;margin-top:2px}' +
      '.close{background:none;border:0;color:' + ink + ';font-size:22px;cursor:pointer;line-height:1;min-width:32px;min-height:32px;border-radius:8px}' +
      '.list{flex:1;overflow-y:auto;padding:14px;background:var(--w-list);display:flex;flex-direction:column;gap:6px}' +
      '.msg{max-width:80%;padding:8px 11px;border-radius:12px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;color:var(--w-text)}' +
      '.msg a{color:inherit;text-decoration:underline}' +
      '.bot{background:var(--w-bubble);align-self:flex-start;border-bottom-left-radius:4px;border:1px solid var(--w-border)}' +
      '.me{background:' + color + ';color:' + ink + ';align-self:flex-end;border-bottom-right-radius:4px}' +
      '.msg img{max-width:100%;border-radius:8px;display:block}' +
      '.typing{align-self:flex-start;background:var(--w-bubble);border-radius:12px;padding:10px 12px;display:none}' +
      '.typing span{display:inline-block;width:6px;height:6px;margin:0 2px;background:var(--w-dot);border-radius:50%;animation:b 1.2s infinite}' +
      '.typing span:nth-child(2){animation-delay:.2s}.typing span:nth-child(3){animation-delay:.4s}' +
      '@keyframes b{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-4px);opacity:1}}' +
      '.form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--w-border);background:var(--w-panel)}' +
      '.form textarea{flex:1;resize:none;border:1px solid var(--w-field);border-radius:10px;padding:9px 10px;font-size:14px;height:40px;max-height:100px;color:var(--w-text);background:var(--w-panel)}' +
      '.form textarea:focus{border-color:var(--w-line)}' +
      '.form button{background:' + color + ';color:' + ink + ';border:0;border-radius:10px;padding:0 14px;font-size:14px;cursor:pointer}' +
      '.form button:disabled{opacity:.5}.err{color:var(--w-err);font-size:12px;padding:0 12px 8px;background:var(--w-panel)}' +
      '.chips{display:flex;flex-wrap:wrap;gap:6px;align-self:flex-start;max-width:90%}' +
      '.chip{background:var(--w-bubble);border:1px solid var(--w-line);color:var(--w-text);border-radius:999px;padding:6px 12px;font-size:13px;line-height:1.3;cursor:pointer;text-decoration:none;min-height:32px;font-family:inherit}' +
      '.chip:disabled{opacity:.5;cursor:default}' +
      '@media (prefers-reduced-motion:reduce){.typing span{animation:none}}:focus-visible{outline:3px solid #111;outline-offset:2px;box-shadow:0 0 0 5px #fff}' +
      '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}' +
      '@media (max-width:480px){.panel{height:calc(100vh - 100px)}}';
    root.appendChild(style);

    var wrap = el('div', 'w ' + (cfg.theme === 'dark' || cfg.theme === 'light' ? cfg.theme : 'auto'));
    // El widget está en español aunque la página del cliente diga otro idioma.
    host.setAttribute('lang', 'es');
    wrap.setAttribute('lang', 'es');
    var panel = el('div', 'panel');
    panel.style.display = 'none';
    var head = el('div', 'head');
    var ht = el('div');
    ht.appendChild(el('div', 'title', cfg.title));
    if (cfg.subtitle) ht.appendChild(el('div', 'sub', cfg.subtitle));
    var closeBtn = el('button', 'close', '×');
    closeBtn.setAttribute('aria-label', 'Cerrar chat');
    head.appendChild(ht);
    head.appendChild(closeBtn);
    // Registro de la conversación: lo que llega se anuncia solo.
    var list = el('div', 'list');
    list.setAttribute('role', 'log');
    list.setAttribute('aria-label', 'Conversación');
    var typing = el('div', 'typing');
    typing.setAttribute('aria-hidden', 'true');
    typing.innerHTML = '<span></span><span></span><span></span>';
    // Avisos para el lector fuera del registro: «escribiendo» y, con el chat cerrado, que llegó un mensaje.
    var typingStatus = el('div', 'sr');
    typingStatus.setAttribute('role', 'status');
    var notice = el('div', 'sr');
    notice.setAttribute('role', 'status');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', cfg.title || 'Chat con el negocio');
    panel.id = 'customer-chat';
    var err = el('div', 'err');
    err.setAttribute('role', 'alert');
    err.style.display = 'none';
    var form = el('form', 'form');
    var input = el('textarea');
    input.placeholder = 'Escribe tu mensaje…';
    input.setAttribute('aria-label', 'Mensaje');
    var send = el('button', null, 'Enviar');
    send.type = 'submit';
    form.appendChild(input);
    form.appendChild(send);
    panel.appendChild(head);
    panel.appendChild(list);
    panel.appendChild(typingStatus);
    panel.appendChild(err);
    panel.appendChild(form);
    var launcher = el('button', 'launcher', cfg.launcher_text || 'Chatea con nosotros');
    launcher.insertAdjacentHTML('afterbegin', '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 20 12z"/></svg>');
    var launcherText = cfg.launcher_text || 'Chatea con nosotros';
    var badge = el('span', 'badge');
    badge.setAttribute('aria-hidden', 'true');
    badge.style.display = 'none';
    launcher.appendChild(badge);
    launcher.setAttribute('aria-controls', panel.id);
    launcher.setAttribute('aria-expanded', 'false');
    root.addEventListener('keydown', function (e) { if (e.key === 'Escape' && open) { e.preventDefault(); toggle(false); } });
    wrap.appendChild(panel);
    wrap.appendChild(launcher);
    wrap.appendChild(notice);
    root.appendChild(wrap);

    // Botones de un flujo: solo los del último mensaje se pueden tocar (los de enlace siempre abren).
    var liveChips = null;
    function addMessage(m) {
      if (rendered[m.id]) return;
      rendered[m.id] = true;
      if (liveChips) {
        liveChips.querySelectorAll('button').forEach(function (x) { x.disabled = true; });
        liveChips = null;
      }
      var b = el('div', 'msg ' + (m.from === 'customer' ? 'me' : 'bot'));
      // Quién habla, para el lector (a la vista lo dicen el lado y el color).
      b.appendChild(el('span', 'sr', m.from === 'customer' ? 'Tú: ' : (cfg.title || 'Negocio') + ': '));
      if (m.from === 'customer') b.setAttribute('aria-live', 'off'); // lo que uno mismo escribió no se vuelve a leer
      if (m.image_url) {
        var img = el('img');
        img.src = m.image_url;
        img.alt = m.text ? '' : 'Imagen';
        img.loading = 'lazy';
        img.onload = scroll;
        b.appendChild(img);
      }
      if (m.file && /^https?:\/\//.test(m.file.url || '')) {
        if (m.file.kind === 'video' || m.file.kind === 'audio') {
          var media = el(m.file.kind);
          media.src = m.file.url;
          media.controls = true;
          media.preload = 'metadata';
          media.style.maxWidth = '100%';
          b.appendChild(media);
        } else {
          var link = el('a', 'file', '📎 ' + (m.file.name || 'Archivo'));
          link.href = m.file.url;
          link.target = '_blank';
          link.rel = 'noopener';
          link.setAttribute('download', m.file.name || '');
          b.appendChild(link);
        }
      }
      if (m.text) richText(b, m.text);
      list.insertBefore(b, typing);
      if (m.buttons && m.buttons.length) {
        var row = el('div', 'chips');
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', 'Opciones');
        m.buttons.forEach(function (x) {
          if (x.kind === 'url') {
            if (!/^https:\/\//.test(x.url || '')) return;
            var a = el('a', 'chip', x.label + ' ↗');
            a.href = x.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            row.appendChild(a);
          } else {
            var btn = el('button', 'chip', x.label);
            btn.type = 'button';
            // El botón se desactiva al llegar la respuesta: el foco pasa al campo para no perderse.
            btn.onclick = function () { sendMessage(x.label, x.payload); input.focus(); };
            row.appendChild(btn);
          }
        });
        list.insertBefore(row, typing);
        liveChips = row;
      }
      if (m.from !== 'customer' && !open) {
        unread++;
        badge.textContent = unread;
        badge.style.display = 'flex';
        launcher.setAttribute('aria-label', launcherText + ' (' + unread + (unread === 1 ? ' mensaje nuevo)' : ' mensajes nuevos)'));
        notice.textContent = 'Mensaje nuevo de ' + (cfg.title || 'el negocio');
      }
    }
    function scroll() {
      list.scrollTop = list.scrollHeight;
    }
    list.appendChild(typing);
    if (cfg.welcome_message) addMessage({ id: 'welcome', from: 'bot', text: cfg.welcome_message });
    unread = 0;
    launcher.removeAttribute('aria-label');

    function ensureSession() {
      if (session) return Promise.resolve(session);
      session = storage(true);
      if (session) return Promise.resolve(session);
      return api('POST', '/session').then(function (d) {
        session = d.session;
        storage(false, session);
        return session;
      });
    }

    var polling;
    function poll() {
      if (polling) return polling;
      if (!session || document.hidden) return Promise.resolve();
      polling = api('GET', '/messages?session=' + session + '&after=' + lastId)
        .then(function (d) {
          (d.messages || []).forEach(function (m) {
            addMessage(m);
            if (m.id > lastId) lastId = m.id;
          });
          typing.style.display = d.typing ? 'block' : 'none';
          typingStatus.textContent = d.typing ? (cfg.title || 'El negocio') + ' está escribiendo…' : '';
          if (open) scroll();
        })
        .catch(function () { /* reintento en el siguiente ciclo */ }).finally(function () { polling = null; });
      return polling;
    }

    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        poll().then(schedule);
      }, open ? 2500 : 15000);
    }

    function toggle(v) {
      open = v;
      panel.style.display = open ? 'flex' : 'none';
      launcher.setAttribute('aria-expanded', String(open));
      if (!open) launcher.focus();
      if (open) {
        unread = 0;
        badge.style.display = 'none';
        launcher.removeAttribute('aria-label');
        notice.textContent = '';
        scroll();
        input.focus();
        poll();
      }
      schedule();
    }

    launcher.onclick = function () { toggle(!open); };
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { poll(); schedule(); } });
    closeBtn.onclick = function () { toggle(false); };
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit'));
      }
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      sendMessage(input.value.trim());
    });
    /** Envía lo escrito o, con `button`, el botón tocado (su texto y su identificador). */
    function sendMessage(text, button) {
      if (!text || sending) return;
      sending = true;
      send.disabled = true;
      err.style.display = 'none';
      ensureSession()
        .then(function () { return api('POST', '/messages', button ? { session: session, text: text, button: button } : { session: session, text: text }); })
        .then(function (d) {
          if (!button) input.value = '';
          if (d.id) {
            addMessage({ id: d.id, from: 'customer', text: text });
            if (d.id > lastId) lastId = d.id;
          }
          typing.style.display = 'block';
          typingStatus.textContent = (cfg.title || 'El negocio') + ' está escribiendo…';
          scroll();
          return poll();
        })
        .catch(function (e2) {
          err.textContent = e2.message || 'No se pudo enviar';
          err.style.display = 'block';
        })
        .then(function () {
          sending = false;
          send.disabled = false;
          schedule();
        });
    }

    // Recupera la conversación previa de este navegador.
    session = storage(true);
    poll().then(function () {
      unread = 0;
      badge.style.display = 'none';
      launcher.removeAttribute('aria-label');
      schedule();
    });
  }).catch(function () { /* chat desactivado o dominio no permitido */ });
})();
