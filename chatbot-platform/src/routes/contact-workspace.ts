import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contactFor, scopeAccount, targetAccount, HttpError } from '../access.js';
import { query, queryOne } from '../db.js';
import type { User } from '../types.js';
import { parse } from './util.js';

const Filters=z.object({view:z.enum(['all','pending','unassigned','upcoming']).default('all'),search:z.string().trim().max(200).default(''),tag:z.string().trim().max(60).default('')});
const phoneKey=(phone:string)=>{const digits=phone.replace(/\D/g,'');return digits.length>=10&&digits.length<=15?digits:'';};
const operator=(u:User)=>u.role==='agent'?u.id:null;
export async function contactWorkspaceRoutes(api:FastifyInstance) {
 api.get('/api/contacts',async(req:any)=>{
  const filters=parse(Filters,req.query??{}),accountId=scopeAccount(req.user,req.query.account_id);
  const offset=parse(z.coerce.number().int().min(0).max(100000),req.query.offset??0);
  const rows=await query(`WITH visible AS (
   SELECT ct.id,ct.account_id,a.name AS account_name,ct.name,ct.push_name,ct.phone,ct.tags,
    CASE WHEN length(regexp_replace(ct.phone,'[^0-9]','','g')) BETWEEN 10 AND 15 THEN 'tel:'||regexp_replace(ct.phone,'[^0-9]','','g') ELSE 'id:'||ct.id::text END AS identity,
    recent.id AS conversation_id,recent.at,
    EXISTS(SELECT 1 FROM conversations c WHERE c.contact_id=ct.id AND c.status<>'closed' AND c.assigned_user_id IS NULL AND ($2::uuid IS NULL OR c.assigned_user_id=$2)) AS unassigned,
    EXISTS(SELECT 1 FROM contact_tasks t WHERE t.contact_id=ct.id AND t.kind='pendiente' AND t.status='abierta' AND ($2::uuid IS NULL OR t.conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversations c WHERE c.id=t.conversation_id AND c.assigned_user_id=$2))) AS pending,
    (SELECT min(a.starts_at) FROM appointments a WHERE a.contact_id=ct.id AND a.status='confirmed' AND a.source<>'simulador' AND a.starts_at>=now() AND ($2::uuid IS NULL OR a.assigned_user_id=$2 OR EXISTS(SELECT 1 FROM conversations c WHERE c.id=a.conversation_id AND c.assigned_user_id=$2))) AS next_appointment
   FROM contacts ct JOIN accounts a ON a.id=ct.account_id JOIN channels ch ON ch.id=ct.channel_id AND ch.type<>'playground'
   JOIN LATERAL(SELECT c.id,coalesce(c.last_message_at,c.created_at) AS at FROM conversations c WHERE c.contact_id=ct.id AND ($2::uuid IS NULL OR c.assigned_user_id=$2) ORDER BY coalesce(c.last_message_at,c.created_at) DESC,c.id LIMIT 1) recent ON true
   WHERE ($1::uuid IS NULL OR ct.account_id=$1)
  ), grouped AS (
   SELECT account_id,max(account_name) AS account_name,identity,(array_agg(id ORDER BY at DESC,id))[1] AS id,
    (array_agg(coalesce(nullif(name,''),nullif(push_name,''),'Sin nombre') ORDER BY at DESC,id))[1] AS name,
    (array_agg(phone ORDER BY at DESC,id))[1] AS phone,count(*)::int AS channels,
    max(at) AS last_activity,min(next_appointment) AS next_appointment,bool_or(pending) AS pending,bool_or(unassigned) AS unassigned,
    bool_or(name ILIKE $3 OR push_name ILIKE $3 OR phone ILIKE $3 OR ($7<>'' AND regexp_replace(phone,'[^0-9]','','g') ILIKE $7)) AS matches_search,
    bool_or($4='' OR tags ? $4) AS matches_tag,jsonb_agg(tags) AS tag_groups
   FROM visible GROUP BY account_id,identity
  ) SELECT * FROM grouped WHERE matches_search AND matches_tag AND ($5='all' OR ($5='pending' AND pending) OR ($5='unassigned' AND unassigned) OR ($5='upcoming' AND next_appointment IS NOT NULL)) ORDER BY last_activity DESC,id OFFSET $6 LIMIT 51`,[accountId,operator(req.user),`%${filters.search}%`,filters.tag,filters.view,offset,filters.search.replace(/\D/g,'')?`%${filters.search.replace(/\D/g,'')}%`:'']);
  return {items:rows.slice(0,50).map(({tag_groups,identity,matches_search,matches_tag,...r})=>({...r,tags:[...new Set(tag_groups.flat())]})),has_more:rows.length>50,next_offset:offset+50};
 });
 api.get('/api/contacts/:id/profile',async(req:any)=>{
  const root=await contactFor(req.user,req.params.id),phone=phoneKey(root.phone),user=operator(req.user);
  const records=await query(`SELECT ct.*,ch.name AS channel_name,ch.type AS channel_type FROM contacts ct JOIN channels ch ON ch.id=ct.channel_id AND ch.type<>'playground' WHERE ct.account_id=$1 AND (ct.id=$2 OR ($3<>'' AND regexp_replace(ct.phone,'[^0-9]','','g')=$3)) AND EXISTS(SELECT 1 FROM conversations c WHERE c.contact_id=ct.id AND ($4::uuid IS NULL OR c.assigned_user_id=$4)) ORDER BY ct.id`,[root.account_id,root.id,phone,user]);
  if(!records.length)throw new HttpError(404,'Contacto no encontrado');
  const ids=records.map(r=>r.id);
  const [conversations,tasks,appointments]=await Promise.all([
   query(`SELECT c.*,ch.name AS channel_name,ch.type AS channel_type,b.name AS chatbot_name,u.name AS assigned_name FROM conversations c JOIN channels ch ON ch.id=c.channel_id LEFT JOIN chatbots b ON b.id=c.chatbot_id LEFT JOIN users u ON u.id=c.assigned_user_id WHERE c.account_id=$1 AND c.contact_id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR c.assigned_user_id=$3) ORDER BY coalesce(c.last_message_at,c.created_at) DESC,c.id LIMIT 100`,[root.account_id,ids,user]),
   query(`SELECT t.* FROM contact_tasks t WHERE t.account_id=$1 AND t.contact_id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR t.conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversations c WHERE c.id=t.conversation_id AND c.assigned_user_id=$3)) ORDER BY t.created_at DESC LIMIT 200`,[root.account_id,ids,user]),
   query(`SELECT a.* FROM appointments a WHERE a.account_id=$1 AND a.contact_id=ANY($2::uuid[]) AND a.status='confirmed' AND a.source<>'simulador' AND a.starts_at>=now() AND ($3::uuid IS NULL OR a.assigned_user_id=$3 OR EXISTS(SELECT 1 FROM conversations c WHERE c.id=a.conversation_id AND c.assigned_user_id=$3)) ORDER BY a.starts_at LIMIT 100`,[root.account_id,ids,user]),
  ]);
  const requests=conversations.length?await query('SELECT * FROM conversation_requests WHERE conversation_id=ANY($1::uuid[]) ORDER BY started_at DESC LIMIT 200',[conversations.map(c=>c.id)]):[];
  const account=await queryOne("SELECT name,coalesce(settings->>'timezone','America/Mexico_City') AS timezone FROM accounts WHERE id=$1",[root.account_id]);
  return {contact:root,account_name:account?.name,timezone:account?.timezone,records,conversations,tasks,appointments,requests,tags:[...new Set(records.flatMap(r=>r.tags))]};
 });
 api.get('/api/contact-views',async(req:any)=>{
  const id=await targetAccount(req.user,req.query.account_id);
  return query('SELECT id,name,filters FROM contact_views WHERE account_id=$1 AND user_id=$2 ORDER BY name',[id,req.user.id]);
 });
 api.post('/api/contact-views',async(req:any)=>{
  const id=await targetAccount(req.user,req.query.account_id),input=parse(z.object({name:z.string().trim().min(1).max(80),filters:Filters}),req.body);
  return queryOne('INSERT INTO contact_views(account_id,user_id,name,filters) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,user_id,name) DO UPDATE SET filters=excluded.filters RETURNING id,name,filters',[id,req.user.id,input.name,JSON.stringify(input.filters)]);
 });
 api.delete('/api/contact-views/:id',async(req:any)=>{
  const id=await targetAccount(req.user,req.query.account_id);
  const removed=await queryOne('DELETE FROM contact_views WHERE id=$1 AND account_id=$2 AND user_id=$3 RETURNING id',[req.params.id,id,req.user.id]);
  if(!removed)throw new HttpError(404,'Vista no encontrada');return {ok:true};
 });
}
