import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHarness, dbAvailable, pool, store } from './harness.js';
const { config } = await import('../src/config.js');
const { semanticKnowledge, indexKnowledge, knowledgeIndexStatus } = await import('../src/engine/knowledge.js');
const { prepareKnowledge, KnowledgeWorker } = await import('../src/engine/knowledge-preparation.js');
const { operationalStatus } = await import('../src/engine/operations.js');
const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL no disponible' }, fn);
let h: Awaited<ReturnType<typeof createHarness>>;
let a: any, b: any, botA: any, botB: any;
let calls = 0;
const old = { ...config.knowledgeSearch, key: config.openai.apiKey };
const fake = { complete: async () => { throw new Error('No chat'); }, transcribe: async () => '', embed: async (texts: string[], model: string) => {
  calls++; return { vectors: texts.map(()=>Array.from({length:1536},(_,i)=>i===0?1:0)), model, input_tokens: 10, latency_ms: 1, cost_usd: 0.001 };
} };
before(async () => {
  if (!ok) return;
  h = await createHarness();
  a = await store.createAccount('Piloto A'); b = await store.createAccount('Perfil B');
  botA = await store.createChatbot(a.id, {name:'A'}); botB = await store.createChatbot(b.id, {name:'B'});
  await store.upsertKnowledge(botA.id,{title:'Tarifa',content:'Habitación $1,650.'});
  await store.upsertKnowledge(botB.id,{title:'Otro perfil',content:'Dato privado B'});
  config.knowledgeSearch.enabled = true; config.openai.apiKey='SYNTHETIC-PRIVATE-KEY'; config.knowledgeSearch.accountIds=[a.id];
});
after(async () => { const {key,...search}=old; Object.assign(config.knowledgeSearch,search); config.openai.apiKey=old.key; if(h) await h.app.close(); await pool.end(); });

t('el piloto limita indexado, consultas y mantenimiento al perfil permitido', async () => {
  const worker = new KnowledgeWorker(fake); await worker.runOnce();
  assert.equal((await knowledgeIndexStatus(botA)).indexed_items,1);
  assert.equal((await knowledgeIndexStatus(botB)).enabled,false);
  const before=calls;
  assert.equal((await h.authed('POST', `/api/chatbots/${botB.id}/knowledge/index`)).statusCode,400);
  assert.equal(await indexKnowledge(botB,fake),0);
  assert.equal(await semanticKnowledge(botB,await store.listKnowledge(botB.id,true),'dato',fake),null);
  assert.equal(calls,before);
  assert.equal((await knowledgeIndexStatus(botB)).indexed_items,0);
});

t('la preparación global rechaza perfiles fuera del piloto antes de generar embeddings', async () => {
  const before=calls;
  await assert.rejects(prepareKnowledge({all:true},{apply:true,ai:fake}),/fuera del piloto/);
  assert.equal(calls,before);
});

t('selección y degradación quedan registradas sin texto del cliente ni errores sensibles', async () => {
  await semanticKnowledge(botA,await store.listKnowledge(botA.id,true),'CONSULTA-PRIVADA',fake);
  await semanticKnowledge(botA,await store.listKnowledge(botA.id,true),'CONSULTA-PRIVADA',{...fake,embed:async()=>{throw new Error('SYNTHETIC-PRIVATE-KEY');}});
  const result=await operationalStatus();
  assert.equal(result.search?.attempts,2); assert.equal(result.search?.fallbacks,1);
  assert.equal(result.search?.selected,1); assert.equal(result.search.fallback_ratio,0.5);
  const logs=(await pool.query("SELECT message,details FROM event_logs WHERE message='knowledge_search'")).rows;
  assert.ok(!JSON.stringify(logs).includes('CONSULTA-PRIVADA'));
  assert.ok(!JSON.stringify(logs).includes('SYNTHETIC-PRIVATE-KEY'));
});

t('el diagnóstico es de lectura y no presenta una clave configurada como proveedor sano', async () => {
  const before=calls;
  const result=await operationalStatus();
  assert.equal(calls,before); assert.equal(result.provider,'not_checked');
  assert.equal(result.rollout.mode,'pilot'); assert.equal(result.knowledge.enabled_agents,1);
  assert.equal(result.knowledge.pending_items,0); assert.equal(result.usage?.runs,2);
  assert.ok(Math.abs(result.usage!.recorded_usd-0.002)<1e-9);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC-PRIVATE-KEY'));
  await assert.rejects(operationalStatus(0)); await assert.rejects(operationalStatus(1441));
});

t('solo el maestro accede a las métricas globales; health público no las revela', async () => {
  const account=(await h.authed('POST','/api/accounts',{name:'Admin limitado',admin:{email:'limited@ops.test',password:'limited-password-123'}})).json();
  assert.ok(account.id);
  const limited=await h.loginAs('limited@ops.test','limited-password-123');
  assert.equal((await limited('GET','/api/health/operations')).statusCode,403);
  assert.equal((await h.app.inject({method:'GET',url:'/api/health/operations'})).statusCode,401);
  assert.equal((await h.authed('GET','/api/health/operations')).statusCode,200);
  assert.deepEqual((await h.app.inject({method:'GET',url:'/health'})).json(),{ok:true});
});

t('desactivar búsqueda conserva índices y conocimiento y evita llamadas nuevas', async () => {
  const before=calls;
  const chunks=(await pool.query('SELECT * FROM knowledge_chunks ORDER BY item_id,model,chunk_no')).rows;
  const items=await store.listKnowledge(botA.id);
  config.knowledgeSearch.enabled=false;
  assert.equal(await semanticKnowledge(botA,items,'Hola',fake),null);
  assert.equal(await indexKnowledge(botA,fake),0);
  await new KnowledgeWorker(fake).runOnce();
  assert.equal(calls,before);
  assert.deepEqual((await pool.query('SELECT * FROM knowledge_chunks ORDER BY item_id,model,chunk_no')).rows,chunks);
  assert.deepEqual(await store.listKnowledge(botA.id),items);
  config.knowledgeSearch.enabled=true;
});

t('retirar la lista piloto permite completar otros perfiles sin reindexar el primero',async()=>{
  config.knowledgeSearch.accountIds=[];
  const before=calls;
  const result=await prepareKnowledge({all:true},{apply:true,ai:fake});
  assert.equal(result.complete,true); assert.equal(result.processed_items,1);
  assert.equal(calls,before+1);
});

test('una lista piloto inválida falla antes del arranque, sin ampliar el alcance',()=>{
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"await import('./src/config.ts')"],{env:{...process.env,KNOWLEDGE_SEARCH_ACCOUNT_IDS:'invalid'},encoding:'utf8'});
  assert.notEqual(result.status,0); assert.match(result.stderr,/debe contener UUID/);
});

t('un UUID válido de perfil inexistente no acredita un piloto preparado',async()=>{
  config.knowledgeSearch.accountIds=['00000000-0000-0000-0000-000000000001'];
  try { const result=await operationalStatus(); assert.equal(result.rollout.valid,false); assert.equal(result.knowledge.complete,false); }
  finally { config.knowledgeSearch.accountIds=[]; }
});
