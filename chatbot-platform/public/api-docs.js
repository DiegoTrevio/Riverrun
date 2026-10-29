/* Documentación navegable de la API v1, generada de /api/v1/openapi.json (la misma especificación de Postman). */
(async () => {
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    n.append(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
    return n;
  };
  /** Texto con `código` y **negritas** (lo único que usa la descripción). */
  const rich = (s) => String(s ?? '').split(/(`[^`]+`|\*\*[^*]+\*\*)/).filter(Boolean).map((p) => (p.startsWith('`') ? el('code', {}, p.slice(1, -1)) : p.startsWith('**') ? el('strong', {}, p.slice(2, -2)) : p));
  const prose = (s) => {
    const out = []; let list = null;
    for (const line of String(s ?? '').split('\n')) {
      if (line.startsWith('- ')) { if (!list) out.push((list = el('ul', { class: 'intro' }))); list.append(el('li', {}, rich(line.slice(2)))); }
      else { list = null; if (line.trim()) out.push(el('p', {}, rich(line))); }
    }
    return out;
  };
  const copyable = (code, what) => {
    const btn = el('button', { type: 'button', 'aria-label': `Copiar ${what}`, onclick: async () => { try { await navigator.clipboard.writeText(code); btn.textContent = 'Copiado'; setTimeout(() => (btn.textContent = 'Copiar'), 1500); } catch { btn.textContent = 'Cópialo a mano'; } } }, 'Copiar');
    return el('div', { class: 'pre-wrap' }, el('pre', { tabindex: '0', 'aria-label': what }, code), btn);
  };

  let spec;
  try { spec = await (await fetch('/api/v1/openapi.json')).json(); }
  catch { document.getElementById('lead').textContent = 'No se pudo cargar la especificación. Recarga la página.'; return; }
  // La dirección del dominio donde se abrió (la de tu marca, si tienes una), como en el panel.
  const base = `${location.origin}/api/v1`;
  const byRef = (r) => { const [, , kind, name] = r.split('/'); return spec.components[kind][name]; };
  const resolve = (s) => (s && s.$ref ? resolve(byRef(s.$ref)) : s || {});
  const refName = (s) => (s && s.$ref ? s.$ref.split('/').pop() : '');

  const typeOf = (raw) => {
    const s = resolve(raw);
    if (raw && raw.$ref) return `objeto ${refName(raw)}`;
    if ('const' in s) return JSON.stringify(s.const);
    if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
    if (s.oneOf) return s.oneOf.map(typeOf).join(' o ');
    if (s.allOf) return 'objeto';
    const names = { string: 'texto', integer: 'entero', number: 'número', boolean: 'sí/no', object: 'objeto', array: 'lista', null: 'null' };
    const t = Array.isArray(s.type) ? s.type.map((x) => names[x] || x).join(' o ') : names[s.type] || s.type || 'valor';
    if (s.type === 'array') return `lista de ${typeOf(s.items)}`;
    return s.format ? `${t} (${s.format})` : t;
  };
  /** Propiedades de un esquema (resuelve $ref y allOf). */
  const propsOf = (raw) => {
    const s = resolve(raw);
    if (s.allOf) return s.allOf.map(propsOf).reduce((a, b) => ({ props: { ...a.props, ...b.props }, required: [...a.required, ...b.required] }), { props: {}, required: [] });
    return { props: s.properties || {}, required: s.required || [] };
  };
  const fieldsTable = (raw, caption, context = '') => {
    const { props, required } = propsOf(raw);
    const rows = Object.entries(props);
    if (!rows.length) return null;
    return el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': context ? `${caption}: ${context}` : caption }, el('table', {}, el('caption', { class: 'muted', style: 'text-align:left' }, caption),
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Campo'), el('th', { scope: 'col' }, 'Tipo'), el('th', { scope: 'col' }, 'Descripción'))),
      el('tbody', {}, rows.map(([k, v]) => el('tr', {},
        el('td', {}, el('code', {}, k), required.includes(k) ? el('span', { class: 'req' }, ' obligatorio') : null),
        el('td', {}, typeOf(v)),
        el('td', {}, rich(resolve(v).description || v.description || '')))))));
  };
  const curl = (method, path, op) => {
    const url = `${base}${path}`;
    const example = op.requestBody?.content?.['application/json']?.example;
    const lines = [`curl${method === 'get' ? '' : ` -X ${method.toUpperCase()}`} "${url}"`, '  -H "Authorization: Bearer TU_LLAVE"'];
    if (method !== 'get') {
      lines.push('  -H "Content-Type: application/json"', '  -H "Idempotency-Key: un-id-unico-de-la-operacion"');
      if (example) lines.push(`  -d '${JSON.stringify(example)}'`);
    }
    return lines.join(' \\\n');
  };
  const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const doc = document.getElementById('doc');
  // En el teléfono el índice va plegado para no tapar el contenido.
  const toc = el('div');
  document.getElementById('toc').append(el('details', { open: matchMedia('(min-width: 821px)').matches ? '' : null }, el('summary', {}, 'Contenido'), toc));
  document.getElementById('lead').textContent = 'Todo lo que puedes hacer con tu llave, con ejemplos para copiar.';
  doc.append(...prose(spec.info.description), el('div', { class: 'base' }, el('strong', {}, 'Dirección base:'), el('code', {}, base)), copyable(`curl ${base}/me -H "Authorization: Bearer TU_LLAVE"`, 'el comando para probar tu llave'));

  const tocList = el('ul');
  toc.append(el('h2', {}, 'Rutas'), tocList);
  for (const tag of spec.tags) {
    const id = `t-${slug(tag.name)}`;
    tocList.append(el('li', {}, el('a', { href: `#${id}` }, tag.name)));
    const section = el('section', { 'aria-labelledby': id }, el('h2', { class: 'section', id }, tag.name), el('p', { class: 'muted' }, tag.description));
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (!op.tags?.includes(tag.name)) continue;
        const opId = `${method}-${slug(path)}`;
        const params = (op.parameters || []).map((p) => (p.$ref ? byRef(p.$ref) : p));
        const reqSchema = op.requestBody?.content?.['application/json']?.schema;
        const okStatus = Object.keys(op.responses).find((c) => c.startsWith('2'));
        const okSchema = okStatus && op.responses[okStatus].content?.['application/json']?.schema;
        const listItem = okSchema && resolve(okSchema).properties?.data?.items;
        section.append(el('article', { class: 'op', id: opId, 'aria-labelledby': `${opId}-h` },
          el('div', { class: 'op-head' }, el('span', { class: `method m-${method}` }, method.toUpperCase()), el('h3', { id: `${opId}-h`, class: 'path' }, path)),
          el('p', {}, rich(op.summary)), op.description ? el('p', { class: 'muted' }, rich(op.description)) : null,
          params.length ? el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': `Parámetros de ${method.toUpperCase()} ${path}` }, el('table', {}, el('caption', { class: 'muted', style: 'text-align:left' }, 'Parámetros'),
            el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Nombre'), el('th', { scope: 'col' }, 'Dónde'), el('th', { scope: 'col' }, 'Tipo'), el('th', { scope: 'col' }, 'Descripción'))),
            el('tbody', {}, params.map((p) => el('tr', {}, el('td', {}, el('code', {}, p.name), p.required ? el('span', { class: 'req' }, ' obligatorio') : null), el('td', {}, { path: 'ruta', query: 'consulta', header: 'cabecera' }[p.in] || p.in), el('td', {}, typeOf(p.schema)), el('td', {}, rich(p.description)))))))
            : null,
          reqSchema ? fieldsTable(reqSchema, 'Cuerpo (JSON)', `${method.toUpperCase()} ${path}`) : null,
          copyable(curl(method, path, op), `el ejemplo de ${method.toUpperCase()} ${path}`),
          el('details', {}, el('summary', {}, 'Respuestas'),
            el('ul', {}, Object.entries(op.responses).map(([code, r]) => el('li', {}, el('code', {}, code), ' ', rich((r.$ref ? byRef(r.$ref) : r).description)))),
            listItem ? fieldsTable(listItem, 'Cada elemento de data', `${method.toUpperCase()} ${path}`) : okSchema ? fieldsTable(okSchema, 'Campos de la respuesta', `${method.toUpperCase()} ${path}`) : null)));
      }
    }
    doc.append(section);
  }

  // Webhooks: cabeceras, cómo verificar la firma y cada evento con sus datos.
  const hooks = Object.entries(spec.webhooks || {});
  const hookList = el('ul');
  toc.append(el('h2', {}, 'Webhooks'), el('ul', {}, el('li', {}, el('a', { href: '#webhooks' }, 'Cómo llegan y cómo verificarlos'))), hookList);
  const verifyNode = `import crypto from 'node:crypto';
// raw: el cuerpo tal como llegó (sin volver a serializar); header: x-riverrun-signature
export function verify(raw, header, secret, toleranceSec = 300) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false; // viejo: posible repetición
  const expected = crypto.createHmac('sha256', secret).update(\`\${t}.\${raw}\`).digest('hex');
  return v1.length === expected.length && crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}`;
  const verifyPy = `import hmac, hashlib, time
def verify(raw: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    if abs(time.time() - int(parts["t"])) > tolerance:
        return False  # viejo: posible repetición
    expected = hmac.new(secret.encode(), parts["t"].encode() + b"." + raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(parts["v1"], expected)`;
  const hookSection = el('section', { 'aria-labelledby': 'webhooks' },
    el('h2', { class: 'section', id: 'webhooks' }, 'Webhooks'),
    el('p', {}, 'Créalos en Integraciones: eliges la dirección y los eventos. Cada aviso es un POST con JSON: ', el('code', {}, '{ id, type, api_version, created_at, account_id, origin, data }'), '. El contacto, la cita y el cobro llegan con la misma forma que en la API.'),
    el('ul', { class: 'intro' },
      el('li', {}, rich('Cabeceras: `x-riverrun-event` (el tipo), `x-riverrun-delivery` (el id del evento), `x-riverrun-signature` y `x-signature` (la de antes, sin hora).')),
      el('li', {}, rich('Responde 2xx en menos de 10 s. Si no, se reintenta 6 veces en unas 8 h con el **mismo** `id`: úsalo para no procesar dos veces. Desde «Ver entregas» puedes reenviar cualquier evento de los últimos 30 días.')),
      el('li', {}, rich('`origin: "api"` quiere decir que lo provocó tu propio sistema por la API (ignóralo si no quieres responder a tu propio cambio).')),
      el('li', {}, rich('«Todos los eventos» incluye los de siempre; los de cobros, cotizaciones y reprogramar citas se eligen uno por uno.'))),
    el('h3', {}, 'Verificar la firma'), el('p', { class: 'muted' }, 'Con el secreto de webhooks de Integraciones, sobre el cuerpo crudo:'),
    copyable(verifyNode, 'el ejemplo en Node'), copyable(verifyPy, 'el ejemplo en Python'));
  for (const [type, item] of hooks) {
    const id = `w-${slug(type)}`;
    hookList.append(el('li', {}, el('a', { href: `#${id}` }, el('code', {}, type))));
    const schema = item.post.requestBody.content['application/json'].schema;
    hookSection.append(el('article', { class: 'op', id, 'aria-labelledby': `${id}-h` },
      el('div', { class: 'op-head' }, el('span', { class: 'method m-post' }, 'EVENTO'), el('h3', { id: `${id}-h`, class: 'path' }, type)),
      el('p', {}, item.post.summary),
      fieldsTable(schema.properties.data, 'Campos de data', type)));
  }
  doc.append(hookSection);

  // Errores: los códigos estables.
  const MEANING = {
    invalid_request: 'Datos inválidos: fields dice qué campo y por qué', invalid_phone: 'El teléfono no parece un teléfono (falta la lada de país)', channel_required: 'Tienes varios WhatsApp: indica channel_id (vienen en channels)',
    no_whatsapp_channel: 'La cuenta no tiene un WhatsApp activo', invalid_channel: 'channel_id no es un WhatsApp de tu cuenta', not_found: 'No existe en tu cuenta (o el id no es un uuid)', route_not_found: 'Esa ruta no existe',
    missing_key: 'Falta Authorization: Bearer rr_…', invalid_key: 'La llave no existe o se revocó', read_only_key: 'La llave es de solo lectura', account_paused: 'La cuenta está en pausa por su plan (puede leer)',
    account_inactive: 'La cuenta está desactivada', rate_limited: 'Demasiadas solicitudes: espera Retry-After', idempotency_conflict: 'Esa Idempotency-Key ya se usó con otra petición', idempotency_in_progress: 'La primera petición con esa llave sigue en curso', invalid_idempotency_key: 'Idempotency-Key vacía o de más de 200 caracteres',
    invalid_json: 'El cuerpo no es JSON válido', invalid_cursor: 'El cursor no es el next_cursor de la página anterior', not_pending: 'El cobro ya no está pendiente', receivables_disabled: 'Los cobros no están activados en esta instalación',
    nobody_available: 'No hay nadie disponible para recibir la conversación', invalid_user: 'user_id no es una persona de tu equipo (GET /team)', not_sent: 'El mensaje no se pudo enviar: reason dice por qué', internal_error: 'Error del servidor: reintenta en unos minutos',
  };
  toc.append(el('h2', {}, 'Referencia'), el('ul', {}, el('li', {}, el('a', { href: '#errores' }, 'Errores'))));
  doc.append(el('section', { 'aria-labelledby': 'errores' }, el('h2', { class: 'section', id: 'errores' }, 'Errores'),
    el('p', {}, 'Todos los errores traen ', el('code', {}, 'error'), ' (para personas), ', el('code', {}, 'code'), ' (estable, para tu programa) y, cuando aplica, ', el('code', {}, 'fields'), ' con el campo y el motivo.'),
    copyable(JSON.stringify(spec.components.schemas.Error.example, null, 2), 'el ejemplo de error'),
    el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Códigos de error' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'code'), el('th', { scope: 'col' }, 'Qué significa'))),
      el('tbody', {}, Object.entries(MEANING).map(([c, m]) => el('tr', {}, el('td', {}, el('code', {}, c)), el('td', {}, m))))))));
})();
