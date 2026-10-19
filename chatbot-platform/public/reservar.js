/* Página pública para reservar: servicio → persona (si se permite) → día y hora → datos → confirmación. */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var token = location.pathname.split('/').filter(Boolean).pop() || '';
  var base = '/api/public/booking/' + encodeURIComponent(token);
  var st = { info: null, service: null, person: null, slots: [], day: '', slot: null, form: { name: '', email: '', phone: '', notes: '', website: '' }, error: '', busy: false, moreDays: false };
  // Día corto para los botones: «lun 19 oct».
  var short = new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  function dayChip(date) { return short.format(new Date(date + 'T12:00:00Z')).replace(/\./g, ''); }

  function el(tag, props) {
    var node = document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') node.textContent = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      (Array.isArray(c) ? c : [c]).forEach(function (x) { if (x !== null && x !== undefined && x !== false) node.append(x.nodeType ? x : document.createTextNode(String(x))); });
    }
    return node;
  }
  function call(method, url, body) {
    return fetch(url, { method: method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'No se pudo completar. Intenta de nuevo.'); return d; }); });
  }
  function kindText(s) { return s.kind === 'call' ? (s.call_mode === 'video' ? 'Videollamada' : 'Llamada telefónica') : 'Cita'; }

  function header() {
    var i = st.info;
    return el('header', {}, i.business.logo ? el('img', { src: i.business.logo, alt: '' }) : null,
      el('div', {}, el('h1', { text: i.person ? 'Agenda con ' + i.person : i.title || 'Agenda tu cita' }), el('div', { class: 'muted small', text: i.business.name })));
  }
  function back(fn, label) { return el('button', { class: 'back', type: 'button', onclick: fn }, '← ' + (label || 'Volver')); }
  function draw() {
    app.replaceChildren();
    if (!st.info) return;
    app.append(header());
    if (st.done) return app.append(doneView());
    if (!st.service) return app.append(servicesView());
    var needPerson = st.service.people && st.service.people.length && st.person === null;
    if (needPerson) return app.append(peopleView());
    if (!st.slot) return app.append(timesView());
    app.append(formView());
  }

  function servicesView() {
    if (!st.info.services.length) return el('div', { class: 'card' }, el('p', { text: 'Por ahora no hay horarios para reservar aquí.' }));
    return el('div', { class: 'card' }, el('h2', { text: '¿Qué quieres agendar?' }),
      el('div', { class: 'choices' }, st.info.services.map(function (s) {
        return el('button', { type: 'button', onclick: function () { pickService(s); } },
          el('strong', { text: s.name }), el('br'), el('span', { class: 'small muted', text: kindText(s) + ' · ' + s.duration + ' min' }),
          s.description ? el('div', { class: 'small muted', text: s.description }) : null);
      })));
  }
  function pickService(s) { st.service = s; st.person = s.people && s.people.length ? null : ''; st.slot = null; loadSlots(); }

  function peopleView() {
    return el('div', { class: 'card' }, st.info.services.length > 1 ? back(function () { st.service = null; draw(); }) : null,
      el('h2', { text: '¿Con quién?' }),
      el('div', { class: 'choices' },
        el('button', { type: 'button', onclick: function () { st.person = ''; loadSlots(); } }, el('strong', { text: 'Con quien esté disponible' })),
        st.service.people.map(function (p) { return el('button', { type: 'button', onclick: function () { st.person = p.id; loadSlots(); } }, el('strong', { text: p.name })); })));
  }

  function loadSlots() {
    st.slots = []; st.day = ''; st.loading = true; draw();
    var q = '?service_id=' + encodeURIComponent(st.service.id) + (st.person ? '&person_id=' + encodeURIComponent(st.person) : '');
    call('GET', base + '/slots' + q).then(function (list) { st.slots = list; st.day = list[0] ? list[0].date : ''; st.loading = false; draw(); })
      .catch(function (e) { st.loading = false; st.error = e.message; draw(); });
  }
  function timesView() {
    var days = [];
    st.slots.forEach(function (s) { if (days.indexOf(s.date) < 0) days.push(s.date); });
    var backTo = st.service.people && st.service.people.length ? function () { st.person = null; draw(); } : st.info.services.length > 1 ? function () { st.service = null; draw(); } : null;
    var card = el('div', { class: 'card' }, backTo ? back(backTo) : null, el('h2', { text: st.service.name }),
      el('p', { class: 'small muted', text: kindText(st.service) + ' · ' + st.service.duration + ' min' + (st.service.location ? ' · ' + st.service.location : '') + ' · horario de ' + st.info.timezone.replace(/_/g, ' ') }));
    if (st.loading) return el('div', {}, card, el('p', { class: 'muted', text: 'Buscando horarios…' }));
    if (st.error) card.append(el('p', { class: 'error', role: 'alert', text: st.error }));
    if (!st.slots.length) { card.append(el('p', { text: 'No hay horarios disponibles por ahora. Intenta más tarde.' })); return card; }
    var shown = st.moreDays ? days.slice(0, 30) : days.slice(0, 7);
    card.append(el('p', { class: 'small', text: 'Elige el día:' }), el('div', { class: 'times' }, shown.map(function (d) {
      var first = st.slots.find(function (s) { return s.date === d; });
      return el('button', { type: 'button', 'aria-pressed': String(d === st.day), 'aria-label': first.day, onclick: function () { st.day = d; draw(); } }, dayChip(d));
    }), !st.moreDays && days.length > 7 ? el('button', { type: 'button', onclick: function () { st.moreDays = true; draw(); } }, 'Ver más días') : null));
    var selected = st.slots.find(function (s) { return s.date === st.day; });
    card.append(el('p', { class: 'small', text: 'Elige la hora' + (selected ? ' (' + selected.day + '):' : ':') }), el('div', { class: 'times' }, st.slots.filter(function (s) { return s.date === st.day; }).map(function (s) {
      return el('button', { type: 'button', onclick: function () { st.slot = s; st.error = ''; draw(); } }, s.label);
    })));
    return card;
  }

  function input(key, label, attrs) {
    var id = 'f-' + key;
    var field = el(key === 'notes' ? 'textarea' : 'input', Object.assign({ id: id, name: key, value: st.form[key], oninput: function (e) { st.form[key] = e.target.value; } }, attrs || {}));
    if (key === 'notes') field.value = st.form.notes;
    return [el('label', { for: id, text: label }), field];
  }
  function formView() {
    var s = st.service;
    var phoneNeeded = s.kind === 'call' && s.call_mode !== 'video';
    var form = el('form', { onsubmit: submit, novalidate: true },
      input('name', 'Tu nombre', { required: true, autocomplete: 'name', maxlength: 120 }),
      input('email', 'Tu correo (te enviamos la confirmación)', { type: 'email', required: true, autocomplete: 'email', maxlength: 200 }),
      input('phone', phoneNeeded ? 'Tu teléfono (te llamaremos a este número)' : 'Tu teléfono (opcional)', { type: 'tel', required: phoneNeeded, autocomplete: 'tel', maxlength: 30 }),
      input('notes', 'Algo que debamos saber (opcional)', { maxlength: 1000, rows: 3 }),
      el('div', { class: 'trap', 'aria-hidden': 'true' }, el('label', { for: 'f-website', text: 'No llenar' }), el('input', { id: 'f-website', name: 'website', tabindex: '-1', autocomplete: 'off', oninput: function (e) { st.form.website = e.target.value; } })),
      st.error ? el('p', { class: 'error', role: 'alert', text: st.error }) : null,
      el('p', {}, el('button', { class: 'primary', type: 'submit', disabled: st.busy }, st.busy ? 'Agendando…' : 'Confirmar')));
    return el('div', { class: 'card' }, back(function () { st.slot = null; st.error = ''; draw(); }, 'Cambiar horario'),
      el('h2', { text: s.name + ': ' + st.slot.day + ', ' + st.slot.label }), form);
  }
  function submit(e) {
    e.preventDefault();
    if (st.busy) return;
    st.busy = true; st.error = ''; draw();
    call('POST', base, { service_id: st.service.id, slot: st.slot.key, person_id: st.person || null, name: st.form.name, email: st.form.email, phone: st.form.phone, notes: st.form.notes, website: st.form.website })
      .then(function (r) { st.busy = false; st.done = r; draw(); })
      .catch(function (err) { st.busy = false; st.error = err.message; draw(); });
  }
  function doneView() {
    var r = st.done;
    return el('div', { class: 'card', role: 'status' }, el('h2', { text: '¡Listo! Quedó agendada.' }),
      el('p', { text: (r.service || st.service.name) + ' · ' + (r.when || '') + (r.person ? ' con ' + r.person : '') }),
      r.meeting_url && /^https:\/\//.test(r.meeting_url) ? el('p', {}, 'Enlace para la videollamada: ', el('a', { href: r.meeting_url, rel: 'noopener', target: '_blank', text: r.meeting_url })) : null,
      el('p', { class: 'small muted', text: r.email_sent ? 'Te enviamos la confirmación a ' + (r.email || 'tu correo') + ' y un recordatorio antes de la hora.'
        : 'Guarda estos datos: no pudimos enviarte la confirmación por correo, pero el negocio ya tiene tu reserva.' }));
  }

  call('GET', base).then(function (info) {
    st.info = info;
    if (info.business.color) document.documentElement.style.setProperty('--accent', info.business.color);
    document.title = (info.person ? 'Agenda con ' + info.person : info.title || 'Agendar') + ' · ' + info.business.name;
    if (info.services.length === 1) pickService(info.services[0]); else draw();
  }).catch(function (e) {
    app.replaceChildren(el('div', { class: 'card' }, el('h1', { text: 'Enlace no disponible' }), el('p', { text: e.message })));
  });
})();
