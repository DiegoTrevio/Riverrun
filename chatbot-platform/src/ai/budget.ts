import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db.js';
import { config } from '../config.js';
import { logEvent } from '../logs.js';
import { notifyUsers } from '../automation/store.js';
import { HttpError } from '../access.js';
import type { AiProvider, CompletionRequest, CompletionResult, EmbeddingResult } from './provider.js';

const Money=z.number().finite().min(0).max(1000000).nullable();
const Rate=z.number().finite().min(0).max(10000).refine(n=>n===0||n>=0.000001,'La tarifa positiva mínima es 0.000001 USD');
const Price=z.object({model:z.string().trim().min(1).max(120),input_per_mtok:Rate,output_per_mtok:Rate,per_audio_minute:Rate.default(0),is_free:z.boolean().default(false)});
export const BudgetSettings=z.object({
 monthly_usd:Money.default(null),daily_usd:Money.default(null),
 max_output_tokens:z.number().int().min(256).max(16000).default(2048),
 models:z.array(z.object({model:z.string().trim().min(1).max(120),period:z.enum(['day','month']),limit_usd:z.number().finite().min(0).max(1000000)})).max(20).default([]),
 prices:z.array(Price).max(20).default([]),
}).refine(s=>new Set(s.models.map(m=>normalize(m.model)+':'+m.period)).size===s.models.length,'No repitas el límite de un modelo y periodo')
 .refine(s=>new Set(s.prices.map(p=>normalize(p.model))).size===s.prices.length,'No repitas el precio de un modelo');
