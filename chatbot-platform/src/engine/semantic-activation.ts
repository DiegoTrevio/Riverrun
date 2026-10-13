import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { query,queryOne } from '../db.js';
import * as store from '../store/index.js';
import { knowledgeChunks,knowledgeHash,knowledgeIndexStatus } from './knowledge.js';
import { semanticPolicy } from './semantic-policy.js';
export async function activationStatus(accountId:string) {
  const bots=await store.listChatbots(accountId);
  const agents=await Promise.all(bots.map(async bot=>({id:bot.id,name:bot.name,...await knowledgeIndexStatus(bot)})));
  const items=(await Promise.all(bots.map(b=>store.listKnowledge(b.id,true)))).flat();
  const signature=createHash('sha256').update(config.knowledgeSearch.model+':'+items.map(k=>k.id+':'+knowledgeHash(k)+':'+k.always_include).sort().join('|')).digest('hex');
  const pendingIds=new Set(agents.filter(a=>a.pending_items).map(a=>a.id));
  const pending=items.filter(k=>!k.always_include&&pendingIds.has(k.chatbot_id));
  const bytes=pending.reduce((n,k)=>n+knowledgeChunks(k.content).reduce((sum,text)=>sum+Buffer.byteLength(k.category+'\n'+k.title+'\n'+text),0),0);
  const price=config.knowledgeSearch.pricePerMillion ?? (/^(openai\/)?text-embedding-3-small$/.test(config.knowledgeSearch.model)?0.02:null);
  const policy=await semanticPolicy(accountId);
  const errors=await query(`SELECT s.item_id,k.title,s.error_code,s.attempts,s.retry_at FROM knowledge_preparation_state s JOIN knowledge_items k ON k.id=s.item_id JOIN chatbots b ON b.id=k.chatbot_id WHERE b.account_id=$1 AND s.error_code IS NOT NULL ORDER BY s.updated_at DESC LIMIT 50`,[accountId]);
  const usage=await queryOne(`SELECT reserved_tokens FROM embedding_usage WHERE account_id=$1 AND day=(now() AT TIME ZONE 'UTC')::date`,[accountId]);
  return { ...policy, model:config.knowledgeSearch.model,force_off:config.knowledgeSearch.forceOff,signature,agents,
    available:agents.every(a=>a.available),pending_items:agents.reduce((n,a)=>n+a.pending_items,0),indexed_items:agents.reduce((n,a)=>n+a.indexed_items,0),
    errors,reserved_tokens:usage?.reserved_tokens??0,estimate:{token_ceiling:bytes,approximate_tokens:Math.ceil(bytes/4),upper_estimated_usd:price===null?null:bytes*price/1e6,price_per_million:price},
    ready:agents.every(a=>a.complete)&&policy.verified_model===config.knowledgeSearch.model&&policy.tested_signature===signature };
}
