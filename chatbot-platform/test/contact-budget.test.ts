import { after,before,beforeEach,test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness,dbAvailable,pool,store,waitFor } from './harness.js';
const { accountAi,AiBudgetBlocked }=await import('../src/ai/budget.js');
const { AiError }=await import('../src/ai/provider.js');
const ok=await dbAvailable();let h:Awaited<ReturnType<typeof createHarness>>;
const t=(name:string,fn:()=>Promise<void>)=>test(name,{skip:!ok&&'PostgreSQL no disponible'},fn);
before(async()=>{if(ok)h=await createHarness();});
beforeEach(async()=>{if(h){if(h.channelId)await pool.query('DELETE FROM channels WHERE id=$1',[h.channelId]);h.accountId='';await h.createBot({rules:{verify_facts:false},ai:{typing_simulation:false}});h.reset();h.setScript(()=>({messages:['Hola, te ayudo.']}));}});
after(async()=>{if(h)await h.app.close();await pool.end();});
const url=(path='/api/ai-budget')=>`${path}?account_id=${h.accountId}`;
async function setBudget(settings:any){const current=(await h.authed('GET',url())).json(),r=await h.authed('PUT',url(),{revision:current.revision,settings});assert.equal(r.statusCode,200,r.body);return r.json();}
const req={model:'openai/gpt-4.1-mini',messages:[{role:'user' as const,content:'hola'}],json_schema:{name:'budget_case',schema:{}}};
const call=()=>accountAi(h.ai,h.accountId,h.botId).complete(req);
async function contact(channel:any,phone='5215512345678',name='Ana') {const c=await store.upsertContact(channel,phone,phone,name),v=await store.getOrCreateConversation(channel,c.id);await store.updateContact(c.id,{name});return {contact:c,conversation:v};}
async function getProfile(id:string){const r=await h.authed('GET',`/api/contacts/${id}/profile`);assert.equal(r.statusCode,200,r.body);return r.json();}

