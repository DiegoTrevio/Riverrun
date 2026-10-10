/**
 * Freno de envíos (OUTBOUND_MODE=sandbox): ningún mensaje, correo, webhook ni cita sale a un destino que no esté en
 * OUTBOUND_SANDBOX_ALLOW. En live no cambia nada. Estas pruebas no hacen red: el bloqueo ocurre antes de salir.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool } from './harness.js';

const ok = await dbAvailable();
const dbTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { config } = await import('../src/config.js');
const guard = await import('../src/outbound-guard.js');
const { postSigned } = await import('../src/automation/automator.js');
const { sendMail } = await import('../src/mailer.js');
import type { Transport } from '../src/engine/transport.js';

const saved = { mode: config.outbound.mode, allow: config.outbound.allow };
const sandbox = (allow: string[] = []) => {
  config.outbound.mode = 'sandbox';
  config.outbound.allow = allow;
};

/** Transporte falso que cuenta cada envío real: si el freno funciona, el contador no sube. */
function fakeTransport() {
  const calls: string[] = [];
  const t: Transport = {
    kind: 'whatsapp',
    sendText: async (text) => {
      calls.push(`text:${text}`);
      return 'id';
    },
    sendImage: async (_img, caption) => {
      calls.push(`image:${caption}`);
      return 'id';
    },
    sendFile: async (_file, caption) => {
      calls.push(`file:${caption}`);
      return 'id';
    },
    notify: async (number, text) => {
      calls.push(`notify:${number}:${text}`);
    },
  };
  return { t, calls };
}

test('un destino se compara sin formato: teléfono por dígitos, correo sin mayúsculas, URL sin barra final', () => {
  assert.equal(guard.normalizeDestination('+52 55 1234-5678'), '525512345678');
  assert.equal(guard.normalizeDestination('Prueba@Ejemplo.MX '), 'prueba@ejemplo.mx');
  assert.equal(guard.normalizeDestination('https://Hooks.Ejemplo.mx/x/'), 'https://hooks.ejemplo.mx/x');
});

test('en live todo destino está permitido (producción no cambia)', () => {
  config.outbound.mode = 'live';
  config.outbound.allow = [];
  try {
    assert.equal(guard.outboundAllowed('5215512345678'), true);
    assert.equal(guard.outboundAllowed('alguien@ejemplo.mx'), true);
  } finally {
    Object.assign(config.outbound, saved);
  }
});

test('en sandbox solo sale lo que está en la lista; sin lista no sale nada', () => {
  try {
    sandbox();
    assert.equal(guard.outboundAllowed('5215512345678'), false);
    sandbox(['+52 1 55 1234 5678', 'qa@ejemplo.mx']);
    assert.equal(guard.outboundAllowed('5215512345678'), true, 'el número con otro formato es el mismo destino');
    assert.equal(guard.outboundAllowed('QA@ejemplo.mx'), true);
    assert.equal(guard.outboundAllowed('5215500000000'), false);
    assert.equal(guard.outboundAllowed(''), false, 'un destino vacío nunca pasa');
    assert.equal(guard.outboundAllowed(undefined), false);
  } finally {
    Object.assign(config.outbound, saved);
  }
});

test('el transporte envuelto no llama al real cuando el destino está bloqueado (texto, imagen, archivo y aviso)', async () => {
  try {
    sandbox(['5215512345678']);
    const { t, calls } = fakeTransport();
    const g = guard.guardTransport(t, '5215599999999');
    await assert.rejects(g.sendText('hola', 0), guard.OutboundBlockedError);
    await assert.rejects(g.sendImage({} as any, 'foto', 0), guard.OutboundBlockedError);
    await assert.rejects(g.sendFile!({} as any, 'pdf', 0), guard.OutboundBlockedError);
    await assert.rejects(g.notify('5215599999999', 'aviso'), guard.OutboundBlockedError);
    assert.deepEqual(calls, [], 'ningún envío llegó al transporte real');
  } finally {
    Object.assign(config.outbound, saved);
  }
});

