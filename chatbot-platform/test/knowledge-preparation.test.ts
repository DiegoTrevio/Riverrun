import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, store } from './harness.js';
const { config } = await import('../src/config.js');
const { prepareKnowledge, KnowledgeWorker } = await import('../src/engine/knowledge-preparation.js');
const { indexKnowledge, knowledgeIndexStatus, knowledgeHash, vectorAvailable } = await import('../src/engine/knowledge.js');
const ok = await dbAvailable();
let vectorReady = false;
const t = (name: string, fn: () => Promise<void>) => test(name,{skip:!ok && 'PostgreSQL no disponible'},async (context) => {
 if (!vectorReady) { context.skip('pgvector no disponible para la preparación semántica'); return; }
 await fn();
});
let h: Awaited<ReturnType<typeof createHarness>>;
const previous={enabled:config.knowledgeSearch.enabled,model:config.knowledgeSearch.model};
let a: any, b: any, botA: any, botB: any, essential: any, item: any;
let calls=0;
const vector=Array.from({length:1536},(_,i)=>i===0?1:0);
const fake={complete:async()=>{throw new Error('No chat');},transcribe:async()=>'',embed:async(texts:string[],model:string)=>{calls++;return {vectors:texts.map(()=>vector),model,input_tokens:10,latency_ms:1,cost_usd:0.00001};}};
before(async()=>{if(ok){h=await createHarness();vectorReady=await vectorAvailable();if(process.env.REQUIRE_PGVECTOR==='true')assert.ok(vectorReady);config.knowledgeSearch.enabled=true;}});
after(async()=>{config.knowledgeSearch.enabled=previous.enabled;config.knowledgeSearch.model=previous.model;if(h)await h.app.close();await pool.end();});

t('plan de todos los perfiles cuenta pendientes y esenciales sin gastar embeddings',async()=>{
 a=await store.createAccount('Perfil A');b=await store.createAccount('Perfil B');
 botA=await store.createChatbot(a.id,{name:'Agente A'});botB=await store.createChatbot(b.id,{name:'Agente B'});
 item=await store.upsertKnowledge(botA.id,{title:'Tarifa',content:'Doble $1,650. '+ 'Detalle confirmado. '.repeat(100)});
 essential=await store.upsertKnowledge(botA.id,{title:'Regla',content:'No mascotas',always_include:true});
 await store.upsertKnowledge(botA.id,{title:'Borrador',content:'No publicar',active:false});
 await store.upsertKnowledge(botB.id,{title:'Privado',content:'Datos de otro perfil'});
 const plan=await prepareKnowledge({all:true});
 assert.equal(calls,0);assert.equal(plan.pending_items,2);
 const one=plan.results.find(r=>r.chatbot_id===botA.id)!;assert.equal(one.essential_items,1);assert.equal(one.inactive_items,1);assert.ok(one.expected_chunks>1);assert.equal(one.complete,false);
});

t('preparación por perfil conserva aislamiento; reejecutar completa sin volver a gastar',async()=>{
 const result=await prepareKnowledge({accountId:a.id},{apply:true,ai:fake});
 assert.equal(result.complete,true);assert.equal(result.processed_items,1);
 assert.equal((await knowledgeIndexStatus(botB)).indexed_items,0);
 const charged=calls;
 const repeated=await prepareKnowledge({accountId:a.id},{apply:true,ai:fake});
 assert.equal(repeated.processed_items,0);assert.equal(calls,charged);
 const all=await prepareKnowledge({all:true},{apply:true,ai:fake});assert.equal(all.complete,true);assert.equal(all.pending_items,0);
});

t('detecta un índice parcialmente perdido y lo repara antes de declarar completo',async()=>{
 await pool.query('DELETE FROM knowledge_chunks WHERE item_id=$1 AND chunk_no=1',[item.id]);
 const incomplete=await knowledgeIndexStatus(botA);assert.equal(incomplete.indexed_items,0);assert.equal(incomplete.pending_items,1);
 assert.equal(await indexKnowledge(botA,fake),1);assert.equal((await knowledgeIndexStatus(botA)).complete,true);
});

