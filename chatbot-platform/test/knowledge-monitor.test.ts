import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, store } from './harness.js';
const {config}=await import('../src/config.js');
const {superviseKnowledge,accountKnowledgeMetrics}=await import('../src/engine/knowledge-monitor.js');
const {indexKnowledge}=await import('../src/engine/knowledge.js');
const {logEvent}=await import('../src/logs.js');
const ok=await dbAvailable();
const t=(name:string,fn:()=>Promise<void>)=>test(name,{skip:!ok&&'PostgreSQL no disponible'},fn);
let h:Awaited<ReturnType<typeof createHarness>>,a:any,b:any,bot:any,limited:any;
const previous={search:{...config.knowledgeSearch},monitor:{...config.knowledgeMonitor},key:config.openai.apiKey};
const now=new Date(Date.now()+2000);
const fake={complete:async()=>{throw Error('No chat');},transcribe:async()=>'',embed:async(texts:string[],model:string)=>({vectors:texts.map(()=>Array.from({length:1536},(_,i)=>i===0?1:0)),model,input_tokens:5,latency_ms:1,cost_usd:0.001})};
before(async()=>{
 if(!ok)return;
 h=await createHarness();
 a=(await h.authed('POST','/api/accounts',{name:'Perfil supervisado',admin:{email:'supervised@test.mx',password:'supervised-pass-123'}})).json();
 b=(await h.authed('POST','/api/accounts',{name:'Perfil ajeno',admin:{email:'other@test.mx',password:'other-pass-123'}})).json();
 limited=await h.loginAs('supervised@test.mx','supervised-pass-123');
 bot=await store.createChatbot(a.id,{name:'Agente'});
 await store.upsertKnowledge(bot.id,{title:'Tarifa',content:'Doble $1,650.'});
 config.knowledgeSearch.enabled=true;config.knowledgeSearch.accountIds=[a.id];config.openai.apiKey='PRIVATE-TEST-KEY';
 Object.assign(config.knowledgeMonitor,{enabled:true,pendingMinutes:15,fallbackRatio:0.05,minAttempts:20,latencyMs:10000,hourlyUsd:5});
});
after(async()=>{Object.assign(config.knowledgeSearch,previous.search);Object.assign(config.knowledgeMonitor,previous.monitor);config.openai.apiKey=previous.key;if(h)await h.app.close();await pool.end();});

t('guarda pendientes sin avisar durante el periodo de gracia; avisa al quedar estancados',async()=>{
 await superviseKnowledge(now);
 assert.equal((await pool.query("SELECT count(*)::int n FROM notifications WHERE kind='knowledge'")).rows[0].n,0);
 await superviseKnowledge(new Date(now.getTime()+16*60000));
 const alerts=(await pool.query("SELECT * FROM knowledge_alerts WHERE account_id=$1 AND kind='pending'",[a.id])).rows;
 assert.equal(alerts[0].active,true);
 const notifications=(await pool.query("SELECT n.*,u.role,u.account_id user_account FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.kind='knowledge'")).rows;
 assert.equal(notifications.length,2); // Master and this profile's admin only.
 assert.ok(notifications.every(n=>n.role==='superadmin'||n.user_account===a.id));
});

t('réplicas concurrentes no repiten el aviso; una edición reinicia la espera',async()=>{
 const tick=new Date(now.getTime()+17*60000);
 await Promise.all([superviseKnowledge(tick),superviseKnowledge(tick)]);
 assert.equal((await pool.query("SELECT count(*)::int n FROM notifications WHERE kind='knowledge'")).rows[0].n,2);
 const item=(await store.listKnowledge(bot.id))[0];
 await store.upsertKnowledge(bot.id,{id:item.id,content:'Doble $1,700.'});
 await superviseKnowledge(new Date(now.getTime()+18*60000));
 assert.equal((await pool.query("SELECT active FROM knowledge_alerts WHERE account_id=$1 AND kind='pending'",[a.id])).rows[0].active,false);
 assert.equal((await pool.query("SELECT count(*)::int n FROM notifications WHERE title LIKE 'Resuelto:%'")).rows[0].n,2);
});

