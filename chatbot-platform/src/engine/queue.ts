import crypto from 'node:crypto';
import { config } from '../config.js';
import { tick } from '../watchdog.js';
import { query, queryOne } from '../db.js';
import { coordinated, DeliveryUncertain,detached } from './coordination.js';
export type Runner = (id: string, attempt: { restarts: number }) => Promise<{ status: string }>;
/** Fallos que se pueden repetir sin riesgo de duplicar un envío (la IA falló, o el trabajo era de antes de un reinicio). */
export const RETRYABLE_DEAD = ['processing_error', 'stale_pending'];

/**
 * Programa la conversación. Con `revive` (mensaje nuevo del cliente), un trabajo en revisión por un fallo que se puede
 * repetir vuelve a la cola: el cliente no se queda sin respuesta para siempre. Un envío incierto nunca se repite solo.
 */
export async function enqueue(id: string, delay: number, client?: { query: (...args: any[]) => Promise<any> }, revive = false) {
  const sql = `INSERT INTO conversation_work(conversation_id,run_at) VALUES($1,now()+$2*interval '1 millisecond')
    ON CONFLICT(conversation_id) DO UPDATE SET run_at=EXCLUDED.run_at,revision=conversation_work.revision+1,
    state=CASE WHEN $3 AND conversation_work.state='dead' AND conversation_work.reason=ANY($4::text[]) THEN 'pending'
      WHEN conversation_work.state IN ('running','dead') THEN conversation_work.state ELSE 'pending' END,
    reason=CASE WHEN $3 AND conversation_work.state='dead' AND conversation_work.reason=ANY($4::text[]) THEN NULL ELSE conversation_work.reason END,
    revivals=CASE WHEN $3 AND conversation_work.state='dead' AND conversation_work.reason=ANY($4::text[]) THEN 0 ELSE conversation_work.revivals END,
    attempts=CASE WHEN conversation_work.state='done' OR ($3 AND conversation_work.state='dead' AND conversation_work.reason=ANY($4::text[])) THEN 0 ELSE conversation_work.attempts END,updated_at=now()`;
  const args = [id, delay, revive, RETRYABLE_DEAD];
  if(client) await client.query(sql,args); else await query(sql,args);
}
/** Local state only tracks promises for shutdown; all eligibility, debounce and retries live in PostgreSQL. */
export class ConversationQueue {
  private stopped=false;
  /** Apagándose: ya no toma trabajo nuevo, pero sí guarda lo que llegue (otro proceso o el reinicio lo atiende). */
  private draining=false;
  private active=new Set<Promise<unknown>>();
  private processing=new Map<string,Promise<boolean>>();
  private hints=new Set<string>();
  private timer?: NodeJS.Timeout;
  private wake?: NodeJS.Timeout;
  private wakeAt=Infinity;
  private polling=false;
  constructor(private runner: Runner,private maxRestarts=2,private errorRetryMs=config.queue.retryMs,
    private onGiveUp?: (id:string)=>void|Promise<void>,private maxAttempts=config.queue.attempts,options:{autoStart?:boolean}={}) {
    if(config.queue.role!=='http' && options.autoStart!==false) this.start();
  }
  start() {
    if(this.timer||this.stopped) return;
    this.timer=setInterval(()=>{void this.runDue(config.queue.concurrency,false).catch(()=>console.warn('[queue] PostgreSQL no disponible; trabajos conservados.'));},config.queue.pollMs);
    this.timer.unref();
  }
  async schedule(id:string,delay:number,revive=false) {
    if(this.stopped) throw new Error('La cola está cerrada');
    this.hints.add(id);
    try {await enqueue(id,delay,undefined,revive);} catch(e) {this.hints.delete(id);throw e;}
    // Optional wakeup only: PostgreSQL remains authoritative if this timer is lost.
    const at=Date.now()+delay+5;
    if(this.timer && !this.draining && config.queue.role!=='http' && at<this.wakeAt) {
      clearTimeout(this.wake);this.wakeAt=at;
      this.wake=setTimeout(()=>{this.wakeAt=Infinity;void detached(()=>this.runDue(config.queue.concurrency,false).catch(()=>undefined));},delay+5);
      this.wake.unref();
    }
  }
  async exclusive<T>(id:string,fn:()=>Promise<T>):Promise<T> {
    if(this.stopped) throw new Error('La cola está cerrada');
    const task=(async()=>{
      for(;;) {
        if(this.stopped) throw new Error('La cola está cerrada');
        const r=await coordinated(`conversation:${id}`,`manual:${crypto.randomUUID()}`,fn);
        if(r.acquired) return r.value;
        await new Promise(r=>setTimeout(r,100));
      }
    })();
    this.active.add(task);
    try {return await task;} finally {this.active.delete(task);}
  }
  async runDue(limit=config.queue.concurrency,wait=true) {
    limit=Math.max(1,Math.min(config.queue.concurrency,Math.trunc(limit)||1));
    if(this.stopped||this.draining||this.polling) return 0;
    this.polling=true;
    try {
      const rows=await query(`SELECT conversation_id FROM conversation_work WHERE (state='pending' AND run_at<=now()) OR (state='running' AND lease_until<now()) ORDER BY run_at LIMIT $1`,[Math.min(24,limit*4)]);
      if(this.stopped) return 0;
      const tasks:Promise<boolean>[]=[];
      for(const row of rows) {
        if(this.stopped||this.processing.size>=limit) break;
        if(this.processing.has(row.conversation_id)) continue;
        const task=this.run(row.conversation_id);this.processing.set(row.conversation_id,task);this.active.add(task);tasks.push(task);
        const finish=()=>{this.processing.delete(row.conversation_id);this.active.delete(task);};
        void task.then(finish,()=>{finish();console.warn('[queue] Trabajo conservado para recuperación.');});
      }
      let n=tasks.length;
      if(wait) {
        const results=await Promise.allSettled(tasks);n=results.filter(r=>r.status==='fulfilled'&&r.value).length;
        const error=results.find(r=>r.status==='rejected');if(error?.status==='rejected') throw error.reason;
      }
      tick('queue');
      if(this.hints.size) {
        const live=await query(`SELECT conversation_id FROM conversation_work WHERE conversation_id=ANY($1::uuid[]) AND state IN ('pending','running')`,[[...this.hints]]);
        this.hints=new Set(live.map(r=>r.conversation_id));
      }
      return n;
    } finally {this.polling=false;}
  }
  private async run(id:string) {
    const r=await coordinated(`conversation:${id}`,`queue:${id}`,async()=>{
      const token=crypto.randomUUID();
      const job=await queryOne(`UPDATE conversation_work SET state='running',token=$2,claimed_revision=revision,lease_until=now()+interval '5 minutes',updated_at=now()
        WHERE conversation_id=$1 AND ((state='pending' AND run_at<=now()) OR (state='running' AND lease_until<now())) RETURNING *`,[id,token]);
      if(!job) return false;
      const heartbeat=setInterval(()=>{void query(`UPDATE conversation_work SET lease_until=now()+interval '5 minutes' WHERE conversation_id=$1 AND token=$2`,[id,token]).catch(()=>undefined);},30_000);
      heartbeat.unref();
      let status='error';let reason='processing_error';
      try {status=(await this.runner(id,{restarts:job.restarts})).status;}
      catch(e) {if(e instanceof DeliveryUncertain) {status='uncertain';reason='delivery_uncertain';}}
      finally {clearInterval(heartbeat);}
      const errors=job.attempts+(status==='error'?1:0);
      const dead=status==='uncertain'||(status==='error'&&errors>=this.maxAttempts);
      const repeat=status==='error'||status==='restart'||status==='busy';
      const delay=status==='error'?Math.min(config.queue.maxRetryMs,this.errorRetryMs*2**(errors-1)):status==='busy'?2000:500;
      await query(`UPDATE conversation_work SET state=CASE WHEN $3 THEN 'dead' WHEN $4 OR revision<>claimed_revision THEN 'pending' ELSE 'done' END,
        run_at=CASE WHEN $4 THEN now()+$5*interval '1 millisecond' ELSE run_at END,attempts=$6,
        restarts=CASE WHEN $7='restart' THEN restarts+1 ELSE 0 END,reason=CASE WHEN $3 OR $7='error' THEN $8 ELSE NULL END,
        token=NULL,lease_until=NULL,updated_at=now() WHERE conversation_id=$1 AND token=$2`,[id,token,dead,repeat,delay,errors,status,reason]);
      if(dead) await this.onGiveUp?.(id);
      return true;
    },true);
    return r.acquired&&r.value;
  }
  has(id:string) {return this.hints.has(id);}
  canRestart(n:number) {return n<this.maxRestarts;}
  /** Deja de tomar trabajo nuevo (al apagar): lo que ya corre termina y lo pendiente queda en PostgreSQL. */
  drain() {this.draining=true;clearInterval(this.timer);clearTimeout(this.wake);}
  async stop() {this.stopped=true;clearInterval(this.timer);clearTimeout(this.wake);await Promise.allSettled([...this.active]);this.hints.clear();}
  get size() {return this.hints.size+this.active.size;}
}
