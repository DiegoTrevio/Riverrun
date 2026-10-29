/** Piezas del Copiloto que no necesitan base de datos: esquemas, historial, página, enlaces y ejecutor. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COPILOT_TOOLS } from '../src/copilot/tools/index.js';
import { toolSpec, allowed } from '../src/copilot/registry.js';
import { buildHistory } from '../src/copilot/history.js';
import { systemMessage } from '../src/copilot/prompt.js';
import { parsePage } from '../src/copilot/page.js';
import { clip, day, forModel, safeLink } from '../src/copilot/summarize.js';
import { keepAccount, path, qs, ToolError } from '../src/copilot/executor.js';
import { argsHash, stableJson, type Action, type Message } from '../src/copilot/store.js';
import { pickPaths } from '../src/copilot/actions.js';

const ID = '11111111-2222-4333-8444-555555555555';

test('herramientas: nombres únicos, en snake_case y con un JSON Schema limpio', () => {
  const names = COPILOT_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const t of COPILOT_TOOLS) {
    assert.match(t.name, /^[a-z_]{3,48}$/);
    assert.ok(t.description.length <= 220, `${t.name}: descripción corta`);
    const spec = toolSpec(t);
    const text = JSON.stringify(spec.parameters);
    assert.equal(spec.parameters.type, 'object');
    assert.equal(spec.parameters.additionalProperties, false, t.name);
    assert.ok(!text.includes('$schema'));
    assert.ok(!text.includes('9007199254740991'), `${t.name}: sin topes enormes`);
    assert.ok(!/"format":"uuid","pattern"/.test(text), `${t.name}: sin el regex de uuid`);
  }
});

test('herramientas: un agente no recibe las de administrador; el superadmin sí', () => {
  const fake = { name: 'solo_admin', roles: ['admin'] } as any;
  assert.equal(allowed(fake, { role: 'agent' } as any), false);
  assert.equal(allowed(fake, { role: 'admin' } as any), true);
  assert.equal(allowed(fake, { role: 'superadmin' } as any), true);
  assert.equal(allowed({ ...fake, available: () => false }, { role: 'admin' } as any), false);
});

const msg = (id: number, m: Partial<Message>): Message => ({ id: String(id), thread_id: 't', turn_id: 'u', role: 'user', content: '', tool_calls: null, tool_call_id: null, refs: [], redacted: false, created_at: new Date(), rev: String(id), ...m });

test('historial: cada llamada queda con su resultado y los resultados sueltos se quitan', () => {
  const h = buildHistory([
    msg(1, { role: 'user', content: 'Etiqueta a Ana' }),
    msg(2, { role: 'assistant', tool_calls: [{ id: 'a', name: 'etiquetar', arguments: '{}' }, { id: 'b', name: 'buscar_contactos', arguments: '{}' }] }),
    msg(3, { role: 'tool', tool_call_id: 'a', content: '{"estado":"hecho"}' }),
    msg(4, { role: 'tool', tool_call_id: 'zzz', content: 'suelto' }),
  ], []);
  assert.deepEqual(h.map((m) => m.role), ['user', 'assistant', 'tool', 'tool']);
  assert.equal((h[2] as any).tool_call_id, 'a');
  assert.equal((h[3] as any).tool_call_id, 'b');
  assert.match((h[3] as any).content, /sin_resultado/);
});

test('historial: un aviso del panel que cae entre una llamada y su resultado va después del resultado', () => {
  const h = buildHistory([
    msg(1, { role: 'user', content: 'Etiqueta a Ana' }),
    msg(2, { role: 'assistant', tool_calls: [{ id: 'a', name: 'etiquetar', arguments: '{}' }] }),
    msg(3, { role: 'event', content: 'Confirmaste: Enviar mensaje a Beto → hecho.' }),
    msg(4, { role: 'tool', tool_call_id: 'a', content: '{"estado":"hecho"}' }),
  ], []);
  assert.deepEqual(h.map((m) => m.role), ['user', 'assistant', 'tool', 'user']);
  assert.equal((h[2] as any).content, '{"estado":"hecho"}', 'el resultado real, no «sin resultado»');
  assert.match(String((h[3] as any).content), /^\[Aviso del panel\] Confirmaste/);
});

test('fechas: una fecha sola no se mueve de día por la zona horaria', () => {
  assert.equal(day('2026-11-04', 'America/Mexico_City'), '2026-11-04');
  assert.equal(day(new Date('2026-11-04T03:00:00Z'), 'America/Mexico_City'), '2026-11-03');
});

test('historial: los turnos viejos solo conservan lo que se pidió y lo que se respondió; las referencias se explican', () => {
  const list: Message[] = [];
  let n = 0;
  for (let i = 0; i < 8; i++) {
    list.push(msg(++n, { role: 'user', content: `pedido ${i}` }));
    list.push(msg(++n, { role: 'assistant', tool_calls: [{ id: `c${i}`, name: 'ver_contacto', arguments: '{}' }] }));
    list.push(msg(++n, { role: 'tool', tool_call_id: `c${i}`, content: '{}' }));
    list.push(msg(++n, { role: 'assistant', content: `respuesta ${i}` }));
  }
  const action = { id: ID, tool: 'etiquetar', status: 'done', title: 'Etiqueté a Ana', args: { contacto_ids: [ID] } } as unknown as Action;
  list.push(msg(++n, { role: 'user', content: 'cámbiale la etiqueta', refs: [ID] }));
  const h = buildHistory(list, [action]);
  const roles = h.map((m) => m.role);
  assert.equal(roles.slice(0, 4).join(','), 'user,assistant,user,assistant', 'los dos primeros turnos sin herramientas');
  assert.match(String(h.at(-1)!.content), /\[Se refiere a estas acciones\]\nA11111111 · etiquetar · hecho · Etiqueté a Ana/);
});

test('página: ruta del panel → tipo, id y área (solo ids válidos)', () => {
  assert.deepEqual(parsePage(`#/contact/${ID}`), { hash: `#/contact/${ID}`, kind: 'contact', id: ID, area: 'contactos' });
  assert.equal(parsePage(`#/automation/lienzo/${ID}`).kind, 'board');
  assert.equal(parsePage(`#/cotizaciones/historial?id=${ID}`).id, ID);
  assert.equal(parsePage('#/contact/../../etc').id, undefined);
  assert.equal(parsePage('').kind, 'agents');
  assert.equal(parsePage('#/bot/x/instrucciones').id, undefined);
});

test('enlaces: solo rutas conocidas del panel', () => {
  assert.equal(safeLink(`#/contact/${ID}`), true);
  assert.equal(safeLink(`#/cotizaciones/historial?id=${ID}`), true);
  assert.equal(safeLink('https://evil.test'), false);
  assert.equal(safeLink('javascript:alert(1)'), false);
  assert.equal(safeLink('#/contact/<img>'), false);
  assert.equal(safeLink('#/desconocida/1'), false);
});

test('ejecutor: las rutas solo aceptan ids simples y el superadmin no ve otras cuentas', () => {
  assert.equal(path`/api/contacts/${ID}/profile`, `/api/contacts/${ID}/profile`);
  assert.throws(() => path`/api/contacts/${'../users'}`, ToolError);
  assert.throws(() => path`/api/contacts/${'a?b=1'}`, ToolError);
  assert.equal(qs({ a: 'x y', b: undefined, c: '' }), '?a=x+y');
  assert.deepEqual(keepAccount([{ id: 1, account_id: 'A' }, { id: 2, account_id: 'B' }, { id: 3 }], 'A').map((x: any) => x.id), [1, 3]);
  assert.throws(() => keepAccount({ contact: { account_id: 'B' } }, 'A'), /No encontrado/);
  assert.deepEqual(keepAccount({ items: [{ account_id: 'B' }] }, 'A'), { items: [] });
});

test('huella de una propuesta: no depende del orden de las claves', () => {
  assert.equal(stableJson({ b: 1, a: [1, { d: 2, c: 3 }] }), '{"a":[1,{"c":3,"d":2}],"b":1}');
  assert.equal(argsHash('t', { a: 1, b: 2 }, { title: 'x' }), argsHash('t', { b: 2, a: 1 }, { title: 'x' }));
  assert.notEqual(argsHash('t', { a: 1 }, null), argsHash('t', { a: 2 }, null));
  assert.deepEqual(pickPaths({ conversation: { status: 'bot', assigned_user_id: null } }, ['conversation.status', 'conversation.assigned_user_id', 'x.y']), { 'conversation.status': 'bot', 'conversation.assigned_user_id': null, 'x.y': null });
});

test('resultados cortos para el modelo: textos y listas recortados', () => {
  const long = 'x'.repeat(500);
  const c = clip({ a: long, list: Array.from({ length: 30 }, (_, i) => i), vacio: '', nada: null }) as any;
  assert.equal(c.a.length, 301);
  assert.equal(c.list.length, 21);
  assert.equal(c.list.at(-1), '… y 10 más');
  assert.ok(!('vacio' in c) && !('nada' in c));
  assert.ok(forModel({ big: Array.from({ length: 20 }, () => long) }).length <= 3000 + 20);
});

test('herramientas: el esquema que ve el modelo es corto, sin perder lo que importa', () => {
  const walk = (node: any, depth: number, out: { nestedDefault: number; nestedAdditional: number }) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, depth, out));
    if (!node || typeof node !== 'object') return;
    if (depth > 1 && 'default' in node) out.nestedDefault++;
    if (depth > 0 && node.additionalProperties === false) out.nestedAdditional++;
    for (const [k, v] of Object.entries(node)) walk(v, k === 'properties' ? depth : depth + 1, out);
  };
  const size = (role: string) => JSON.stringify(COPILOT_TOOLS.filter((t) => allowed(t, { role } as any)).map(toolSpec)).length;
  for (const t of COPILOT_TOOLS) {
    const out = { nestedDefault: 0, nestedAdditional: 0 };
    walk(toolSpec(t).parameters, 0, out);
    assert.deepEqual(out, { nestedDefault: 0, nestedAdditional: 0 }, t.name);
  }
  // Los valores por omisión de los argumentos sí van: dicen qué pasa si el modelo no los manda.
  const cita = toolSpec(COPILOT_TOOLS.find((t) => t.name === 'crear_cita')!).parameters as any;
  assert.equal(cita.properties.avisar_al_cliente.default, true);
  // Tope de regresión: lo que va en cada paso de cada pedido no debe volver a crecer sin darse cuenta.
  assert.ok(size('admin') < 39_000, `herramientas de administrador: ${size('admin')} caracteres`);
  assert.ok(size('agent') < 14_000, `herramientas de agente: ${size('agent')} caracteres`);
});

test('cambiar_regla: el modelo ve un esquema corto, pero el servidor valida con el completo', () => {
  const def = COPILOT_TOOLS.find((t) => t.name === 'cambiar_regla')!;
  assert.ok(JSON.stringify(toolSpec(def)).length < 1500, 'no repite el esquema de crear_regla');
  assert.equal(def.schema.safeParse({ regla_id: ID, acciones: [{ type: 'no_existe' }] }).success, false);
  assert.equal(def.schema.safeParse({ regla_id: ID, acciones: [{ type: 'add_tag', tag: 'interesado' }, { type: 'alert_team' }] }).success, true);
});

test('prompt: la lista de la conversación lleva solo cambios y propuestas, las últimas 12', () => {
  const act = (i: number, risk: string) => ({ id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, tool: risk === 'read' ? 'buscar_contactos' : 'etiquetar', risk, status: 'done', title: `Acción ${i}`, args: { n: i } }) as unknown as Action;
  const actions = Array.from({ length: 30 }, (_, i) => act(i, i % 2 ? 'read' : 'reversible'));
  const system = systemMessage({ model: 'anthropic/claude-sonnet-4.5', user: { role: 'admin', name: 'Dueña' } as any, accountName: 'Barbería', timezone: 'America/Mexico_City', snapshot: '', page: {}, actions });
  const dynamic = (system.content as any[])[1].text as string;
  assert.ok(!dynamic.includes('buscar_contactos'), 'sin consultas');
  assert.equal((dynamic.match(/· etiquetar ·/g) ?? []).length, 12);
  assert.ok(dynamic.includes('Acción 28') && !dynamic.includes('Acción 4 '), 'las más nuevas');
  assert.deepEqual((system.content as any[])[0].cache_control, { type: 'ephemeral' }, 'la parte fija va a la caché');
});

test('historial: los resultados de herramientas de turnos viejos se recortan; los de los 2 últimos no', () => {
  const big = JSON.stringify({ contactos: 'x'.repeat(2500) });
  const turn = (n: number) => [
    msg(n * 10, { role: 'user', content: `Pedido ${n}`, turn_id: `t${n}` }),
    msg(n * 10 + 1, { role: 'assistant', tool_calls: [{ id: `c${n}`, name: 'buscar_contactos', arguments: '{}' }], turn_id: `t${n}` }),
    msg(n * 10 + 2, { role: 'tool', tool_call_id: `c${n}`, content: big, turn_id: `t${n}` }),
    msg(n * 10 + 3, { role: 'assistant', content: 'Listo.', turn_id: `t${n}` }),
  ];
  const h = buildHistory([...turn(1), ...turn(2), ...turn(3)], []);
  const tools = h.filter((m: any) => m.role === 'tool') as any[];
  assert.equal(tools.length, 3);
  assert.ok(tools[0].content.length < 900 && tools[0].content.endsWith('(recortado)'), 'el turno viejo se recorta');
  assert.equal(tools[1].content, big);
  assert.equal(tools[2].content, big);
});
