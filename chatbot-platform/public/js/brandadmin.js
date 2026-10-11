import { api, field, h, run, text, confirmAction } from './core.js';
import { render } from './main.js';

/* ------------------------------ Marca blanca (superadmin) ------------------------------ */

const readFile = (file) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(file); });

function brandForm(b, cname) {
  const f = { name: b.name || '', color: b.color || '', domain: b.domain || '', support_email: b.support_email || '' };
  let logo; // undefined = sin cambios, null = quitar, texto = nuevo
  const preview = h('div', { style: 'min-height:40px' }, b.logo ? h('img', { src: b.logo, style: 'height:40px' }) : h('span', { class: 'muted small' }, 'Sin logo'));
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', onchange: async (e) => {
    const x = e.target.files[0];
    if (!x) return;
    if (x.size > 256 * 1024) { e.target.value = ''; return run(() => { throw new Error('El logo pesa más de 256 KB'); }); }
    logo = await readFile(x);
    preview.replaceChildren(h('img', { src: logo, style: 'height:40px' }));
  } });
  const color = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : '#128c7e', oninput: (e) => { f.color = e.target.value; } });
  const save = async () => {
    const body = { name: f.name, color: f.color, domain: f.domain.trim() || null, support_email: f.support_email };
    if (logo !== undefined) body.logo = logo;
    if (!(await run(() => (b.id ? api('PUT', `/api/brands/${b.id}`, body) : api('POST', '/api/brands', body)), 'Guardada'))) return;
    render();
  };
  return h('div', { class: 'card' },
    h('h2', {}, b.id ? b.name : 'Nueva marca'),
    field('Nombre que verá el cliente', text(f, 'name')),
    field('Color principal', color),
    field('Logo (PNG, JPG o WebP, máx. 256 KB)', h('div', {}, preview, file, b.logo ? h('button', { class: 'small', onclick: () => { logo = null; preview.replaceChildren(h('span', { class: 'muted small' }, 'Sin logo')); } }, 'Quitar logo') : null)),
    field('Dominio propio (opcional)', text(f, 'domain', { placeholder: 'panel.miagencia.com' }), `El cliente crea un registro DNS (CNAME o A) de ese dominio hacia ${cname}. El certificado HTTPS se genera solo la primera vez que alguien lo visita.`),
    field('Correo de soporte', text(f, 'support_email', { placeholder: 'soporte@miagencia.com' })),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: save }, 'Guardar'),
      b.id ? h('button', { class: 'danger', onclick: async () => { if (await confirmAction(`¿Borrar la marca "${b.name}"? Sus cuentas vuelven a la marca de la plataforma.`)) { if (!(await run(() => api('DELETE', `/api/brands/${b.id}`), 'Borrada'))) return; render(); } } }, 'Borrar') : null),
    b.id ? h('p', { class: 'muted small' }, `${b.accounts} cuenta(s) usan esta marca. Asigna la marca a una cuenta desde "Cuentas" → Marca. Quien se registre desde el dominio de la marca queda con ella automáticamente.`) : null);
}

export async function viewBrands(root) {
  const { brands, cname_target } = await api('GET', '/api/brands');
  root.append(
    h('h1', {}, 'Marca blanca'),
    h('p', { class: 'muted' }, 'Para revender con tu propio nombre: cada marca cambia el nombre, el logo, el color y el remitente de los correos de las cuentas que la usan, y puede tener su propio dominio.'),
    ...brands.map((b) => brandForm(b, cname_target)),
    brandForm({}, cname_target));
}
