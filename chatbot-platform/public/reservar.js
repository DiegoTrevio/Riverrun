/* Página pública para reservar: servicio → persona (si se permite) → día y hora → datos → confirmación. */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var token = location.pathname.split('/').filter(Boolean).pop() || '';
  var base = '/api/public/booking/' + encodeURIComponent(token);
  var st = { focus: null, req: 0, info: null, service: null, person: null, slots: [], day: '', slot: null, form: { name: '', email: '', phone: '', notes: '', website: '' }, error: '', busy: false, moreDays: false };
  // Idioma de la página: el del negocio con sus clientes. El servidor ya lo pone en <html lang> y lo repite en la información.
  var lang = document.documentElement.lang === 'en' ? 'en' : 'es';
  function t(es, en) { return lang === 'en' ? en : es; }
  // Los avisos del servidor vienen en español; en inglés se cambian por estos (test/booking-page.test.ts
  // revisa que estén todos los de src/routes/booking.ts).
  var ERRORS_EN = {
    'No se pudo completar. Intenta de nuevo.': "Something went wrong. Please try again.",
    'Datos inválidos': 'Please check your details.',
    'Demasiadas visitas; intenta en un minuto.': 'Too many visits; please try again in a minute.',
    'Demasiados intentos; espera un momento.': 'Too many attempts; please wait a moment.',
    'Esa persona no atiende este servicio': "That person doesn't offer this service",
    'Escribe tu teléfono: te llamaremos a ese número': "Enter your phone number: we'll call you there",
    'Ese servicio ya no está disponible.': 'That service is no longer available.',
    'Este enlace para reservar ya no está disponible.': 'This booking link is no longer available.',
    'Este enlace recibió muchas reservas seguidas; intenta más tarde.': 'This link got too many bookings in a row; please try again later.',
    'Este enlace ya recibió muchas reservas hoy; intenta mañana o escríbele al negocio.': 'This link already got many bookings today; try tomorrow or contact the business.',
    'Este enlace ya se usó o venció. Vuelve a elegir tu horario.': 'This link was already used or expired. Please choose your time again.',
    'Hiciste demasiadas reservas seguidas; intenta más tarde.': 'You made too many bookings in a row; please try again later.',
    'Las reservas en línea no están disponibles por ahora. Escríbele al negocio.': 'Online booking is not available right now. Please contact the business.',
    'Servicio no disponible': 'Service unavailable',
    'Ya tienes varias reservas próximas con este negocio. Si necesitas otra, escríbeles directamente.': 'You already have several upcoming bookings with this business. If you need another, contact them directly.',
    'Confirma que no eres un robot e intenta de nuevo.': "Confirm you're not a robot and try again.",
    'No pudimos comprobar el captcha: intenta en un momento': "We couldn't check the captcha: please try again in a moment",
    'Ese horario ya se ocupó. Elige otro.': 'That time was just taken. Please choose another.',
  };
  function serverText(msg) {
    if (lang !== 'en' || !msg) return msg;
    if (ERRORS_EN[msg]) return ERRORS_EN[msg];
    var taken = /^Ese horario ya se ocupó\. Elige otro: (.*)$/.exec(msg);
    return taken ? 'That time was just taken. Choose another: ' + taken[1] : msg;
  }
  // Día corto para los botones: «lun 19 oct» / «Mon, Oct 19».
  function dayChip(date) {
    var short = new Intl.DateTimeFormat(t('es-MX', 'en-US'), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    return short.format(new Date(date + 'T12:00:00Z')).replace(/\./g, '');
  }

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
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(serverText(d.error || 'No se pudo completar. Intenta de nuevo.')); return d; }); });
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
    root.setProperty('--link', dark ? until(color, '#ffffff', ['#1b1b1b', '#262626']) : until(color, '#000000', ['#f1f1f1', '#ffffff']));
  }
  function kindText(s) { return s.kind === 'call' ? (s.call_mode === 'video' ? t('Videollamada', 'Video call') : t('Llamada telefónica', 'Phone call')) : t('Cita', 'Appointment'); }

  function header() {
    var i = st.info;
    return el('header', {}, i.business.logo ? el('img', { src: i.business.logo, alt: '' }) : null,
      el('div', {}, el('h1', { text: i.person ? t('Agenda con ', 'Book with ') + i.person : i.title || t('Agenda tu cita', 'Book your appointment') }), el('div', { class: 'muted small', text: i.business.name })));
  }
  function back(fn, label) { return el('button', { class: 'back', type: 'button', onclick: fn }, '← ' + (label || t('Volver', 'Back'))); }
  /*
   * Cada paso redibuja la tarjeta. Sin región en vivo en <main> (se releería todo): el foco va adonde sigue la persona,
   * casi siempre el título del paso (st.focus es un selector; null en la primera carga).
   */
  function draw() {
    app.replaceChildren();
    if (!st.info) return;
    app.append(header());
    if (st.confirmError) app.append(el('div', { class: 'card', role: 'alert' }, el('h2', { text: t('No se pudo confirmar', "Couldn't confirm") }), el('p', { text: st.confirmError }),
      el('p', {}, el('a', { href: location.pathname, text: t('Elegir un horario', 'Choose a time') }))));
    else if (st.done && st.done.pending) app.append(pendingView());
    else if (st.done) app.append(doneView());
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
    if (!st.info.services.length) return el('div', { class: 'card' }, el('p', { text: t('Por ahora no hay horarios para reservar aquí.', 'There are no times to book here right now.') }));
    return el('div', { class: 'card' }, el('h2', { text: t('¿Qué quieres agendar?', 'What would you like to book?') }),
      el('div', { class: 'choices' }, st.info.services.map(function (s) {
        return el('button', { type: 'button', onclick: function () { pickService(s); } },
          el('strong', { text: s.name }), el('br'), el('span', { class: 'small muted', text: kindText(s) + ' · ' + s.duration + ' min' }),
          s.description ? el('div', { class: 'small muted', text: s.description }) : null);
      })));
  }
  function pickService(s, first) { st.service = s; st.person = s.people && s.people.length ? null : ''; st.slot = null; if (st.person === null) return first ? draw() : step(); loadSlots(first); }

  function peopleView() {
    return el('div', { class: 'card' }, st.info.services.length > 1 ? back(function () { st.service = null; step(); }) : null,
      el('h2', { text: t('¿Con quién?', 'With whom?') }),
      el('div', { class: 'choices' },
        el('button', { type: 'button', onclick: function () { st.person = ''; loadSlots(); } }, el('strong', { text: t('Con quien esté disponible', 'Whoever is available') })),
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
      el('p', { class: 'small muted', text: kindText(st.service) + ' · ' + st.service.duration + ' min' + (st.service.location ? ' · ' + st.service.location : '') + t(' · horario de ', ' · times in ') + st.info.timezone.replace(/_/g, ' ') }));
    if (st.loading) return el('div', {}, card, el('p', { class: 'muted', role: 'status', text: t('Buscando horarios…', 'Looking for times…') }));
    if (st.error) card.append(el('p', { class: 'error', text: st.error })); // recibe el foco: se lee al llegar
    if (!st.slots.length) { card.append(el('p', { text: t('No hay horarios disponibles por ahora. Intenta más tarde.', 'No times available right now. Please try again later.') })); return card; }
    var shown = st.moreDays ? days.slice(0, 30) : days.slice(0, 7);
    card.append(el('p', { class: 'small', text: t('Elige el día:', 'Choose a day:') }), el('div', { class: 'times' }, shown.map(function (d) {
      var first = st.slots.find(function (s) { return s.date === d; });
      // El nombre empieza con lo que se ve («lun 19 oct») y luego la fecha completa, solo para el lector.
      return el('button', { type: 'button', 'data-day': d, 'aria-pressed': String(d === st.day), onclick: function () { st.day = d; st.focus = '[data-day="' + d + '"]'; draw(); } },
        dayChip(d), el('span', { class: 'sr', text: ' (' + first.day + ')' }));
    }), !st.moreDays && days.length > 7 ? el('button', { type: 'button', onclick: function () { st.moreDays = true; st.focus = '[data-day="' + shown[shown.length - 1] + '"]'; draw(); } }, t('Ver más días', 'Show more days')) : null));
    var selected = st.slots.find(function (s) { return s.date === st.day; });
    var count = st.slots.filter(function (s) { return s.date === st.day; }).length;
    // Al elegir un día el foco se queda en él: cuántos horarios hay se dice aparte.
    card.append(el('p', { class: 'sr', role: 'status', text: selected ? count + (count === 1 ? t(' horario el ', ' time on ') : t(' horarios el ', ' times on ')) + selected.day : '' }));
    card.append(el('p', { class: 'small', text: t('Elige la hora', 'Choose a time') + (selected ? ' (' + selected.day + '):' : ':') }), el('div', { class: 'times' }, st.slots.filter(function (s) { return s.date === st.day; }).map(function (s) {
      return el('button', { type: 'button', onclick: function () { st.slot = s; st.error = ''; step(); } }, s.label);
    })));
    return card;
  }

  /** Campo al que se refiere el error del servidor (por la palabra que menciona), para marcarlo y enfocarlo. */
  function errorField() {
    var e = (st.error || '').toLowerCase();
    return /correo|email/.test(e) ? 'email' : /tel[eé]fono|phone/.test(e) ? 'phone' : /nombre|name/.test(e) ? 'name' : '';
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
      input('name', t('Tu nombre', 'Your name'), { required: true, autocomplete: 'name', maxlength: 120 }),
      input('email', t('Tu correo (te enviamos la confirmación)', "Your email (we'll send you the confirmation)"), { type: 'email', required: true, autocomplete: 'email', maxlength: 200 }),
      input('phone', phoneNeeded ? t('Tu teléfono (te llamaremos a este número)', "Your phone (we'll call you at this number)") : t('Tu teléfono (opcional)', 'Your phone (optional)'), { type: 'tel', required: phoneNeeded, autocomplete: 'tel', maxlength: 30 }),
      input('notes', t('Algo que debamos saber (opcional)', 'Anything we should know (optional)'), { maxlength: 1000, rows: 3 }),
      el('div', { class: 'trap', 'aria-hidden': 'true' }, el('label', { for: 'f-website', text: t('No llenar', 'Leave empty') }), el('input', { id: 'f-website', name: 'website', tabindex: '-1', autocomplete: 'off', oninput: function (e) { st.form.website = e.target.value; } })),
      captchaBox(),
      st.error ? el('p', { class: 'error', id: 'form-error', text: st.error }) : null, // el foco va a su campo o a él
      el('p', {}, el('button', { class: 'primary', type: 'submit', 'aria-disabled': st.busy ? 'true' : null }, st.busy ? t('Enviando…', 'Sending…') : t('Confirmar', 'Confirm'))));
    return el('div', { class: 'card' }, back(function () { st.slot = null; st.error = ''; step(); }, t('Cambiar horario', 'Change time')),
      el('h2', { text: s.name + ': ' + st.slot.day + ', ' + st.slot.label }), form);
  }
  /** Captcha de Cloudflare (solo si el servidor lo pide): su respuesta va con la reserva. */
  var captchaToken = '';
  function captchaBox() {
    var key = st.info && st.info.turnstile_site_key;
    if (!key) return null;
    var box = el('div', { class: 'captcha' });
    var render = function () { window.turnstile.render(box, { sitekey: key, language: lang, callback: function (t) { captchaToken = t; }, 'expired-callback': function () { captchaToken = ''; } }); };
    if (window.turnstile) setTimeout(render, 0);
    else if (!document.getElementById('cf-turnstile')) {
      var sc = document.createElement('script');
      sc.id = 'cf-turnstile'; sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; sc.async = true;
      sc.onload = render;
      document.head.append(sc);
    } else document.getElementById('cf-turnstile').addEventListener('load', render);
    return box;
  }
  /** Se pidió la reserva: falta abrir el enlace que llegó al correo (IN-18). */
  function pendingView() {
    var r = st.done;
    return el('div', { class: 'card', role: 'status' }, el('h2', { text: t('Revisa tu correo', 'Check your email') }),
      el('p', { text: t('Te enviamos un enlace a ', 'We sent a link to ') + (r.email || t('tu correo', 'your email')) + t('. Ábrelo para confirmar tu reserva: vence en una hora.', '. Open it to confirm your booking: it expires in one hour.') }),
      el('p', { class: 'small muted', text: t('Hasta que lo abras, el horario no queda apartado. Si no te llega, revisa tu correo no deseado.', "Until you open it, the time isn't held. If it doesn't arrive, check your spam folder.") }));
  }
  function submit(e) {
    e.preventDefault();
    if (st.busy) return;
    st.busy = true; st.error = ''; st.focus = 'button.primary'; draw();
    call('POST', base, { service_id: st.service.id, slot: st.slot.key, person_id: st.person || null, name: st.form.name, email: st.form.email, phone: st.form.phone, notes: st.form.notes, website: st.form.website, turnstile_token: captchaToken || undefined })
      .then(function (r) { st.busy = false; st.done = r; step(); })
      // El error se dice (role=alert) y el foco va a su campo, o al error si no se sabe cuál es.
      .catch(function (err) { st.busy = false; st.error = err.message; st.focus = errorField() ? '#f-' + errorField() : '#form-error'; draw(); });
  }
  function doneView() {
    var r = st.done;
    return el('div', { class: 'card', role: 'status' }, el('h2', { text: t('¡Listo! Quedó agendada.', "You're all set! It's booked.") }),
      el('p', { text: (r.service || st.service.name) + ' · ' + (r.when || '') + (r.person ? t(' con ', ' with ') + r.person : '') }),
      r.meeting_url && /^https:\/\//.test(r.meeting_url) ? el('p', {}, t('Enlace para la videollamada: ', 'Video call link: '), el('a', { href: r.meeting_url, rel: 'noopener', target: '_blank', text: r.meeting_url })) : null,
      el('p', { class: 'small muted', text: r.email_sent ? t('Te enviamos la confirmación a ', 'We sent the confirmation to ') + (r.email || t('tu correo', 'your email')) + t(' y un recordatorio antes de la hora.', ", and we'll send a reminder before it starts.")
        : t('Guarda estos datos: no pudimos enviarte la confirmación por correo, pero el negocio ya tiene tu reserva.', "Save these details: we couldn't email you the confirmation, but the business has your booking.") }));
  }

  // Enlace del correo: confirma la reserva y la agenda.
  var confirmCode = new URLSearchParams(location.search).get('confirmar');
  call('GET', base).then(function (info) {
    st.info = info;
    lang = info.lang === 'en' ? 'en' : 'es';
    document.documentElement.lang = lang;
    if (confirmCode) {
      if (/^#[0-9a-f]{6}$/i.test(info.business.color || '')) brandColors(info.business.color);
      history.replaceState(null, '', location.pathname);
      document.title = t('Confirmar reserva · ', 'Confirm booking · ') + info.business.name;
      return call('POST', base + '/confirm', { code: confirmCode })
        .then(function (r) { st.done = r; step(); })
        .catch(function (e) { st.confirmError = e.message; st.focus = '.card h2'; draw(); });
    }
    if (/^#[0-9a-f]{6}$/i.test(info.business.color || '')) brandColors(info.business.color);
    document.title = (info.person ? t('Agenda con ', 'Book with ') + info.person : info.title || t('Agendar', 'Book')) + ' · ' + info.business.name;
    if (info.services.length === 1) pickService(info.services[0], true); else draw();
  }).catch(function (e) {
    app.replaceChildren(el('div', { class: 'card' }, el('h1', { text: t('Enlace no disponible', 'Link unavailable') }), el('p', { text: e.message })));
  });
})();