t('la ficha reúne canales del mismo teléfono y conserva el origen de datos distintos',async()=>{
 const a=await contact((await store.getChannel(h.channelId))!);
 const channel=await store.createChannel({account_id:h.accountId,chatbot_id:h.botId,type:'whatsapp',name:'Segundo teléfono',config:{instance:'segundo'}}),b=await contact(channel);
 await store.updateContact(a.contact.id,{data:{pedido:'Tacos'},notes:['Entrega en recepción']});await store.updateContact(b.contact.id,{data:{pedido:'Quesadillas'}});
 const profile=await getProfile(a.contact.id);assert.equal(profile.records.length,2);assert.equal(profile.conversations.length,2);assert.deepEqual(profile.records.map((r:any)=>r.data.pedido).sort(),['Quesadillas','Tacos']);
 const directory=await h.authed('GET',`/api/contacts?account_id=${h.accountId}`);assert.equal(directory.statusCode,200,directory.body);assert.equal(directory.json().items.length,1);assert.equal(directory.json().items[0].channels,2);
 assert.equal((await store.getContact(a.contact.id))!.data.pedido,'Tacos');
});
t('teléfonos iguales en distintos perfiles no comparten datos ni fichas',async()=>{
 const a=await contact((await store.getChannel(h.channelId))!);const other=await store.createAccount('Otro perfil'),bot=await store.createChatbot(other.id,{name:'Privado'}),ch=await store.createChannel({account_id:other.id,chatbot_id:bot.id,type:'whatsapp',name:'Privado',config:{instance:'privado'}}),b=await contact(ch);
 await store.updateContact(b.contact.id,{data:{secreto:'NO_DEBE_APARECER'}});
 const d=await getProfile(a.contact.id);assert.equal(d.records.length,1);assert.doesNotMatch(JSON.stringify(d),/NO_DEBE_APARECER/);
});
t('usuarios agentes solo ven sus canales, resúmenes, pendientes y citas autorizados',async()=>{
 const a=await contact((await store.getChannel(h.channelId))!),ch=await store.createChannel({account_id:h.accountId,chatbot_id:h.botId,type:'whatsapp',name:'Oculto',config:{instance:'oculto'}}),b=await contact(ch);
 const made=await h.authed('POST','/api/users',{account_id:h.accountId,name:'Operador',email:'operador'+h.botId+'@test.mx',password:'secreto123',role:'agent'});assert.equal(made.statusCode,200,made.body);
 const user=made.json();await pool.query('UPDATE conversations SET assigned_user_id=$2 WHERE id=$1',[a.conversation.id,user.id]);await store.updateContact(b.contact.id,{data:{secreto:'CANAL_OCULTO'}});
 const logged=await h.loginAs(user.email,'secreto123'),r=await logged('GET',`/api/contacts/${a.contact.id}/profile`);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().records.length,1);assert.doesNotMatch(r.body,/CANAL_OCULTO/);
 assert.equal((await logged('GET',`/api/contacts/${b.contact.id}/profile`)).statusCode,404);
 assert.equal((await logged('GET',url())).statusCode,403);
});
t('los filtros de pendientes, sin asignar y citas próximas usan datos reales',async()=>{
 const a=await contact((await store.getChannel(h.channelId))!);await store.insertContactTask({account_id:h.accountId,contact_id:a.contact.id,conversation_id:a.conversation.id,kind:'pendiente',body:'Confirmar pedido',due_on:null,created_by:null,created_via:'panel'});
 let r=await h.authed('GET',`/api/contacts?account_id=${h.accountId}&view=pending`);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().items.length,1);
 assert.equal((await h.authed('GET',`/api/contacts?account_id=${h.accountId}&view=unassigned`)).json().items.length,1);
 assert.equal((await h.authed('GET',`/api/contacts?account_id=${h.accountId}&view=upcoming`)).json().items.length,0);
 const created=await h.authed('POST','/api/services',{account_id:h.accountId,name:'Visita',duration_minutes:30,min_notice_minutes:0,max_days_ahead:5,notify_team:false,reminders:[]});assert.equal(created.statusCode,200,created.body);
 await pool.query("INSERT INTO appointments(account_id,service_id,service_name,kind,contact_id,conversation_id,starts_at,ends_at,source) VALUES($1,$2,'Visita','appointment',$3,$4,now()+interval '1 day',now()+interval '1 day 30 minutes','panel')",[h.accountId,created.json().id,a.contact.id,a.conversation.id]);
 assert.equal((await h.authed('GET',`/api/contacts?account_id=${h.accountId}&view=upcoming`)).json().items.length,1);assert.equal((await getProfile(a.contact.id)).appointments.length,1);
 assert.equal((await h.authed('GET',`/api/contacts?account_id=${h.accountId}&search=%2B521551234`)).json().items.length,1);
});
t('no se agrupan contactos sin teléfono por nombre o por respuestas no verificadas',async()=>{
 const ch=(await store.getChannel(h.channelId))!;
 for(const id of ['cliente-a','cliente-b']){const c=await store.upsertContact(ch,id,'','Ana');await store.updateContact(c.id,{data:{telefono:'5215512345678'}});await store.getOrCreateConversation(ch,c.id);}
 const r=await h.authed('GET',`/api/contacts?account_id=${h.accountId}`);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().items.length,2);
});
t('las vistas guardadas pertenecen al usuario y al perfil y rechazan filtros inválidos',async()=>{
 const r=await h.authed('POST',url('/api/contact-views'),{name:'Pendientes',filters:{view:'pending',tag:'cliente'}});assert.equal(r.statusCode,200,r.body);
 assert.equal((await h.authed('GET',url('/api/contact-views'))).json().length,1);
 assert.equal((await h.authed('POST',url('/api/contact-views'),{name:'Inválida',filters:{view:'inventada'}})).statusCode,400);
 assert.equal((await h.authed('DELETE',url(`/api/contact-views/${r.json().id}`))).statusCode,200);
});
t('un presupuesto agotado bloquea la llamada antes de enviar a la IA y avisa una sola vez',async()=>{
 await setBudget({monthly_usd:0});for(let i=0;i<2;i++)await assert.rejects(call,AiBudgetBlocked);assert.equal(h.calls.length,0);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_budget_notices WHERE account_id=$1',[h.accountId])).rows[0].n,1);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_spend WHERE account_id=$1',[h.accountId])).rows[0].n,0);
});
t('reservas simultáneas no rebasan el cupo del perfil ni agotan conexiones del pool',async()=>{
 await setBudget({monthly_usd:0.003});let release!:()=>void;const wait=new Promise<void>(r=>release=r);
 h.setScript(async()=>{await wait;return {messages:['Hola.']};});
 const calls=Array.from({length:25},()=>call().then(()=>true,e=>{assert.ok(e instanceof AiBudgetBlocked);return false;}));
 await waitFor(()=>h.calls.length>0);
 await waitFor(async()=>(await pool.query("SELECT count(*)::int n FROM ai_budget_notices WHERE account_id=$1 AND reason='budget_exhausted'",[h.accountId])).rows[0].n===1);
 const reserved=(await pool.query("SELECT sum(reserved_usd) total,count(*)::int n FROM ai_spend WHERE account_id=$1 AND state='reserved'",[h.accountId])).rows[0];assert.ok(Number(reserved.total)<=0.003);assert.equal(reserved.n,1);
 release();assert.equal((await Promise.all(calls)).filter(Boolean).length,1);
});
t('un costo reportado se conserva y un costo no reportado se muestra estimado',async()=>{
 await call();let ledger=(await pool.query('SELECT * FROM ai_spend WHERE account_id=$1 ORDER BY created_at DESC',[h.accountId])).rows[0];assert.equal(ledger.cost_source,'estimated');assert.ok(Number(ledger.charged_usd)>0);
 const original=h.ai.complete;h.ai.complete=async r=>({...await original(r),cost_usd:0.0003});try{await call();}finally{h.ai.complete=original;}
 ledger=(await pool.query('SELECT * FROM ai_spend WHERE account_id=$1 ORDER BY created_at DESC',[h.accountId])).rows[0];assert.equal(ledger.cost_source,'reported');assert.equal(Number(ledger.charged_usd),0.0003);
});
t('el timeout conserva la reserva y un rechazo definitivo la libera',async()=>{
 await setBudget({monthly_usd:0.01});h.setScript(()=>new AiError('Timeout',503));await assert.rejects(call);
 let rows=(await pool.query('SELECT * FROM ai_spend WHERE account_id=$1 ORDER BY created_at',[h.accountId])).rows;assert.equal(rows[0].state,'uncertain');assert.equal(rows[0].charged_usd,null);assert.ok(Number(rows[0].reserved_usd)>0);
 h.setScript(()=>new AiError('Clave rechazada',401));await assert.rejects(call);rows=(await pool.query('SELECT * FROM ai_spend WHERE account_id=$1 ORDER BY created_at',[h.accountId])).rows;assert.equal(rows[1].state,'rejected');assert.equal(Number(rows[1].charged_usd),0);
});
t('un modelo sin tarifa no se trata como gratis y bloquea solo cuando hay un límite aplicable',async()=>{
 const unknown=()=>accountAi(h.ai,h.accountId,h.botId).complete({...req,model:'modelo-no-tarifado'});
 await unknown();const r=await h.authed('GET',url());assert.equal(r.statusCode,200,r.body);assert.equal(r.json().usage.find((u:any)=>u.period==='month').unknown,1);
 await setBudget({monthly_usd:5});await assert.rejects(unknown,(e:any)=>e.code==='price_unknown');
 await assert.rejects(call,(e:any)=>e.code==='unresolved_cost');
});
t('confirmar un importe pendiente requiere perfil, permisos y una explicación',async()=>{
 await accountAi(h.ai,h.accountId,h.botId).complete({...req,model:'sin-precio'});const entry=(await h.authed('GET',url())).json().review[0];
 assert.equal((await h.authed('POST',url(`/api/ai-budget/review/${entry.id}`),{amount_usd:0,note:'x'})).statusCode,400);
 assert.equal((await h.authed('POST',url(`/api/ai-budget/review/${entry.id}`),{amount_usd:0.002,note:'Importe revisado con el proveedor'})).statusCode,200);
 const row=(await pool.query('SELECT * FROM ai_spend WHERE id=$1',[entry.id])).rows[0];assert.equal(row.cost_source,'confirmed');assert.equal(Number(row.charged_usd),0.002);
});
t('el límite por modelo considera los modelos de respaldo antes de llamar',async()=>{
 await setBudget({models:[{model:'gpt-4.1',period:'day',limit_usd:0}]});
 await assert.rejects(()=>accountAi(h.ai,h.accountId,h.botId).complete({...req,fallback_models:['openai/gpt-4.1']}),AiBudgetBlocked);assert.equal(h.calls.length,0);
});
t('el agotamiento pasa la conversación a una persona sin reintentos de IA ni mensajes técnicos',async()=>{
 await setBudget({monthly_usd:0});await h.webhook('hola');await h.idle();const conv=await h.conversationFor();assert.equal(conv.status,'human');assert.equal(h.calls.length,0);assert.ok(h.sent.length>0);assert.doesNotMatch(h.sent.map(s=>s.text).join(' '),/presupuesto|tokens|USD|API/);
});
t('cambiar el presupuesto invalida las pruebas aprobadas del agente',async()=>{
 const v=(await h.authed('GET',`/api/chatbots/${h.botId}/versions`)).json();assert.equal((await h.authed('PUT',`/api/chatbots/${h.botId}/tests`,{revision:v.suite.revision,cases:[{name:'Saludo',turns:[{text:'hola',expect:{contains:['ayudo']}}]}]})).statusCode,200);
 const run=await h.authed('POST',`/api/chatbots/${h.botId}/tests/run`,{revision:v.draft.revision});assert.equal(run.statusCode,202,run.body);await (await import('../src/agent-quality.js')).settleAgentTests();assert.equal((await h.authed('GET',`/api/chatbots/${h.botId}/versions`)).json().can_publish,true);
 await setBudget({monthly_usd:10});const next=(await h.authed('GET',`/api/chatbots/${h.botId}/versions`)).json();assert.equal(v.draft.revision,next.draft.revision);assert.equal(next.can_publish,false);
});