export type BudgetPolicy=z.infer<typeof BudgetSettings>;
export const normalize=(model:string)=>model.replace(/^openai\//,'').replace(/-\d{4}-\d{2}-\d{2}$/,'');
export class AiBudgetBlocked extends HttpError {
 constructor(public code:'budget_exhausted'|'price_unknown'|'unresolved_cost'|'audio_duration_unknown') {super(409,code==='budget_exhausted'?'El perfil llegó a su presupuesto de IA.':'No se pudo reservar el presupuesto de esta llamada. Revisa Consumo de IA.');}
}
export async function expireReservations(accountId:string) {
 await query(`UPDATE ai_spend SET state='uncertain',finished_at=now() WHERE account_id=$1 AND state='reserved' AND created_at<now()-($2::int*interval '1 millisecond')`,[accountId,Math.max(300000,config.openai.timeoutMs*3+60000)]);
}
export async function budgetPolicy(accountId:string) {
 const row=await queryOne('SELECT revision,settings FROM ai_budget_settings WHERE account_id=$1',[accountId]);
 return {revision:row?.revision??0,settings:BudgetSettings.parse(row?.settings??{})};
}
type Quote={model:string;input_per_mtok:number;cached_per_mtok?:number;output_per_mtok:number;per_audio_minute:number};
async function price(model:string,policy:BudgetPolicy,client?:import('pg').PoolClient):Promise<Quote|null> {
 const name=normalize(model);
 const local=policy.prices.filter(p=>name===normalize(p.model)||name.startsWith(normalize(p.model)+'-')).sort((a,b)=>b.model.length-a.model.length)[0];
 if(local)return local.is_free||local.input_per_mtok+local.output_per_mtok+local.per_audio_minute>0?{...local,model:name}:null;
 const sql=`SELECT * FROM ai_prices WHERE starts_with($1::text,regexp_replace(model,'^openai/','')) ORDER BY length(model) DESC LIMIT 1`;
 const found=client?(await client.query(sql,[name])).rows[0]:await queryOne(sql,[name]);
 if(found)return found.is_free||Number(found.input_per_mtok)+Number(found.output_per_mtok)+Number(found.per_audio_minute)>0?{model:name,input_per_mtok:Number(found.input_per_mtok),cached_per_mtok:Number(found.cached_per_mtok),output_per_mtok:Number(found.output_per_mtok),per_audio_minute:Number(found.per_audio_minute)}:null;
 if(name==='text-embedding-3-small')return {model:name,input_per_mtok:config.knowledgeSearch.pricePerMillion??0.02,output_per_mtok:0,per_audio_minute:0};
 return null;
}
type Spec={kind:string;models:string[];input:number;output:number;seconds?:number};
const constrained=(p:BudgetPolicy,models:string[])=>p.monthly_usd!==null||p.daily_usd!==null||p.models.some(m=>models.includes(normalize(m.model)));
const cost=(p:Quote,input:number,output:number,seconds=0,cached=0)=>p.per_audio_minute>0?seconds/60*p.per_audio_minute:((input-cached)*p.input_per_mtok+cached*(p.cached_per_mtok??p.input_per_mtok)+output*p.output_per_mtok)/1000000;
async function notice(accountId:string,reason:string) {
 try {
  const won=await queryOne(`INSERT INTO ai_budget_notices(account_id,day,reason) VALUES($1,(now() AT TIME ZONE 'UTC')::date,$2) ON CONFLICT DO NOTHING RETURNING reason`,[accountId,reason]);
  if(!won)return;
  const admins=await query<{id:string}>("SELECT id FROM users WHERE active AND ((account_id=$1 AND role='admin') OR role='superadmin')",[accountId]);
  await notifyUsers(accountId,admins.map(a=>a.id),{title:reason==='budget_80'?'Te acercas al presupuesto de IA':'Revisa el presupuesto de IA',body:reason==='budget_80'?'El gasto y las reservas de este perfil llegaron al 80 % de un límite.':reason==='budget_exhausted'?'Se alcanzó un límite de gasto. La atención manual y las reglas programadas siguen disponibles.':'Hay un precio o importe pendiente de confirmar antes de continuar con la IA.',kind:'alert',link:`#/consumo?account_id=${accountId}`});
  await logEvent({level:'warn',source:'ai',message:'ai_budget_blocked',accountId,details:{reason}});
 }catch{/* A notification outage must never permit an unreserved call. */}
}
async function reserve(accountId:string,chatbotId:string|null,spec:Spec) {
 try{return await withTransaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`ai-budget:${accountId}`]);
  const row=(await client.query('SELECT revision,settings FROM ai_budget_settings WHERE account_id=$1',[accountId])).rows[0];
  const policy=BudgetSettings.parse(row?.settings??{}),limited=constrained(policy,spec.models);
  const output=limited&&spec.kind!=='transcription'?Math.min(spec.output,policy.max_output_tokens):spec.output;
  const prices=await Promise.all(spec.models.map(m=>price(m,policy,client)));
  if(limited&&prices.some(p=>!p))throw new AiBudgetBlocked('price_unknown');
  if(limited&&prices.some(p=>p!.per_audio_minute>0)&&spec.seconds===undefined)throw new AiBudgetBlocked('audio_duration_unknown');
  const estimates=prices.map(p=>p?cost({...p,input_per_mtok:Math.max(p.input_per_mtok,p.cached_per_mtok??0)},spec.input,output,spec.seconds):null);
  const amount=estimates.some(p=>p===null)?null:Math.max(...estimates as number[]);
  const caps=[...(policy.monthly_usd!==null?[{period:'month',limit_usd:policy.monthly_usd,model:null}]:[]),...(policy.daily_usd!==null?[{period:'day',limit_usd:policy.daily_usd,model:null}]:[]),...policy.models.filter(m=>spec.models.includes(normalize(m.model))).map(m=>({...m,model:normalize(m.model)}))];
  let nearing=false;
  for(const cap of caps) {
   const used=(await client.query(`SELECT coalesce(sum(coalesce(charged_usd,reserved_usd)),0) AS used,count(*) FILTER(WHERE charged_usd IS NULL AND (reserved_usd IS NULL OR quote->>'model_mismatch'='true') AND state<>'rejected')::int AS unknown FROM ai_spend WHERE account_id=$1 AND created_at>=date_trunc($2,now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND ($3::text IS NULL OR $3=ANY(models)) AND state<>'rejected'`,[accountId,cap.period,cap.model])).rows[0];
   if(used.unknown>0)throw new AiBudgetBlocked('unresolved_cost');
   if(Number(used.used)+(amount??0)>cap.limit_usd)throw new AiBudgetBlocked('budget_exhausted');
   if(cap.limit_usd>0&&Number(used.used)+(amount??0)>=cap.limit_usd*0.8)nearing=true;
  }
  const inserted=(await client.query(`INSERT INTO ai_spend(account_id,chatbot_id,kind,models,state,reserved_usd,cost_source,policy_revision,quote) VALUES($1,$2,$3,$4,'reserved',$5,'unknown',$6,$7) RETURNING id`,[accountId,chatbotId,spec.kind,spec.models,amount,row?.revision??0,JSON.stringify({prices,input_tokens:spec.input,output_tokens:output})])).rows[0];
  return {id:inserted.id,policy,limited,output,amount,prices,nearing};
 });}catch(e){if(e instanceof AiBudgetBlocked)await notice(accountId,e.code);throw e;}
}
async function settle(accountId:string,reservation:Awaited<ReturnType<typeof reserve>>,spec:Spec,result:CompletionResult|EmbeddingResult|string) {
 const object=typeof result==='string'?null:result;
 const model=normalize(object?.model??spec.models[0]);
 const usage=object&&'usage' in object?object.usage:undefined;
 const input=usage?.input_tokens??(object&&'input_tokens' in object?object.input_tokens:spec.input);
 const output=usage?.output_tokens??0;
 const reported=object?.cost_usd;
 const known=spec.models.find(m=>model===m||model.startsWith(m+'-'));
 const tariff=known?reservation.prices[spec.models.indexOf(known)]:null;
 const validReport=typeof reported==='number'&&Number.isFinite(reported)&&reported>=0;
 const cached=Math.min(input,Math.max(0,usage?.cached_tokens??0));
 const estimate=tariff&&(tariff.per_audio_minute===0||spec.seconds!==undefined)?cost(tariff,input,output,spec.seconds,cached):null;
 const charged=validReport?reported:estimate;
 const unexpected=!known;
 await withTransaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`ai-budget:${accountId}`]);
  await client.query(`UPDATE ai_spend SET state=$2,charged_usd=$3,cost_source=$4,input_tokens=$5,output_tokens=$6,models=$7,quote=quote||jsonb_build_object('model_mismatch',$8::boolean),finished_at=now() WHERE id=$1 AND state IN ('reserved','uncertain') AND cost_source<>'confirmed'`,[reservation.id,charged===null||unexpected?'uncertain':'settled',charged,validReport?'reported':charged!==null?'estimated':'unknown',input,output,known?[known]:[...new Set([...spec.models,model])],unexpected]);
 });
 if(unexpected||charged===null||(reservation.amount!==null&&charged>reservation.amount+0.00000001))await notice(accountId,'cost_review');
}
async function invoke<T extends CompletionResult|EmbeddingResult|string>(accountId:string,botId:string|null,spec:Spec,fn:(r:Awaited<ReturnType<typeof reserve>>)=>Promise<T>):Promise<T> {
 const held=await reserve(accountId,botId,spec);
 if(held.nearing)await notice(accountId,'budget_80');
 try{const result=await fn(held);await settle(accountId,held,spec,result);return result;}
 catch(e:any){
  const rejected=e?.notDispatched===true||([400,401,403,404,422,429].includes(e?.status)&&e?.definiteRejection!==false);
  await query(`UPDATE ai_spend SET state=$2,charged_usd=$3,cost_source='unknown',finished_at=now() WHERE id=$1 AND state='reserved'`,[held.id,rejected?'rejected':'uncertain',rejected?0:null]).catch(()=>undefined);
  throw e;
 }
}

