import { api, area, check, field, fill, fmtDate, h, run, select, settingsSection, state, text, toast, confirmAction, ask, dialog } from './core.js';

/** El título de un aviso sin el emoji con que llega también por WhatsApp (en el panel lo dice el texto). */
const plainTitle = (t) => String(t || '').replace(/^[\p{Extended_Pictographic}️‍\s]+/u, '');
import { accountPicker } from './dashboard.js';
import { render } from './main.js';
import { ROLE_LABEL, acct, isAdmin, isSuper, withAcct } from './session.js';
import { refreshBell } from './shell.js';
import { usd } from './usage.js';

/* ------------------------------ Mis avisos ------------------------------ */

const ALERT_CHANNELS = [['panel', 'Panel'], ['whatsapp', 'WhatsApp'], ['email', 'Correo']];

/**
 * Tabla «grupo × panel / WhatsApp / correo». prefs se modifica en el lugar y solo guarda lo que la persona cambia: lo que no
 * toca sigue como siempre (ver alert-groups en el servidor).
 */
function alertPrefsTable(groups, prefs, o = {}) {
  return h('div', { class: 'table-scroll' }, h('table', { class: 'alert-prefs' },
    h('caption', { class: 'sr-only' }, 'Por dónde te llega cada tipo de aviso'),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Aviso'), ALERT_CHANNELS.map(([, l]) => h('th', { scope: 'col' }, l)))),
    h('tbody', {}, groups.map((g) => h('tr', {},
      h('th', { scope: 'row' }, h('strong', {}, g.label), h('div', { class: 'small muted' }, g.hint)),
      ALERT_CHANNELS.map(([c, l]) => {
        const locked = c === 'panel' && g.panel_locked;
        const noPhone = c === 'whatsapp' && o.noPhone;
        const chosen = prefs[g.key]?.[c];
        // «Solo lo urgente»: sin elección propia, de este grupo salen por correo solo algunos avisos (p. ej. los
        // recordatorios, no el primer aviso). Se muestra a medias y con su texto, para no aparentar «todo» o «nada».
        const urgent = chosen === undefined && g.defaults[c] === 'urgent';
        const note = urgent ? h('div', { class: 'small muted' }, 'solo urgentes') : null;
        const input = h('input', {
          type: 'checkbox', checked: locked || (!noPhone && (chosen ?? g.defaults[c] === true)), disabled: locked || noPhone,
          'aria-label': `${g.label}: ${l}${urgent ? ' (solo lo urgente)' : ''}`,
          'aria-describedby': locked ? 'alert-note-panel' : noPhone ? 'alert-note-whatsapp' : null,
          onchange: (e) => { prefs[g.key] = { ...(prefs[g.key] || {}), [c]: e.target.checked }; e.target.indeterminate = false; note?.remove(); },
        });
        if (urgent) input.indeterminate = true;
        return h('td', {}, input, note);
      }))))),
    h('p', { id: 'alert-note-panel', class: 'small muted' }, 'Errores y emergencias siempre llegan al panel.'),
    o.noPhone ? h('p', { id: 'alert-note-whatsapp', class: 'small muted' }, 'WhatsApp: agrega un número para alertas y activa «Recibir las alertas del equipo por WhatsApp».') : null);
}

/** El administrador ajusta los avisos de una persona de su equipo. */
async function editMemberAlerts(u) {
  const groups = await api('GET', '/api/alert-groups');
  const prefs = structuredClone(u.alert_prefs || {});
  const body = h('div', {},
    h('p', { class: 'small muted' }, u.phone && u.notify_whatsapp ? `Su WhatsApp para alertas: +${u.phone}.` : 'No tiene WhatsApp para alertas activado: esos avisos solo le llegan en el panel y por correo.'),
    alertPrefsTable(groups, prefs, { noPhone: !(u.phone && u.notify_whatsapp) }));
  if (!(await dialog(`Avisos de ${u.name || u.email}`, body, 'Guardar'))) return;
  if (await run(() => api('PUT', `/api/users/${u.id}`, { alert_prefs: prefs }), 'Avisos guardados')) render();
}

/* ------------------------------ Usuarios ------------------------------ */

