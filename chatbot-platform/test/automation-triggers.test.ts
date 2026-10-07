import { after, afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, store, waitFor } from './harness.js';
const available = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, {skip: !available && 'PostgreSQL no disponible'}, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
beforeEach(async () => { if (available) { h = await createHarness(); await h.createBot(); h.setScript(() => ({messages:['Hola.']})); } });
afterEach(async () => { if (h) await h.app.close(); });
after(async () => { await pool.end(); });
async function rule(type: string, extra = {}) {
  const response = await h.authed('POST','/api/automations',{account_id:h.accountId,name:`Audit ${type}`,trigger:{type,...extra},actions:[{type:'add_tag',tag:`fired_${type}`} ]});
  assert.equal(response.statusCode,200,response.body);
  return response.json().id as string;
}
async function runs(id: string) { return (await pool.query('SELECT run_count FROM automations WHERE id=$1',[id])).rows[0].run_count as number; }
async function live(phone = '5215599900001') {
  const before = h.sent.length;
  await h.webhook('hola',{phone});
  await waitFor(() => h.sent.length > before); await h.idle();
  const conv = await h.conversationFor(phone);
  await h.service.automator.settle(conv.id);
  return conv;
}
t('nuevo contacto y primer mensaje ignoran historial y reacciones, sin repetirse', async () => {
  const fresh = await rule('new_contact');
  const first = await rule('message_received',{match:'any',first_message_only:true});
  await h.webhook('histórico',{timestamp:Math.floor(Date.now()/1000)-3600});
  await waitFor(async () => !!(await h.conversationFor('5215511112222')));
  const conv = await h.conversationFor('5215511112222');
  await store.insertMessage({conversation_id:conv.id,direction:'in',sender:'customer',type:'reaction',content:'👍',processed:true});
  assert.equal(await runs(fresh),0);
  await live('5215511112222');
  assert.equal(await runs(fresh),1); assert.equal(await runs(first),1);
  await live('5215511112222');
  assert.equal(await runs(fresh),1); assert.equal(await runs(first),1);
});
t('primer mensaje concurrente se reconoce por su ID, no por contar mensajes', async () => {
  const fresh = await rule('new_contact');
  const channel = (await store.getChannel(h.channelId))!;
  const contact = await store.upsertContact(channel,'concurrent@s.whatsapp.net','5215599900009','Ana');
  const conv = await store.getOrCreateConversation(channel,contact.id);
  // Both incoming records already exist when automation handles the first one.
  const a = (await store.insertMessage({conversation_id:conv.id,direction:'in',sender:'customer',content:'primero',type:'text'}))!;
  const b = (await store.insertMessage({conversation_id:conv.id,direction:'in',sender:'customer',content:'segundo',type:'text'}))!;
  await Promise.all([h.service.automator.onInbound(conv,contact,a,'primero'),h.service.automator.onInbound(conv,contact,b,'segundo')]);
  assert.equal(await runs(fresh),1);
});
t('datos del panel activan captura, conservan ambas copias y no repiten valores iguales o vacíos', async () => {
  const capture = await rule('data_captured',{field:'correo'});
  const name = await rule('data_captured',{field:'nombre'});
  const conv = await live();
  const payload = {name:'Diego',data:{correo:'diego@example.test'}};
  const response = await h.authed('PUT',`/api/contacts/${conv.contact_id}`,payload);
  assert.equal(response.statusCode,200,response.body);
  assert.equal(await runs(capture),1); assert.equal(await runs(name),1);
  assert.equal((await store.getContact(conv.contact_id))!.data.correo,payload.data.correo);
  assert.equal((await store.getConversation(conv.id))!.data.correo,payload.data.correo);
  await Promise.all([h.authed('PUT',`/api/contacts/${conv.contact_id}`,payload),h.authed('PUT',`/api/contacts/${conv.contact_id}`,payload)]);
  assert.equal(await runs(capture),1); assert.equal(await runs(name),1);
  await h.authed('PUT',`/api/contacts/${conv.contact_id}`,{data:{correo:''}});
  assert.equal(await runs(capture),1);
  await h.authed('PUT',`/api/contacts/${conv.contact_id}`,{data:{correo:'nuevo@example.test'}});
  assert.equal(await runs(capture),2);
});
t('baja del panel dispara una vez, detiene secuencias y permite una nueva baja tras el alta', async () => {
  const opt = await rule('opt_out'); const conv = await live();
  const seq = (await h.authed('POST','/api/sequences',{account_id:h.accountId,name:'Pending',steps:[{delay_value:1,delay_unit:'days',text:'Seguimiento'}]})).json();
  await h.service.automator.enroll(seq.id,conv.id,'test');
  const response = await h.authed('PUT',`/api/contacts/${conv.contact_id}`,{opted_out:true});
  assert.equal(response.statusCode,200,response.body); assert.equal(await runs(opt),1);
  assert.equal((await pool.query('SELECT status FROM sequence_enrollments WHERE conversation_id=$1',[conv.id])).rows[0].status,'stopped');
  await h.authed('PUT',`/api/contacts/${conv.contact_id}`,{opted_out:true});
  assert.equal(await runs(opt),1);
  await h.authed('PUT',`/api/contacts/${conv.contact_id}`,{opted_out:false});
  await Promise.all([h.authed('PUT',`/api/contacts/${conv.contact_id}`,{opted_out:true}),h.authed('PUT',`/api/contacts/${conv.contact_id}`,{opted_out:true})]);
  assert.equal(await runs(opt),2);
});
t('tomar desde el panel emite transferencia una vez incluso con llamadas simultáneas', async () => {
  const handoff = await rule('handoff'); const conv = await live();
  await Promise.all([h.authed('POST',`/api/conversations/${conv.id}/takeover`,{}),h.authed('POST',`/api/conversations/${conv.id}/takeover`,{})]);
  await h.service.automator.settle(conv.id);
  assert.equal(await runs(handoff),1);
  await h.authed('POST',`/api/conversations/${conv.id}/release`,{});
  await h.authed('POST',`/api/conversations/${conv.id}/takeover`,{});
  await h.service.automator.settle(conv.id); assert.equal(await runs(handoff),2);
});
t('responder desde el panel o el teléfono dispara transferencia; el eco no la repite', async () => {
  const handoff = await rule('handoff'); const conv = await live();
  const sent = await h.authed('POST',`/api/conversations/${conv.id}/send`,{text:'Atiendo yo'});
  assert.equal(sent.statusCode,200,sent.body); await h.service.automator.settle(conv.id);
  assert.equal(await runs(handoff),1);
  await h.authed('POST',`/api/conversations/${conv.id}/release`,{});
  const channel = (await store.getChannel(h.channelId))!;
  const own = {messageId:'PHONE-HUMAN',externalId:'5215599900001@s.whatsapp.net',phone:'5215599900001',displayName:'',fromMe:true,type:'text' as const,text:'Respuesta humana desde teléfono',timestamp:Math.floor(Date.now()/1000)};
  await h.service.handleIncoming(channel,own);
  await h.service.automator.settle(conv.id); assert.equal(await runs(handoff),2);
  await h.service.handleIncoming(channel,own);
  await h.service.automator.settle(conv.id); assert.equal(await runs(handoff),2);
});
t('editar un contacto de otro perfil no escribe ni dispara reglas', async () => {
  const capture = await rule('data_captured'); const opt = await rule('opt_out'); const conv = await live();
  await h.authed('POST','/api/accounts',{name:'Otro',admin:{email:'other@audit.test',password:'other-audit-password'}});
  const other = await h.loginAs('other@audit.test','other-audit-password');
  const response = await other('PUT',`/api/contacts/${conv.contact_id}`,{data:{correo:'wrong@example.test'},opted_out:true});
  assert.equal(response.statusCode,404); assert.equal(await runs(capture),0); assert.equal(await runs(opt),0);
});
t('el cierre espera los eventos de transferencia para guardar sus acciones', async () => {
  const handoff = await rule('handoff'); const conv = await live();
  const handle = h.service.automator.handle.bind(h.service.automator);
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  h.service.automator.handle = async event => {
    if (event.type !== 'handoff') return handle(event);
    started(); await new Promise<void>(resolve => { release = resolve; });
    return handle(event);
  };
  await h.authed('POST',`/api/conversations/${conv.id}/takeover`,{});
  await pending;
  let closed = false;
  const closing = h.app.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed,false);
  release(); await closing;
  assert.equal(await runs(handoff),1);
});
