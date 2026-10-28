/**
 * Lienzo de flujos sin base de datos: cómo el dibujo (inicio, mensajes, esperas, botones y acciones) se convierte en la
 * regla y los flujos que ejecuta el sistema, y qué pendientes impiden publicarlo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardSchema, compileBoard, delayOf } from '../src/automation/flow-board.js';

type N = { id: string; type: string; data?: Record<string, unknown> };
const board = (nodes: N[], edges: [string, string, string][], settings = {}) => BoardSchema.parse({
  nodes: nodes.map((n, i) => ({ x: 0, y: i * 200, ...n })),
  edges: edges.map(([from, port, to], i) => ({ id: `e${i}`, from, port, to })),
  settings,
});
const keyword = (keywords: string[]) => ({ trigger: { type: 'message_received', match: 'keywords', keywords }, stop_ai: true });
const errors = (f: ReturnType<typeof compileBoard>) => f.problems.filter((p) => !p.warning).map((p) => p.message);

test('la línea principal es un flujo; las esperas se suman como la espera del mensaje siguiente', () => {
  const f = compileBoard(board([
    { id: 't', type: 'trigger', data: keyword(['promo']) },
    { id: 'tag', type: 'action', data: { action: 'tag', tag: 'promo' } },
    { id: 'm1', type: 'message', data: { text: 'Hola {{nombre}}' } },
    { id: 'w1', type: 'wait', data: { value: 1, unit: 'days' } },
    { id: 'w2', type: 'wait', data: { value: 2, unit: 'hours', at_time: '10:00' } },
    { id: 'm2', type: 'message', data: { text: 'Seguimiento' } },
  ], [['t', 'out', 'tag'], ['tag', 'out', 'm1'], ['m1', 'out', 'w1'], ['w1', 'out', 'w2'], ['w2', 'out', 'm2']]), 'Promo de verano');
  assert.deepEqual(errors(f), []);
  assert.equal(f.main, ':main', 'el flujo principal se publica con una clave fija');
  assert.equal(f.sequences[0].steps[0].node, 'm1');
  assert.deepEqual(f.rule?.actions, [{ type: 'add_tag', tag: 'promo' }], 'las acciones antes del primer mensaje van en la regla');
  assert.equal(f.rule?.stop_ai, true);
  assert.equal(f.sequences.length, 1);
  const [s] = f.sequences;
  assert.equal(s.name, 'Promo de verano');
  assert.deepEqual(s.steps.map((st) => [st.text, st.delay_value, st.delay_unit, st.at_time]), [['Hola {{nombre}}', 0, 'minutes', ''], ['Seguimiento', 26, 'hours', '10:00']]);
});

test('botones: a lo que sigue = seguir ya; a otro mensaje = otra rama; a una acción = esa acción; sin línea = terminar', () => {
  const f = compileBoard(board([
    { id: 't', type: 'trigger', data: keyword(['menu']) },
    { id: 'm1', type: 'message', data: { text: '¿Qué quieres ver?', wait_for_choice: true, buttons: [
      { id: 'a', label: 'Precios', reply: 'Va 👇' }, { id: 'b', label: 'Ya, gracias' }, { id: 'c', label: 'Hablar con alguien' },
      { id: 'd', label: 'Etiquétame' }, { id: 'u', label: 'Ver menú', kind: 'url', url: 'https://menu.test' },
    ] } },
    { id: 'w', type: 'wait', data: { value: 1, unit: 'days' } },
    { id: 'm2', type: 'message', data: { text: 'Te escribo mañana' } },
    { id: 'p1', type: 'message', data: { text: 'Lista de precios: …' } },
    { id: 'h', type: 'action', data: { action: 'handoff' } },
  ], [['t', 'out', 'm1'], ['m1', 'out', 'w'], ['w', 'out', 'm2'], ['m1', 'b:a', 'p1'], ['m1', 'b:c', 'h'], ['m1', 'b:d', 'm2']]), 'Menú');
  assert.deepEqual(errors(f).filter((m) => !m.includes('3 botones')), []);
  const buttons = f.sequences[0].steps[0].buttons;
  assert.deepEqual(buttons.map((b) => [b.label, b.action, b.target ?? null]), [
    ['Precios', 'start_sequence', 'p1'],
    ['Ya, gracias', 'end', null],
    ['Hablar con alguien', 'handoff', null],
    ['Etiquétame', 'next', null],
    ['Ver menú', 'next', null],
  ]);
  assert.equal(buttons[0].reply, 'Va 👇');
  assert.equal(f.sequences[0].steps[0].wait_for_choice, true);
  assert.deepEqual(f.sequences.map((s) => [s.key, s.name, s.steps.length]), [[':main', 'Menú', 2], ['p1', 'Menú · Lista de precios: …', 1]]);
  assert.ok(errors(f).some((m) => m.includes('3 botones')), 'cuatro botones de respuesta no se publican');
});

test('una rama que vuelve al mensaje del menú se repite con un botón (no con la línea principal)', () => {
  const ok = compileBoard(board([
    { id: 't', type: 'trigger', data: { trigger: null } },
    { id: 'm1', type: 'message', data: { text: 'Menú', buttons: [{ id: 'a', label: 'Otra vez' }] } },
  ], [['t', 'out', 'm1'], ['m1', 'b:a', 'm1']]), 'Repetir');
  assert.deepEqual(errors(ok), []);
  assert.equal(ok.rule, null, '«lo inicio yo» no crea regla');
  assert.deepEqual(ok.sequences[0].steps[0].buttons.map((b) => [b.action, b.target]), [['start_sequence', ':main']], 'volver al menú es volver al flujo principal');

  const loop = compileBoard(board([
    { id: 't', type: 'trigger', data: { trigger: null } },
    { id: 'm1', type: 'message', data: { text: 'Uno' } },
    { id: 'm2', type: 'message', data: { text: 'Dos' } },
  ], [['t', 'out', 'm1'], ['m1', 'out', 'm2'], ['m2', 'out', 'm1']]), 'Círculo');
  assert.ok(errors(loop).some((m) => m.includes('regresa a un mensaje anterior')));
});

test('pendientes: sin inicio, mensaje vacío, palabras faltantes, acciones después de un mensaje y elementos sueltos', () => {
  assert.deepEqual(errors(compileBoard(board([], []), 'X')), ['Agrega el inicio: cuándo empieza el flujo.']);
  const f = compileBoard(board([
    { id: 't', type: 'trigger', data: { trigger: { type: 'message_received', match: 'keywords', keywords: [] } } },
    { id: 'm1', type: 'message', data: { text: '' } },
    { id: 'tag', type: 'action', data: { action: 'tag', tag: 'x' } },
    { id: 'loose', type: 'message', data: { text: 'Suelto' } },
    { id: 'n', type: 'note', data: { text: 'Idea: agregar foto' } },
  ], [['t', 'out', 'm1'], ['m1', 'out', 'tag']]), 'X');
  const msgs = errors(f);
  assert.ok(msgs.some((m) => m.includes('al menos una palabra')));
  assert.ok(msgs.some((m) => m.includes('está vacío')));
  assert.ok(msgs.some((m) => m.includes('Las acciones salen de un botón o del inicio')));
  const warn = f.problems.filter((p) => p.warning);
  assert.deepEqual(warn.map((p) => p.node), ['loose'], 'lo suelto avisa sin impedir publicar; las notas no cuentan');
  assert.ok(f.problems.every((p) => !p.node || ['t', 'm1', 'tag', 'loose'].includes(p.node)), 'cada pendiente señala su elemento');
});

test('pasar con una persona en el inicio termina ahí; un botón no avisa al equipo', () => {
  const f = compileBoard(board([
    { id: 't', type: 'trigger', data: { trigger: { type: 'new_contact' } } },
    { id: 'h', type: 'action', data: { action: 'handoff' } },
    { id: 'm1', type: 'message', data: { text: 'No debería salir' } },
  ], [['t', 'out', 'h'], ['h', 'out', 'm1']]), 'Atención');
  assert.ok(errors(f).some((m) => m.includes('Después de pasar con una persona')));
  assert.deepEqual(f.rule?.actions.map((a) => a.type), ['handoff']);

  const g = compileBoard(board([
    { id: 't', type: 'trigger', data: { trigger: null } },
    { id: 'm1', type: 'message', data: { text: 'Hola', buttons: [{ id: 'a', label: 'Avisar' }] } },
    { id: 'al', type: 'action', data: { action: 'alert' } },
  ], [['t', 'out', 'm1'], ['m1', 'b:a', 'al']]), 'Aviso');
  assert.ok(errors(g).some((m) => m.includes('Un botón no puede avisar al equipo')));
});

test('las esperas usan la unidad exacta más grande', () => {
  assert.deepEqual(delayOf(0), { delay_value: 0, delay_unit: 'minutes' });
  assert.deepEqual(delayOf(90), { delay_value: 90, delay_unit: 'minutes' });
  assert.deepEqual(delayOf(120), { delay_value: 2, delay_unit: 'hours' });
  assert.deepEqual(delayOf(2880), { delay_value: 2, delay_unit: 'days' });
});

test('el esquema rechaza ids y líneas inválidas y da valores por omisión a cada elemento', () => {
  assert.ok(!BoardSchema.safeParse({ nodes: [{ id: 'a b', type: 'message', x: 0, y: 0 }] }).success);
  assert.ok(!BoardSchema.safeParse({ edges: [{ id: 'e', from: 'a', port: 'boton', to: 'b' }] }).success);
  const b = BoardSchema.parse({ nodes: [{ id: 'm', type: 'message', x: 1, y: 2 }, { id: 'n', type: 'note', x: 0, y: 0 }] });
  assert.deepEqual(b.nodes[0], { id: 'm', type: 'message', x: 1, y: 2, data: { text: '', image_id: '', attachment_id: '', photo_hint: '', buttons: [], wait_for_choice: false, if_no_choice: 'end' } });
  assert.deepEqual(b.settings, { stop_on_reply: true, business_hours_only: true });
});

test('«esperar a que elija» sin una Espera da un día para elegir; un botón «sigue» sin esperar es un pendiente', () => {
  const nodes = (wait: boolean) => [
    { id: 't', type: 'trigger', data: keyword(['menu']) },
    { id: 'm1', type: 'message', data: { text: '¿Qué te interesa?', wait_for_choice: wait, buttons: [{ id: 'a', label: 'Precios' }, { id: 'b', label: 'Horario' }] } },
    { id: 'm2', type: 'message', data: { text: 'Estos son los precios' } },
    { id: 'm3', type: 'message', data: { text: 'Abrimos de 9 a 7' } },
  ];
  const edges: [string, string, string][] = [['t', 'out', 'm1'], ['m1', 'out', 'm2'], ['m1', 'b:a', 'm2'], ['m1', 'b:b', 'm3']];
  const waiting = compileBoard(board(nodes(true), edges), 'Menú');
  assert.deepEqual(errors(waiting), []);
  const [main] = waiting.sequences;
  assert.deepEqual([main.steps[1].delay_value, main.steps[1].delay_unit], [1, 'days'], 'el siguiente sale al elegir o, si no elige, en un día');
  const loose = compileBoard(board(nodes(false), edges), 'Menú');
  assert.ok(errors(loose).some((m) => m.includes('«Precios» sigue con el mensaje siguiente, pero ese mensaje sale enseguida')));
  // Con una Espera de por medio, el tiempo para elegir es el de la Espera.
  const withWait = compileBoard(board([...nodes(true), { id: 'w', type: 'wait', data: { value: 2, unit: 'hours' } }], [['t', 'out', 'm1'], ['m1', 'out', 'w'], ['w', 'out', 'm2'], ['m1', 'b:a', 'm2'], ['m1', 'b:b', 'm3']]), 'Menú');
  assert.deepEqual([withWait.sequences[0].steps[1].delay_value, withWait.sequences[0].steps[1].delay_unit], [2, 'hours']);
});

test('las etiquetas de los botones se revisan como al publicar (números, acentos y palabras reservadas)', () => {
  const f = compileBoard(board([
    { id: 't', type: 'trigger', data: keyword(['menu']) },
    { id: 'm1', type: 'message', data: { text: 'Elige', buttons: [{ id: 'a', label: '1' }, { id: 'b', label: 'Sí' }, { id: 'c', label: 'Si' }] } },
    { id: 'm2', type: 'message', data: { text: 'Otra', buttons: [{ id: 'd', label: '👍' }, { id: 'e', label: 'BAJA' }] } },
  ], [['t', 'out', 'm1'], ['m1', 'out', 'm2']]), 'Menú', { reserved: ['baja'] });
  const e = errors(f);
  assert.ok(e.some((m) => m.includes('«1» no puede ser solo un número')));
  assert.ok(e.includes('Dos botones no pueden decir lo mismo.'), 'Sí y Si son el mismo botón');
  assert.ok(e.some((m) => m.includes('«👍» necesita letras o números')));
  assert.ok(e.some((m) => m.includes('«BAJA» se confunde con la palabra para darse de baja')));
});

test('un hueco por llenar ([precio]) impide publicar; un texto entre corchetes como [2x1] no', () => {
  const msg = (text: string) => compileBoard(board([{ id: 't', type: 'trigger', data: keyword(['promo']) }, { id: 'm1', type: 'message', data: { text } }], [['t', 'out', 'm1']]), 'Promo');
  assert.deepEqual(errors(msg('El corte cuesta [precio de la promo].')), ['Completa lo que está entre corchetes: «[precio de la promo]».']);
  assert.deepEqual(errors(msg('Promo [2x1] esta semana. [Ver menú] abajo.')), []);
});

test('un inicio a medio llenar se guarda y queda como pendiente (no se publica la regla)', () => {
  const b = board([{ id: 't', type: 'trigger', data: { trigger: { type: 'tag_added', tag: '' } } }, { id: 'm1', type: 'message', data: { text: 'Hola' } }], [['t', 'out', 'm1']]);
  const f = compileBoard(b, 'Etiqueta');
  assert.deepEqual(errors(f), ['Escribe la etiqueta que inicia el flujo.']);
  assert.equal(f.rule, null);
  assert.ok(!BoardSchema.safeParse({ nodes: [{ id: 't', type: 'trigger', x: 0, y: 0, data: { trigger: { type: 'intent', description: 'x'.repeat(301) } } }] }).success, 'los textos siguen teniendo su límite');
});
