import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db.js';
import type { InboundMessage } from '../channels/types.js';
import type { Channel } from '../types.js';
import * as store from '../store/index.js';
import { maskSensitive } from './safety.js';
import { deepClean } from './text.js';
import { coordinated, DeliveryUncertain } from './coordination.js';

/** The HTTP acknowledgement follows this commit, never an unpersisted background promise. */
export class InboundQueue {
  private stopped=false;
  private timer?:NodeJS.Timeout;
  private running?:Promise<void>;
  private hints=new Set<number>();
  constructor(private receive:(channel:Channel,msg:InboundMessage)=>Promise<unknown>,private failed:(channel:Channel)=>Promise<void>) {
    if(config.queue.role!=='http') {
      this.timer=setInterval(()=>this.wake(),config.queue.pollMs);this.timer.unref();
    }
  }
  async accept(channel:Channel,messages:InboundMessage[]) {
    if(this.stopped) throw new Error('La recepción está cerrada');
    const ids=await withTransaction(async client=>{
      const inserted:number[]=[];
      for(const msg of messages) {
        const payload=deepClean({...msg,text:maskSensitive(msg.text)});
        const rows=(await client.query(`INSERT INTO inbound_receipts(channel_id,external_id,message_id,from_me,payload) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT DO NOTHING RETURNING id`,[channel.id,msg.externalId,msg.messageId,msg.fromMe,JSON.stringify(payload)])).rows;
        inserted.push(...rows.map(r=>r.id));
      }
      return inserted;
    });
    ids.forEach(id=>this.hints.add(id));
    if(config.queue.role!=='http') setImmediate(()=>this.wake());
    return ids.length;
  }
  private wake() {if(!this.running&&!this.stopped) this.running=this.runDue().catch(()=>console.warn('[inbox] Recepciones conservadas; PostgreSQL no disponible.')).finally(()=>{this.running=undefined;});}
  async runDue() {
    if(this.stopped) return;
    const rows=await query(`SELECT * FROM inbound_receipts WHERE (state='pending' AND run_at<=now()) OR (state='running' AND lease_until<now()) ORDER BY id LIMIT 10`);
    for(const row of rows) {
      if(this.stopped) break;
      await coordinated(`inbound:${row.channel_id}:${row.external_id}`,`receipt:${row.id}`,async()=>{
        const receipt=await queryOne(`UPDATE inbound_receipts SET state='running',lease_until=now()+interval '5 minutes',attempts=attempts+1
          WHERE id=$1 AND ((state='pending' AND run_at<=now()) OR (state='running' AND lease_until<now())) RETURNING *`,[row.id]);
        if(!receipt) return;
        const channel=await store.getChannel(row.channel_id);
        if(!channel) return;
        try {
          const prior=await queryOne(`SELECT m.meta FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN contacts ct ON ct.id=c.contact_id
            WHERE c.channel_id=$1 AND ct.external_id=$2 AND m.external_message_id=$3`,[channel.id,row.external_id,row.message_id]);
          if(prior?.meta?.receipt_ready===false) throw new DeliveryUncertain();
          await this.receive(channel,receipt.payload);
          await query(`UPDATE inbound_receipts SET state='done',payload='{}',lease_until=NULL,reason=NULL WHERE id=$1`,[row.id]);
          this.hints.delete(row.id);
        } catch(e) {
          const dead=e instanceof DeliveryUncertain||receipt.attempts>=config.queue.attempts;
          await query(`UPDATE inbound_receipts SET state=$2,reason=$3,lease_until=NULL,run_at=now()+$4*interval '1 millisecond' WHERE id=$1`,[row.id,dead?'dead':'pending',e instanceof DeliveryUncertain?'receipt_interrupted':'receipt_processing',Math.min(config.queue.maxRetryMs,config.queue.retryMs*2**(receipt.attempts-1))]);
          if(dead) {this.hints.delete(row.id);await this.failed(channel);}
        }
      });
    }
  }
  async stop() {this.stopped=true;clearInterval(this.timer);await this.running;this.hints.clear();}
  get size() {return this.hints.size+(this.running?1:0);}
}
