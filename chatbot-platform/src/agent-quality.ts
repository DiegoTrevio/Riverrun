import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { getSettings } from './automation/store.js';
import { query, queryOne } from './db.js';
import { HttpError } from './access.js';
import * as store from './store/index.js';
import { hydrateChatbot, type Chatbot, type User } from './types.js';
import type { ProcessResult } from './engine/engine.js';
import type { ChatService } from './service.js';
import type { AiProvider } from './ai/provider.js';
import type { AgendaContext } from './automation/agenda.js';
import { PlaygroundTransport } from './engine/transport.js';
import { detached } from './engine/coordination.js';
import { withAgentSnapshot } from './engine/agent-snapshot.js';
import { maskSensitive } from './engine/safety.js';

const Expect = z.object({
  contains: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  not_contains: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  action: z.enum(['reply','reply_with_image','handoff','no_reply','paused']).optional(),
  image_codes: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
  data: z.record(z.string().max(80),z.string().max(500)).default({}),
  booked: z.boolean().optional(),
}).refine(x=>x.contains.length+x.not_contains.length+x.image_codes.length+Object.keys(x.data).length>0 || x.action!==undefined || x.booked!==undefined,'Agrega al menos un resultado esperado');
export const AgentCaseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  turns: z.array(z.object({ text:z.string().trim().min(1).max(4000), expect:Expect.optional() })).min(1).max(6),
}).refine(x=>x.turns.some(t=>t.expect),'Agrega un resultado esperado a la conversación');
export const AgentSuiteSchema = z.object({revision:z.number().int().nonnegative(),cases:z.array(AgentCaseSchema).max(10)});
type AgentCase = z.infer<typeof AgentCaseSchema>;
export type AgentDraft = {chatbot_id:string; revision:number; configuration:Record<string,any>; base_configuration:Record<string,any>; step_map:number[]|null; image_rules:{id:string;send_when:any}[]|null};
export const configuration = (bot:Chatbot) => Object.fromEntries(['name','personality','rules','data_fields','flow','ai','saved_messages'].map(k=>[k,(bot as any)[k]]));
function canonical(value:any):string {
  if(value instanceof Date)return JSON.stringify(value.toISOString());
  return JSON.stringify(value===null||typeof value!=='object'?value:Array.isArray(value)?value.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])));
}
export const equalConfiguration = (a:unknown,b:unknown) => canonical(a)===canonical(b);

export async function agentDraft(bot:Chatbot):Promise<AgentDraft> {
  await query(`INSERT INTO agent_drafts(chatbot_id,configuration,base_configuration) SELECT id,agent_configuration(chatbots),agent_configuration(chatbots) FROM chatbots WHERE id=$1 ON CONFLICT DO NOTHING`,[bot.id]);
  return (await queryOne<AgentDraft>('SELECT * FROM agent_drafts WHERE chatbot_id=$1',[bot.id]))!;
}
export async function agentSuite(botId:string) {
  await query('INSERT INTO agent_test_suites(chatbot_id) VALUES($1) ON CONFLICT DO NOTHING',[botId]);
  return (await queryOne<{revision:number;cases:AgentCase[]}>('SELECT revision,cases FROM agent_test_suites WHERE chatbot_id=$1',[botId]))!;
}
export async function qualitySignature(bot:Chatbot,draft:AgentDraft,suiteSnapshot?:{revision:number;cases:AgentCase[]}) {
  const [suite,knowledge,images,services,settings,intents,policy] = await Promise.all([
    suiteSnapshot??queryOne('SELECT revision,cases FROM agent_test_suites WHERE chatbot_id=$1',[bot.id]),store.listKnowledge(bot.id),store.listImages(bot.id),
    query('SELECT * FROM services WHERE account_id=$1 ORDER BY id',[bot.account_id]),
    query('SELECT settings FROM accounts WHERE id=$1',[bot.account_id]),
    query('SELECT * FROM automations WHERE account_id=$1 ORDER BY id',[bot.account_id]),
    query('SELECT * FROM semantic_settings WHERE account_id=$1',[bot.account_id]),
  ]);
  return crypto.createHash('sha256').update(canonical({engine:1,draft:{revision:draft.revision,configuration:draft.configuration,step_map:draft.step_map,image_rules:draft.image_rules},suite,knowledge,images,services,settings,intents,policy,
    provider:{url:config.openai.baseUrl,model:config.openai.defaultModel,fallback:config.openai.fallbackModels,summary:config.openai.summaryModel},search:config.knowledgeSearch})).digest('hex');
}