t('precios actualizados no cambian la estimación de una llamada en curso',async()=>{
 await setBudget({monthly_usd:5,prices:[{model:'gpt-4.1-mini',input_per_mtok:0.4,output_per_mtok:1.6}]});
 let release!:()=>void;const held=new Promise<void>(r=>release=r);h.setScript(async()=>{await held;return {messages:['Hola.']};});const pending=call();await waitFor(()=>h.calls.length===1);
 await setBudget({monthly_usd:5,prices:[{model:'gpt-4.1-mini',input_per_mtok:100,output_per_mtok:100}]});release();await pending;
 const row=(await pool.query('SELECT * FROM ai_spend WHERE account_id=$1',[h.accountId])).rows[0];assert.equal(Number(row.charged_usd),0.000072);assert.equal(row.quote.prices[0].input_per_mtok,0.4);
});
t('modelos fechados y alias OpenAI comparten el límite del modelo lógico',async()=>{
 await setBudget({models:[{model:'gpt-4.1-mini',period:'month',limit_usd:0}]});await assert.rejects(()=>accountAi(h.ai,h.accountId,h.botId).complete({...req,model:'openai/gpt-4.1-mini-2025-04-14'}),AiBudgetBlocked);assert.equal(h.calls.length,0);
});
t('un modelo inesperado mantiene su costo conocido y bloquea importes sin determinar',async()=>{
 await setBudget({monthly_usd:5});const original=h.ai.complete;
 h.ai.complete=async r=>({...await original(r),model:'modelo-inesperado'});try{await call();}finally{h.ai.complete=original;}
 let row=(await pool.query('SELECT * FROM ai_spend WHERE account_id=$1',[h.accountId])).rows[0];assert.equal(row.state,'uncertain');assert.equal(row.quote.model_mismatch,true);await assert.rejects(call,(e:any)=>e.code==='unresolved_cost');
 await h.authed('POST',url(`/api/ai-budget/review/${row.id}`),{amount_usd:0.001,note:'Revisado con el proveedor'});
 h.ai.complete=async r=>({...await original(r),model:'otro-modelo',cost_usd:0.02});try{await call();}finally{h.ai.complete=original;}
 row=(await pool.query('SELECT * FROM ai_spend WHERE account_id=$1 ORDER BY created_at DESC',[h.accountId])).rows[0];assert.equal(Number(row.charged_usd),0.02);assert.equal(row.cost_source,'reported');
});
t('una reserva abandonada se revisa sin liberar el saldo automáticamente',async()=>{
 const r=(await pool.query("INSERT INTO ai_spend(account_id,kind,models,state,reserved_usd,cost_source,created_at) VALUES($1,'decision',ARRAY['gpt-4.1-mini'],'reserved',0.1,'unknown',now()-interval '1 day') RETURNING id",[h.accountId])).rows[0];
 const status=(await h.authed('GET',url())).json();assert.equal(status.review.find((x:any)=>x.id===r.id).state,'uncertain');assert.equal(Number(status.review.find((x:any)=>x.id===r.id).reserved_usd),0.1);
});
t('el cuerpo de error en HTTP 200 no libera una reserva como si fuera un rechazo previo',async()=>{
 await setBudget({monthly_usd:5});h.setScript(()=>new AiError('Error después de procesar',400,undefined,false));await assert.rejects(call);
 const row=(await pool.query('SELECT * FROM ai_spend WHERE account_id=$1',[h.accountId])).rows[0];assert.equal(row.state,'uncertain');assert.equal(row.charged_usd,null);
});
t('embeddings y audio usan el presupuesto del mismo perfil',async()=>{
 await setBudget({monthly_usd:0});let calls=0;h.ai.embed=async(texts,model)=>{calls++;return {vectors:texts.map(()=>Array(1536).fill(1)),model,input_tokens:10,latency_ms:1};};
 await assert.rejects(()=>accountAi(h.ai,h.accountId,h.botId).embed!(['hola'],'openai/text-embedding-3-small'),AiBudgetBlocked);assert.equal(calls,0);
 await assert.rejects(()=>accountAi(h.ai,h.accountId,h.botId).transcribe(Buffer.from('audio'),'audio/ogg'),AiBudgetBlocked);
});
t('dos sesiones no pueden sobrescribir el presupuesto ni confirmar importes de otro perfil',async()=>{
 const first=await setBudget({monthly_usd:10});const changed=await setBudget({monthly_usd:20});assert.equal(changed.revision,first.revision+1);
 assert.equal((await h.authed('PUT',url(),{revision:first.revision,settings:{monthly_usd:0}})).statusCode,409);
 const other=await store.createAccount('Otro'),entry=(await pool.query("INSERT INTO ai_spend(account_id,kind,models,state,cost_source) VALUES($1,'decision',ARRAY['privado'],'unknown','unknown') RETURNING id",[other.id])).rows[0];
 assert.equal((await h.authed('POST',url(`/api/ai-budget/review/${entry.id}`),{amount_usd:0,note:'Revisado correctamente'})).statusCode,404);
});

