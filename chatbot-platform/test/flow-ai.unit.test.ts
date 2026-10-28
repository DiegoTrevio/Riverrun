/**
 * Crear flujos y cambiar instrucciones con IA, sin base de datos: cómo la respuesta de la IA se convierte en un lienzo
 * válido (y qué se conserva al pedir un cambio), y cómo se aplican las operaciones a las instrucciones del agente.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardSchema, compileBoard } from '../src/automation/flow-board.js';
import { boardToSpec, designFlow, fitLabel, FlowSpecSchema, specToBoard } from '../src/automation/flow-ai.js';
import { applyPromptOps, editPrompt, promptUnits } from '../src/agent-prompt-edit.js';
import type { AiProvider, CompletionRequest } from '../src/ai/provider.js';

const block = (b: Record<string, unknown>) => ({ text: '', minutes: 0, at_time: '', photo: '', buttons: [], wait_for_choice: false, next: '', ...b });
const button = (label: string, go_to = '', extra: Record<string, unknown> = {}) => ({ label, kind: 'reply', url: '', reply: '', go_to, ...extra });
const spec = (over: Record<string, unknown> = {}) => FlowSpecSchema.parse({
  name: 'Promo 2x1', summary: 'Armé la promo.', review: [],
  trigger: { type: 'message_received', keywords: ['promo', ' PROMO '], match: 'keywords', minutes: 0, tag: '' },
  start: 'tag1',
  blocks: [
    block({ id: 'tag1', type: 'tag', text: 'promo', next: 'm1' }),
    block({ id: 'm1', type: 'message', text: '{{nombre}}, esta semana hay 2x1. ¿Te interesa?', wait_for_choice: true, next: 'w1', buttons: [button('Quiero apartar mi lugar ya', 'h1'), button('Ver precios', 'm2')] }),
    block({ id: 'm2', type: 'message', text: 'Corte $150, barba $100.' }),
    block({ id: 'h1', type: 'handoff', text: 'Quiere apartar' }),
    block({ id: 'w1', type: 'wait', minutes: 1440, at_time: '10:00', next: 'm3' }),
    block({ id: 'm3', type: 'message', text: '¿Pudiste ver la promo?' }),
  ],
  ...over,
});
const errors = (problems: { warning?: boolean; message: string }[]) => problems.filter((p) => !p.warning).map((p) => p.message);

test('la respuesta de la IA se convierte en un lienzo que se puede publicar tal cual', () => {
  const { board, usedUpload } = specToBoard(spec());
  const f = compileBoard(board, 'Promo 2x1');
  assert.deepEqual(errors(f.problems), []);
  assert.equal(usedUpload, false);
  assert.deepEqual(f.rule?.trigger, { type: 'message_received', match: 'keywords', keywords: ['promo', 'PROMO'], first_message_only: false });
  assert.equal(f.rule?.stop_ai, true, 'con palabras clave el flujo contesta en lugar del agente');
  assert.deepEqual(f.rule?.actions, [{ type: 'add_tag', tag: 'promo' }]);
  const main = f.sequences.find((s) => s.key === f.main)!;
  assert.deepEqual(main.steps.map((s) => s.text), ['{{nombre}}, esta semana hay 2x1. ¿Te interesa?', '¿Pudiste ver la promo?']);
  assert.deepEqual([main.steps[1].delay_value, main.steps[1].delay_unit, main.steps[1].at_time], [1, 'days', '10:00']);
  assert.deepEqual(main.steps[0].buttons.map((b) => [b.label, b.action]), [['Quiero apartar mi', 'handoff'], ['Ver precios', 'start_sequence']]);
  assert.equal(main.steps[0].wait_for_choice, true);
  assert.equal(f.sequences.length, 2, 'la rama de «Ver precios» es su propio flujo');
});

test('etiquetas de botón a 20 caracteres, ids raros y referencias que no existen', () => {
  assert.equal(fitLabel('Quiero apartar mi lugar ya'), 'Quiero apartar mi');
  assert.equal(fitLabel('Supercalifragilísticoespialidoso'), 'Supercalifragilístic');
  const { board } = specToBoard(spec({
    start: 'paso 1',
    blocks: [block({ id: 'paso 1', type: 'message', text: 'Hola', next: 'no-existe', buttons: [button('Sí', 'tampoco')] })],
  }));
  const m = board.nodes.find((n) => n.type === 'message')!;
  assert.match(m.id, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(board.edges.map((e) => [e.from, e.to]), [['t1', m.id]], 'solo queda la línea del inicio');
});

test('al pedir un cambio se conservan fotos, notas, posiciones y las condiciones del inicio', () => {
  const current = BoardSchema.parse({
    nodes: [
      { id: 'start', type: 'trigger', x: 10, y: 20, data: { trigger: { type: 'new_contact' }, conditions: [{ type: 'has_tag', tag: 'vip' }], stop_ai: false } },
      { id: 'hola', type: 'message', x: 10, y: 200, data: { text: 'Hola', attachment_id: '11111111-1111-4111-8111-111111111111' } },
      { id: 'nota', type: 'note', x: -300, y: 0, data: { text: 'Agregar opción de precios' } },
    ],
    edges: [{ id: 'e1', from: 'start', port: 'out', to: 'hola' }],
  });
  const s = boardToSpec(current, 'Bienvenida');
  assert.equal(s.trigger.type, 'new_contact');
  assert.equal(s.blocks[0].photo, 'keep');
  s.trigger.type = 'keep';
  s.blocks[0].buttons = [button('Precios', 'nuevo')];
  s.blocks.push(block({ id: 'nuevo', type: 'message', text: 'Precios: [precio]', photo: 'foto de la lista de precios' }));
  const { board } = specToBoard(s, current);
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const start = byId.get('start')!;
  assert.equal(start.type === 'trigger' && start.data.conditions.length, 1);
  assert.deepEqual([start.x, start.y], [10, 20]);
  const hola = byId.get('hola')!;
  assert.ok(hola.type === 'message' && hola.data.attachment_id === '11111111-1111-4111-8111-111111111111', 'la foto del mensaje sigue');
  assert.deepEqual([hola.x, hola.y], [10, 200]);
  assert.ok(byId.get('nota'), 'la nota de la pizarra sigue');
  const f = compileBoard(board, 'Bienvenida');
  assert.deepEqual(errors(f.problems), ['Completa lo que está entre corchetes: «[precio]».']);
  assert.ok(f.problems.some((p) => p.warning && p.message === 'Falta la foto: foto de la lista de precios.'));
});

test('la imagen adjunta se usa como foto solo si la IA la pone en un mensaje', () => {
  const s = spec();
  s.blocks[1].photo = 'upload';
  const uploadId = '22222222-2222-4222-8222-222222222222';
  const { board, usedUpload } = specToBoard(s, null, uploadId);
  assert.equal(usedUpload, true);
  assert.ok(board.nodes.some((n) => n.type === 'message' && n.data.attachment_id === uploadId));
  assert.equal(specToBoard(spec(), null, uploadId).usedUpload, false);
});

test('ida y vuelta: un lienzo descrito para la IA y vuelto a armar publica lo mismo', () => {
  const { board } = specToBoard(spec());
  const again = specToBoard(boardToSpec(board, 'Promo 2x1'), board).board;
  const a = compileBoard(board, 'Promo 2x1');
  const b = compileBoard(again, 'Promo 2x1');
  const shape = (f: typeof a) => f.sequences.map((s) => s.steps.map((x) => [x.text, x.buttons.map((y) => [y.label, y.action])]));
  assert.deepEqual(shape(b), shape(a));
  assert.deepEqual(b.rule, a.rule);
});

function fakeAi(replies: unknown[]) {
  const calls: CompletionRequest[] = [];
  const ai: AiProvider = {
    async complete(req) {
      calls.push(req);
      const r = replies[Math.min(calls.length - 1, replies.length - 1)];
      return { content: typeof r === 'string' ? r : JSON.stringify(r), model: req.model, latency_ms: 1, usage: { input_tokens: 10, cached_tokens: 0, output_tokens: 10 } };
    },
    async transcribe() { return ''; },
  };
  return { ai, calls };
}

test('si la IA arma algo que el sistema no ejecuta, se le pide una corrección con el bloque señalado', async () => {
  const bad = spec({ blocks: [...spec().blocks.slice(0, 5), block({ id: 'm3', type: 'tag', text: 'seguimiento' })] });
  const { ai, calls } = fakeAi([bad, spec()]);
  const r = await designFlow(ai, { idea: 'Promo 2x1 cuando escriban promo', business: 'Nombre del negocio: Barbería' });
  assert.equal(calls.length, 2);
  const fixMsg = String(calls[1].messages.at(-1)!.content);
  assert.match(fixMsg, /Bloque m3: Después de un mensaje solo siguen mensajes y esperas/);
  assert.deepEqual(errors(r.problems), []);
  assert.equal(r.name, 'Promo 2x1');
  assert.equal(r.runs.length, 2);
  assert.match(String(calls[0].messages[1].content), /Barbería[\s\S]*Promo 2x1 cuando escriban promo/);
  assert.equal(calls[0].json_schema?.name, 'flow_board');
  const once = fakeAi([spec()]);
  await designFlow(once.ai, { idea: 'Promo' });
  assert.equal(once.calls.length, 1, 'sin pendientes no hay segunda llamada');
});

test('una respuesta que no es JSON o sin bloques da un error claro', async () => {
  await assert.rejects(designFlow(fakeAi(['{"name":']).ai, { idea: 'x' }), /no terminó de armar el flujo/);
  await assert.rejects(designFlow(fakeAi([{ ...spec(), blocks: [] }]).ai, { idea: 'x' }), /No entendí qué flujo armar/);
  await assert.rejects(designFlow(fakeAi([spec()]).ai, { idea: '  ' }), /Escribe tu idea o sube una imagen/);
});

const PROMPT = 'Eres Mario, de la Barbería Don Lalo.\n\nSERVICIOS\n- Corte $150\n- Envío gratis a domicilio\n- Barba $100\n\nAtiende de tú y breve.';

test('las instrucciones se parten en renglones y se vuelven a armar con sus saltos de línea', () => {
  const units = promptUnits(PROMPT);
  assert.deepEqual(units.map((u) => u.text), ['Eres Mario, de la Barbería Don Lalo.', 'SERVICIOS', '- Corte $150', '- Envío gratis a domicilio', '- Barba $100', 'Atiende de tú y breve.']);
  assert.equal(applyPromptOps(units, []).prompt, PROMPT);
  assert.equal(applyPromptOps(units, []).changed, false);
});

test('quitar, sustituir y agregar tocan solo esos renglones', () => {
  const r = applyPromptOps(promptUnits(PROMPT), [
    { op: 'remove', line: 4, text: '' },
    { op: 'replace', line: 3, text: '- Corte $180' },
    { op: 'add', line: 5, text: '- Los domingos cerramos' },
    { op: 'add', line: 0, text: 'IMPORTANTE: no prometas horarios.' },
    { op: 'remove', line: 99, text: '' },
  ]);
  assert.equal(r.prompt, 'IMPORTANTE: no prometas horarios.\n\nEres Mario, de la Barbería Don Lalo.\n\nSERVICIOS\n- Corte $180\n- Barba $100\n- Los domingos cerramos\n\nAtiende de tú y breve.');
  assert.deepEqual(r.lines.filter((l) => l.state !== 'same').map((l) => [l.state, l.text, l.before ?? '']), [
    ['new', 'IMPORTANTE: no prometas horarios.', ''],
    ['changed', '- Corte $180', '- Corte $150'],
    ['removed', '- Envío gratis a domicilio', ''],
    ['new', '- Los domingos cerramos', ''],
  ]);
  assert.equal(applyPromptOps([], [{ op: 'add', line: 3, text: 'Atiende de usted.' }]).prompt, 'Atiende de usted.');
});

test('cambiar instrucciones con IA: renglones numerados, y si no encuentra qué cambiar, pregunta', async () => {
  const { ai, calls } = fakeAi([{ summary: 'Quité el envío gratis.', question: '', operations: [{ op: 'remove', line: 4, text: '' }] }]);
  const r = await editPrompt(ai, { prompt: PROMPT, instruction: 'ya no hay envío gratis', agent: 'Mario' });
  assert.match(String(calls[0].messages[1].content), /\[4\] - Envío gratis a domicilio[\s\S]*ya no hay envío gratis/);
  assert.equal(r.changed, true);
  assert.equal(r.summary, 'Quité el envío gratis.');
  assert.doesNotMatch(r.prompt, /Envío gratis/);
  const none = await editPrompt(fakeAi([{ summary: '', question: 'No encontré nada sobre estacionamiento.', operations: [] }]).ai, { prompt: PROMPT, instruction: 'quita lo del estacionamiento' });
  assert.equal(none.changed, false);
  assert.equal(none.question, 'No encontré nada sobre estacionamiento.');
  assert.equal(none.prompt, PROMPT);
});

test('un cambio con IA no pierde datos que su formato no lleva (filtros del inicio, esperas de 0, fotos)', () => {
  const current = BoardSchema.parse({
    nodes: [
      { id: 't', type: 'trigger', x: 0, y: 0, data: { trigger: { type: 'message_received', match: 'keywords', keywords: ['promo'], first_message_only: true } } },
      { id: 'm1', type: 'message', x: 0, y: 200, data: { text: 'Hola', image_id: '33333333-3333-4333-8333-333333333333' } },
      { id: 'w', type: 'wait', x: 0, y: 400, data: { value: 0, unit: 'minutes', at_time: '10:00' } },
      { id: 'm2', type: 'message', x: 0, y: 520, data: { text: 'Adiós', attachment_id: '44444444-4444-4444-8444-444444444444' } },
    ],
    edges: [{ id: 'e1', from: 't', port: 'out', to: 'm1' }, { id: 'e2', from: 'm1', port: 'out', to: 'w' }, { id: 'e3', from: 'w', port: 'out', to: 'm2' }],
  });
  const s = boardToSpec(current, 'Promo');
  s.trigger.keywords = ['promo', 'oferta'];
  s.blocks.find((b) => b.id === 'm1')!.photo = '';
  s.blocks.find((b) => b.id === 'm2')!.photo = 'remove';
  const { board } = specToBoard(s, current);
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const t = byId.get('t')!;
  assert.deepEqual(t.type === 'trigger' && t.data.trigger, { type: 'message_received', match: 'keywords', keywords: ['promo', 'oferta'], first_message_only: true }, 'se suma la palabra sin perder «solo el primer mensaje»');
  const w = byId.get('w')!;
  assert.deepEqual(w.type === 'wait' && w.data, { value: 0, unit: 'minutes', at_time: '10:00' });
  const m1 = byId.get('m1')!, m2 = byId.get('m2')!;
  assert.equal(m1.type === 'message' && m1.data.image_id, '33333333-3333-4333-8333-333333333333', 'si la IA no repite la foto, se queda');
  assert.equal(m2.type === 'message' && m2.data.attachment_id, '', 'con «remove» se quita');
  // El servicio de «agenda una cita» tampoco se pierde.
  const appt = BoardSchema.parse({ nodes: [{ id: 't', type: 'trigger', x: 0, y: 0, data: { trigger: { type: 'appointment_booked', service_id: 'svc-1' } } }] });
  const again = specToBoard(boardToSpec(appt, 'Cita'), appt).board.nodes[0];
  assert.deepEqual(again.type === 'trigger' && again.data.trigger, { type: 'appointment_booked', service_id: 'svc-1' });
});

test('seis botones de la IA se quedan en 3 de respuesta y 2 de enlace', () => {
  const sixButtons = spec({
    start: 'm1',
    blocks: [block({ id: 'm1', type: 'message', text: 'Menú', buttons: [button('Uno', ''), button('Dos', ''), button('Tres', ''), button('Cuatro', ''),
      { label: 'Web', kind: 'url', url: 'https://a.mx', reply: '', go_to: '' }, { label: 'Mapa', kind: 'url', url: 'https://b.mx', reply: '', go_to: '' }, { label: 'Otro', kind: 'url', url: 'https://c.mx', reply: '', go_to: '' }] })],
  });
  const { board } = specToBoard(sixButtons);
  const m = board.nodes.find((n) => n.type === 'message')!;
  assert.deepEqual(m.type === 'message' && m.data.buttons.map((b) => b.label), ['Uno', 'Dos', 'Tres', 'Web', 'Mapa']);
});

test('al aplicar un cambio, el resto de las instrucciones queda idéntico (sangrías, renglones en blanco, final)', () => {
  const text = 'PRECIOS\n  - Adultos $150\n  - Niños $100\n \nHorario: 9 a 7\n';
  const units = promptUnits(text);
  assert.equal(applyPromptOps(units, []).prompt, text);
  const r = applyPromptOps(units, [{ op: 'replace', line: 3, text: '- Niños $120' }]);
  assert.equal(r.prompt, 'PRECIOS\n  - Adultos $150\n  - Niños $120\n \nHorario: 9 a 7\n');
  const removed = applyPromptOps(units, [{ op: 'remove', line: 4, text: '' }]);
  assert.equal(removed.prompt, 'PRECIOS\n  - Adultos $150\n  - Niños $100\n');
});
