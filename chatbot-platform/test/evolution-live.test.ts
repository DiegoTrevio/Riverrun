/**
 * [real] Compatibilidad contra Evolution API REAL (no simulado). Se ejecuta con scripts/evolution-compat.sh, que levanta
 * un entorno aislado y desechable con el mismo docker-compose.yml de producción; sin esas variables, cada prueba se
 * omite con el motivo (nunca cuenta como pasada sin ejecutarse). No usa teléfonos: lo que necesita un WhatsApp vinculado
 * (recibir un mensaje real, entregar un envío) queda documentado en docs/evolution-api.md como verificación manual.
 *
 *   EVOLUTION_LIVE_URL, EVOLUTION_LIVE_KEY   Evolution a probar y su llave global.
 *   EVOLUTION_LIVE_EXPECT                    versión que debe informar (p. ej. 2.3.7).
 *   EVOLUTION_LIVE_PHASE                     suite (por defecto) · persist-setup · persist-check (persistencia entre reinicios/versiones)
 *                                            · incompatible (la imagen debe detectarse como incompatible).
 *   EVOLUTION_LIVE_STATE                     archivo donde persist-setup deja lo que persist-check compara.
 *   EVOLUTION_LIVE_WEBHOOK_HOST              nombre con el que Evolution llega a esta máquina (host.docker.internal).
 *   EVOLUTION_LIVE_REQUIRE_QR=true           exige el QR (solo donde Evolution tiene salida a los servidores de WhatsApp).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

const URL_ = process.env.EVOLUTION_LIVE_URL ?? '';
const KEY = process.env.EVOLUTION_LIVE_KEY ?? '';
const EXPECT = process.env.EVOLUTION_LIVE_EXPECT ?? '';
const PHASE = process.env.EVOLUTION_LIVE_PHASE ?? 'suite';
const live = !!URL_ && !!KEY;
const skip = live ? false : '[real] requiere Evolution real: scripts/evolution-compat.sh';
if (live) {
  // Para que el monitoreo de RiverRun (probeService) consulte este Evolution.
  process.env.EVOLUTION_URL = URL_;
  process.env.EVOLUTION_API_KEY = KEY;
}
const { EvolutionClient, EvolutionError, WEBHOOK_EVENTS } = await import('../src/evolution/client.js');
const { assessVersion } = await import('../src/evolution/compat.js');
const { parseWebhook } = await import('../src/evolution/parse.js');
const evo = new EvolutionClient(URL_, KEY, 30_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t = (name: string, fn: (ctx: any) => Promise<void>, phase = 'suite') => test(`[real] ${name}`, { skip: skip || (PHASE !== phase && `fase ${phase}`), timeout: 180_000 }, fn);

// Receptor de webhooks: Evolution (en su contenedor) le envía los eventos de la instancia de prueba.
const events: any[] = [];
const receiver = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    try {
      events.push({ path: req.url, body: JSON.parse(raw) });
    } catch {
      events.push({ path: req.url, body: raw });
    }
    res.writeHead(200).end('ok');
  });
});
let hookUrl = '';
const name = `rrcompat${Date.now().toString(36)}`;
const PERSIST = 'rrpersist';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

before(async () => {
  if (!live) return;
  await new Promise<void>((r) => receiver.listen(0, '0.0.0.0', r));
  hookUrl = `http://${process.env.EVOLUTION_LIVE_WEBHOOK_HOST || 'host.docker.internal'}:${(receiver.address() as any).port}/webhook/compat`;
});
after(async () => {
  receiver.close();
  if (live && PHASE === 'suite') await evo.deleteInstance(name).catch(() => undefined);
});

/* ------------------------------ Persistencia entre reinicios y versiones ------------------------------ */

t('persistencia (antes): instancia con su webhook', async () => {
  await evo.deleteInstance(PERSIST).catch(() => undefined);
  const created = await evo.createInstance(PERSIST, 'http://backend:3000/webhook/persistencia');
  const id = created?.instance?.instanceId;
  assert.ok(id, JSON.stringify(created).slice(0, 300));
  fs.writeFileSync(process.env.EVOLUTION_LIVE_STATE!, JSON.stringify({ id, webhook: 'http://backend:3000/webhook/persistencia', version: (await evo.serverInfo()).version }));
}, 'persist-setup');