/** Invitar por correo: la persona elige su contraseña (o entra con Google) y se une sola a la cuenta. */
async function inviteCard() {
  // El superadmin invita a la cuenta que tenga elegida.
  if (isSuper() && !acct()) return null;
  const pending = await api('GET', withAcct('/api/invitations'));
  const inv = { email: '', name: '', role: 'agent' };
  const send = async (e) => {
    e.preventDefault();
    if (await run(() => api('POST', withAcct('/api/invitations'), inv), `Invitación enviada a ${inv.email}`)) render();
  };
  return h('section', { class: 'card', 'aria-labelledby': 'invite-title' },
    h('h2', { id: 'invite-title', style: 'margin-top:0' }, 'Invitar a tu equipo'),
    h('p', { class: 'muted small' }, 'Le llega un correo con un enlace para unirse: elige su propia contraseña o entra con Google. El enlace vence en 7 días.'),
    h('form', { onsubmit: send },
      h('div', { class: 'grid' },
        field('Correo', text(inv, 'email', { type: 'email', required: true, autocomplete: 'off', placeholder: 'persona@empresa.com' })),
        field('Nombre (opcional)', text(inv, 'name', { autocomplete: 'off' })),
        field('Rol', select(inv, 'role', [['agent', 'Operador · conversaciones y agenda'], ['admin', 'Administrador · gestiona todo el perfil']]))),
      h('button', { class: 'primary', type: 'submit' }, 'Enviar invitación')),
    pending.length ? [
      h('h3', {}, 'Invitaciones pendientes'),
      h('ul', { class: 'plain' }, pending.map((p) => h('li', { class: 'row', style: 'justify-content:space-between;flex-wrap:wrap;gap:8px' },
        h('span', {}, h('strong', {}, p.email), ` · ${ROLE_LABEL[p.role]} · `, p.expired ? h('span', { class: 'badge orange' }, 'vencida') : h('span', { class: 'muted small' }, `vence ${fmtDate(p.expires_at)}`)),
        h('span', { class: 'row' },
          h('button', { class: 'small', 'aria-label': `Reenviar invitación a ${p.email}`, onclick: async () => { if (await run(() => api('POST', withAcct(`/api/invitations/${p.id}/resend`)), 'Invitación reenviada')) render(); } }, 'Reenviar'),
          h('button', { class: 'small danger', 'aria-label': `Cancelar invitación a ${p.email}`, onclick: async () => { if (await confirmAction(`¿Cancelar la invitación a ${p.email}?`) && (await run(() => api('DELETE', withAcct(`/api/invitations/${p.id}`)), 'Invitación cancelada'))) render(); } }, 'Cancelar'))))),
    ] : null);
}