t('preparación sin conversaciones registra errores de embeddings sin secretos ni contenido',async()=>{
 await assert.rejects(indexKnowledge(bot,{...fake,embed:async()=>{throw Error('PRIVATE-TEST-KEY TEXTO-PRIVADO');}}));
 const events=(await pool.query("SELECT message,details FROM event_logs WHERE account_id=$1 AND message='knowledge_embedding'",[a.id])).rows;
 assert.equal(events.at(-1).details.outcome,'error');
 assert.ok(!JSON.stringify(events).includes('PRIVATE-TEST-KEY')&&!JSON.stringify(events).includes('TEXTO-PRIVADO'));
 await superviseKnowledge(new Date(now.getTime()+19*60000));
 assert.equal((await pool.query("SELECT active FROM knowledge_alerts WHERE account_id=$1 AND kind='embedding'",[a.id])).rows[0].active,true);
});

t('registra uso alternativo, latencia y costos; aplica mínimos de muestras',async()=>{
 for(let i=0;i<19;i++)await logEvent({level:'warn',source:'engine',message:'knowledge_search',accountId:a.id,chatbotId:bot.id,details:{outcome:'fallback',duration_ms:20000}});
 await superviseKnowledge(new Date(now.getTime()+20*60000));
 assert.equal((await pool.query("SELECT count(*)::int n FROM knowledge_alerts WHERE account_id=$1 AND kind IN ('fallback','latency') AND active",[a.id])).rows[0].n,0);
 await logEvent({level:'warn',source:'engine',message:'knowledge_search',accountId:a.id,chatbotId:bot.id,details:{outcome:'fallback',duration_ms:20000}});
 await store.insertAiRun({account_id:a.id,chatbot_id:bot.id,conversation_id:null,kind:'embedding',model:'synthetic',input_tokens:1,cached_tokens:0,output_tokens:0,latency_ms:1,cost_usd:6});
 await superviseKnowledge(new Date(now.getTime()+21*60000));
 const metrics=await accountKnowledgeMetrics(a.id,new Date(now.getTime()+21*60000));
 assert.equal(metrics.attempts,20);assert.equal(metrics.fallback_ratio,1);assert.equal(metrics.p95_ms,20000);assert.equal(metrics.recorded_usd,6);
 assert.equal((await pool.query("SELECT count(*)::int n FROM knowledge_alerts WHERE account_id=$1 AND kind IN ('fallback','latency','cost') AND active",[a.id])).rows[0].n,3);
});

t('costos no reportados provocan aviso aunque la contabilidad use una estimación',async()=>{
 await indexKnowledge(bot,{...fake,embed:async(texts:string[],model:string)=>{const r=await fake.embed(texts,model);return {...r,cost_usd:undefined};}});
 const metrics=await accountKnowledgeMetrics(a.id,new Date(now.getTime()+22*60000));
 assert.equal(metrics.unreported_embedding_costs,1);
});

t('las entregas fallidas generan avisos asociados al perfil correcto',async()=>{
 const channel=await store.createChannel({account_id:a.id,chatbot_id:bot.id,type:'playground',name:'Simulador',config:{}});
 const contact=await store.upsertContact(channel,'synthetic-customer','','');
 const conversation=await store.getOrCreateConversation(channel,contact.id);
 await store.insertMessage({conversation_id:conversation.id,direction:'out',sender:'bot',content:'Texto privado sintético',status:'failed'});
 await superviseKnowledge(new Date(now.getTime()+23*60000));
 assert.equal((await pool.query("SELECT active FROM knowledge_alerts WHERE account_id=$1 AND kind='delivery'",[a.id])).rows[0].active,true);
 const bodies=(await pool.query("SELECT body FROM notifications WHERE kind='knowledge'")).rows;
 assert.ok(!JSON.stringify(bodies).includes('Texto privado sintético'));
});

t('la latencia de embeddings se supervisa aunque no haya consultas de clientes',async()=>{
 config.knowledgeSearch.accountIds=[a.id,b.id];
 for(let i=0;i<20;i++)await logEvent({level:'info',source:'ai',message:'knowledge_embedding',accountId:b.id,details:{outcome:'ok',duration_ms:20000,cost_reported:true}});
 await superviseKnowledge(new Date(now.getTime()+24*60000));
 const metrics=await accountKnowledgeMetrics(b.id,new Date(now.getTime()+24*60000));
 assert.equal(metrics.attempts,0);assert.equal(metrics.embedding_attempts,20);assert.equal(metrics.embedding_p95_ms,20000);
 assert.equal((await pool.query("SELECT active FROM knowledge_alerts WHERE account_id=$1 AND kind='latency'",[b.id])).rows[0].active,true);
});