// Reusable by the UI runner and Promptfoo: check observable engine behavior, never the model's self-assessment.
export function checkAgentExpectations(expect:z.infer<typeof Expect>,actual:{text:string;action:string;images:string[];data:Record<string,unknown>;booked:boolean}) {
  const failures:string[]=[];
  const normalized = (s:string)=>s.normalize('NFKC').toLocaleLowerCase('es');
  for(const phrase of expect.contains) if(!normalized(actual.text).includes(normalized(phrase))) failures.push(`La respuesta no contiene «${phrase}»`);
  for(const phrase of expect.not_contains) if(normalized(actual.text).includes(normalized(phrase))) failures.push(`La respuesta contiene «${phrase}»`);
  if(expect.action!==undefined&&actual.action!==expect.action) failures.push(`Acción esperada: ${expect.action}; obtenida: ${actual.action}`);
  for(const code of expect.image_codes) if(!actual.images.includes(code)) failures.push(`No envió la foto «${code}»`);
  for(const [key,value] of Object.entries(expect.data)) if(normalized(String(actual.data[key]??''))!==normalized(value)) failures.push(`No guardó el valor esperado en «${key}»`);
  if(expect.booked!==undefined&&actual.booked!==expect.booked) failures.push(expect.booked?'No generó la reserva simulada':'Generó una reserva no esperada');
  return failures;
}

const activeRuns = new Set<Promise<void>>();
export async function settleAgentTests() { await Promise.allSettled([...activeRuns]); }
export async function expireAgentTests(botId:string) {
  await query(`UPDATE agent_test_runs SET status='error',results='[{"name":"Evaluación interrumpida","passed":false,"error":"La evaluación se interrumpió. Vuelve a ejecutar las pruebas."}]',finished_at=now() WHERE chatbot_id=$1 AND status='running' AND created_at<now()-interval '5 minutes'`,[botId]);
  const expired=await query<{id:string}>(`SELECT ch.id FROM channels ch JOIN agent_test_runs r ON ch.config->>'evaluation_run_id'=r.id::text WHERE ch.chatbot_id=$1 AND ch.type='playground' AND r.status='error'`,[botId]);
  for(const channel of expired){await query('DELETE FROM contacts WHERE channel_id=$1',[channel.id]);await query('DELETE FROM channels WHERE id=$1',[channel.id]);}
}
export async function startAgentTests(bot:Chatbot,draft:AgentDraft,user:User,service:ChatService,parseConfiguration:(v:unknown)=>Record<string,any>) {
  const suite=await agentSuite(bot.id);
  await getSettings(bot.account_id);
  if(!suite.cases.length) throw new HttpError(400,'Agrega al menos una prueba del negocio antes de publicar.');
  // Interrupted processes cannot permanently block a new run.
  await expireAgentTests(bot.id);
  const signature=await qualitySignature(bot,draft,suite);
  let run;
  try { run=await queryOne(`INSERT INTO agent_test_runs(chatbot_id,draft_revision,signature,author_id,status) VALUES($1,$2,$3,$4,'running') RETURNING *`,[bot.id,draft.revision,signature,user.id]); }
  catch(e:any) { if(e.code==='23505') throw new HttpError(409,'Ya hay una evaluación en curso para este agente.'); throw e; }
  const work=detached(()=>executeAgentTests(run!.id,bot,draft,suite.cases,service,parseConfiguration)).catch(()=>undefined).finally(()=>activeRuns.delete(work));
  activeRuns.add(work);
  return run;
}

