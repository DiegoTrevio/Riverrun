import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createHarness,dbAvailable,pool,store,waitFor} from './harness.js';
const {config}=await import('../src/config.js');
const {setPool}=await import('../src/db.js');
const {indexKnowledge,semanticKnowledge,knowledgeIndexStatus}=await import('../src/engine/knowledge.js');
const {semanticPolicy}=await import('../src/engine/semantic-policy.js');
const {KnowledgeWorker}=await import('../src/engine/knowledge-preparation.js');
const ok=await dbAvailable();
const t=(name:string,fn:()=>Promise<void>)=>test(name,{skip:!ok},fn);
let h:Awaited<ReturnType<typeof createHarness>>;
const original={enabled:config.knowledgeSearch.enabled,key:config.openai.apiKey,retry:config.queue.retryMs,poll:config.queue.pollMs};
const vector=Array.from({length:1536},(_,i)=>i===0?1:0);
let embeddings=0;
const fake={complete:async()=>{throw new Error('not used');},transcribe:async()=>'',embed:async(texts:string[],model:string)=>{embeddings++;return {vectors:texts.map(()=>vector),model,input_tokens:texts.length*10,latency_ms:1,cost_usd:0.00001};}};
before(async()=>{if(!ok)return;config.queue.retryMs=50;config.queue.pollMs=50;config.knowledgeSearch.enabled=false;config.openai.apiKey='synthetic-test-provider';h=await createHarness();await h.createBot({ai:{debounce_seconds:0,typing_simulation:false}});h.ai.embed=fake.embed;});
after(async()=>{config.knowledgeSearch.enabled=original.enabled;config.openai.apiKey=original.key;config.queue.retryMs=original.retry;config.queue.pollMs=original.poll;if(h)await h.app.close();await pool.end();});
const path=()=>`/api/chatbots/${h.botId}/semantic`;
const msg=(phone:string,text='hola')=>h.webhook(text,{phone});
async function conversation(phone:string) {await waitFor(async()=>!!await h.conversationFor(phone));return h.conversationFor(phone);}