t('persistencia (después): la misma instancia, el mismo webhook, sin recrear nada', async () => {
  const saved = JSON.parse(fs.readFileSync(process.env.EVOLUTION_LIVE_STATE!, 'utf8'));
  const list = await evo.request('GET', `/instance/fetchInstances?instanceName=${PERSIST}`, undefined, 0);
  assert.equal(list?.[0]?.id, saved.id, 'mismo identificador de instancia');
  const w = await evo.findWebhook(PERSIST);
  assert.equal(w?.url, saved.webhook);
  assert.ok(w?.enabled);
  for (const e of WEBHOOK_EVENTS) assert.ok(w!.events.includes(e), `evento ${e}`);
  assert.ok(['connecting', 'close', 'open'].includes(await evo.connectionState(PERSIST)));
}, 'persist-check');

/* ------------------------------ Versión incompatible ------------------------------ */

t('versión incompatible: RiverRun la detecta y la verificación posterior a actualizar falla', async () => {
  const { assessAfterChange, probeService } = await import('../src/evolution/status.js');
  const s = await probeService({ force: true });
  assert.ok(s.reachable, 'Evolution responde');
  assert.ok(s.blocked === 'license' || s.assessment.status === 'incompatible', JSON.stringify(s));
  const r = assessAfterChange(s, null, [], s.version);
  assert.equal(r.status, 'fail', JSON.stringify(r));
}, 'incompatible');

/* ------------------------------ Suite ------------------------------ */

t('autenticación: la llave correcta pasa; una equivocada o ausente se rechaza', async () => {
  assert.equal(await evo.checkApiKey(), true);
  assert.equal(await new EvolutionClient(URL_, 'llave-equivocada', 10_000).checkApiKey(), false);
  await assert.rejects(new EvolutionClient(URL_, '', 10_000).request('GET', '/instance/fetchInstances', undefined, 0), (e: any) => e.status === 401);
});

t('versión: la raíz la informa y el monitoreo de RiverRun la reconoce', async () => {
  const info = await evo.serverInfo();
  assert.ok(info.version, 'Evolution informa su versión');
  if (EXPECT) assert.equal(info.version, EXPECT);
  const { probeService } = await import('../src/evolution/status.js');
  const s = await probeService({ force: true });
  assert.deepEqual([s.reachable, s.auth, s.version, s.assessment.status], [true, true, info.version, assessVersion(info.version).status]);
});

t('crear instancia con el mismo cuerpo que RiverRun (webhook incluido)', async () => {
  const created = await evo.createInstance(name, hookUrl);
  assert.equal(created?.instance?.instanceName, name);
  assert.ok(created?.instance?.instanceId);
});

t('webhook: guarda la URL y los eventos que RiverRun necesita; se reconfigura sin recrear', async () => {
  let w = await evo.findWebhook(name);
  assert.equal(w?.url, hookUrl);
  assert.equal(w?.enabled, true);
  for (const e of WEBHOOK_EVENTS) assert.ok(w!.events.includes(e), `evento ${e}`);
  await evo.setWebhook(name, `${hookUrl}?v=2`);
  w = await evo.findWebhook(name);
  assert.equal(w?.url, `${hookUrl}?v=2`);
  await evo.setWebhook(name, hookUrl);
  assert.equal((await evo.findWebhook(name))?.url, hookUrl);
});

t('estado de conexión, perfil sin vincular y estado de una instancia inexistente', async () => {
  assert.ok(['connecting', 'close', 'open'].includes(await evo.connectionState(name)));
  const profile = await evo.fetchInstance(name);
  assert.equal(profile?.number, '', 'sin teléfono vinculado no hay número');
  await assert.rejects(evo.connectionState(`${name}x`), (e: any) => e instanceof EvolutionError && e.status === 404);
  const { whatsappAdapter } = await import('../src/channels/whatsapp.js');
  assert.deepEqual(await whatsappAdapter.status!({ config: { instance: `${name}x` } } as any), { state: 'not_found' });
});

