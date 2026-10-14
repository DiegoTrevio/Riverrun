import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { botFor, HttpError, requireRole } from '../access.js';
import { query, queryOne, withTransaction } from '../db.js';
import * as store from '../store/index.js';
import { hydrateChatbot, imageSendWhen, type Chatbot } from '../types.js';
import type { ChatService } from '../service.js';
import { agentDraft, agentSuite, AgentSuiteSchema, equalConfiguration, expireAgentTests, qualitySignature, startAgentTests, type AgentDraft } from '../agent-quality.js';
import { parse } from './util.js';
import { photoWarnings } from '../engine/photo-check.js';
import { logEvent } from '../logs.js';

type Normalize = (before:Chatbot,input:unknown)=>Promise<Record<string,any>>;
type Apply = (before:Chatbot,input:Record<string,any>,client:PoolClient,remapOnly?:boolean)=>Promise<Chatbot|null>;
const Revision=z.object({revision:z.number().int().nonnegative()});

export async function agentVersionRoutes(api:FastifyInstance,service:ChatService,normalize:Normalize,apply:Apply) {
  const admin={preHandler:requireRole('admin')};
  const locked=async(client:PoolClient,bot:Chatbot,revision:number)=>{
    await client.query('SELECT id FROM chatbots WHERE id=$1 FOR UPDATE',[bot.id]);
    const draft=(await client.query<AgentDraft>('SELECT * FROM agent_drafts WHERE chatbot_id=$1 FOR UPDATE',[bot.id])).rows[0];
    if(!draft||draft.revision!==revision) throw new HttpError(409,'El borrador cambió en otra sesión. Recarga antes de continuar.');
    return draft;
  };
  api.get('/api/chatbots/:id/versions',admin,async(req:any)=>{
    const bot=await botFor(req.user,req.params.id),draft=await agentDraft(bot);
    await expireAgentTests(bot.id);
    const [live]=await query('SELECT agent_configuration(chatbots) AS configuration FROM chatbots WHERE id=$1',[bot.id]);
    const [releases,runs,suite]=await Promise.all([
      query('SELECT id,chatbot_id,author_name,reason,created_at FROM agent_releases WHERE chatbot_id=$1 ORDER BY id DESC LIMIT 50',[bot.id]),
      query('SELECT * FROM agent_test_runs WHERE chatbot_id=$1 ORDER BY created_at DESC LIMIT 10',[bot.id]),agentSuite(bot.id),
    ]);
    const signature=await qualitySignature(bot,draft);
    const passed=runs.find(r=>r.status==='passed'&&r.signature===signature&&Date.now()-new Date(r.created_at).getTime()<86400000);
    const images=await store.listImages(bot.id);
    const imageChanges=draft.image_rules?.some(r=>{const image=images.find(i=>i.id===r.id);return image&&!equalConfiguration(imageSendWhen(image),r.send_when);})??false;
    const draftBot=hydrateChatbot({...bot,...draft.configuration});
    return {draft,draft_bot:draftBot,draft_photo_warnings:photoWarnings(draftBot,images),live:live.configuration,releases,runs,suite,changed:imageChanges||!equalConfiguration(draft.configuration,live.configuration),conflict:!equalConfiguration(draft.base_configuration,live.configuration),can_publish:!!passed,tested_run:passed?.id??null};
  });
  api.put('/api/chatbots/:id/version-draft',admin,async(req:any)=>{
    const bot=await botFor(req.user,req.params.id);
    const {revision,patch}=parse(Revision.extend({patch:z.record(z.string(),z.unknown())}),req.body);
    await agentDraft(bot);
    return withTransaction(async(client)=>{
      const draft=await locked(client,bot,revision);
      const merged=await normalize(hydrateChatbot({...bot,...draft.configuration}),patch);
      delete merged.active;
      let map=draft.step_map;
      let imageRules=draft.image_rules;
      const next: number[]|undefined=merged.flow_step_map;
      if(next) {
        imageRules=(await store.listImages(bot.id)).map(i=>{const w=imageRules?.find(r=>r.id===i.id)?.send_when??imageSendWhen(i);return {id:i.id,send_when:{...w,flow_steps:[...new Set((w.flow_steps??[]).map((n:number)=>next[n-1]??0).filter((n:number)=>n>0))]}};});
        map=map?map.map(n=>n>0?next[n-1]??0:0):next;
        const remap=(n:number)=>n>0?next[n-1]??0:0;
        merged.saved_messages=(merged.saved_messages??draft.configuration.saved_messages).map((m:any)=>({...m,flow_step:remap(m.flow_step)}));
      }
      delete merged.flow_step_map;
      return (await client.query(`UPDATE agent_drafts SET revision=revision+1,configuration=$2,step_map=$3,image_rules=$5,author_id=$4,updated_at=now() WHERE chatbot_id=$1 RETURNING *`,[bot.id,JSON.stringify({...draft.configuration,...merged}),map?JSON.stringify(map):null,req.user.id,imageRules?JSON.stringify(imageRules):null])).rows[0];
    });
  });
  // Restoring creates a new draft. Live channels keep the current published release until tests pass again.
  api.post('/api/chatbots/:id/version-restore',admin,async(req:any)=>{
    const bot=await botFor(req.user,req.params.id);
    const {revision,release_id}=parse(Revision.extend({release_id:z.number().int().positive().optional()}),req.body);
    await agentDraft(bot);
    return withTransaction(async(client)=>{
      await locked(client,bot,revision);
      const live=(await client.query('SELECT agent_configuration(chatbots) AS configuration FROM chatbots WHERE id=$1',[bot.id])).rows[0].configuration;
      const selected=release_id?(await client.query('SELECT configuration,image_rules FROM agent_releases WHERE id=$1 AND chatbot_id=$2',[release_id,bot.id])).rows[0]:{configuration:live};
      if(!selected) throw new HttpError(404,'Versión no encontrada');
      const current=hydrateChatbot({...bot,...live});
      const restored=await normalize(current,selected.configuration);delete restored.active;delete restored.flow_step_map;
      return (await client.query('UPDATE agent_drafts SET configuration=$2,base_configuration=$3,step_map=$5,image_rules=$6,revision=revision+1,author_id=$4,updated_at=now() WHERE chatbot_id=$1 RETURNING *',[bot.id,JSON.stringify(restored),JSON.stringify(live),req.user.id,release_id?JSON.stringify(current.flow.steps.map(step=>{const n=restored.flow.steps.findIndex((x:any)=>equalConfiguration(x,step));return n+1;})):null,release_id?JSON.stringify(selected.image_rules):null])).rows[0];
    });
  });
  api.post('/api/chatbots/:id/version-publish',admin,async(req:any)=>{
    const bot=await botFor(req.user,req.params.id);
    const {revision,run_id}=parse(Revision.extend({run_id:z.string().uuid()}),req.body);
    const published=await withTransaction(async(client)=>{
      const draft=await locked(client,bot,revision);
      // Prevent a catalog/rule edit from racing the final signature check and commit.
      await client.query('LOCK TABLE knowledge_items,images,services,automations,semantic_settings,agent_test_suites IN SHARE ROW EXCLUSIVE MODE');
      await client.query('SELECT id FROM accounts WHERE id=$1 FOR SHARE',[bot.account_id]);
      const live=(await client.query('SELECT agent_configuration(chatbots) AS configuration FROM chatbots WHERE id=$1',[bot.id])).rows[0].configuration;
      if(!equalConfiguration(live,draft.base_configuration)) throw new HttpError(409,'La versión publicada cambió. Restaura la versión actual y vuelve a integrar tus cambios.');
      const run=await queryOne('SELECT * FROM agent_test_runs WHERE id=$1 AND chatbot_id=$2',[run_id,bot.id]);
      if(!run||run.status!=='passed'||Date.now()-new Date(run.created_at).getTime()>=86400000||run.signature!==await qualitySignature(bot,draft)) throw new HttpError(409,'Ejecuta y aprueba las pruebas del borrador actual antes de publicar.');
      const ready=await normalize(bot,draft.configuration);
      const beforeRelease=(await client.query('SELECT max(id) AS id FROM agent_releases WHERE chatbot_id=$1',[bot.id])).rows[0].id;
      await client.query("SELECT set_config('riverrun.author_id',$1,true),set_config('riverrun.author_name',$2,true),set_config('riverrun.release_reason',$3,true)",[req.user.id,req.user.email,`Publicada tras pruebas ${run.id}`]);
      // Saved messages were already remapped while drafting; only images/conversation stages remain to move.
      const saved=ready.saved_messages;
      if(draft.step_map) await apply(bot,{...ready,flow_step_map:draft.step_map,saved_messages:[]},client,true);
      for(const image of draft.image_rules??[]) {
        await client.query('UPDATE images SET send_when=$3,updated_at=now() WHERE id=$1 AND chatbot_id=$2',[image.id,bot.id,JSON.stringify(image.send_when)]);
      }
      const published=await store.updateChatbot(bot.id,{...ready,saved_messages:saved},client);
      const afterRelease=(await client.query('SELECT max(id) AS id FROM agent_releases WHERE chatbot_id=$1',[bot.id])).rows[0].id;
      if(beforeRelease===afterRelease) await client.query(`INSERT INTO agent_releases(chatbot_id,configuration,image_rules,author_id,author_name,reason) SELECT id,agent_configuration(chatbots),coalesce((SELECT jsonb_agg(jsonb_build_object('id',i.id,'send_when',i.send_when)) FROM images i WHERE i.chatbot_id=chatbots.id),'[]'),$2,$3,$4 FROM chatbots WHERE id=$1`,[bot.id,req.user.id,req.user.email,`Publicada tras pruebas ${run.id}`]);
      const fresh=(await client.query('SELECT agent_configuration(chatbots) AS configuration FROM chatbots WHERE id=$1',[bot.id])).rows[0].configuration;
      await client.query('UPDATE agent_drafts SET configuration=$2,base_configuration=$2,step_map=NULL,image_rules=NULL,revision=revision+1,updated_at=now() WHERE chatbot_id=$1',[bot.id,JSON.stringify(fresh)]);
      return published;
    });
    await logEvent({level:'info',source:'admin',message:`Versión del agente publicada por ${req.user.email}`,accountId:bot.account_id,chatbotId:bot.id});
    return published;
  });
  api.get('/api/chatbots/:id/tests',admin,async(req:any)=>{
    const bot=await botFor(req.user,req.params.id);return agentSuite(bot.id);
  });
  api.put('/api/chatbots/:id/tests',admin,async(req:any)=>{
    const bot=await botFor(req.user,req.params.id);
    const input=parse(AgentSuiteSchema,req.body);await agentSuite(bot.id);
    const saved=await queryOne('UPDATE agent_test_suites SET cases=$3,revision=revision+CASE WHEN cases IS DISTINCT FROM $3::jsonb THEN 1 ELSE 0 END WHERE chatbot_id=$1 AND revision=$2 RETURNING revision,cases',[bot.id,input.revision,JSON.stringify(input.cases)]);
    if(!saved) throw new HttpError(409,'Las pruebas cambiaron en otra sesión. Recarga antes de guardar.');
    return saved;
  });
  api.post('/api/chatbots/:id/tests/run',admin,async(req:any,reply)=>{
    const bot=await botFor(req.user,req.params.id),draft=await agentDraft(bot);
    const {revision}=parse(Revision,req.body);
    if(revision!==draft.revision) throw new HttpError(409,'El borrador cambió. Recarga antes de probar.');
    return reply.code(202).send(await startAgentTests(bot,draft,req.user,service,value=>value as Record<string,any>));
  });
  api.get('/api/chatbots/:id/tests/runs/:runId',admin,async(req:any)=>{
    await botFor(req.user,req.params.id);
    await expireAgentTests(req.params.id);
    const run=await queryOne('SELECT * FROM agent_test_runs WHERE id=$1 AND chatbot_id=$2',[req.params.runId,req.params.id]);
    if(!run) throw new HttpError(404,'Evaluación no encontrada');return run;
  });
  api.get('/api/chatbots/:id/tests/promptfoo',admin,async(req:any,reply)=>{
    const bot=await botFor(req.user,req.params.id),draft=await agentDraft(bot),suite=await agentSuite(bot.id);
    return reply.header('content-disposition','attachment; filename="agent-promptfoo.json"').send({
      description:`Pruebas del agente ${bot.name}`,prompts:['Evaluar el borrador guardado'],providers:['file://./agent-cases-provider.mjs'],
      tests:suite.cases.map((c,index)=>({description:c.name,vars:{agent_id:bot.id,revision:draft.revision,suite_revision:suite.revision,index},assert:[{type:'javascript',value:'JSON.parse(output).passed === true'}]})),
    });
  });
}