t('activación por empresa verifica, prepara, compara y revierte sin habilitar a otros clientes',async()=>{
 const other=await store.createAccount('Aislada');
 await store.upsertKnowledge(h.botId,{title:'Tarifa',content:'Hotel: habitación doble por $1,650.',source_url:'https://example.com/tarifas'});
 assert.equal((await semanticPolicy(h.accountId)).enabled,false);
 assert.equal((await h.authed('PUT',path(),{enabled:true})).statusCode,409);
 const verify=await h.authed('POST',path()+'/verify',{});assert.equal(verify.statusCode,200,verify.body);
 const prepare=await h.authed('POST',path()+'/prepare',{daily_token_budget:10000});assert.equal(prepare.statusCode,200,prepare.body);
 assert.equal((await semanticPolicy(h.accountId)).enabled,false,'preparar no modifica respuestas actuales');
 const comparison=await h.authed('POST',path()+'/test',{query:'¿Cuánto vale una estancia?'});assert.equal(comparison.statusCode,200,comparison.body);assert.equal(comparison.json().semantic[0].source_url,'https://example.com/tarifas');
 const activate=await h.authed('PUT',path(),{enabled:true});assert.equal(activate.statusCode,200,activate.body);assert.equal((await semanticPolicy(other.id)).enabled,false);
 assert.equal((await h.authed('PUT',path(),{enabled:false})).statusCode,200);assert.equal((await semanticPolicy(h.accountId)).enabled,false);
});
t('un administrador ajeno no puede verificar, preparar, probar ni cambiar el conocimiento de la empresa',async()=>{
 const other=await store.createAccount('Otro cliente');await h.addUser({account_id:other.id,email:'other-architecture@test.mx',name:'Otro',password:'Pz-947-Qx-948-Kv',role:'admin'});
 const user=await h.loginAs('other-architecture@test.mx','Pz-947-Qx-948-Kv');
 for(const [method,suffix,body] of [['GET','',undefined],['POST','/verify',{}],['POST','/prepare',{daily_token_budget:10000}],['POST','/test',{query:'tarifa'}],['PUT','',{enabled:true}]] as const) {
  assert.equal((await user(method,path()+suffix,body)).statusCode,404);
 }
});
t('índice incompleto se reanuda usando embeddings ya guardados; presupuesto y caché quedan aislados',async()=>{
 await pool.query('UPDATE semantic_settings SET preparing=true WHERE account_id=$1',[h.accountId]);
 const k=await store.upsertKnowledge(h.botId,{title:'Documento extenso',content:'Información autorizada. '.repeat(1200)});
 let batches=0;
 const interrupted={...fake,embed:async(texts:string[],model:string)=>{if(++batches===2)throw new Error('synthetic-interruption');return fake.embed(texts,model);}};
 const bot=(await store.getChatbot(h.botId))!;await assert.rejects(indexKnowledge(bot,interrupted,Infinity,{retryNow:true}));
 const cachedBefore=(await pool.query('SELECT count(*)::int AS n FROM query_embedding_cache WHERE account_id=$1',[h.accountId])).rows[0].n;assert.ok(cachedBefore>0);
 const before=embeddings;await indexKnowledge(bot,fake,Infinity,{retryNow:true});assert.equal(embeddings-before,1,'se vuelve a generar solo el último lote fallido');assert.equal((await knowledgeIndexStatus(bot)).complete,true);
 await pool.query('UPDATE semantic_settings SET enabled=true,daily_token_budget=100000 WHERE account_id=$1',[h.accountId]);
 const calls=embeddings;const items=await store.listKnowledge(bot.id,true);await semanticKnowledge(bot,items,'pregunta nueva',fake);await semanticKnowledge(bot,items,'pregunta nueva',fake);assert.equal(embeddings-calls,1);
 const other=await store.createAccount('Caché aislada');const b=await store.createChatbot(other.id,{name:'Otro'});await pool.query('INSERT INTO semantic_settings(account_id,enabled,preparing) VALUES($1,true,true)',[other.id]);await store.upsertKnowledge(b.id,{title:'Privado',content:'Dato exclusivo de otro cliente.'});await indexKnowledge(b,fake);
 const fetched=await semanticKnowledge(b,await store.listKnowledge(b.id,true),'pregunta nueva',fake);assert.ok(fetched?.every(k=>k.chatbot_id===b.id));assert.equal(embeddings-calls,3,'otro perfil paga su propio índice y su propia consulta');
 await pool.query('UPDATE semantic_settings SET daily_token_budget=100 WHERE account_id=$1',[h.accountId]);const n=embeddings;assert.equal(await semanticKnowledge(bot,items,'consulta que excede el presupuesto',fake),null);assert.equal(embeddings,n,'se aplica límite antes de llamar al proveedor');await pool.query('UPDATE semantic_settings SET daily_token_budget=100000 WHERE account_id=$1',[h.accountId]);
 await store.deleteKnowledge(k.id);
});
t('un documento editado durante la búsqueda no devuelve fragmentos viejos; cambiar fuentes invalida la activación',async()=>{
 const bot=(await store.getChatbot(h.botId))!;const k=(await store.listKnowledge(bot.id,true))[0];
 const racing={...fake,embed:async(texts:string[],model:string)=>{await store.upsertKnowledge(bot.id,{id:k.id,content:'Nueva tarifa verificada $1,800.'});return fake.embed(texts,model);}};
 const result=await semanticKnowledge(bot,await store.listKnowledge(bot.id,true),'consulta distinta durante edición',racing);
 assert.ok(!result?.some(k=>k.content.includes('1,650')));
 assert.equal((await h.authed('PUT',path(),{enabled:true})).statusCode,409);
 await indexKnowledge(bot,fake);await h.authed('PUT',path(),{enabled:false});
});
t('webhooks simultáneos con el mismo ID solo generan un mensaje, una decisión y un envío',async()=>{
 h.setScript(()=>({messages:['Hola, ¿cómo puedo ayudarte?']}));const before=h.sent.length,calls=h.calls.length;
 await Promise.all([h.webhook('hola',{phone:'521555880001',id:'duplicate-architecture'}),h.webhook('hola',{phone:'521555880001',id:'duplicate-architecture'})]);await h.idle();
 const conv=await conversation('521555880001');assert.equal((await store.recentMessages(conv.id,20)).filter(m=>m.direction==='in').length,1);assert.equal(h.sent.length-before,1);assert.equal(h.calls.length-calls,1);
});
t('transferencia humana mientras la IA piensa cancela los envíos pendientes',async()=>{
 let release!:()=>void;let start!:()=>void;const started=new Promise<void>(r=>start=r);h.setScript(async()=>{start();await new Promise<void>(r=>release=r);return {messages:['Respuesta tardía']};});
 const before=h.sent.length;await msg('521555880002');await started;const conv=await conversation('521555880002');await h.service.takeover(conv.id,'prueba de intervención humana');release();await h.idle();assert.equal(h.sent.length,before);assert.equal((await store.getConversation(conv.id))!.status,'human');
});
t('una respuesta humana desde WhatsApp toma prioridad aunque los dos workers de IA estén ocupados',async()=>{
 let release!:()=>void;const held=new Promise<void>(r=>release=r);let started=0;
 h.setScript(async()=>{started++;await held;return {messages:['No debe salir tras el humano']};});
 const before=h.sent.length;
 try {
  await msg('521555880007');await msg('521555880008');await waitFor(()=>started===2);
  await h.webhook('Yo te atiendo',{phone:'521555880007',fromMe:true,id:'human-control-priority'});
  const first=await conversation('521555880007');await waitFor(async()=> (await store.getConversation(first.id))?.status==='human');
  const second=await conversation('521555880008');await h.service.takeover(second.id,'detener la prueba');
 } finally {release();}
 await h.idle();assert.equal(h.sent.length,before);
});
t('pérdida de la sesión PostgreSQL durante la IA impide enviar con un worker sin propiedad',async()=>{
 let release!:()=>void;let start!:()=>void;const started=new Promise<void>(r=>start=r);h.setScript(async()=>{start();await new Promise<void>(r=>release=r);return {messages:['No debe salir con sesión perdida']};});
 const before=h.sent.length;await msg('521555880003');await started;
 const pid=(await pool.query(`SELECT l.pid FROM pg_locks l WHERE l.locktype='advisory' AND l.pid<>pg_backend_pid() GROUP BY l.pid HAVING count(*)>=2 LIMIT 1`)).rows[0]?.pid;assert.ok(pid);
 await pool.query('SELECT pg_terminate_backend($1)',[pid]);release();
 await waitFor(async()=>{const c=await h.conversationFor('521555880003');const w=(await pool.query('SELECT attempts FROM conversation_work WHERE conversation_id=$1',[c.id])).rows[0];return w?.attempts>=1;});
 const conv=await conversation('521555880003');await h.service.takeover(conv.id,'detener reintentos de la prueba');await h.idle();assert.equal(h.sent.length,before);
});
t('PostgreSQL temporalmente inaccesible conserva la cola y se recupera sin pérdida',async()=>{
 await h.idle();const broken=new pg.Pool({host:'127.0.0.1',port:1,user:'chatbot',database:'chatbot_test',connectionTimeoutMillis:100});
 const count=(await pool.query('SELECT count(*)::int AS n FROM conversation_work')).rows[0].n;
 setPool(broken);try {await assert.rejects(h.service.queue.runDue());}finally{setPool(pool);await broken.end();}
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM conversation_work')).rows[0].n,count);
 h.setScript(()=>({messages:['Conexión restablecida']}));const n=h.sent.length;await msg('521555880004');await h.idle();assert.equal(h.sent.length,n+1);
});
t('caída del proveedor persiste los reintentos y permite recuperación autorizada desde DLQ',async()=>{
 h.setScript(()=>new Error('synthetic-provider-down'));await msg('521555880005');
 const conv=await conversation('521555880005');await waitFor(async()=> (await pool.query('SELECT state FROM conversation_work WHERE conversation_id=$1',[conv.id])).rows[0]?.state==='dead');
 const work=(await h.authed('GET',`/api/conversations/${conv.id}/work`)).json();assert.equal(work.work.attempts,3);assert.equal(work.work.reason,'processing_error');
 h.setScript(()=>({messages:['Hola, ya puedo atenderte.']}));const recover=await h.authed('POST',`/api/conversations/${conv.id}/work/recover`,{action:'retry'});assert.equal(recover.statusCode,200,recover.body);await h.idle();assert.equal((await store.pendingInbound(conv.id)).length,0);
});
t('un fallo después de entregar una parte no repite mensajes ni se descarta sin revisión',async()=>{
 h.setScript(()=>({messages:['Hola de nuevo']}));h.failNext.text=1;await msg('521555880006');const conv=await conversation('521555880006');
 await waitFor(async()=> (await pool.query('SELECT state FROM conversation_work WHERE conversation_id=$1',[conv.id])).rows[0]?.state==='dead');
 const work=(await h.authed('GET',`/api/conversations/${conv.id}/work`)).json();assert.equal(work.work.reason,'delivery_uncertain');assert.ok(work.deliveries.length);assert.equal((await store.pendingInbound(conv.id)).length,1);
 assert.equal((await h.authed('POST',`/api/conversations/${conv.id}/work/recover`,{action:'retry'})).statusCode,409);
 const ack=await h.authed('POST',`/api/conversations/${conv.id}/work/recover`,{action:'acknowledge',review_up_to:work.review_up_to});assert.equal(ack.statusCode,200,ack.body);
});