export async function viewUsers(root) {
  const [users, invite] = await Promise.all([api('GET', `/api/users${acct()}`), inviteCard()]);
  const n = { name: '', email: '', password: '', role: 'agent', phone: '', notify_whatsapp: false };
  const roles = [['agent', 'Operador · conversaciones y agenda de su perfil'], ['admin', 'Administrador · gestiona su perfil completo']];
  if (isSuper()) roles.push(['superadmin', 'Maestro · acceso a todos los perfiles']);
  const assignedProfile = h('div', {}, accountPicker(n));
  const me = state.me.user;
  root.append(
    h('h1', {}, 'Usuarios y permisos'),
    h('p', { class: 'muted' }, 'Cada usuario pertenece a un perfil de negocio y solo puede gestionar sus datos. El maestro tiene acceso a todos los perfiles.'),
    invite,
    h('details', { class: 'card', open: !invite },
      h('summary', {}, h('strong', {}, invite ? 'Crear usuario con contraseña inicial' : 'Nuevo usuario')),
      h('div', { class: 'grid' },
        field('Nombre', text(n, 'name')),
        field('Correo', text(n, 'email', { type: 'email', autocomplete: 'off', placeholder: 'persona@empresa.com' })),
        field('Contraseña inicial', text(n, 'password', { type: 'password', autocomplete: 'new-password', minlength: 8 }), 'Mínimo 8 caracteres. Pídele que la cambie al entrar.'),
        field('Rol', select(n, 'role', roles, () => { assignedProfile.hidden = n.role === 'superadmin'; })),
        field('WhatsApp para alertas (opcional)', text(n, 'phone', { placeholder: '5215512345678' }))),
      check(n, 'notify_whatsapp', 'Enviarle las alertas también por WhatsApp'),
      assignedProfile,
      h('button', { class: 'primary', onclick: async () => { if (await run(() => api('POST', '/api/users', n.role === 'superadmin' ? { ...n, account_id: null } : n), 'Usuario creado')) render(); } }, 'Crear usuario')),
    h('div', { class: 'card' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Usuario'), h('th', {}, 'Rol'), isSuper() ? h('th', {}, 'Perfil asignado') : null, h('th', {}, 'Último acceso'), h('th', {}, 'Acciones'))),
        h('tbody', {}, users.map((u) => {
          const self = u.id === me.id;
          return h('tr', {},
            h('td', {}, h('strong', {}, u.name || '—'), h('div', { class: 'muted small' }, u.email, u.phone ? ` · WhatsApp +${u.phone}${u.notify_whatsapp ? ' (alertas)' : ''}` : ''), !u.active ? h('span', { class: 'badge orange' }, 'desactivado') : null, u.active && u.role !== 'superadmin' && u.available === false ? h('span', { class: 'badge' }, 'no disponible para turnos') : null),
            h('td', {}, u.role === 'superadmin' || self ? ROLE_LABEL[u.role]
              : h('select', { 'aria-label': `Rol de ${u.email}`, onchange: async (e) => { if (await run(() => api('PUT', `/api/users/${u.id}`, { role: e.target.value }), 'Rol actualizado')) render(); } },
                  [['agent', 'Operador del perfil'], ['admin', 'Administrador del perfil']].map(([v, l]) => h('option', { value: v, selected: u.role === v }, l)))),
            isSuper() ? h('td', { class: 'small' }, u.role === 'superadmin' ? 'Todos los perfiles' : h('select', { 'aria-label': `Perfil de ${u.email}`, onchange: async (e) => { if (await run(() => api('PUT', `/api/users/${u.id}`, { account_id: e.target.value }), 'Perfil asignado')) render(); else e.target.value = u.account_id; } }, state.accounts.map((a) => h('option', { value: a.id, selected: u.account_id === a.id }, a.name)))) : null,
            h('td', { class: 'small muted' }, u.last_login_at ? fmtDate(u.last_login_at) : 'nunca'),
            h('td', {}, self ? h('span', { class: 'muted small' }, 'tú') : h('div', { class: 'row' },
              isSuper() && u.role !== 'superadmin' ? h('button', { class: 'small', onclick: async () => { if (await confirmAction(`¿Dar a ${u.email} acceso maestro a TODOS los perfiles?`)) { if (!(await run(() => api('PUT', `/api/users/${u.id}`, { role: 'superadmin' }), 'Acceso maestro asignado'))) return; render(); } } }, 'Dar acceso maestro') : null,
              u.role !== 'superadmin' && u.active ? h('button', { class: 'small', title: 'Si no está disponible se salta en el reparto por turnos', onclick: async () => { if (await run(() => api('PUT', `/api/users/${u.id}`, { available: u.available === false }), u.available === false ? 'Disponible' : 'Fuera de turno')) render(); } }, u.available === false ? 'Marcar disponible' : 'Fuera de turno') : null,
              h('button', { class: 'small', onclick: async () => { if (await run(() => api('PUT', `/api/users/${u.id}`, { active: !u.active }), u.active ? 'Desactivado' : 'Activado')) render(); } }, u.active ? 'Desactivar' : 'Activar'),
              h('button', { class: 'small', onclick: async () => { const pw = await ask('Nueva contraseña (mínimo 8 caracteres)', '', { type: 'password', minlength: 8, required: true }); if (pw) if (!(await run(() => api('PUT', `/api/users/${u.id}`, { password: pw }), 'Contraseña actualizada'))) return; } }, 'Restablecer contraseña'),
              h('button', { class: 'small', onclick: async () => {
                const phone = await ask('WhatsApp para alertas (con lada; vacío para quitar)', u.phone || '');
                if (phone !== null && (await run(() => api('PUT', `/api/users/${u.id}`, { phone, notify_whatsapp: !!phone.replace(/\D/g, '') }), 'Actualizado'))) render();
              } }, 'Alertas WhatsApp'),
              u.role !== 'superadmin' ? h('button', { class: 'small', 'aria-label': `Avisos de ${u.email}`, onclick: () => editMemberAlerts(u) }, 'Avisos') : null,
              h('button', { class: 'small danger', onclick: async () => { if (await confirmAction(`¿Eliminar a ${u.email}?`)) { if (!(await run(() => api('DELETE', `/api/users/${u.id}`), 'Eliminado'))) return; render(); } } }, 'Eliminar'))));
        })))),
  );
}

/* ------------------------------ Cuentas ------------------------------ */