t('informe y notificaciones respetan perfiles, incluso si se pide una cuenta ajena',async()=>{
 const response=await limited('GET',`/api/knowledge/monitor?account_id=${b.id}`);
 assert.equal(response.statusCode,200);assert.deepEqual(response.json().accounts.map((x:any)=>x.id),[a.id]);
 const notices=(await limited('GET','/api/notifications')).json().items;
 assert.ok(notices.every((n:any)=>n.account_id===a.id));
 assert.equal((await h.app.inject({method:'GET',url:'/api/knowledge/monitor'})).statusCode,401);
 assert.equal((await h.authed('GET','/api/knowledge/monitor?account_id=invalid')).statusCode,400);
 assert.equal((await h.authed('GET',`/api/knowledge/monitor?account_id=${b.id}`)).json().accounts[0].id,b.id);
});

t('resolver y reabrir una incidencia genera nuevos avisos; conserva el estado tras otra revisión',async()=>{
 await superviseKnowledge(new Date(now.getTime()+90*60000));
 const active=(await pool.query("SELECT count(*)::int n FROM knowledge_alerts WHERE account_id=$1 AND active",[a.id])).rows[0].n;
 assert.equal(active,0);
 await logEvent({level:'error',source:'ai',message:'knowledge_embedding',accountId:a.id,chatbotId:bot.id,details:{outcome:'error',stage:'provider'}});
 // Use a current timestamp, then move it forward to the next observed window.
 await pool.query("UPDATE event_logs SET created_at=$2 WHERE account_id=$1 AND message='knowledge_embedding'",[a.id,new Date(now.getTime()+91*60000)]);
 await superviseKnowledge(new Date(now.getTime()+92*60000));
 assert.equal((await pool.query("SELECT active FROM knowledge_alerts WHERE account_id=$1 AND kind='embedding'",[a.id])).rows[0].active,true);
 const count=(await pool.query("SELECT count(*)::int n FROM notifications WHERE kind='knowledge'")).rows[0].n;
 await superviseKnowledge(new Date(now.getTime()+93*60000));
 assert.equal((await pool.query("SELECT count(*)::int n FROM notifications WHERE kind='knowledge'")).rows[0].n,count);
});

t('un inventario roto avisa sin afirmar que el diagnóstico terminó bien',async()=>{
 await pool.query('ALTER TABLE knowledge_chunks RENAME COLUMN content TO temporarily_unavailable_content');
 try {
  const result=await superviseKnowledge(new Date(now.getTime()+94*60000));
  assert.equal(result.failed,1);
  assert.equal((await pool.query("SELECT active FROM knowledge_alerts WHERE account_id=$1 AND kind='configuration'",[a.id])).rows[0].active,true);
  assert.ok((await pool.query("SELECT id FROM notifications WHERE account_id=$1 AND title='Aviso: no se pudo completar la supervisión'",[a.id])).rows.length>0);
 } finally {await pool.query('ALTER TABLE knowledge_chunks RENAME COLUMN temporarily_unavailable_content TO content');}
});

t('retención de siete días y apagado de supervisión no borran incidentes ni datos del negocio',async()=>{
 await pool.query("INSERT INTO knowledge_monitor_samples(account_id,observed_at,metrics) VALUES($1,$2,'{}')",[a.id,new Date(now.getTime()-8*86400000)]);
 await superviseKnowledge(new Date(now.getTime()+95*60000));
 assert.equal((await pool.query("SELECT count(*)::int n FROM knowledge_monitor_samples WHERE observed_at<$1",[new Date(now.getTime()-7*86400000)])).rows[0].n,0);
 const before=(await pool.query('SELECT count(*)::int n FROM knowledge_monitor_samples')).rows[0].n;
 config.knowledgeMonitor.enabled=false;
 assert.deepEqual(await superviseKnowledge(new Date(now.getTime()+95*60000)),{checked:0,failed:0});
 assert.equal((await pool.query('SELECT count(*)::int n FROM knowledge_monitor_samples')).rows[0].n,before);
 assert.equal((await store.listKnowledge(bot.id)).length,1);
});