t('QR: Evolution genera el código para vincular', async (ctx) => {
  let qr: string | undefined;
  for (let i = 0; i < 8 && !qr; i++) {
    const c = await evo.connect(name).catch(() => ({} as any));
    qr = c.base64 || events.find((e) => /qrcode/i.test(String(e.body?.event)))?.body?.data?.qrcode?.base64;
    if (!qr) await sleep(5000);
  }
  if (!qr) {
    if (process.env.EVOLUTION_LIVE_REQUIRE_QR === 'true') assert.fail('Evolution no generó el QR');
    ctx.skip('Evolution no generó el QR: este entorno no llega a los servidores de WhatsApp (verificación manual en docs/evolution-api.md)');
    return;
  }
  assert.match(qr, /^data:image\/png;base64,/);
});

t('webhooks entrantes: Evolution entrega eventos y RiverRun los interpreta', async (ctx) => {
  for (let i = 0; i < 6 && !events.length; i++) await sleep(5000);
  if (!events.length) {
    ctx.skip('Evolution no envió eventos en 30 s (sin conexión con WhatsApp no hay cambios de estado que notificar)');
    return;
  }
  const { whatsappAdapter } = await import('../src/channels/whatsapp.js');
  for (const e of events) {
    const parsed = parseWebhook(e.body);
    assert.equal(parsed.instance, name, 'el evento identifica la instancia');
    assert.ok(['connection.update', 'qrcode.updated', 'messages.upsert'].includes(parsed.event), parsed.event);
    const r = whatsappAdapter.parse({ channel: { config: { instance: name } } as any, body: e.body } as any);
    assert.ok(!r.notices?.some((n: any) => /no coincide/.test(n.message)), 'la instancia coincide con la del canal');
  }
});

t('envío de texto e imagen sin teléfono vinculado: falla de forma manejable y acotada', async () => {
  // El envío depende de la red hacia WhatsApp: sin vínculo, Evolution responde con un error HTTP o, si esa red tarda,
  // el cliente agota su tiempo (2 intentos de 30 s). Ambos son aceptables; no lo es un éxito ni un cuelgue sin límite.
  // Cualquier fallo de red o HTTP llega al llamador como EvolutionError (estado HTTP, o tiempo agotado / conexión).
  const manageable = (e: unknown) => e instanceof EvolutionError;
  const bounded = async (send: () => Promise<unknown>) => {
    const started = Date.now();
    await assert.rejects(send(), manageable);
    assert.ok(Date.now() - started < 75_000, 'termina dentro de la cota del cliente (2 intentos de 30 s)');
  };
  await bounded(() => evo.sendText(name, '5215500000000', 'prueba de compatibilidad'));
  await bounded(() => evo.sendImage(name, '5215500000000', PNG, 'image/png', 'prueba.png', 'pie'));
});

t('descarga de medios: un mensaje inexistente da un error manejable', async () => {
  await assert.rejects(evo.getMediaBase64(name, 'NO-EXISTE-0001'), (e: any) => e instanceof EvolutionError);
});

t('cerrar la sesión de una instancia ya cerrada: 400 "not connected" (el panel la da por desconectada)', async () => {
  await evo.logout(name).catch(() => undefined);
  let err: any = null;
  for (let i = 0; i < 10 && !err; i++) {
    err = await evo.logout(name).then(() => null, (e: unknown) => e);
    if (!err) await sleep(1000);
  }
  assert.ok(err instanceof EvolutionError, 'una sesión cerrada no se vuelve a cerrar');
  assert.equal(err.status, 400);
  assert.match(err.message, /not connected/i, 'el texto que reconoce POST /whatsapp/logout');
});

t('eliminar y recrear la instancia con el mismo nombre', async () => {
  await evo.logout(name).catch(() => undefined);
  await evo.deleteInstance(name);
  // Evolution la libera de forma asíncrona (RiverRun lo contempla: createOrWait reintenta mientras el nombre siga ocupado).
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) {
    gone = await evo.connectionState(name).then(() => false, (e: any) => e.status === 404);
    if (!gone) await sleep(1000);
  }
  assert.ok(gone, 'la instancia borrada deja de existir');
  let created: any = null;
  // Como RiverRun (createOrWait): Evolution tarda un momento en liberar el nombre.
  for (let i = 0; i < 15 && !created; i++) {
    created = await evo.createInstance(name, hookUrl).catch(async (e: any) => {
      if (!(e.status === 409 || e.status === 403)) throw e;
      await sleep(1000);
      return null;
    });
  }
  assert.equal(created?.instance?.instanceName, name);
  assert.equal((await evo.findWebhook(name))?.url, hookUrl, 'la instancia recreada trae su webhook');
});