t('un precio en cero requiere confirmar que el modelo es gratuito',async()=>{
 await setBudget({monthly_usd:0});const model='modelo-gratuito-'+h.botId;
 assert.equal((await h.authed('PUT',`/api/ai-prices/${model}`,{})).statusCode,200);
 const request=()=>accountAi(h.ai,h.accountId,h.botId).complete({...req,model});await assert.rejects(request,(e:any)=>e.code==='price_unknown');assert.equal(h.calls.length,0);
 assert.equal((await h.authed('PUT',`/api/ai-prices/${model}`,{is_free:true})).statusCode,200);await request();const row=(await pool.query('SELECT * FROM ai_spend WHERE account_id=$1',[h.accountId])).rows[0];assert.equal(Number(row.charged_usd),0);assert.equal(row.cost_source,'estimated');
});
t('importar una imagen reserva un margen de visión antes de enviarla al modelo',async()=>{
 await setBudget({daily_usd:0.1});await assert.rejects(()=>accountAi(h.ai,h.accountId,h.botId,'import').complete({...req,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://example.com/menu.png'}}]}]}),AiBudgetBlocked);assert.equal(h.calls.length,0);
});

t('un presupuesto en cero bloquea incluso cargos positivos menores que un nanodólar',async()=>{
 await setBudget({daily_usd:0,prices:[{model:'text-embedding-3-small',input_per_mtok:0.000001,output_per_mtok:0}]});let dispatched=0;h.ai.embed=async(texts,model)=>{dispatched++;return {vectors:texts.map(()=>Array(1536).fill(1)),model,input_tokens:1,latency_ms:1};};
 await assert.rejects(()=>accountAi(h.ai,h.accountId,h.botId).embed!(['a'],'openai/text-embedding-3-small'),AiBudgetBlocked);assert.equal(dispatched,0);
});
t('los cargos pequeños se conservan con precisión y un fallo antes de enviar no consume saldo',async()=>{
 await setBudget({monthly_usd:1,prices:[{model:'gpt-4.1-mini',input_per_mtok:0.000001,output_per_mtok:0}]});await call();let rows=(await pool.query('SELECT * FROM ai_spend WHERE account_id=$1 ORDER BY created_at',[h.accountId])).rows;assert.equal(Number(rows[0].charged_usd),0.0000000001);
 h.setScript(()=>AiError.beforeDispatch('Configuración incompleta'));await assert.rejects(call);rows=(await pool.query('SELECT * FROM ai_spend WHERE account_id=$1 ORDER BY created_at',[h.accountId])).rows;assert.equal(rows[1].state,'rejected');assert.equal(Number(rows[1].charged_usd),0);
});

t('el límite monetario se verifica antes de reservar tokens semánticos',async()=>{
 await setBudget({monthly_usd:0});let tokens=0,sends=0;h.ai.embed=async(texts,model)=>{sends++;return {vectors:texts.map(()=>Array(1536).fill(1)),model,input_tokens:1,latency_ms:1};};
 await assert.rejects(()=>accountAi(h.ai,h.accountId,h.botId,'embedding',async()=>{tokens++;}).embed!(['texto'],'openai/text-embedding-3-small'),AiBudgetBlocked);assert.equal(tokens,0);assert.equal(sends,0);
 await setBudget({monthly_usd:1});await assert.rejects(()=>accountAi(h.ai,h.accountId,h.botId,'embedding',async()=>{throw new Error('Cupo de tokens agotado');}).embed!(['texto'],'openai/text-embedding-3-small'));
 const row=(await pool.query('SELECT * FROM ai_spend WHERE account_id=$1',[h.accountId])).rows[0];assert.equal(row.state,'rejected');assert.equal(Number(row.charged_usd),0);assert.equal(sends,0);
});
