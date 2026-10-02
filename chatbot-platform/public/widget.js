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
    var color = cfg.color || '#128c7e';
    var style = el('style');
    style.textContent =
      ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
      '.launcher{display:flex;align-items:center;gap:8px;background:' + color + ';color:#fff;border:0;border-radius:999px;padding:12px 18px;font-size:15px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.2);position:relative}' +
      '.badge{position:absolute;top:-6px;right:-6px;background:#e53935;color:#fff;border-radius:999px;font-size:11px;min-width:20px;height:20px;display:flex;align-items:center;justify-content:center;padding:0 6px}' +
      '.panel{width:360px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - 100px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden;margin-bottom:12px}' +
      '.head{background:' + color + ';color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:flex-start}' +
      '.title{font-weight:700;font-size:16px}.sub{font-size:12px;opacity:.9;margin-top:2px}' +
      '.close{background:none;border:0;color:#fff;font-size:22px;cursor:pointer;line-height:1}' +
      '.list{flex:1;overflow-y:auto;padding:14px;background:#f4f5f7;display:flex;flex-direction:column;gap:6px}' +
      '.msg{max-width:80%;padding:8px 11px;border-radius:12px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;color:#1c1f24}' +
      '.msg a{color:inherit;text-decoration:underline}' +
      '.bot{background:#fff;align-self:flex-start;border-bottom-left-radius:4px;box-shadow:0 1px 1px rgba(0,0,0,.06)}' +
      '.me{background:' + color + ';color:#fff;align-self:flex-end;border-bottom-right-radius:4px}' +
      '.msg img{max-width:100%;border-radius:8px;display:block}' +
      '.typing{align-self:flex-start;background:#fff;border-radius:12px;padding:10px 12px;display:none}' +
      '.typing span{display:inline-block;width:6px;height:6px;margin:0 2px;background:#999;border-radius:50%;animation:b 1.2s infinite}' +
      '.typing span:nth-child(2){animation-delay:.2s}.typing span:nth-child(3){animation-delay:.4s}' +
      '@keyframes b{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-4px);opacity:1}}' +
      '.form{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff}' +
      '.form textarea{flex:1;resize:none;border:1px solid #d1d5db;border-radius:10px;padding:9px 10px;font-size:14px;height:40px;max-height:100px;outline:none;color:#1c1f24;background:#fff}' +
      '.form textarea:focus{border-color:' + color + '}' +
      '.form button{background:' + color + ';color:#fff;border:0;border-radius:10px;padding:0 14px;font-size:14px;cursor:pointer}' +
      '.form button:disabled{opacity:.5}.err{color:#c0392b;font-size:12px;padding:0 12px 8px;background:#fff}' +
      '@media (max-width:480px){.panel{height:calc(100vh - 100px)}}';
    root.appendChild(style);

    var wrap = el('div');
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
    var list = el('div', 'list');
    var typing = el('div', 'typing');
    typing.innerHTML = '<span></span><span></span><span></span>';
    var err = el('div', 'err');
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
    panel.appendChild(err);
    panel.appendChild(form);
    var launcher = el('button', 'launcher', '💬 ' + (cfg.launcher_text || 'Chatea con nosotros'));
    var badge = el('span', 'badge');
    badge.style.display = 'none';
    launcher.appendChild(badge);
    wrap.appendChild(panel);
    wrap.appendChild(launcher);
    root.appendChild(wrap);

    function addMessage(m) {
      if (rendered[m.id]) return;
      rendered[m.id] = true;
      var b = el('div', 'msg ' + (m.from === 'customer' ? 'me' : 'bot'));
      if (m.image_url) {
        var img = el('img');
        img.src = m.image_url;
        img.alt = '';
        img.loading = 'lazy';
        img.onload = scroll;
        b.appendChild(img);
      }
      if (m.text) richText(b, m.text);
      list.insertBefore(b, typing);
      if (m.from !== 'customer' && !open) {
        unread++;
        badge.textContent = unread;
        badge.style.display = 'flex';
      }
    }
    function scroll() {
      list.scrollTop = list.scrollHeight;
    }
    list.appendChild(typing);
    if (cfg.welcome_message) addMessage({ id: 'welcome', from: 'bot', text: cfg.welcome_message });
    unread = 0;

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

    function poll() {
      if (!session) return Promise.resolve();
      return api('GET', '/messages?session=' + session + '&after=' + lastId)
        .then(function (d) {
          (d.messages || []).forEach(function (m) {
            addMessage(m);
            if (m.id > lastId) lastId = m.id;
          });
          typing.style.display = d.typing ? 'block' : 'none';
          if (open) scroll();
        })
        .catch(function () { /* reintento en el siguiente ciclo */ });
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
      if (open) {
        unread = 0;
        badge.style.display = 'none';
        scroll();
        input.focus();
        poll();
      }
      schedule();
    }

    launcher.onclick = function () { toggle(!open); };
    closeBtn.onclick = function () { toggle(false); };
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit'));
      }
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text || sending) return;
      sending = true;
      send.disabled = true;
      err.style.display = 'none';
      ensureSession()
        .then(function () { return api('POST', '/messages', { session: session, text: text }); })
        .then(function (d) {
          input.value = '';
          if (d.id) {
            addMessage({ id: d.id, from: 'customer', text: text });
            if (d.id > lastId) lastId = d.id;
          }
          typing.style.display = 'block';
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
    });

    // Recupera la conversación previa de este navegador.
    session = storage(true);
    poll().then(function () {
      unread = 0;
      badge.style.display = 'none';
      schedule();
    });
  }).catch(function () { /* chat desactivado o dominio no permitido */ });
})();
