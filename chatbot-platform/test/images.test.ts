/** Fotos en el momento que decide el negocio: por palabra, bienvenida, etapa, objetivo; envío manual y fallas. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
// El arnés va primero: define las variables de entorno antes de que se cargue la configuración.
import { createHarness, dbAvailable, pool, sleep, store } from './harness.js';
const { imagesAfterReply } = await import('../src/engine/images.js');

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
const IDS: Record<string, string> = {};

const PNG = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C6360000002000154A24F5D0000000049454E44AE426082', 'hex');
async function upload(code: string, name: string, sendWhen: Record<string, unknown>, extra: Record<string, string> = {}) {
  const b = '----x';
  const part = (n: string, v: string) => `--${b}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const fields = { code, name, caption: '', send_when: JSON.stringify(sendWhen), ...extra };
  const body = Buffer.concat([
    Buffer.from(Object.entries(fields).map(([k, v]) => part(k, v)).join('')),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${code}.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  const r = await h.app.inject({ method: 'POST', url: `/api/chatbots/${h.botId}/images`, payload: body, headers: { cookie: h.cookie, 'content-type': `multipart/form-data; boundary=${b}` } });
  assert.equal(r.statusCode, 200, r.body);
  IDS[code] = r.json().id;
  return r.json();
}
const say = async (text: string, phone: string) => {
  const r = await h.webhook(text, { phone });
  assert.equal(r.statusCode, 200, r.body);
  await sleep(350);
  await h.idle();
};
const photosTo = (phone: string) => h.sent.filter((s) => s.kind === 'image' && s.to === phone).map((s) => s.image);
const prompt = () => String(h.calls[h.calls.length - 1].messages[0].content);

before(async () => {
  if (!ok) return;
  h = await createHarness();
  await h.createBot({ flow: { goal: 'Que el cliente reserve', steps: [{ title: 'Saludo' }, { title: 'Pedir fechas' }] } });
  await upload('menu', 'Menú del día', { mode: 'rules', keywords: ['menú', 'carta'] });
  await upload('bienvenida', 'Bienvenida', { mode: 'rules', first_message: true });
  await upload('mapa', 'Mapa', { mode: 'both', flow_steps: [2] });
  await upload('gracias', 'Gracias', { mode: 'rules', on_goal: true });
  await upload('suite', 'Suite', {}, { usage_rule: 'Cuando pregunten por la suite' });
});
after(async () => {
  if (h) await h.app.close();
  await pool.end();
});

test('después de responder: etapa, objetivo y cita; "una sola vez" no repite (función pura)', () => {
  const img = (id: string, send_when: unknown) => ({ id, code: id, name: id, send_when } as any);
  const imgs = [img('a', { mode: 'rules', flow_steps: [2] }), img('b', { mode: 'rules', on_goal: true }), img('c', { mode: 'both', on_booking: true }), img('d', { mode: 'ai', on_booking: true })];
  const pick = (o: Partial<Parameters<typeof imagesAfterReply>[1]>) => imagesAfterReply(imgs, { stepReached: 0, goalReached: false, booked: false, sentIds: [], skip: [], ...o }).map((x) => x.image.id);
  assert.deepEqual(pick({ stepReached: 2 }), ['a']);
  assert.deepEqual(pick({ goalReached: true }), ['b']);
  assert.deepEqual(pick({ booked: true }), ['c'], 'en modo "La IA decide" el sistema no la envía solo');
  assert.deepEqual(pick({ booked: true, sentIds: ['c'] }), [], 'ya enviada');
});

t('bienvenida: sale con la primera respuesta; la IA sabe cuáles se envían solas y no puede elegirlas', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola! Bienvenida.'] }));
  const phone = '5215540000001';
  await say('hola', phone);
  assert.deepEqual(h.sent.filter((s) => s.to === phone).map((s) => s.kind), ['text', 'image'], 'primero el texto y luego la foto');
  assert.deepEqual(photosTo(phone), ['bienvenida']);
  const p = prompt();
  assert.match(p, /El sistema envía estas fotos solo en sus momentos \(NO las pongas en image_ids\)[\s\S]*`menu` \| Menú del día: el cliente escribe "menú" o "carta"/);
  // "Ambos": la IA puede elegirla y el prompt dice cuándo la envía sola (sin decirle que no la use).
  assert.match(p, /ID: `mapa` \| Mapa[^\n]*además el sistema la envía sola al llegar a la etapa 2 \(Pedir fechas\)/);
  assert.match(p, /En ESTA respuesta el sistema enviará: Bienvenida/);
  assert.ok(!p.includes('ID: `menu`'), 'las de "solo en estos momentos" no están en el catálogo de la IA');
  assert.ok(p.includes('ID: `suite`') && p.includes('ID: `mapa`'));
  await say('¿qué tal?', phone);
  assert.deepEqual(photosTo(phone), ['bienvenida'], 'solo en la primera respuesta');
});

t('por palabra: "menú" envía la foto aunque la IA no la incluya; se reenvía si la vuelve a pedir', async () => {
  h.reset();
  const phone = '5215540000002';
  await say('hola', phone); // bienvenida
  h.setScript(() => ({ messages: ['Claro, te comparto el menú.'] }));
  await say('¿Me pasas el menú?', phone);
  assert.equal(h.sent.filter((s) => s.kind === 'text').at(-1)!.text, 'Claro, te comparto el menú.', 'no se bloquea como "promesa de foto"');
  assert.deepEqual(photosTo(phone), ['bienvenida', 'menu']);
  h.setScript(() => ({ messages: ['¡Con gusto!'] }));
  await say('gracias', phone);
  assert.deepEqual(photosTo(phone), ['bienvenida', 'menu']);
  await say('mándame otra vez la carta', phone);
  assert.deepEqual(photosTo(phone), ['bienvenida', 'menu', 'menu']);
  const logs = (await pool.query(`SELECT message FROM event_logs WHERE conversation_id = $1`, [(await h.conversationFor(phone)).id])).rows.map((r) => r.message).join('\n');
  assert.match(logs, /Foto enviada por regla: menu \(el cliente escribió "menú"\)/);
});

t('la IA no puede enviar por su cuenta una foto de "solo en estos momentos"', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola!'] }));
  const phone = '5215540000003';
  await say('hola', phone);
  h.setScript(() => ({ action: 'reply_with_image', messages: ['Aquí está.'], image_ids: ['menu', 'suite'] }));
  await say('¿cómo es la suite?', phone);
  assert.deepEqual(photosTo(phone), ['bienvenida', 'suite']);
});

t('etapa del recorrido y objetivo: cada foto sale una sola vez al llegar', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola!'] }));
  const phone = '5215540000004';
  await say('hola', phone);
  h.setScript(() => ({ messages: ['¿Para qué fechas?'], flow_step: 2 }));
  await say('quiero reservar', phone);
  assert.deepEqual(photosTo(phone), ['bienvenida', 'mapa']);
  await say('aún no sé', phone);
  assert.deepEqual(photosTo(phone), ['bienvenida', 'mapa'], 'sigue en la etapa 2: no se repite');
  h.setScript(() => ({ messages: ['¡Listo, reservado!'], flow_step: 2, goal_completed: true }));
  await say('del 3 al 5', phone);
  assert.deepEqual(photosTo(phone), ['bienvenida', 'mapa', 'gracias']);
});

t('si la IA decide no responder, la foto pedida sale igual; en una transferencia no', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola!'] }));
  const phone = '5215540000005';
  await say('hola', phone);
  h.setScript(() => ({ action: 'no_reply', messages: [] }));
  await say('menú', phone);
  assert.deepEqual(photosTo(phone), ['bienvenida', 'menu']);
  h.setScript(() => ({ action: 'handoff', messages: ['Te paso con alguien.'], handoff_reason: 'quiere pagar' }));
  await say('quiero pagar, y mándame el menú', phone);
  assert.deepEqual(photosTo(phone), ['bienvenida', 'menu'], 'al transferir no se envía');
});

t('envío manual desde la conversación: el agente manda una foto; otra cuenta o desactivada no', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola!'] }));
  const phone = '5215540000006';
  await say('hola', phone);
  const conv = await h.conversationFor(phone);
  assert.equal((await h.authed('POST', '/api/users', { account_id: h.accountId, email: 'agente@hotel.mx', name: 'Agente', password: 'clave-segura-1', role: 'agent' })).statusCode, 200);
  const agent = await h.loginAs('agente@hotel.mx', 'clave-segura-1');
  assert.equal((await agent('GET', `/api/chatbots/${h.botId}/images`)).statusCode, 200, 'el agente ve el catálogo');
  // Un agente solo escribe en las conversaciones que tiene asignadas.
  assert.equal((await h.authed('PUT', `/api/conversations/${conv.id}/assign`, { user_id: (await agent('GET', '/api/me')).json().user.id })).statusCode, 200);
  const r = await agent('POST', `/api/conversations/${conv.id}/send-image`, { image_id: IDS.suite });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().sender, 'human');
  assert.equal(r.json().image_id, IDS.suite);
  assert.deepEqual(photosTo(phone), ['bienvenida', 'suite']);
  assert.equal((await h.authed('GET', `/api/conversations/${conv.id}`)).json().conversation.status, 'human', 'como el texto manual: toma la conversación');

  // Foto de otra cuenta → 404; desactivada → 400 (y no toma la conversación).
  const acc = (await h.authed('POST', '/api/accounts', { name: 'Otra' })).json();
  const bot = (await h.authed('POST', '/api/chatbots', { account_id: acc.id, name: 'Otro' })).json();
  const foreign = (await pool.query(`INSERT INTO images (chatbot_id, code, name, file_path, mime_type) VALUES ($1,'x','X','x.png','image/png') RETURNING id`, [bot.id])).rows[0].id;
  assert.equal((await agent('POST', `/api/conversations/${conv.id}/send-image`, { image_id: foreign })).statusCode, 404);
  await pool.query(`UPDATE images SET active = false WHERE id = $1`, [IDS.mapa]);
  const off = await agent('POST', `/api/conversations/${conv.id}/send-image`, { image_id: IDS.mapa });
  assert.equal(off.statusCode, 400);
  assert.match(off.json().error, /desactivada/);
  await pool.query(`UPDATE images SET active = true WHERE id = $1`, [IDS.mapa]);
});

t('si WhatsApp rechaza la foto: queda como fallida, en Registros, y el panel muestra el error', async () => {
  h.reset();
  h.setScript(() => ({ messages: ['¡Hola!'] }));
  const phone = '5215540000007';
  await say('hola', phone);
  const conv = await h.conversationFor(phone);
  h.failNext.image = 1;
  const r = await h.authed('POST', `/api/conversations/${conv.id}/send-image`, { image_id: IDS.suite, takeover: false });
  assert.equal(r.statusCode, 400);
  const msg = (await pool.query(`SELECT status FROM messages WHERE conversation_id = $1 AND image_id = $2`, [conv.id, IDS.suite])).rows[0];
  assert.equal(msg.status, 'failed');
  const logs = (await pool.query(`SELECT message FROM event_logs WHERE conversation_id = $1`, [conv.id])).rows.map((x) => x.message).join('\n');
  assert.match(logs, /No se pudo enviar la imagen suite \(whatsapp\): Evolution sendMedia → HTTP 400/);
  // Una foto fallida no cuenta como enviada: la siguiente vez sí sale.
  assert.equal((await h.authed('POST', `/api/conversations/${conv.id}/send-image`, { image_id: IDS.suite, takeover: false })).statusCode, 200);
});

t('probador de palabras: dice qué foto se enviaría', async () => {
  const r = (await h.authed('POST', `/api/chatbots/${h.botId}/test-message`, { text: '¿tienen carta?', first_message: false })).json();
  assert.ok(r.steps.some((s: any) => s.kind === 'images' && /"Menú del día" \(el cliente escribió "carta"\)/.test(s.detail)), JSON.stringify(r.steps));
});

t('pregunta del asistente: guarda la regla, la aplica sin elección de IA y no duplica la foto', async () => {
  await upload('opciones', 'Tipos de habitación', {mode:'both',assistant_keywords:['qué tipo de habitación'],once:true});
  const saved = (await h.authed('GET',`/api/chatbots/${h.botId}/images`)).json().find((img:any)=>img.code==='opciones');
  assert.deepEqual(saved.send_when.assistant_keywords,['qué tipo de habitación']);
  h.reset(); const phone='5215540000010';
  h.setScript(()=>({messages:['Hola.']})); await say('hola',phone);
  h.setScript(()=>({action:'ask',messages:['¿Qué tipo de habitación prefieres? Te comparto la foto.'],image_ids:[]}));
  await say('quiero reservar',phone);
  assert.deepEqual(photosTo(phone),['bienvenida','opciones']);
  assert.match(prompt(),/el asistente dice o pregunta "qué tipo de habitación"/);
  h.setScript(()=>({action:'ask',messages:['¿Qué tipo de habitación prefieres?']}));
  await say('todavía no sé',phone);
  assert.deepEqual(photosTo(phone),['bienvenida','opciones']);
  await h.authed('PUT',`/api/images/${IDS.opciones}`,{send_when:{mode:'rules',assistant_keywords:['qué tipo de habitación'],once:false}});
  await say('sigo pensando',phone);
  assert.deepEqual(photosTo(phone),['bienvenida','opciones','opciones']);
  await h.authed('PUT',`/api/images/${IDS.opciones}`,{active:false});
});

t('pregunta del asistente no permite fotos por texto interno, no_reply o transferencia', async () => {
  await upload('interno','Prueba interna',{mode:'rules',assistant_keywords:['qué tipo de habitación']});
  h.reset(); const phone='5215540000011';
  h.setScript(()=>({messages:['Hola.']})); await say('hola',phone);
  h.setScript(()=>({thinking:'qué tipo de habitación',messages:['¿En qué te ayudo?']}));
  await say('quiero información',phone);
  h.setScript(()=>({action:'no_reply',messages:['qué tipo de habitación']})); await say('ok',phone);
  h.setScript(()=>({action:'handoff',messages:['¿Qué tipo de habitación prefieres?'],handoff_reason:'Atención humana'})); await say('quiero pagar',phone);
  assert.deepEqual(photosTo(phone),['bienvenida']);
  await h.authed('PUT',`/api/images/${IDS.interno}`,{active:false});
});

t('contexto de etapa permite anunciar la foto automática y el contexto libre llega al modelo', async () => {
  h.reset(); const phone='5215540000012';
  h.setScript(()=>({messages:['Hola.']})); await say('hola',phone);
  h.setScript(()=>({messages:['¿Para qué fechas? Te comparto la imagen.'],flow_step:2}));
  await say('quiero reservar',phone);
  assert.deepEqual(photosTo(phone),['bienvenida','mapa']);
  h.setScript(req=>{
    assert.match(req.messages[0].content,/ID: `suite`[\s\S]*enviar cuando: Cuando pregunten por la suite/);
    return {action:'reply_with_image',messages:['Esta es la suite.'],image_ids:['suite']};
  });
  await say('¿cómo es la suite?',phone);
  assert.deepEqual(photosTo(phone),['bienvenida','mapa','suite']);
});

t('solo confirma en registros fotos entregadas y una foto fallida puede pedirse otra vez', async () => {
  h.reset(); const phone='5215540000013';
  h.setScript(()=>({messages:['Hola.']})); await say('hola',phone);
  h.failNext.image=1; h.setScript(()=>({messages:['Aquí está.']})); await say('menú',phone);
  const conv=await h.conversationFor(phone);
  let logs=(await pool.query('SELECT message FROM event_logs WHERE conversation_id=$1',[conv.id])).rows.map(r=>r.message);
  assert.ok(!logs.some(msg=>msg.includes('Foto enviada por regla: menu')));
  assert.ok(logs.some(msg=>msg.includes('No se pudo enviar la imagen menu')));
  await say('carta',phone);
  assert.equal(photosTo(phone).filter(code=>code==='menu').length,1);
  logs=(await pool.query('SELECT message FROM event_logs WHERE conversation_id=$1',[conv.id])).rows.map(r=>r.message);
  assert.equal(logs.filter(msg=>msg.includes('Foto enviada por regla: menu')).length,1);
});

t('la bienvenida ignora historial antiguo; el límite se aplica a fotos automáticas y de IA juntas', async () => {
  h.reset(); const phone='5215540000014';
  await h.webhook('histórico',{phone,timestamp:Math.floor(Date.now()/1000)-3600});
  await sleep(100);
  h.setScript(()=>({messages:['Hola.']})); await say('hola',phone);
  assert.deepEqual(photosTo(phone),['bienvenida']);
  await h.authed('PUT',`/api/chatbots/${h.botId}`,{rules:{max_images_per_reply:1}});
  // La IA eligió y anunció la suite: sale en la respuesta; la foto de la regla (menú) no cabe y sale unos segundos después.
  h.setScript(()=>({messages:['Aquí está.'],image_ids:['suite']})); await say('menú',phone);
  assert.deepEqual(photosTo(phone),['bienvenida','suite']);
  const logs=(await pool.query('SELECT message FROM event_logs WHERE conversation_id=$1',[(await h.conversationFor(phone)).id])).rows.map(r=>r.message);
  assert.ok(logs.some(msg=>msg.includes('no caben en esta respuesta (límite de 1); se envían enseguida: menu')), logs.join(' | '));
  await h.fastForward();
  assert.deepEqual(photosTo(phone),['bienvenida','suite','menu']);
  await h.authed('PUT',`/api/chatbots/${h.botId}`,{rules:{max_images_per_reply:2}});
});

t('una foto elegida por IA y por regla se envía una vez y solo en el contexto coincidente', async () => {
  await upload('catalogo','Catálogo',{mode:'both',keywords:['catálogo']},{usage_rule:'Cuando el cliente pida ver el catálogo'});
  h.reset(); const phone='5215540000015';
  h.setScript(()=>({messages:['Hola.']})); await say('hola',phone);
  h.setScript(()=>({messages:['Claro.'],image_ids:['catalogo']})); await say('catálogo',phone);
  assert.deepEqual(photosTo(phone),['bienvenida','catalogo']);
  h.setScript(()=>({messages:['¿En qué te ayudo?']})); await say('gracias',phone);
  assert.deepEqual(photosTo(phone),['bienvenida','catalogo']);
  await h.authed('PUT',`/api/images/${IDS.catalogo}`,{active:false});
});

t('una foto pendiente o fallida no cuenta como entregada', async () => {
  h.reset(); const phone='5215540000016';
  h.setScript(()=>({messages:['Hola.']})); await say('hola',phone);
  const conv=await h.conversationFor(phone);
  await pool.query("INSERT INTO messages (conversation_id,direction,sender,type,image_id,status) VALUES ($1,'out','bot','image',$2,'pending')",[conv.id,IDS.suite]);
  assert.ok(!(await store.sentImageIds(conv.id)).includes(IDS.suite));
  await pool.query("UPDATE messages SET status='ok' WHERE conversation_id=$1 AND image_id=$2",[conv.id,IDS.suite]);
  assert.ok((await store.sentImageIds(conv.id)).includes(IDS.suite));
});

t('contexto de cita: envía indicaciones solo cuando la reserva se confirma', async () => {
  await upload('indicaciones','Indicaciones de la cita',{mode:'rules',on_booking:true});
  const service = (await h.authed('POST','/api/services',{account_id:h.accountId,name:'Visita',duration_minutes:30,min_notice_minutes:0,max_days_ahead:5,notify_team:false,reminders:[]})).json();
  const slots=(await h.authed('GET',`/api/services/${service.id}/slots`)).json();
  assert.ok(slots.length>0);
  h.reset(); const phone='5215540000017';
  h.setScript(()=>({messages:['Hola.']})); await say('hola',phone);
  h.setScript(()=>({messages:['Listo. Te comparto la imagen.'],booking:{action:'book',service_id:service.id,slot:slots[0].key,appointment_id:''}}));
  await say('quiero ese horario',phone);
  assert.deepEqual(photosTo(phone),['bienvenida','indicaciones']);
  const conv=await h.conversationFor(phone);
  assert.equal((await pool.query("SELECT count(*)::int n FROM appointments WHERE conversation_id=$1 AND status='confirmed'",[conv.id])).rows[0].n,1);
  await say('quiero ese mismo horario','5215540000018');
  assert.ok(!photosTo('5215540000018').includes('indicaciones'));
  await h.authed('PUT',`/api/images/${IDS.indicaciones}`,{active:false});
});

t('contexto semántico en modo reglas: usa intención e historial sin coincidencia de términos', async () => {
  const condition='Cuando el cliente necesite comparar alternativas de alojamiento';
  await upload('comparacion','Comparación de opciones',{mode:'rules',context:condition});
  h.reset(); const phone='5215540000020';
  h.setScript(()=>({messages:['¿Cómo te ayudo?']})); await say('vamos dos parejas',phone);
  h.setScript(req=>{
    const system=req.messages[0].content;
    assert.match(system,/Fotos por contexto \(usa context_image_ids, no image_ids\)/);
    assert.ok(system.includes(condition));
    assert.ok(JSON.stringify(req.messages).includes('vamos dos parejas'));
    assert.ok(!system.includes('ID: `comparacion`'), 'no habilita libre elección para una foto solo por reglas');
    return {action:'reply',messages:['Te comparto la imagen para que elijas.'],context_image_ids:['comparacion']};
  });
  await say('¿me enseñas cómo es cada una para decidir?',phone);
  assert.deepEqual(photosTo(phone),['bienvenida','comparacion']);
  const conv=await h.conversationFor(phone);
  const image=(await pool.query('SELECT meta,status FROM messages WHERE conversation_id=$1 AND image_id=$2',[conv.id,IDS.comparacion])).rows[0];
  assert.equal(image.status,'ok'); assert.equal(image.meta.image_trigger,`contexto: ${condition}`);
  h.setScript(()=>({messages:['Claro.'],context_image_ids:['comparacion']})); await say('gracias',phone);
  assert.deepEqual(photosTo(phone),['bienvenida','comparacion']);
  await h.authed('PUT',`/api/images/${IDS.comparacion}`,{send_when:{mode:'rules',context:condition,once:false}});
  await say('¿me las vuelves a enseñar?',phone);
  assert.deepEqual(photosTo(phone),['bienvenida','comparacion','comparacion']);
  await h.authed('PUT',`/api/images/${IDS.comparacion}`,{active:false});
});

t('contexto no coincidente no manda foto; selección contextual y otros disparadores no duplican', async () => {
  await upload('situacion','Opciones',{mode:'both',context:'Al explicar opciones de habitaciones',assistant_keywords:['cuál prefieres'],once:false});
  h.reset(); const phone='5215540000021';
  h.setScript(()=>({messages:['Hola.']})); await say('hola',phone);
  assert.deepEqual(photosTo(phone),['bienvenida']);
  h.setScript(()=>({messages:['¿Cuál prefieres?'],context_image_ids:['situacion'],image_ids:['situacion']}));
  await say('quiero elegir una',phone);
  assert.deepEqual(photosTo(phone),['bienvenida','situacion']);
  await h.authed('PUT',`/api/images/${IDS.situacion}`,{active:false});
});

t('contexto descarta fotos inexistentes, sin condición, inactivas o de otro agente', async () => {
  await upload('contexto_off','Desactivada',{mode:'rules',context:'Al explicar opciones'});
  await h.authed('PUT',`/api/images/${IDS.contexto_off}`,{active:false});
  const account=(await h.authed('POST','/api/accounts',{name:'Otra cuenta de imágenes'})).json();
  const bot=(await h.authed('POST','/api/chatbots',{account_id:account.id,name:'Otro'})).json();
  await pool.query("INSERT INTO images (chatbot_id,code,name,file_path,mime_type,send_when) VALUES ($1,'privada','Privada','private.png','image/png',$2)",[bot.id,JSON.stringify({mode:'rules',context:'Al explicar opciones'})]);
  h.reset(); const phone='5215540000022';
  h.setScript(()=>({messages:['Hola.']})); await say('hola',phone);
  h.setScript(()=>({messages:['¿Cómo te ayudo?'],context_image_ids:['privada','contexto_off','suite','desconocida']}));
  await say('quiero ver opciones',phone);
  assert.deepEqual(photosTo(phone),['bienvenida']);
  assert.ok(!prompt().includes('ID de contexto: `privada`'));
});