test('el transporte envuelto sí envía al destino permitido, y el aviso al encargado se valida por su número', async () => {
  try {
    sandbox(['5215512345678']);
    const { t, calls } = fakeTransport();
    const g = guard.guardTransport(t, '5215512345678');
    await g.sendText('hola', 0);
    await g.notify('5215512345678', 'aviso');
    await assert.rejects(g.notify('5215599999999', 'otro'), guard.OutboundBlockedError);
    assert.deepEqual(calls, ['text:hola', 'notify:5215512345678:aviso']);
  } finally {
    Object.assign(config.outbound, saved);
  }
});

test('un transporte sin sendFile sigue sin sendFile después de envolverlo', () => {
  const { t } = fakeTransport();
  const { sendFile: _ignored, ...withoutFile } = t;
  assert.equal(guard.guardTransport(withoutFile as Transport, 'x').sendFile, undefined);
});

test('el servicio de chat entrega transportes con freno: el simulador queda fuera, los canales reales no', async () => {
  const { ChatService } = await import('../src/service.js');
  const fake = fakeTransport();
  const svc = new ChatService({} as any, () => fake.t);
  try {
    sandbox(['5215512345678']);
    const contact = { phone: '5215599999999', external_id: '5215599999999' } as any;
    const real = svc.transportFor({ type: 'whatsapp', account_id: 'a', chatbot_id: null } as any, contact);
    await assert.rejects(real.sendText('hola', 0), guard.OutboundBlockedError);
    const email = svc.transportFor({ type: 'email', account_id: 'a', chatbot_id: null } as any, { phone: '', external_id: 'cliente@ejemplo.mx' } as any);
    await assert.rejects(email.sendText('hola', 0), guard.OutboundBlockedError);
    const playground = svc.transportFor({ type: 'playground', account_id: 'a', chatbot_id: null } as any, contact);
    await playground.sendText('hola', 0);
    assert.deepEqual(fake.calls, ['text:hola'], 'solo el simulador llegó al transporte');
  } finally {
    Object.assign(config.outbound, saved);
    await svc.queue.stop();
  }
});

test('el webhook de un cliente no sale a una URL que no está permitida (antes de cualquier red)', async () => {
  try {
    sandbox(['https://hooks.permitido.example/ok']);
    await assert.rejects(postSigned('https://hooks.cliente.example/recibe', { a: 1 }, 'secreto'), guard.OutboundBlockedError);
  } finally {
    Object.assign(config.outbound, saved);
  }
});

let h: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  if (!ok) return;
  h = await createHarness();
});
after(async () => {
  Object.assign(config.outbound, saved);
  if (h) await h.app.close();
  await pool.end();
});

dbTest('la prueba manual de WhatsApp desde el panel responde 403 en sandbox y no envía', async () => {
  await h.createBot();
  try {
    sandbox([]);
    const r = await h.authed('POST', `/api/channels/${h.channelId}/whatsapp/test`, { number: '5215512345678', text: 'prueba' });
    assert.equal(r.statusCode, 403, r.body);
    assert.match(r.json().error ?? r.body, /OUTBOUND_MODE=sandbox/);
  } finally {
    Object.assign(config.outbound, saved);
  }
});

dbTest('un correo a un destino no permitido no sale en sandbox y el registro no incluye el destinatario', async () => {
  try {
    sandbox([]);
    const sentOk = await sendMail({ to: 'cliente-real@ejemplo.mx', subject: 'Asunto con dato de cliente', text: 'hola' });
    assert.equal(sentOk, false);
    const logs = await pool.query(`SELECT message FROM event_logs WHERE message LIKE 'Correo bloqueado%' ORDER BY id DESC LIMIT 1`);
    assert.equal(logs.rows.length, 1);
    assert.doesNotMatch(logs.rows[0].message, /cliente-real|Asunto con dato/);
  } finally {
    Object.assign(config.outbound, saved);
  }
});