export async function viewAccounts(root) {
  const accounts = await api('GET', '/api/accounts');
  state.accounts = accounts;
  const n = { name: '', withAdmin: true, admin: { name: '', email: '', password: '' } };
  const adminBox = h('div', {},
    h('div', { class: 'grid' },
      field('Nombre del administrador', text(n.admin, 'name')),
      field('Correo', text(n.admin, 'email', { placeholder: 'dueño@cliente.com' })),
      field('Contraseña inicial', text(n.admin, 'password', { type: 'password' }), 'Mínimo 8 caracteres.')));
  root.append(
    h('h1', {}, 'Perfiles de negocio'),
    h('div', { class: 'card' },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Cada perfil funciona como una subcuenta: tiene sus propios usuarios, asistentes, canales, conversaciones y agenda. Sus usuarios solo gestionan ese perfil; el maestro puede abrirlos todos.'),
      h('h2', {}, 'Nuevo perfil'),
      field('Nombre del cliente', text(n, 'name', { placeholder: 'Hotel Las Palmas' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { n.withAdmin = e.target.checked; adminBox.hidden = !n.withAdmin; } }), 'Crear también su primer administrador'),
      adminBox,
      h('button', { class: 'primary', onclick: async () => {
        const body = { name: n.name, ...(n.withAdmin ? { admin: n.admin } : {}) };
        const acc = await run(() => api('POST', '/api/accounts', body), 'Cuenta creada');
        if (acc) { state.accountId = acc.id; try { localStorage.setItem('cp-account', acc.id); } catch { /* */ } state.me = null; render(); }
      } }, 'Crear perfil')),
    h('div', { class: 'card' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Perfil'), h('th', {}, 'Estado'), h('th', {}, 'WhatsApp'), h('th', { class: 'num' }, 'Conversaciones (mes / total)'), h('th', { class: 'num' }, 'IA (mes)'), h('th', {}, 'Última actividad'), h('th', {}, 'Acciones'))),
        h('tbody', {}, accounts.map((a) => h('tr', {},
          h('td', {}, h('strong', {}, a.name),
            a.owner_email ? h('div', { class: 'small muted' }, a.owner_email, a.owner_verified === false ? ' (sin confirmar)' : '') : null,
            h('div', { class: 'small muted' }, `${a.chatbots} bots · ${a.channels} canales · ${a.users} usuarios${a.signup_source === 'signup' ? ' · registro propio' : ''}`)),
          h('td', {}, statusBadge(a),
            // Retención: cuándo se borra sola una cuenta en pausa, y la excepción del superadmin.
            a.deletion_date ? h('div', { class: 'small error' }, `Se borra el ${fmtDate(a.deletion_date)}`) : null,
            a.status === 'paused' && a.paused_at && a.signup_source === 'signup'
              ? h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: !!a.keep_data, onchange: async (e) => {
                if (!(await run(() => api('PUT', `/api/accounts/${a.id}`, { keep_data: e.target.checked }), e.target.checked ? 'Sus datos se conservan' : 'Se borrará al cumplir el plazo'))) { e.target.checked = !e.target.checked; return; }
                render();
              } }), 'Conservar sus datos')
              : null,
            // El Copiloto se enciende cuenta por cuenta.
            h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: !!a.copilot_enabled, 'aria-label': `Copiloto para ${a.name}`, onchange: async (e) => {
              if (!(await run(() => api('PUT', `/api/accounts/${a.id}`, { copilot_enabled: e.target.checked }), e.target.checked ? 'Copiloto encendido' : 'Copiloto apagado'))) { e.target.checked = !e.target.checked; return; }
              render();
            } }), 'Copiloto')),
          h('td', {}, a.whatsapp_state ? h('span', { class: `badge ${a.whatsapp_state === 'open' ? 'green' : 'orange'}` }, { open: 'conectado', close: 'desconectado', connecting: 'conectando' }[a.whatsapp_state] || a.whatsapp_state) : h('span', { class: 'muted small' }, '—')),
          h('td', { class: 'num' }, `${a.conversations_month} / ${a.conversations}`),
          h('td', { class: 'num' }, usd(a.ai_cost_month)),
          h('td', { class: 'small' }, a.last_activity_at ? fmtDate(a.last_activity_at) : '—'),
          h('td', {}, h('div', { class: 'row' },
            h('button', { class: 'small', onclick: () => { state.accountId = a.id; try { localStorage.setItem('cp-account', a.id); } catch { /* */ } location.hash = '#/'; } }, 'Abrir perfil'),
            h('a', { class: 'btn small', href: '#/users', onclick: () => { state.accountId = a.id; try { localStorage.setItem('cp-account', a.id); } catch { /* */ } if (location.hash === '#/users') render(); } }, 'Usuarios'),
            a.status !== 'active' ? h('button', { class: 'small primary', onclick: async () => {
              const plan = await ask('Plan contratado (opcional)', a.plan || '');
              if (plan === null) return;
              if (!(await run(() => api('PUT', `/api/accounts/${a.id}`, { status: 'active', plan }), 'Cuenta activada'))) return;
              render();
            } }, 'Activar plan') : h('button', { class: 'small', onclick: async () => {
              if (!await confirmAction(`¿Pausar "${a.name}"? Su asistente deja de responder, pero pueden entrar al panel.`)) return;
              if (!(await run(() => api('PUT', `/api/accounts/${a.id}`, { status: 'paused' }), 'Cuenta en pausa'))) return;
              render();
            } }, 'Pausar'),
            a.status !== 'active' ? h('button', { class: 'small', onclick: async () => {
              const d = Number(await ask('¿Cuántos días más de prueba?', '7'));
              if (d > 0) { if (!(await run(() => api('PUT', `/api/accounts/${a.id}`, { extend_trial_days: d }), 'Prueba extendida'))) return; render(); }
            } }, 'Extender prueba') : null,
            h('button', { class: 'small', title: 'Excepción de límites para este perfil (sobre su plan)', onclick: async () => {
              const keys = { mensajes: 'messages_per_month', canales: 'channels', usuarios: 'users', asistentes: 'chatbots', redes: 'social_accounts' };
              const cur = Object.entries(keys).filter(([, k]) => a.limits_override?.[k]).map(([n, k]) => `${n}=${a.limits_override[k]}`).join(' ');
              const txt = await ask('Límites especiales de este perfil (se aplican en lugar de los de su plan).\nFormato: mensajes=1000 canales=2 usuarios=5 asistentes=3 redes=2\nDéjalo vacío para quitar la excepción y usar los de su plan.', cur);
              if (txt === null) return;
              const limits_override = {};
              for (const part of txt.split(/[\s,]+/).filter(Boolean)) {
                const [n, v] = part.split('=');
                if (!keys[n.toLowerCase()] || !(Number(v) > 0)) return toast(`No entendí "${part}". Usa, por ejemplo: mensajes=1000 canales=2`, true);
                limits_override[keys[n.toLowerCase()]] = Math.floor(Number(v));
              }
              if (!(await run(() => api('PUT', `/api/accounts/${a.id}`, { limits_override }), 'Límites actualizados'))) return; render();
            } }, 'Límites'),
            h('button', { class: 'small', title: 'Marca blanca de esta cuenta', onclick: async () => {
              const { brands } = await api('GET', '/api/brands');
              if (!brands.length) return toast('Primero crea una marca en "Marca blanca"', true);
              const cur = brands.find((b) => b.id === a.brand_id);
              const txt = await ask(`Marca de "${a.name}". Escribe el nombre de una de estas, o déjalo vacío para usar la de la plataforma:\n${brands.map((b) => `• ${b.name}`).join('\n')}`, cur?.name || '');
              if (txt === null) return;
              const pick = brands.find((b) => b.name.toLowerCase() === txt.trim().toLowerCase());
              if (txt.trim() && !pick) return toast(`No existe la marca "${txt}"`, true);
              if (!(await run(() => api('PUT', `/api/accounts/${a.id}`, { brand_id: pick?.id ?? null }), 'Marca actualizada'))) return; render();
            } }, 'Marca'),
            h('button', { class: 'small', onclick: async () => { const name = await ask('Nuevo nombre', a.name); if (name) { if (!(await run(() => api('PUT', `/api/accounts/${a.id}`, { name }), 'Actualizada'))) return; state.me = null; render(); } } }, 'Renombrar'),
            h('button', { class: 'small', onclick: async () => {
              if (a.active && !await confirmAction(`Al desactivar "${a.name}", sus usuarios no podrán entrar y sus canales dejarán de responder (los mensajes se siguen guardando). ¿Continuar?`)) return;
              if (!(await run(() => api('PUT', `/api/accounts/${a.id}`, { active: !a.active }), a.active ? 'Cuenta desactivada' : 'Cuenta activada'))) return;
              state.me = null;
              render();
            } }, a.active ? 'Desactivar' : 'Activar'),
            h('button', { class: 'small danger', onclick: async () => {
              if (await ask(`Esto borra TODO de "${a.name}" (chatbots, canales, usuarios y conversaciones). Escribe el nombre para confirmar`) === a.name) {
                if (!(await run(() => api('DELETE', `/api/accounts/${a.id}`), 'Cuenta eliminada'))) return;
                if (state.accountId === a.id) state.accountId = '';
                state.me = null;
                render();
              }
            } }, 'Eliminar')))))))),
  );
}

