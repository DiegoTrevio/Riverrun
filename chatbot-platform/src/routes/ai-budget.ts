import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, targetAccount, HttpError } from '../access.js';
import { query, queryOne, withTransaction } from '../db.js';
import { budgetPolicy, BudgetSettings, expireReservations } from '../ai/budget.js';
import { logEvent } from '../logs.js';
import { parse } from './util.js';

export async function aiBudgetRoutes(api:FastifyInstance) {
 const admin={preHandler:requireRole('admin')};
 const account=(req:any)=>targetAccount(req.user,req.query.account_id);
 api.get('/api/ai-budget',admin,async(req:any)=>{
  const id=await account(req);
  await expireReservations(id);
  const [policy,usage,review]=await Promise.all([
   budgetPolicy(id),query(`SELECT period,coalesce(sum(charged_usd) FILTER(WHERE cost_source='reported'),0) AS reported_usd,
    coalesce(sum(charged_usd) FILTER(WHERE cost_source IN ('estimated','legacy','confirmed')),0) AS estimated_usd,
    coalesce(sum(reserved_usd) FILTER(WHERE charged_usd IS NULL AND state<>'rejected'),0) AS held_usd,
    count(*) FILTER(WHERE charged_usd IS NULL AND (reserved_usd IS NULL OR quote->>'model_mismatch'='true') AND state<>'rejected')::int AS unknown,
    count(*) FILTER(WHERE state IN ('uncertain','unknown','reserved'))::int AS pending,
    coalesce(sum(coalesce(charged_usd,reserved_usd)) FILTER(WHERE state<>'rejected'),0) AS committed_usd
    FROM (SELECT *,'month' AS period FROM ai_spend WHERE account_id=$1 AND created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    UNION ALL SELECT *,'day' AS period FROM ai_spend WHERE account_id=$1 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') s GROUP BY period`,[id]),
   query(`SELECT * FROM ai_spend WHERE account_id=$1 AND state IN ('uncertain','unknown','reserved') AND created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' ORDER BY created_at DESC LIMIT 100`,[id]),
  ]);
  return {...policy,usage,review};
 });
 api.put('/api/ai-budget',admin,async(req:any)=>{
  const id=await account(req),body=parse(z.object({revision:z.number().int().nonnegative(),settings:BudgetSettings}),req.body);
  const saved=await withTransaction(async client=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`ai-budget:${id}`]);
   await client.query('INSERT INTO ai_budget_settings(account_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
   const row=(await client.query('UPDATE ai_budget_settings SET settings=$3,revision=revision+1,updated_at=now() WHERE account_id=$1 AND revision=$2 RETURNING revision,settings',[id,body.revision,JSON.stringify(body.settings)])).rows[0];
   if(!row)throw new HttpError(409,'El presupuesto cambió en otra sesión. Recarga antes de guardar.');return row;
  });
  await logEvent({level:'info',source:'admin',message:`Presupuesto de IA actualizado por ${req.user.email}`,accountId:id,details:{revision:saved.revision,monthly_usd:body.settings.monthly_usd,daily_usd:body.settings.daily_usd}});
  return saved;
 });
 api.post('/api/ai-budget/review/:id',admin,async(req:any)=>{
  const accountId=await account(req),body=parse(z.object({amount_usd:z.number().finite().min(0).max(1000000),note:z.string().trim().min(5).max(500)}),req.body);
  const row=await withTransaction(async client=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`ai-budget:${accountId}`]);
   const r=(await client.query(`UPDATE ai_spend SET charged_usd=$3,cost_source='confirmed',state='settled',finished_at=now() WHERE id=$1 AND account_id=$2 AND state IN ('unknown','uncertain') RETURNING id`,[req.params.id,accountId,body.amount_usd])).rows[0];
   if(!r)throw new HttpError(404,'Importe pendiente no encontrado');return r;
  });
  await logEvent({level:'warn',source:'admin',message:`Importe de IA confirmado por ${req.user.email}`,accountId,details:{entry_id:row.id,amount_usd:body.amount_usd,note:body.note}});
  return {ok:true};
 });
}
