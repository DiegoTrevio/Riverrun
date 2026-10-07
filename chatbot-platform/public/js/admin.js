import { api, check, field, fmtDate, h, run, select, state, text, toast } from './core.js';
import { accountPicker } from './dashboard.js';
import { render } from './main.js';
import { ROLE_LABEL, acct, isSuper } from './session.js';
import { refreshBell } from './shell.js';
import { usd } from './usage.js';

/* ------------------------------ Usuarios ------------------------------ */

export async function viewUsers(root) {
  const users = await api('GET', `/api/users${acct()}`);
  const n = { name: '', email: '', password: '', role: 'agent', phone: '', notify_whatsapp: false };
  const roles = [['agent', 'Operador · conversaciones y agenda de su perfil'], ['admin', 'Administrador · gestiona su perfil completo']];
  if (isSuper()) roles.push(['superadmin', 'Maestro · acceso a todos los perfiles']);
  const assignedProfile = h('div', {}, accountPicker(n));
  const me = state.me.user;
  root.append(
    h('h1', {}, 'Usuarios y permisos'),
    h('p', { class: 'muted' }, 'Cada usuario pertenece a un perfil de negocio y solo puede gestionar sus datos. El maestro tiene acceso a todos los perfiles.'),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Nuevo usuario'),
      h('div', { class: 'grid' },
        field('Nombre', text(n, 'name')),
        field('Correo', text(n, 'email', { placeholder: 'persona@empresa.com' })),
        field('Contraseña inicial', text(n, 'password', { type: 'password' }), 'Mínimo 8 caracteres. Pídele que la cambie al entrar.'),
        field('Rol', select(n, 'role', roles, () => { assignedProfile.hidden = n.role === 'superadmin'; })),
        field('WhatsApp para alertas (opcional)', text(n, 'phone', { placeholder: '5215512345678' }))),
      check(n, 'notify_whatsapp', 'Enviarle las alertas también por WhatsApp'),
      assignedProfile,
      h('button', { class: 'primary', onclick: async () => { if (await run(() => api('POST', '/api/users', n.role === 'superadmin' ? { ...n, account_id: null } : n), 'Usuario creado')) render(); } }, 'Crear usuario')),
    h('div', { class: 'card' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Usuario'), h('th', {}, 'Rol'), isSuper() ? h('th', {}, 'Perfil asignado') : null, h('th', {}, 'Último acceso'), h('th', {}, ''))),
        h('tbody', {}, users.map((u) => {
          const self = u.id === me.id;
          return h('tr', {},
            h('td', {}, h('strong', {}, u.name || '—'), h('div', { class: 'muted small' }, u.email, u.phone ? ` · 📱 +${u.phone}${u.notify_whatsapp ? ' (alertas)' : ''}` : ''), !u.active ? h('span', { class: 'badge orange' }, 'desactivado') : null),
            h('td', {}, u.role === 'superadmin' || self ? ROLE_LABEL[u.role]
              : h('select', { onchange: async (e) => { if (await run(() => api('PUT', `/api/users/${u.id}`, { role: e.target.value }), 'Rol actualizado')) render(); } },
                  [['agent', 'Operador del perfil'], ['admin', 'Administrador del perfil']].map(([v, l]) => h('option', { value: v, selected: u.role === v }, l)))),
            isSuper() ? h('td', { class: 'small' }, u.role === 'superadmin' ? 'Todos los perfiles' : h('select', { 'aria-label': `Perfil de ${u.email}`, onchange: async (e) => { if (await run(() => api('PUT', `/api/users/${u.id}`, { account_id: e.target.value }), 'Perfil asignado')) render(); else e.target.value = u.account_id; } }, state.accounts.map((a) => h('option', { value: a.id, selected: u.account_id === a.id }, a.name)))) : null,
            h('td', { class: 'small muted' }, u.last_login_at ? fmtDate(u.last_login_at) : 'nunca'),
            h('td', {}, self ? h('span', { class: 'muted small' }, 'tú') : h('div', { class: 'row' },
              isSuper() && u.role !== 'superadmin' ? h('button', { class: 'small', onclick: async () => { if (confirm(`¿Dar a ${u.email} acceso maestro a TODOS los perfiles?`)) { await run(() => api('PUT', `/api/users/${u.id}`, { role: 'superadmin' }), 'Acceso maestro asignado'); render(); } } }, 'Dar acceso maestro') : null,
              h('button', { class: 'small', onclick: async () => { if (await run(() => api('PUT', `/api/users/${u.id}`, { active: !u.active }), u.active ? 'Desactivado' : 'Activado')) render(); } }, u.active ? 'Desactivar' : 'Activar'),
              h('button', { class: 'small', onclick: async () => { const pw = prompt('Nueva contraseña (mínimo 8 caracteres)'); if (pw) await run(() => api('PUT', `/api/users/${u.id}`, { password: pw }), 'Contraseña actualizada'); } }, 'Restablecer contraseña'),
              h('button', { class: 'small', onclick: async () => {
                const phone = prompt('WhatsApp para alertas (con lada; vacío para quitar)', u.phone || '');
                if (phone !== null && (await run(() => api('PUT', `/api/users/${u.id}`, { phone, notify_whatsapp: !!phone.replace(/\D/g, '') }), 'Actualizado'))) render();
              } }, 'Alertas WhatsApp'),
              h('button', { class: 'small danger', onclick: async () => { if (confirm(`¿Eliminar a ${u.email}?`)) { await run(() => api('DELETE', `/api/users/${u.id}`), 'Eliminado'); render(); } } }, 'Eliminar'))));
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
      h('h3', {}, 'Nuevo perfil'),
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
        h('thead', {}, h('tr', {}, h('th', {}, 'Perfil'), h('th', {}, 'Estado'), h('th', {}, 'WhatsApp'), h('th', { class: 'num' }, 'Conversaciones (mes / total)'), h('th', { class: 'num' }, 'IA (mes)'), h('th', {}, 'Última actividad'), h('th', {}, ''))),
        h('tbody', {}, accounts.map((a) => h('tr', {},
          h('td', {}, h('strong', {}, a.name),
            a.owner_email ? h('div', { class: 'small muted' }, a.owner_email, a.owner_verified === false ? ' (sin confirmar)' : '') : null,
            h('div', { class: 'small muted' }, `${a.chatbots} bots · ${a.channels} canales · ${a.users} usuarios${a.signup_source === 'signup' ? ' · registro propio' : ''}`)),
          h('td', {}, statusBadge(a)),
          h('td', {}, a.whatsapp_state ? h('span', { class: `badge ${a.whatsapp_state === 'open' ? 'green' : 'orange'}` }, { open: 'conectado', close: 'desconectado', connecting: 'conectando' }[a.whatsapp_state] || a.whatsapp_state) : h('span', { class: 'muted small' }, '—')),
          h('td', { class: 'num' }, `${a.conversations_month} / ${a.conversations}`),
          h('td', { class: 'num' }, usd(a.ai_cost_month)),
          h('td', { class: 'small' }, a.last_activity_at ? fmtDate(a.last_activity_at) : '—'),
          h('td', {}, h('div', { class: 'row' },
            h('button', { class: 'small', onclick: () => { state.accountId = a.id; try { localStorage.setItem('cp-account', a.id); } catch { /* */ } location.hash = '#/'; } }, 'Abrir perfil'),
            h('a', { class: 'btn small', href: '#/users', onclick: () => { state.accountId = a.id; try { localStorage.setItem('cp-account', a.id); } catch { /* */ } if (location.hash === '#/users') render(); } }, 'Usuarios'),
            a.status !== 'active' ? h('button', { class: 'small primary', onclick: async () => {
              const plan = prompt('Plan contratado (opcional)', a.plan || '');
              if (plan === null) return;
              await run(() => api('PUT', `/api/accounts/${a.id}`, { status: 'active', plan }), 'Cuenta activada');
              render();
            } }, 'Activar plan') : h('button', { class: 'small', onclick: async () => {
              if (!confirm(`¿Pausar "${a.name}"? Su asistente deja de responder, pero pueden entrar al panel.`)) return;
              await run(() => api('PUT', `/api/accounts/${a.id}`, { status: 'paused' }), 'Cuenta en pausa');
              render();
            } }, 'Pausar'),
            a.status !== 'active' ? h('button', { class: 'small', onclick: async () => {
              const d = Number(prompt('¿Cuántos días más de prueba?', '7'));
              if (d > 0) { await run(() => api('PUT', `/api/accounts/${a.id}`, { extend_trial_days: d }), 'Prueba extendida'); render(); }
            } }, 'Extender prueba') : null,
            h('button', { class: 'small', title: 'Excepción de límites para este perfil (sobre su plan)', onclick: async () => {
              const keys = { mensajes: 'messages_per_month', canales: 'channels', usuarios: 'users', asistentes: 'chatbots' };
              const cur = Object.entries(keys).filter(([, k]) => a.limits_override?.[k]).map(([n, k]) => `${n}=${a.limits_override[k]}`).join(' ');
              const txt = prompt('Límites especiales de este perfil (se aplican en lugar de los de su plan).\nFormato: mensajes=1000 canales=2 usuarios=5 asistentes=3\nDéjalo vacío para quitar la excepción y usar los de su plan.', cur);
              if (txt === null) return;
              const limits_override = {};
              for (const part of txt.split(/[\s,]+/).filter(Boolean)) {
                const [n, v] = part.split('=');
                if (!keys[n.toLowerCase()] || !(Number(v) > 0)) return toast(`No entendí "${part}". Usa, por ejemplo: mensajes=1000 canales=2`, true);
                limits_override[keys[n.toLowerCase()]] = Math.floor(Number(v));
              }
              await run(() => api('PUT', `/api/accounts/${a.id}`, { limits_override }), 'Límites actualizados'); render();
            } }, 'Límites'),
            h('button', { class: 'small', title: 'Marca blanca de esta cuenta', onclick: async () => {
              const { brands } = await api('GET', '/api/brands');
              if (!brands.length) return toast('Primero crea una marca en "Marca blanca"', true);
              const cur = brands.find((b) => b.id === a.brand_id);
              const txt = prompt(`Marca de "${a.name}". Escribe el nombre de una de estas, o déjalo vacío para usar la de la plataforma:\n${brands.map((b) => `• ${b.name}`).join('\n')}`, cur?.name || '');
              if (txt === null) return;
              const pick = brands.find((b) => b.name.toLowerCase() === txt.trim().toLowerCase());
              if (txt.trim() && !pick) return toast(`No existe la marca "${txt}"`, true);
              await run(() => api('PUT', `/api/accounts/${a.id}`, { brand_id: pick?.id ?? null }), 'Marca actualizada'); render();
            } }, 'Marca'),
            h('button', { class: 'small', onclick: async () => { const name = prompt('Nuevo nombre', a.name); if (name) { await run(() => api('PUT', `/api/accounts/${a.id}`, { name }), 'Actualizada'); state.me = null; render(); } } }, 'Renombrar'),
            h('button', { class: 'small', onclick: async () => {
              if (a.active && !confirm(`Al desactivar "${a.name}", sus usuarios no podrán entrar y sus canales dejarán de responder (los mensajes se siguen guardando). ¿Continuar?`)) return;
              await run(() => api('PUT', `/api/accounts/${a.id}`, { active: !a.active }), a.active ? 'Cuenta desactivada' : 'Cuenta activada');
              state.me = null;
              render();
            } }, a.active ? 'Desactivar' : 'Activar'),
            h('button', { class: 'small danger', onclick: async () => {
              if (prompt(`Esto borra TODO de "${a.name}" (chatbots, canales, usuarios y conversaciones). Escribe el nombre para confirmar`) === a.name) {
                await run(() => api('DELETE', `/api/accounts/${a.id}`), 'Cuenta eliminada');
                if (state.accountId === a.id) state.accountId = '';
                state.me = null;
                render();
              }
            } }, 'Eliminar')))))))),
  );
}

/* ------------------------------ Contraseña ------------------------------ */

export async function viewPassword(root) {
  const f = { current: '', password: '', confirm: '' };
  const me = { name: state.me.user.name, phone: state.me.user.phone || '', notify_whatsapp: !!state.me.user.notify_whatsapp };
  root.append(
    h('h1', {}, 'Mi perfil'),
    h('div', { class: 'card', style: 'max-width:420px' },
      field('Nombre', text(me, 'name')),
      field('WhatsApp para alertas', text(me, 'phone', { placeholder: '5215512345678' })),
      check(me, 'notify_whatsapp', 'Recibir las alertas del equipo por WhatsApp'),
      h('button', { onclick: async () => { const u = await run(() => api('PUT', '/api/me', me), 'Perfil guardado'); if (u) state.me.user = { ...state.me.user, ...u }; } }, 'Guardar perfil')),
    h('h2', {}, 'Cambiar contraseña'),
    h('div', { class: 'card', style: 'max-width:420px' },
      field('Contraseña actual', text(f, 'current', { type: 'password' })),
      field('Nueva contraseña', text(f, 'password', { type: 'password' }), 'Mínimo 8 caracteres. Se cerrarán tus otras sesiones abiertas.'),
      field('Repite la nueva contraseña', text(f, 'confirm', { type: 'password' })),
      h('button', { class: 'primary', onclick: async () => {
        if (f.password !== f.confirm) return toast('Las contraseñas no coinciden', true);
        if (await run(() => api('PUT', '/api/me/password', { current: f.current, password: f.password }), 'Contraseña actualizada')) render();
      } }, 'Guardar')),
  );
}

/* ============================== Automatización ============================== */

/** El superadmin debe elegir una cuenta para configurar automatización y agenda. */
export function needAccount(root) {
  if (!isSuper() || state.accountId) return false;
  root.append(h('div', { class: 'card' }, h('p', {}, 'Elige una cuenta en el selector del menú para configurar su automatización y agenda.')));
  return true;
}

/* ============================== Notificaciones ============================== */

export async function viewNotifications(root) {
  const data = await api('GET', '/api/notifications?limit=100');
  root.append(
    h('div', { class: 'row between' }, h('h1', {}, 'Notificaciones'),
      data.unread ? h('button', { onclick: async () => { await run(() => api('POST', '/api/notifications/read', {})); render(); } }, 'Marcar todas como leídas') : null),
    h('div', { class: 'card' },
      data.items.length ? h('table', {}, h('tbody', {}, data.items.map((n) => h('tr', { class: n.link ? 'click' : '', onclick: async () => {
        if (!n.read_at) await api('POST', '/api/notifications/read', { ids: [n.id] });
        if (n.link) location.hash = n.link.replace(/^#/, '#');
        else render();
      } },
        h('td', { style: 'width:10px' }, n.read_at ? '' : h('span', { class: 'badge red' }, '•')),
        h('td', {}, h('strong', {}, n.title), h('div', { class: 'small muted pre' }, n.body)),
        h('td', { class: 'small muted' }, fmtDate(n.created_at))))))
        : h('p', { class: 'muted' }, state.me.user.account_id ? 'Sin notificaciones.' : 'Las notificaciones llegan a los usuarios de cada cuenta.')),
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
