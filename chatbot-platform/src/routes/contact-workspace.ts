import { listContactFields } from '../contacts/fields.js';
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
  // Página siguiente por cursor (última actividad e id del último contacto mostrado), no saltando filas.
  let after:{at:string;id:string}|null=null;
  if(req.query.cursor){
   let raw:unknown;
   try{raw=JSON.parse(Buffer.from(String(req.query.cursor).slice(0,512),'base64url').toString());}catch{throw new HttpError(400,'El cursor de contactos no es válido');}
   after=parse(z.object({at:z.string().datetime({offset:true}),id:z.string().uuid()}),raw);
  }
  const digits=filters.search.replace(/\D/g,'');
  const params=[accountId,operator(req.user),`%${filters.search}%`,filters.tag,filters.view,digits?`%${digits}%`:'',after?.at??null,after?.id??null];
  // Lo caro (pendientes, sin asignar, próxima cita) se calcula solo para los grupos que pasan la búsqueda y la etiqueta;
  // en «Todos», solo para la página que se muestra.
  const flags=`
    EXISTS(SELECT 1 FROM conversations c WHERE c.contact_id=ANY(g.ids) AND c.status<>'closed' AND c.assigned_user_id IS NULL AND ($2::uuid IS NULL OR c.assigned_user_id=$2)) AS unassigned,
    EXISTS(SELECT 1 FROM contact_tasks t WHERE t.contact_id=ANY(g.ids) AND t.kind='pendiente' AND t.status='abierta' AND ($2::uuid IS NULL OR t.conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversations c WHERE c.id=t.conversation_id AND c.assigned_user_id=$2))) AS pending,
    (SELECT min(a.starts_at) FROM appointments a WHERE a.contact_id=ANY(g.ids) AND a.status='confirmed' AND a.source<>'simulador' AND a.starts_at>=now() AND ($2::uuid IS NULL OR a.assigned_user_id=$2 OR EXISTS(SELECT 1 FROM conversations c WHERE c.id=a.conversation_id AND c.assigned_user_id=$2))) AS next_appointment`;
  const view=`($5::text='all' OR ($5='pending' AND pending) OR ($5='unassigned' AND unassigned) OR ($5='upcoming' AND next_appointment IS NOT NULL))`;
  const cursor=`($7::timestamptz IS NULL OR last_activity<$7::timestamptz OR (last_activity=$7::timestamptz AND id>$8::uuid))`;
  const page=filters.view==='all'
   ? `page AS (SELECT * FROM grouped WHERE $5::text='all' AND ${cursor} ORDER BY last_activity DESC,id LIMIT 51)
      SELECT p.*,${flags.replace(/g\.ids/g,'p.ids')} FROM page p ORDER BY last_activity DESC,id`
   : `flagged AS (SELECT g.*,${flags} FROM grouped g)
      SELECT * FROM flagged WHERE ${view} AND ${cursor} ORDER BY last_activity DESC,id LIMIT 51`;
  const rows=await query(`WITH base AS (
   SELECT ct.id,ct.account_id,a.name AS account_name,ct.name,ct.push_name,ct.phone,ct.tags,
    CASE WHEN length(regexp_replace(ct.phone,'[^0-9]','','g')) BETWEEN 10 AND 15 THEN 'tel:'||regexp_replace(ct.phone,'[^0-9]','','g') ELSE 'id:'||ct.id::text END AS identity,
    recent.at
   FROM contacts ct JOIN accounts a ON a.id=ct.account_id JOIN channels ch ON ch.id=ct.channel_id AND ch.type<>'playground'
   JOIN LATERAL(SELECT c.last_message_at AS at FROM conversations c WHERE c.contact_id=ct.id AND ($2::uuid IS NULL OR c.assigned_user_id=$2) ORDER BY c.last_message_at DESC,c.id LIMIT 1) recent ON true
   WHERE ($1::uuid IS NULL OR ct.account_id=$1)
  ), matched AS (
   -- Un grupo (mismo teléfono) entra si alguno de sus registros coincide con la búsqueda y la etiqueta.
   SELECT account_id,identity FROM base GROUP BY account_id,identity
   HAVING bool_or(name ILIKE $3 OR push_name ILIKE $3 OR phone ILIKE $3 OR ($6<>'' AND regexp_replace(phone,'[^0-9]','','g') ILIKE $6))
     AND bool_or($4='' OR tags ? $4)
  ), grouped AS (
   SELECT b.account_id,max(b.account_name) AS account_name,b.identity,(array_agg(b.id ORDER BY b.at DESC,b.id))[1] AS id,
    (array_agg(coalesce(nullif(b.name,''),nullif(b.push_name,''),'Sin nombre') ORDER BY b.at DESC,b.id))[1] AS name,
    (array_agg(b.phone ORDER BY b.at DESC,b.id))[1] AS phone,count(*)::int AS channels,max(b.at) AS last_activity,
    to_char(max(b.at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
    jsonb_agg(b.tags) AS tag_groups,array_agg(b.id) AS ids
   FROM base b JOIN matched m ON m.account_id=b.account_id AND m.identity=b.identity
   GROUP BY b.account_id,b.identity
  ), ${page}`,params);
  const items=rows.slice(0,50),last=items.at(-1),more=rows.length>50;
  return {
   items:items.map(({tag_groups,identity,ids,cursor_at,...r})=>({...r,tags:[...new Set(tag_groups.flat())]})),
   has_more:more,
   next_cursor:more&&last?Buffer.from(JSON.stringify({at:last.cursor_at,id:last.id})).toString('base64url'):null,
  };
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
  const quotes=conversations.length?await query('SELECT id,folio,kind,status,currency,total_min,total_max,open_ended,has_tbd,created_at,conversation_id FROM quotes WHERE account_id=$1 AND conversation_id=ANY($2::uuid[]) ORDER BY created_at DESC LIMIT 50',[root.account_id,conversations.map(c=>c.id)]):[];
  const account=await queryOne("SELECT name,coalesce(settings->>'timezone','America/Mexico_City') AS timezone FROM accounts WHERE id=$1",[root.account_id]);
  return {contact:root,account_name:account?.name,timezone:account?.timezone,contact_fields:await listContactFields(root.account_id),records,conversations,tasks,appointments,requests,quotes,tags:[...new Set(records.flatMap(r=>r.tags))]};
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
