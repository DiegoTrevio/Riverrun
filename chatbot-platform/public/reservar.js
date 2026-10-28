/* Página pública para reservar: servicio → persona (si se permite) → día y hora → datos → confirmación. */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var token = location.pathname.split('/').filter(Boolean).pop() || '';
  var base = '/api/public/booking/' + encodeURIComponent(token);
  var st = { focus: null, req: 0, info: null, service: null, person: null, slots: [], day: '', slot: null, form: { name: '', email: '', phone: '', notes: '', website: '' }, error: '', busy: false, moreDays: false };
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
  /*
   * Color del negocio con contraste suficiente: fondo del botón principal con su tinta (negro o blanco), y para enlaces
   * y foco el mismo tono oscurecido o aclarado hasta 4.5:1 con el fondo del tema (la misma cuenta que el panel).
   */
  function luminance(hex) {
    var c = [1, 3, 5].map(function (i) { var v = parseInt(hex.slice(i, i + 2), 16) / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  }
  function ratio(a, b) { var x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function mix(a, b, t) { return '#' + [1, 3, 5].map(function (i) { var x = parseInt(a.slice(i, i + 2), 16), y = parseInt(b.slice(i, i + 2), 16); return ('0' + Math.round(x + (y - x) * t).toString(16)).slice(-2); }).join(''); }
  function until(color, toward, bgs) { for (var t = 0; t <= 1; t += 0.05) { var c = mix(color, toward, t); if (bgs.every(function (bg) { return ratio(c, bg) >= 4.5; })) return c; } return toward; }
  function brandColors(color) {
    var dark = matchMedia('(prefers-color-scheme: dark)').matches;
    var ink = ratio('#ffffff', color) >= ratio('#101828', color) ? '#ffffff' : '#101828';
    var accent = ratio(ink, color) >= 4.5 ? color : until(color, '#000000', ['#ffffff']);
    var root = document.documentElement.style;
    root.setProperty('--accent', accent);
    root.setProperty('--accent-ink', ratio('#ffffff', accent) >= ratio('#101828', accent) ? '#ffffff' : '#101828');
    root.setProperty('--link', dark ? until(color, '#ffffff', ['#0c111d', '#161b26']) : until(color, '#000000', ['#f9fafb', '#ffffff']));
  }
  function kindText(s) { return s.kind === 'call' ? (s.call_mode === 'video' ? 'Videollamada' : 'Llamada telefónica') : 'Cita'; }

  function header() {
    var i = st.info;
    return el('header', {}, i.business.logo ? el('img', { src: i.business.logo, alt: '' }) : null,
      el('div', {}, el('h1', { text: i.person ? 'Agenda con ' + i.person : i.title || 'Agenda tu cita' }), el('div', { class: 'muted small', text: i.business.name })));
  }
  function back(fn, label) { return el('button', { class: 'back', type: 'button', onclick: fn }, '← ' + (label || 'Volver')); }
  /*
   * Cada paso redibuja la tarjeta. Sin región en vivo en <main> (se releería todo): el foco va adonde sigue la persona,
   * casi siempre el título del paso (st.focus es un selector; null en la primera carga).
   */
  function draw() {
    app.replaceChildren();
    if (!st.info) return;
    app.append(header());
    if (st.done) app.append(doneView());
    else if (!st.service) app.append(servicesView());
    else if (st.service.people && st.service.people.length && st.person === null) app.append(peopleView());
    else if (!st.slot) app.append(timesView());
    else app.append(formView());
    var target = st.focus && app.querySelector(st.focus);
    st.focus = null;
    if (!target) return;
    if (!/^(BUTTON|INPUT|TEXTAREA|A)$/.test(target.tagName)) target.tabIndex = -1;
    target.focus();
  }
  /** Va a otro paso: se dibuja y el foco queda en su título. */
  function step() { st.focus = '.card h2'; draw(); }

  function servicesView() {
    if (!st.info.services.length) return el('div', { class: 'card' }, el('p', { text: 'Por ahora no hay horarios para reservar aquí.' }));
    return el('div', { class: 'card' }, el('h2', { text: '¿Qué quieres agendar?' }),
      el('div', { class: 'choices' }, st.info.services.map(function (s) {
        return el('button', { type: 'button', onclick: function () { pickService(s); } },
          el('strong', { text: s.name }), el('br'), el('span', { class: 'small muted', text: kindText(s) + ' · ' + s.duration + ' min' }),
          s.description ? el('div', { class: 'small muted', text: s.description }) : null);
      })));
  }
  function pickService(s, first) { st.service = s; st.person = s.people && s.people.length ? null : ''; st.slot = null; if (st.person === null) return first ? draw() : step(); loadSlots(first); }

  function peopleView() {
    return el('div', { class: 'card' }, st.info.services.length > 1 ? back(function () { st.service = null; step(); }) : null,
      el('h2', { text: '¿Con quién?' }),
      el('div', { class: 'choices' },
        el('button', { type: 'button', onclick: function () { st.person = ''; loadSlots(); } }, el('strong', { text: 'Con quien esté disponible' })),
        st.service.people.map(function (p) { return el('button', { type: 'button', onclick: function () { st.person = p.id; loadSlots(); } }, el('strong', { text: p.name })); })));
  }

  function loadSlots(first) {
    st.slots = []; st.day = ''; st.loading = true; st.error = ''; if (first) draw(); else step();
    // Una respuesta vieja (la persona ya eligió otro servicio) no pisa la actual. El foco solo vuelve al título si seguía
    // ahí (el título se redibuja); si la persona ya se movió, no se le quita.
    var req = ++st.req;
    var keep = function () { var a = document.activeElement; return !a || a === document.body || a.tagName === 'H2'; };
    var q = '?service_id=' + encodeURIComponent(st.service.id) + (st.person ? '&person_id=' + encodeURIComponent(st.person) : '');
    call('GET', base + '/slots' + q).then(function (list) { if (req !== st.req) return; st.slots = list; st.day = list[0] ? list[0].date : ''; st.loading = false; if (!first && keep()) st.focus = '.card h2'; draw(); })
      .catch(function (e) { if (req !== st.req) return; st.loading = false; st.error = e.message; st.focus = '.card .error'; draw(); });
  }
  function timesView() {
    var days = [];
    st.slots.forEach(function (s) { if (days.indexOf(s.date) < 0) days.push(s.date); });
    var backTo = st.service.people && st.service.people.length ? function () { st.person = null; step(); } : st.info.services.length > 1 ? function () { st.service = null; step(); } : null;
    var card = el('div', { class: 'card' }, backTo ? back(backTo) : null, el('h2', { text: st.service.name }),
      el('p', { class: 'small muted', text: kindText(st.service) + ' · ' + st.service.duration + ' min' + (st.service.location ? ' · ' + st.service.location : '') + ' · horario de ' + st.info.timezone.replace(/_/g, ' ') }));
    if (st.loading) return el('div', {}, card, el('p', { class: 'muted', role: 'status', text: 'Buscando horarios…' }));
    if (st.error) card.append(el('p', { class: 'error', text: st.error })); // recibe el foco: se lee al llegar
    if (!st.slots.length) { card.append(el('p', { text: 'No hay horarios disponibles por ahora. Intenta más tarde.' })); return card; }
    var shown = st.moreDays ? days.slice(0, 30) : days.slice(0, 7);
    card.append(el('p', { class: 'small', text: 'Elige el día:' }), el('div', { class: 'times' }, shown.map(function (d) {
      var first = st.slots.find(function (s) { return s.date === d; });
      // El nombre empieza con lo que se ve («lun 19 oct») y luego la fecha completa, solo para el lector.
      return el('button', { type: 'button', 'data-day': d, 'aria-pressed': String(d === st.day), onclick: function () { st.day = d; st.focus = '[data-day="' + d + '"]'; draw(); } },
        dayChip(d), el('span', { class: 'sr', text: ' (' + first.day + ')' }));
    }), !st.moreDays && days.length > 7 ? el('button', { type: 'button', onclick: function () { st.moreDays = true; st.focus = '[data-day="' + shown[shown.length - 1] + '"]'; draw(); } }, 'Ver más días') : null));
    var selected = st.slots.find(function (s) { return s.date === st.day; });
    var count = st.slots.filter(function (s) { return s.date === st.day; }).length;
    // Al elegir un día el foco se queda en él: cuántos horarios hay se dice aparte.
    card.append(el('p', { class: 'sr', role: 'status', text: selected ? count + (count === 1 ? ' horario el ' : ' horarios el ') + selected.day : '' }));
    card.append(el('p', { class: 'small', text: 'Elige la hora' + (selected ? ' (' + selected.day + '):' : ':') }), el('div', { class: 'times' }, st.slots.filter(function (s) { return s.date === st.day; }).map(function (s) {
      return el('button', { type: 'button', onclick: function () { st.slot = s; st.error = ''; step(); } }, s.label);
    })));
    return card;
  }

  /** Campo al que se refiere el error del servidor (por la palabra que menciona), para marcarlo y enfocarlo. */
  function errorField() {
    var e = (st.error || '').toLowerCase();
    return /correo/.test(e) ? 'email' : /tel[eé]fono/.test(e) ? 'phone' : /nombre/.test(e) ? 'name' : '';
  }
  function input(key, label, attrs) {
    var id = 'f-' + key;
    var bad = st.error && errorField() === key;
    var field = el(key === 'notes' ? 'textarea' : 'input', Object.assign({ id: id, name: key, value: st.form[key], 'aria-invalid': bad ? 'true' : null, 'aria-describedby': bad ? 'form-error' : null, oninput: function (e) { st.form[key] = e.target.value; } }, attrs || {}));
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
      st.error ? el('p', { class: 'error', id: 'form-error', text: st.error }) : null, // el foco va a su campo o a él
      el('p', {}, el('button', { class: 'primary', type: 'submit', 'aria-disabled': st.busy ? 'true' : null }, st.busy ? 'Agendando…' : 'Confirmar')));
    return el('div', { class: 'card' }, back(function () { st.slot = null; st.error = ''; step(); }, 'Cambiar horario'),
      el('h2', { text: s.name + ': ' + st.slot.day + ', ' + st.slot.label }), form);
  }
  function submit(e) {
    e.preventDefault();
    if (st.busy) return;
    st.busy = true; st.error = ''; st.focus = 'button.primary'; draw();
    call('POST', base, { service_id: st.service.id, slot: st.slot.key, person_id: st.person || null, name: st.form.name, email: st.form.email, phone: st.form.phone, notes: st.form.notes, website: st.form.website })
      .then(function (r) { st.busy = false; st.done = r; step(); })
      // El error se dice (role=alert) y el foco va a su campo, o al error si no se sabe cuál es.
      .catch(function (err) { st.busy = false; st.error = err.message; st.focus = errorField() ? '#f-' + errorField() : '#form-error'; draw(); });
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
    if (/^#[0-9a-f]{6}$/i.test(info.business.color || '')) brandColors(info.business.color);
    document.title = (info.person ? 'Agenda con ' + info.person : info.title || 'Agendar') + ' · ' + info.business.name;
    if (info.services.length === 1) pickService(info.services[0], true); else draw();
  }).catch(function (e) {
    app.replaceChildren(el('div', { class: 'card' }, el('h1', { text: 'Enlace no disponible' }), el('p', { text: e.message })));
  });
})();