t('una foto rechazada explícitamente puede reintentarse en el scheduler y solo se entrega una vez',async()=>{
 const {Scheduler}=await import('../src/automation/scheduler.js');
 const astore=await import('../src/automation/store.js');
 const channel=(await store.getChannel(h.channelId))!;
 const contact=await store.upsertContact(channel,'521555880009','521555880009','Prueba');
 const conv=await store.getOrCreateConversation(channel,contact.id);
 const photo=await h.uploadImage('scheduler_retry','Foto que se reintenta',{mode:'ai'});
 const scheduler=new Scheduler({'retry-photo':async()=>{
  const result=await h.service.outbound.send(conv.id,{imageId:photo.id,source:'automation'});
  if(!result.sent) throw new Error('known-rejection');
 }});
 const job=await astore.scheduleJob({account_id:h.accountId,type:'retry-photo',payload:{},run_at:new Date()});
 const before=h.sent.length;h.failNext.image=1;
 await scheduler.runDue();assert.equal((await pool.query('SELECT status FROM jobs WHERE id=$1',[job!.id])).rows[0].status,'pending');
 await pool.query('UPDATE jobs SET run_at=now() WHERE id=$1',[job!.id]);
 await scheduler.runDue();assert.equal((await pool.query('SELECT status FROM jobs WHERE id=$1',[job!.id])).rows[0].status,'done');
 assert.equal(h.sent.length,before+1);assert.equal(h.sent.at(-1)!.kind,'image');await scheduler.stop();
});