/* ------------------------------ Contraseña ------------------------------ */

const VIA = { password: 'con contraseña', google: 'con Google', invite: 'al aceptar una invitación', signup: 'al registrarse', password_change: 'al cambiar la contraseña' };

/** Mi perfil → dónde está abierta tu cuenta: cerrar una sesión o todas las demás (p. ej. si perdiste un teléfono). */
function sessionsCard() {
  // Va dentro de su sección de Mi perfil: la explicación está en la columna de la izquierda.
  const box = h('div', { class: 'stack' }, h('p', { class: 'help', role: 'status' }, 'Cargando sesiones…'));
  const draw = async () => {
    const d = await api('GET', '/api/me/sessions').catch((e) => ({ error: e.message }));
    if (d.error) return fill(box, h('p', { class: 'error' }, d.error));
    const others = d.sessions.filter((s) => !s.current);
    fill(box,
      d.sessions.length ? h('table', { class: 'responsive-table' },
        h('thead', {}, h('tr', {}, ...['Dispositivo', 'Último uso', 'Inició', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, ...d.sessions.map((s) => h('tr', {},
          h('td', { 'data-label': 'Dispositivo' }, h('strong', {}, s.device), s.current ? h('span', { class: 'badge green', style: 'margin-left:6px' }, 'Esta sesión') : null, h('div', { class: 'small muted' }, `${s.ip} · ${VIA[s.via] || s.via}`)),
          h('td', { 'data-label': 'Último uso' }, fmtDate(s.last_seen_at)),
          h('td', { 'data-label': 'Inició' }, fmtDate(s.created_at)),
          h('td', {}, h('button', { class: 'small', 'aria-label': `Cerrar la sesión de ${s.device}${s.current ? ' (esta sesión)' : ''}`, onclick: async () => {
            if (s.current && !(await dialog('Cerrar esta sesión', h('p', {}, 'Saldrás del panel en este dispositivo.'), 'Cerrar sesión'))) return;
            const r = await run(() => api('DELETE', `/api/me/sessions/${s.id}`), 'Sesión cerrada');
            if (r?.current) location.reload(); else if (r) draw();
          } }, 'Cerrar')))))) : h('p', { class: 'muted' }, 'No hay sesiones registradas.'),
      d.legacy ? h('p', { class: 'small muted' }, 'Esta sesión se abrió antes de registrar sesiones: no aparece en la lista y vence sola. Para que aparezca, sal y vuelve a entrar.') : null,
      others.length ? h('button', { class: 'danger', onclick: async () => {
        if (!(await dialog('Cerrar las demás sesiones', h('p', {}, `Se cerrarán ${others.length} ${others.length === 1 ? 'sesión' : 'sesiones'} en otros dispositivos. Esta sigue abierta.`), 'Cerrar las demás'))) return;
        if (await run(() => api('POST', '/api/me/sessions/revoke-others'), 'Sesiones cerradas')) draw();
      } }, 'Cerrar sesión en todos los demás dispositivos') : null);
  };
  draw();
  return box;
}

export async function viewPassword(root) {
  const f = { current: '', password: '', confirm: '' };
  const me = { name: state.me.user.name, phone: state.me.user.phone || '', notify_whatsapp: !!state.me.user.notify_whatsapp, available: state.me.user.available !== false };
  // Los avisos son del equipo de una cuenta: el maestro sin cuenta no los recibe.
  const groups = state.me.user.account_id ? await api('GET', '/api/alert-groups').catch(() => null) : null;
  const prefs = structuredClone(state.me.user.alert_prefs || {});
  // Cada sección con su explicación a la izquierda y su propio «Guardar» abajo a la derecha de su panel.
  root.append(
    h('h1', {}, 'Mi perfil'),
    settingsSection('Tus datos', 'Tu nombre en el panel y el WhatsApp al que te llegan las alertas del equipo.',
      field('Nombre', text(me, 'name')),
      field('WhatsApp para alertas', text(me, 'phone', { placeholder: '5215512345678' })),
      check(me, 'notify_whatsapp', 'Recibir las alertas del equipo por WhatsApp'),
      state.me.user.account_id ? check(me, 'available', 'Estoy disponible: recibir conversaciones asignadas por turnos (desmárcalo si estás fuera de turno)') : null,
      // Al guardar se vuelve a dibujar: «Mis avisos» habilita la columna de WhatsApp en cuanto hay número.
      h('div', { class: 'settings-actions' }, h('button', { onclick: async () => { const u = await run(() => api('PUT', '/api/me', me), 'Perfil guardado'); if (u) { state.me.user = { ...state.me.user, ...u }; render(); } } }, 'Guardar perfil'))),
    groups ? settingsSection('Mis avisos', 'Elige por dónde te llega cada tipo de aviso. El WhatsApp necesita tu número de arriba con «Recibir las alertas del equipo por WhatsApp» activado. Lo que no cambies sigue como hasta ahora.',
      alertPrefsTable(groups, prefs, { noPhone: !(state.me.user.phone && state.me.user.notify_whatsapp) }),
      h('div', { class: 'settings-actions' }, h('button', { onclick: async () => { const u = await run(() => api('PUT', '/api/me', { alert_prefs: prefs }), 'Avisos guardados'); if (u) state.me.user = { ...state.me.user, ...u }; } }, 'Guardar avisos'))) : null,
    settingsSection('Sesiones abiertas', 'Dónde está abierta tu cuenta. Si no reconoces una, ciérrala y cambia tu contraseña.', sessionsCard()),
    settingsSection('Cambiar contraseña', 'La que usas para entrar al panel con tu correo.',
      field('Contraseña actual', text(f, 'current', { type: 'password' })),
      field('Nueva contraseña', text(f, 'password', { type: 'password' }), 'Mínimo 8 caracteres. Se cerrarán tus otras sesiones abiertas.'),
      field('Repite la nueva contraseña', text(f, 'confirm', { type: 'password' })),
      h('div', { class: 'settings-actions' }, h('button', { class: 'primary', onclick: async () => {
        if (f.password !== f.confirm) return toast('Las contraseñas no coinciden', true);
        if (await run(() => api('PUT', '/api/me/password', { current: f.current, password: f.password }), 'Contraseña actualizada')) render();
      } }, 'Guardar'))),
  );
}

/* ============================== Automatización ============================== */

/** El superadmin debe elegir una cuenta para configurar automatización y agenda. */
export function needAccount(root) {
  if (!isSuper() || state.accountId) return false;
  const choice = { account_id: state.accounts.find((a) => a.active)?.id || state.accounts[0]?.id || '' };
  root.append(h('div', { class: 'card' }, h('h2', {}, '¿Qué perfil quieres gestionar?'), field('Perfil de negocio', select(choice, 'account_id', state.accounts.map((a) => [a.id, a.name]))), h('button', { class: 'primary', disabled: !choice.account_id, onclick: () => { state.accountId = choice.account_id; try { localStorage.setItem('cp-account', state.accountId); } catch { /* sin almacenamiento */ } render(); } }, 'Gestionar este perfil')));
  return true;
}

/* ============================== Notificaciones ============================== */

/** Aviso interno manual: a todo el equipo, a un rol, a personas o a quien toque por turnos. */
const CHANNEL_LABEL = { whatsapp: 'WhatsApp', email: 'Correo' };
const DELIVERY_LABEL = { sent: 'entregado', pending: 'reintentando', failed: 'no llegó', skipped: 'no se pudo enviar' };

/** Por dónde llegó un aviso: «WhatsApp: no llegó (motivo) · Correo: entregado (respaldo)». */
function deliveryLine(list) {
  if (!list?.length) return null;
  return h('div', { class: 'small', style: 'margin-top:4px' }, list.map((d, i) => h('span', {},
    i ? ' · ' : '',
    h('span', { class: d.status === 'sent' ? '' : 'error' }, `${CHANNEL_LABEL[d.channel] ?? d.channel}: ${DELIVERY_LABEL[d.status] ?? d.status}`),
    d.fallback ? ' (respaldo)' : '',
    d.error ? h('span', { class: 'muted' }, ` (${d.error})`) : '')));
}

/** Para el administrador: los avisos al equipo que no llegaron por WhatsApp o correo, con «Reintentar». */
async function failedDeliveriesCard() {
  const list = await api('GET', withAcct('/api/alert-deliveries?days=7')).catch(() => []);
  if (!list.length) return null;
  return h('section', { class: 'card', 'aria-labelledby': 'failed-deliveries' },
    h('h2', { id: 'failed-deliveries' }, `Avisos que no llegaron (7 días): ${list.length}`),
    h('p', { class: 'small muted' }, 'Cada aviso se reintenta solo varias veces y los urgentes salen también por el otro canal. Si sigue sin llegar, revisa el teléfono o el correo de la persona en ', h('a', { href: '#/users' }, 'Mi equipo'), '.'),
    h('div', { class: 'table-scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Para', 'Aviso', 'Canal', 'Motivo', 'Fecha', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, list.map((d) => h('tr', {},
        h('td', {}, d.user_name || d.destination),
        h('td', {}, plainTitle(d.title || '')),
        h('td', {}, `${CHANNEL_LABEL[d.channel] ?? d.channel} · ${d.destination}`),
        h('td', { class: 'small' }, d.last_error || DELIVERY_LABEL[d.status] || ''),
        h('td', { class: 'small muted' }, fmtDate(d.created_at)),
        h('td', {}, h('button', { 'aria-label': `Reintentar el aviso «${plainTitle(d.title || '')}» para ${d.user_name || d.destination} por ${CHANNEL_LABEL[d.channel] ?? d.channel}`, onclick: async () => {
          const r = await run(() => api('POST', withAcct(`/api/alert-deliveries/${d.id}/retry`), {}));
          if (!r) return;
          toast(r.status === 'sent' ? 'Listo: el aviso llegó' : 'Sigue sin llegar; se reintentará solo', r.status !== 'sent');
          render();
        } }, 'Reintentar'))))))));
}

async function noticeCard() {
  const users = (await api('GET', withAcct('/api/users')).catch(() => [])).filter((u) => u.account_id && u.active);
  const n = { title: '', body: '', to: 'all', round_robin: false, user_ids: [] };
  return h('details', { class: 'card' }, h('summary', {}, 'Enviar un aviso interno al equipo'),
    h('div', { style: 'margin-top:10px' },
      field('Título', text(n, 'title', { placeholder: 'Llegó un cliente importante' })),
      field('Mensaje', area(n, 'body')),
      field('Para', select(n, 'to', [['all', 'Todo el equipo'], ['admin', 'Administradores'], ['agent', 'Agentes'], ['people', 'Personas que elija']])),
      h('div', { class: 'row' }, users.map((u) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', onchange: (e) => { n.user_ids = e.target.checked ? [...n.user_ids, u.id] : n.user_ids.filter((x) => x !== u.id); } }), u.name || u.email, u.available === false ? ' (no disponible)' : ''))),
      check(n, 'round_robin', 'Enviarlo a una sola persona, por turnos (la siguiente disponible entre las elegidas)'),
      h('button', { class: 'primary', onclick: async () => {
        const body = { title: n.title, body: n.body, round_robin: n.round_robin, ...(withAcct('?').includes('account_id') ? { account_id: state.accountId } : {}) };
        if (n.to === 'admin' || n.to === 'agent') body.roles = [n.to];
        if (n.to === 'people') body.user_ids = n.user_ids;
        const r = await run(() => api('POST', '/api/notifications/send', body));
        if (r) { toast(`Aviso enviado a ${r.sent_to} persona(s)`); render(); }
      } }, 'Enviar aviso')));
}

export async function viewNotifications(root, params) {
  const group = params?.get?.('grupo') || '';
  const data = await api('GET', `/api/notifications?limit=100${group ? `&group=${encodeURIComponent(group)}` : ''}`);
  const filter = { group };
  root.append(
    h('div', { class: 'row between' }, h('h1', {}, 'Notificaciones'),
      data.unread ? h('button', { onclick: async () => { if (!(await run(() => api('POST', '/api/notifications/read', {})))) return; render(); } }, 'Marcar todas como leídas') : null),
    data.whatsapp_failing ? h('p', { class: 'banner warn', role: 'status' }, 'Tus últimos avisos por WhatsApp no llegaron. Revisa tu número (con lada de país) en ', h('a', { href: '#/password' }, 'Mi perfil'), '.') : null,
    isAdmin() && (state.me.user.account_id || state.accountId) ? await failedDeliveriesCard() : null,
    isAdmin() && (state.me.user.account_id || state.accountId) ? await noticeCard() : null,
    h('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px;align-items:flex-end' },
      // Enlaces y no una lista desplegable: cambiar de vista con el teclado no debe saltar de página a cada flecha.
      h('nav', { 'aria-label': 'Mostrar avisos por tipo', class: 'row', style: 'flex-wrap:wrap;gap:6px' },
        [['', 'Todos'], ...(data.groups || []).map((g) => [g.key, g.label])].map(([k, l]) =>
          h('a', { href: k ? `#/notifications?grupo=${k}` : '#/notifications', class: `chip${filter.group === k ? ' active' : ''}`, 'aria-current': filter.group === k ? 'page' : null }, l))),
      state.me.user.account_id ? h('a', { href: '#/password', class: 'small' }, 'Elegir por dónde me llega cada aviso') : null),
    h('div', { class: 'card' },
      data.items.length ? h('table', {}, h('tbody', {}, data.items.map((n) => h('tr', { class: n.link ? 'click' : '', onclick: async () => {
        if (!n.read_at) await api('POST', '/api/notifications/read', { ids: [n.id] });
        if (n.link) location.hash = n.link.replace(/^#/, '#');
        else render();
      } },
        h('td', { style: 'width:10px' }, n.read_at ? '' : h('span', { class: 'badge red' }, '•')),
        h('td', {}, h('strong', {}, plainTitle(n.title)), h('div', { class: 'small muted pre' }, n.body), deliveryLine(n.deliveries)),
        h('td', { class: 'small muted' }, fmtDate(n.created_at))))))
        : h('p', { class: 'muted' }, state.me.user.account_id ? (group ? 'Sin avisos de este tipo.' : 'Sin notificaciones.') : 'Las notificaciones llegan a los usuarios de cada cuenta.')),
  );
  refreshBell();
}

export function statusBadge(a) {
  if (a.active === false) return h('span', { class: 'badge red' }, 'desactivada');
  if (a.status === 'paused') return h('span', { class: 'badge red' }, 'en pausa');
  if (a.status === 'trial') {
    const days = a.trial_ends_at ? Math.ceil((new Date(a.trial_ends_at) - Date.now()) / 86400000) : null;
    return h('span', { class: `badge ${days !== null && days <= 3 ? 'orange' : ''}` }, days === null ? 'prueba' : `prueba · ${Math.max(0, days)} d`);
  }
  return h('span', { class: 'badge green' }, a.plan ? `activa · ${a.plan}` : 'activa');
}
