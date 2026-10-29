/** Piezas del Copiloto que no necesitan base de datos: esquemas, historial, página, enlaces y ejecutor. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COPILOT_TOOLS } from '../src/copilot/tools/index.js';
import { toolSpec, allowed } from '../src/copilot/registry.js';
import { buildHistory } from '../src/copilot/history.js';
import { parsePage } from '../src/copilot/page.js';
import { clip, forModel, safeLink } from '../src/copilot/summarize.js';
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