t('edición invalida de inmediato, mantenimiento incorpora el cambio sin conversación',async()=>{
 await store.upsertKnowledge(botA.id,{id:item.id,content:'Precio actualizado $1,800.'});
 assert.equal((await pool.query('SELECT 1 FROM knowledge_chunks WHERE item_id=$1',[item.id])).rowCount,0);
 assert.equal((await knowledgeIndexStatus(botA)).pending_items,1);
 await new KnowledgeWorker(fake).runOnce();
 assert.equal((await knowledgeIndexStatus(botA)).complete,true);
 const rows=(await pool.query('SELECT content,content_hash FROM knowledge_chunks WHERE item_id=$1',[item.id])).rows;
 assert.equal(rows[0].content,'Precio actualizado $1,800.');assert.equal(rows[0].content_hash,knowledgeHash((await store.getKnowledge(item.id))!));
 const before=calls;await store.upsertKnowledge(botA.id,{id:item.id,sort_order:5});await new KnowledgeWorker(fake).runOnce();assert.equal(calls,before);
});

t('desactivar, marcar esencial y eliminar descartan fragmentos y ajustan cobertura',async()=>{
 await store.upsertKnowledge(botA.id,{id:item.id,active:false});assert.equal((await pool.query('SELECT 1 FROM knowledge_chunks WHERE item_id=$1',[item.id])).rowCount,0);
 assert.equal((await knowledgeIndexStatus(botA)).pending_items,0);
 await store.upsertKnowledge(botA.id,{id:item.id,active:true});await indexKnowledge(botA,fake);
 await store.upsertKnowledge(botA.id,{id:item.id,always_include:true});assert.equal((await knowledgeIndexStatus(botA)).essential_items,2);
 assert.equal((await pool.query('SELECT 1 FROM knowledge_chunks WHERE item_id=$1',[item.id])).rowCount,0);
 await store.deleteKnowledge(item.id);assert.equal((await knowledgeIndexStatus(botA)).essential_items,1);
});

t('fallo parcial conserva trabajo, reporta incompleto y permite reanudar',async()=>{
 const first=await store.upsertKnowledge(botA.id,{title:'Primero',content:'Información uno',sort_order:10});
 await store.upsertKnowledge(botA.id,{title:'Segundo',content:'Información dos',sort_order:20});
 let n=0;const failing={...fake,embed:async(texts:string[],model:string)=>{if(++n===2)throw new Error('TEST-PRIVATE-KEY');return fake.embed(texts,model);}};
 const failed=await prepareKnowledge({chatbotId:botA.id},{apply:true,ai:failing});
 assert.equal(failed.complete,false);assert.equal(failed.failed_agents,1);assert.equal(failed.pending_items,1);
 assert.equal(failed.processed_items,1);
 assert.ok(!JSON.stringify(failed).includes('TEST-PRIVATE-KEY'));
 assert.ok((await pool.query('SELECT 1 FROM knowledge_chunks WHERE item_id=$1',[first.id])).rowCount!>0);
 assert.equal((await prepareKnowledge({chatbotId:botA.id},{apply:true,ai:fake})).processed_items,1);
});

t('bloqueo entre procesos evita indexar mientras otro proceso prepara el mismo agente',async()=>{
 const k=await store.upsertKnowledge(botA.id,{title:'Pendiente',content:'Dato pendiente'});
 const lock=await pool.connect();const key=`${botA.id}:${config.knowledgeSearch.model}`;
 await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);
 try{const before=calls;assert.equal(await indexKnowledge(botA,fake),0);assert.equal(calls,before);assert.equal((await knowledgeIndexStatus(botA)).pending_items,1);}finally{await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);lock.release();}
 assert.equal(await indexKnowledge(botA,fake),1);assert.ok((await pool.query('SELECT 1 FROM knowledge_chunks WHERE item_id=$1',[k.id])).rowCount!>0);
});

t('cambiar modelo vuelve a preparar y el mantenimiento no factura perfiles pausados',async()=>{
 const paused=await store.createAccount('Pausado',{status:'paused'});const bot=await store.createChatbot(paused.id,{name:'Pausado'});
 await store.upsertKnowledge(bot.id,{title:'Documento',content:'Sin preparar'});
 config.knowledgeSearch.model='synthetic/alternate-embedding';
 assert.ok((await knowledgeIndexStatus(botA)).pending_items>0);
 const worker=new KnowledgeWorker(fake);for(let i=0;i<5;i++)await worker.runOnce();
 assert.equal((await knowledgeIndexStatus(botA)).complete,true);assert.equal((await knowledgeIndexStatus(bot)).indexed_items,0);
 const all=await prepareKnowledge({all:true},{apply:true,ai:fake});assert.equal(all.complete,true);
 assert.equal((await pool.query('SELECT DISTINCT model FROM knowledge_chunks')).rows.length,2);
 const charged=calls;config.knowledgeSearch.model=previous.model;
 assert.equal(await indexKnowledge(botA,fake),0);assert.equal(calls,charged,'Preparar otro modelo no debe destruir una versión completa que otra instancia utiliza');
});