/** Every application call has an explicit tenant, including summaries, imports and evaluations. */
/** Duración aproximada de un audio por su tamaño y formato (Opus ~2 KB/s, MP3/M4A ~16 KB/s, WAV ~32 KB/s), al menos 1 s. */
export const audioSeconds=(audio:Buffer,mimeType='')=>{
 const perSecond=/mpeg|mp3|mp4|m4a|aac/i.test(mimeType)?16000:/wav|wave|pcm/i.test(mimeType)?32000:2000;
 return Math.max(1,Math.round(audio.length/perSecond));
};
/**
 * Los datos de una foto o un PDF no cuentan como texto: sus base64 se quitan del cálculo (una foto de 5 MB reservaba
 * ~7 millones de tokens). Cada foto o archivo reserva en su lugar el margen de visión fijo (MEDIA_TOKENS): lo que cobra
 * cada modelo por una imagen varía mucho, y el cobro real se ajusta al terminar.
 */
const withoutMedia=(m:CompletionRequest['messages'][number])=>Array.isArray(m.content)?{...m,content:m.content.map(p=>p.type==='image_url'||p.type==='file'?{type:p.type}:p)}:m;
const MEDIA_TOKENS=1000000;
export function accountAi(ai:AiProvider,accountId:string,chatbotId:string|null=null,kind='decision',beforeEmbed?:()=>Promise<void>):AiProvider {
 const wrapper:AiProvider={
  async complete(req:CompletionRequest){
   const fallbacks=req.fallback_models==='none'?[]:req.fallback_models?.length?req.fallback_models:config.openai.fallbackModels;
   const models=[...new Set([req.model,...fallbacks].slice(0,3).map(normalize))];
   const media=req.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='image_url'||p.type==='file').length;
   const input=Math.max(Buffer.byteLength(JSON.stringify({messages:req.messages.map(withoutMedia),schema:req.json_schema??null,tools:req.tools??null}))+1024+req.messages.length*64,media*MEDIA_TOKENS);
   const output=req.max_tokens??(/^(gpt-5|o\d)/i.test(normalize(req.model))?6000:1200);
   return invoke(accountId,chatbotId,{kind,models,input,output},r=>(r.limited?ai.forBudget?.()??ai:ai).complete({...req,max_tokens:r.output}));
  },
  async transcribe(audio,mimeType,seconds){
   const model=normalize(config.openai.transcriptionModel);
   // Sin duración no se puede reservar el costo de un modelo que cobra por minuto: se estima por el tamaño (~2 KB por segundo de Opus).
   const duration=seconds&&seconds>0?seconds:audioSeconds(audio,mimeType);
   return invoke(accountId,chatbotId,{kind:'transcription',models:[model],input:Math.ceil(audio.length*4/3)+1024,output:4096,seconds:duration},r=>(r.limited?ai.forBudget?.()??ai:ai).transcribe(audio,mimeType,duration));
  },
 };
 if(ai.embed)wrapper.embed=(texts,model)=>invoke(accountId,chatbotId,{kind:'embedding',models:[normalize(model)],input:texts.reduce((n,t)=>n+Buffer.byteLength(t),0)+64,output:0},async r=>{
  try{await beforeEmbed?.();}catch(e){throw Object.assign(e instanceof Error?e:new Error('No se pudo reservar el cupo de embeddings.'),{notDispatched:true});}
  return (r.limited?ai.forBudget?.()??ai:ai).embed!(texts,model);
 });
 return wrapper;
}