async function executeAgentTests(runId:string,bot:Chatbot,draft:AgentDraft,cases:AgentCase[],service:ChatService,parseConfiguration:(v:unknown)=>Record<string,any>) {
  let calls=0,inputTokens=0,outputTokens=0,cost=0,hasCost=false;
  const models=new Set<string>(),results:any[]=[];
  const deadline=Date.now()+120_000;
  const guardRequest=()=>{
    if(calls>=40||Date.now()>deadline||cost>=1) throw new Error('Se alcanzó el límite de 40 llamadas, dos minutos o USD 1 de costo informado. Reduce la cantidad de turnos.');
    calls++;
  };
  const record=(response:{model:string;usage?:{input_tokens:number;output_tokens:number};input_tokens?:number;cost_usd?:number})=>{
    models.add(response.model);inputTokens+=response.usage?.input_tokens??response.input_tokens??0;outputTokens+=response.usage?.output_tokens??0;
    if(response.cost_usd!==undefined){cost+=response.cost_usd;hasCost=true;}
  };
  const provider:AiProvider={transcribe:(...args)=>service.aiProvider.transcribe(...args),async complete(request) {
    guardRequest();
    const response=await service.aiProvider.complete({...request,max_tokens:Math.min(request.max_tokens??1200,1200)});
    record(response);
    return response;
  }};
  // Semantic queries retain the provider's scoped cache and account budget.
  if(service.aiProvider.embed) provider.embed=async(...args)=>{guardRequest();const result=await service.aiProvider.embed!(...args);record(result);return result;};
  let status='error';
  try {
    const snapshot=hydrateChatbot({...bot,...parseConfiguration(draft.configuration)});
    const images=(await store.listImages(bot.id)).map(i=>({...i,send_when:draft.image_rules?.find(r=>r.id===i.id)?.send_when??i.send_when}));
    await withAgentSnapshot(snapshot,async()=>{
      for(const test of cases) {
        if(Date.now()>deadline||calls>=40) throw new Error('Se alcanzó el límite de evaluación. Divide la suite en menos turnos.');
        const channel=await store.createChannel({account_id:bot.account_id,chatbot_id:bot.id,type:'playground',name:'Evaluación aislada',config:{evaluation_run_id:runId}});
        try {
          const contact=await store.upsertContact(channel,`evaluation:${runId}:${crypto.randomUUID()}`,'','Cliente de prueba');
          const conv=await store.getOrCreateConversation(channel,contact.id);
          let agenda:AgendaContext|null=null,booked=false;
          const appointments:NonNullable<AgendaContext>['appointments']=[];
          const engine=service.engine.evaluationEngine(provider,{
            async contextFor(accountId,c,type) { agenda=await service.agenda.contextFor(accountId,c,type);if(agenda)agenda.appointments=appointments;return agenda; },
            async book(o) {
              if(!agenda?.slots[o.serviceId]?.some(s=>s.key===o.slotKey)) return {ok:false,reason:'Horario no disponible',alternatives:[]};
              booked=true;
              const id=crypto.randomUUID(),selected=agenda.services.find(s=>s.id===o.serviceId)!;
              appointments.push({id,service_name:selected.name,kind:selected.kind,label:agenda.slots[o.serviceId].find(s=>s.key===o.slotKey)!.label});
              return {ok:true,appointment:{id} as any};
            },
            async cancel(id) {const index=appointments.findIndex(a=>a.id===id);if(index<0)throw new Error('La evaluación no cancela citas reales.');appointments.splice(index,1);booked=appointments.length>0;},
          },()=>{});
          const turnResults:any[]=[];
          try {
            for(const [index,turn] of test.turns.entries()) {
              const transport=new PlaygroundTransport();
              await store.insertMessage({conversation_id:conv.id,direction:'in',sender:'customer',type:'text',content:maskSensitive(turn.text),processed:false});
              const current=(await store.getConversation(conv.id))!;
              const permitted=current.status==='bot'&&await service.applyGate(snapshot,channel,current,(await store.getContact(contact.id))!,turn.text,transport,engine);
              const result:ProcessResult=permitted?await service.queue.exclusive(conv.id,()=>engine.process(conv.id,transport,{ignoreInactive:true})):{status:current.status==='human'?'human':'paused'};
              await engine.settleBackground();
              const fresh=await store.getContact(contact.id);
              const actual={text:transport.outputs.filter(x=>x.type!=='notify').map(x=>x.text).join('\n'),action:result.plan?.action??result.status,
                images:transport.outputs.flatMap(x=>x.image?[x.image.code]:[]),data:{...fresh?.data,name:fresh?.name},booked};
              const failures=turn.expect?checkAgentExpectations(turn.expect,actual):[];
              // Errors and fallback replies cannot certify a working prompt, even if their text matches.
              if(['error','busy','restart','inactive','nothing'].includes(result.status)||result.fallbackUsed) failures.push('El motor no completó una respuesta válida. Revisa el proveedor y las instrucciones.');
              turnResults.push({turn:index+1,actual,failures});
            }
          } finally { await engine.settleBackground(); }
          results.push({name:test.name,passed:turnResults.every(t=>!t.failures.length),turns:turnResults});
        } finally {
          // All messages, captured contact data and requests belong only to this throwaway channel.
          await query('DELETE FROM contacts WHERE channel_id=$1',[channel.id]);
          await query('DELETE FROM channels WHERE id=$1',[channel.id]);
        }
      }
    },images);
    status=results.every(x=>x.passed)?'passed':'failed';
  } catch(e:any) {
    results.push({name:'Evaluación interrumpida',passed:false,error: e.message?.includes('límite')?e.message:'No se completó la evaluación. Revisa el proveedor de IA y vuelve a ejecutar las pruebas.'});
  }
  await query(`UPDATE agent_test_runs SET status=$2,results=$3,models=$4,calls=$5,input_tokens=$6,output_tokens=$7,cost_usd=$8,finished_at=now() WHERE id=$1 AND status='running'`,[runId,status,JSON.stringify(results),JSON.stringify([...models]),calls,inputTokens,outputTokens,hasCost?cost:null]);
}
