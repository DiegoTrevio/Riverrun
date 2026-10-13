import {fork} from 'node:child_process';
import {once} from 'node:events';
import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,dbAvailable,pool,store,waitFor} from './harness.js';
const {ConversationQueue}=await import('../src/engine/queue.js');
type ConversationQueue=import('../src/engine/queue.js').ConversationQueue;
const {config}=await import('../src/config.js');
const {DeliveryUncertain,coordinated}=await import('../src/engine/coordination.js');
const ok=await dbAvailable();
const t=(name:string,fn:()=>Promise<void>)=>test(name,{skip:!ok},fn);
let h:Awaited<ReturnType<typeof createHarness>>;
const queues:ConversationQueue[]=[];
let conv:string;
before(async()=>{if(!ok)return;h=await createHarness();await h.createBot();await h.service.queue.stop();
 const ch=(await store.getChannel(h.channelId))!;const ct=await store.upsertContact(ch,'521555990001','521555990001','Prueba');conv=(await store.getOrCreateConversation(ch,ct.id)).id;});
after(async()=>{await Promise.all(queues.map(q=>q.stop()));if(h)await h.app.close();await pool.end();});
function queue(run:any,retry=50,attempts=3) {const q=new ConversationQueue(run,2,retry,undefined,attempts);queues.push(q);return q;}
async function reset() {await pool.query('DELETE FROM conversation_work');}

t('el debounce sobrevive al cierre y una segunda instancia ejecuta exactamente una vez',async()=>{
 await reset();let n=0;const q=queue(async()=>{n++;return {status:'replied'};});await q.schedule(conv,60000);await q.stop();
 assert.equal((await pool.query('SELECT state FROM conversation_work')).rows[0].state,'pending');
 await assert.rejects(q.schedule(conv,0),/cerrada/);await assert.rejects(q.exclusive(conv,async()=>1),/cerrada/);
 const next=queue(async()=>{n++;return {status:'replied'};});await pool.query('UPDATE conversation_work SET run_at=now()');await next.runDue();assert.equal(n,1);await next.stop();
});
t('dos workers y operaciones manuales comparten exclusión distribuida',async()=>{
 await reset();let active=0,max=0,n=0;
 const runner=async()=>{active++;max=Math.max(max,active);n++;await new Promise(r=>setTimeout(r,80));active--;return {status:'replied'};};
 const a=queue(runner),b=queue(runner);await a.schedule(conv,0);await Promise.all([a.runDue(),b.runDue()]);assert.equal(n,1);assert.equal(max,1);
 let release!:()=>void;let started!:()=>void;const start=new Promise<void>(r=>started=r);
 const first=a.exclusive(conv,async()=>{started();await new Promise<void>(r=>release=r);});await start;
 let called=false;const second=b.exclusive(conv,async()=>{called=true;});await new Promise(r=>setTimeout(r,30));assert.equal(called,false);release();await Promise.all([first,second]);assert.equal(called,true);
 await a.stop();await b.stop();
});
t('reinicio interrumpido y revisión nueva recuperan trabajo; backoff y DLQ son persistentes',async()=>{
 await reset();let n=0;const q=queue(async()=>{n++;return {status:'error'};},50,2);await q.schedule(conv,0);
 await pool.query(`UPDATE conversation_work SET state='running',lease_until=now()-interval '1 second'`);await q.runDue();
 let row=(await pool.query('SELECT * FROM conversation_work')).rows[0];assert.equal(row.state,'pending');assert.equal(row.attempts,1);assert.ok(new Date(row.run_at)>new Date(row.updated_at));
 await pool.query('UPDATE conversation_work SET run_at=now()');await q.runDue();row=(await pool.query('SELECT * FROM conversation_work')).rows[0];assert.equal(row.state,'dead');assert.equal(n,2);
 await q.schedule(conv,0);assert.equal((await pool.query('SELECT state FROM conversation_work')).rows[0].state,'dead','un webhook nuevo no borra una entrega pendiente de revisión');await q.stop();
});
t('un envío incierto va a revisión y no se vuelve a ejecutar automáticamente',async()=>{
 await reset();let n=0;const q=queue(async()=>{n++;throw new DeliveryUncertain();});await q.schedule(conv,0);await q.runDue();await q.runDue();assert.equal(n,1);assert.equal((await pool.query('SELECT reason FROM conversation_work')).rows[0].reason,'delivery_uncertain');await q.stop();
});
t('apagar espera operaciones activas; un mensaje durante ellas permanece en PostgreSQL',async()=>{
 await reset();const q=queue(async()=>({status:'replied'}));let release!:()=>void;let start!:()=>void;const started=new Promise<void>(r=>start=r);
 const operation=q.exclusive(conv,async()=>{await q.schedule(conv,10000);start();await new Promise<void>(r=>release=r);});await started;
 let ended=false;const stop=q.stop().then(()=>{ended=true;});await Promise.resolve();assert.equal(ended,false);release();await Promise.all([operation,stop]);assert.equal((await pool.query('SELECT state FROM conversation_work')).rows[0].state,'pending');
});
t('el límite de workers se comparte entre instancias',async()=>{
 await reset();await pool.query('INSERT INTO worker_limits(id,concurrency) VALUES(true,1) ON CONFLICT(id) DO UPDATE SET concurrency=1');
 let release!:()=>void;let start!:()=>void;const started=new Promise<void>(r=>start=r);
 const first=coordinated('test:first','one',async()=>{start();await new Promise<void>(r=>release=r);},true);await started;
 const second=await coordinated('test:second','two',async()=>1,true);assert.equal(second.acquired,false);release();await first;
 await pool.query('UPDATE worker_limits SET concurrency=$1',[config.queue.concurrency]);
});

t('SIGKILL durante una respuesta libera el bloqueo y otro proceso recupera el trabajo persistido',async()=>{
 await reset();await pool.query("INSERT INTO conversation_work(conversation_id) VALUES($1)",[conv]);
 const child=fork(new URL('./fixtures/interrupted-worker.mts',import.meta.url),[],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL}});
 let diagnostic='';child.stderr?.on('data',chunk=>diagnostic+=String(chunk));
 try {
  await Promise.race([once(child,'message'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Worker no inició: '+diagnostic)),5000).unref())]);
  assert.equal((await pool.query('SELECT state FROM conversation_work')).rows[0].state,'running');
  child.kill('SIGKILL');await once(child,'exit');
  await pool.query("UPDATE conversation_work SET lease_until=now()-interval '1 second'");
  let calls=0;const replacement=queue(async()=>{calls++;return {status:'replied'};});await replacement.runDue();await replacement.stop();
  assert.equal(calls,1);assert.equal((await pool.query('SELECT state FROM conversation_work')).rows[0].state,'done');
 } finally {if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');}
});
