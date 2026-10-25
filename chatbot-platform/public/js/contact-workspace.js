import { api, ask, field, fill, fmtDate, fmtPhone, h, poll, run, select, state } from './core.js';
import { isAdmin, isSuper, withAcct } from './session.js';
import { badge, KIND, STATUS, totalText } from './quotes.js';
import { tasksCard, requestsCard } from './conversations.js';
import { fieldLabel, fieldText, importContactsDialog } from './contact-fields.js';

export const workspaceTabs=(active)=>h('div',{class:'tabs','aria-label':'Espacio de conversaciones'},
 h('a',{href:'#/conversations',class:active==='inbox'?'active':'','aria-current':active==='inbox'?'page':null},'Bandeja de entrada'),
 h('a',{href:'#/contacts',class:active==='contacts'?'active':'','aria-current':active==='contacts'?'page':null},'Contactos'));

export async function viewContacts(root,params) {
 const model={view:params.get('view')||'all',search:params.get('search')||'',tag:params.get('tag')||''};
 const filters=()=>Object.fromEntries(Object.entries(model).filter(([,v])=>v));
 const apply=()=>{location.hash=`#/contacts?${new URLSearchParams(filters())}`;};
 const rows=h('tbody'),status=h('p',{class:'help',role:'status'});let offset=0,busy=false;
 const more=h('button',{hidden:true,onclick:()=>load(true)},'Cargar más contactos');
 const load=async(append=false)=>{
  if(busy)return;busy=true;more.disabled=true;
  try{
   const page=await api('GET',withAcct(`/api/contacts?${new URLSearchParams({...filters(),offset:append?offset:0})}`));
   offset=page.next_offset;more.hidden=!page.has_more;
   const items=page.items.map(c=>h('tr',{},h('td',{},h('a',{href:`#/contact/${c.id}`},h('strong',{},c.name)),h('div',{class:'small muted'},c.phone?fmtPhone(c.phone):'Sin teléfono'),isSuper()&&!state.accountId?h('div',{class:'small muted'},c.account_name):null),
    h('td',{},`${c.channels} ${c.channels===1?'canal':'canales'}`,h('div',{class:'small muted'},c.tags.join(', '))),
    h('td',{},...(c.pending?[h('span',{class:'badge orange'},'Con pendientes')]:[]),...(c.unassigned?[h('span',{class:'badge'},'Sin asignar')]:[]),c.next_appointment?h('div',{class:'small'},`Cita: ${fmtDate(c.next_appointment)}`):null),
    h('td',{},fmtDate(c.last_activity)),h('td',{},h('a',{class:'btn small',href:`#/contact/${c.id}`},'Ver ficha'))));
   if(append)rows.append(...items);else fill(rows,...(items.length?items:[h('tr',{},h('td',{colspan:5},'No hay contactos con estos filtros.'))]));
   status.textContent='Se muestran únicamente los contactos y canales que puedes gestionar.';
  }catch(error){status.textContent=error.message;status.className='error';}finally{busy=false;more.disabled=false;}
 };
 const saved=h('div',{class:'row'});
 const canSave=!isSuper()||!!state.accountId;
 if(canSave){
  const views=await api('GET',withAcct('/api/contact-views'));
  const pick={id:''},options=select(pick,'id',[['','Mis vistas guardadas'],...views.map(v=>[v.id,v.name])],()=>{const v=views.find(v=>v.id===pick.id);if(v)location.hash=`#/contacts?${new URLSearchParams(v.filters)}`;});
  options.setAttribute('aria-label','Vista de contactos guardada');
  saved.append(options,h('button',{onclick:async()=>{const name=await ask('Nombre de esta vista');if(!name)return;if(await run(()=>api('POST',withAcct('/api/contact-views'),{name,filters:model}),'Vista guardada'))location.hash=`#/contacts?${new URLSearchParams({...filters(),saved:Date.now()})}`;}},'Guardar esta vista'),
   h('button',{onclick:async()=>{if(!pick.id)return;if(await run(()=>api('DELETE',withAcct(`/api/contact-views/${pick.id}`)),'Vista eliminada')){views.splice(views.findIndex(v=>v.id===pick.id),1);options.querySelector(`option[value="${pick.id}"]`)?.remove();pick.id='';options.value='';}}},'Eliminar vista seleccionada'));
 }
 const tools=isAdmin()&&canSave?h('div',{class:'row'},h('button',{onclick:async()=>{if(await importContactsDialog())load();}},'Importar contactos'),h('a',{class:'btn',href:withAcct('/api/export/contacts.csv'),download:''},'Exportar CSV')):null;
 root.append(h('div',{class:'row between'},h('h1',{},'Contactos'),tools),workspaceTabs('contacts'),h('p',{class:'help'},'Encuentra a una persona y retoma su atención desde una sola ficha. Los registros del mismo teléfono se reúnen dentro del perfil, conservando el origen de cada dato.'),
  h('div',{class:'card stack'},h('div',{class:'row'},field('Mostrar',select(model,'view',[['all','Todos'],['pending','Con pendientes'],['unassigned','Sin asignar'],['upcoming','Con citas próximas']],apply)),
   field('Buscar nombre o teléfono',h('input',{type:'search',value:model.search,onchange:e=>{model.search=e.target.value;apply();}})),field('Etiqueta',h('input',{value:model.tag,onchange:e=>{model.tag=e.target.value;apply();}}))),saved),status,
  h('div',{class:'card'},h('table',{class:'responsive-table'},h('thead',{},h('tr',{},...['Persona','Canales y etiquetas','Qué sigue','Última actividad',''].map(s=>h('th',{},s)))),rows)),more);
 await load();poll(()=>offset<=50?load():undefined,10000,root);
}

export async function viewContact(root,id) {
 const body=h('div'),draft={kind:'pendiente',body:'',due_on:''};root.append(body);
 const load=async()=>{
  const d=await api('GET',`/api/contacts/${id}/profile`);if(!root.isConnected)return;
  state.timeZone=d.timezone||'America/Mexico_City';
  // Los «Datos de tus clientes» primero y en su orden; después lo demás.
  const cf=d.contact_fields||[],rank=k=>{const i=cf.findIndex(f=>f.key===k);return i<0?cf.length:i;};
  const ordered=data=>Object.entries(data||{}).filter(([,v])=>v!=='').sort((a,b)=>rank(a[0])-rank(b[0]));
  const latest=d.conversations[0],main=d.records.find(r=>r.id===latest?.contact_id)||d.contact;
  const scope=()=>{if(isSuper()){state.accountId=d.contact.account_id;try{localStorage.setItem('cp-account',state.accountId);}catch{/* optional storage */}}};
  const agendaWeek=starts=>{const date=new Intl.DateTimeFormat('en-CA',{timeZone:state.timeZone||'America/Mexico_City'}).format(new Date(starts));const monday=new Date(`${date}T12:00:00Z`);monday.setUTCDate(monday.getUTCDate()-(monday.getUTCDay()+6)%7);return monday.toISOString().slice(0,10);};
  fill(body,h('a',{class:'breadcrumb',href:'#/contacts'},'← Contactos'),h('div',{class:'row between'},h('h1',{},main.name||main.push_name||'Contacto'),latest?h('a',{class:'btn primary',href:`#/conversation/${latest.id}`},'Retomar conversación'):null),
   h('p',{class:'help'},`${d.account_name} · ${main.phone?`${fmtPhone(main.phone)} · `:''}${d.records.length} ${d.records.length===1?'canal visible':'canales visibles'}. Los datos se conservan por canal para evitar sobrescribir respuestas distintas.`),
   d.tags.length?h('div',{class:'row'},...d.tags.map(t=>h('span',{class:'badge'},t))):null,
   h('div',{class:'grid'},h('div',{class:'card stack'},h('h2',{},'Datos y notas'),...d.records.map(r=>h('details',{open:d.records.length===1},h('summary',{},r.channel_name),
    h('dl',{},...(r.name?[h('dt',{},'Nombre guardado'),h('dd',{},r.name)]:[]),...ordered(r.data).flatMap(([k,v])=>[h('dt',{},fieldLabel(k,cf)),h('dd',{},fieldText(cf.find(f=>f.key===k),v))])),...(r.notes||[]).map(n=>h('p',{class:'small'},n)),
    ...d.conversations.filter(c=>c.contact_id===r.id).slice(0,1).map(c=>h('a',{class:'btn small',href:`#/conversation/${c.id}`},'Editar datos de este canal'))))),
    h('div',{class:'card stack'},h('h2',{},'Citas próximas'),...(d.appointments.length?d.appointments.map(a=>h('div',{},h('strong',{},a.service_name),h('p',{class:'small'},fmtDate(a.starts_at)),h('a',{href:`#/agenda?week=${agendaWeek(a.starts_at)}`,onclick:scope},'Ver en la agenda'))):[h('p',{class:'muted'},'No hay citas próximas visibles.')]))),
   ...(latest?[tasksCard({tasks:d.tasks},latest,main,load,draft)]:[]),
   ...(state.meta?.receivables_enabled?[h('div',{class:'card stack'},h('h2',{},'Cobros'),h('p',{class:'small muted'},'Lo que te debe este cliente y sus recordatorios de pago.'),h('div',{class:'row'},h('a',{class:'btn small',href:`#/cobros?contact=${main.id}`,onclick:scope},'Ver sus cobros'),h('a',{class:'btn small primary',href:`#/cobros?contact=${main.id}&name=${encodeURIComponent(main.name||main.push_name||'')}`,onclick:scope},'Nuevo cobro')))]:[]),
   ...(d.quotes?.length?[h('div',{class:'card stack'},h('h2',{},'Cotizaciones'),...d.quotes.map(q=>h('div',{class:'row',style:'gap:6px;flex-wrap:wrap;align-items:center'},
    h('strong',{},q.folio),badge(KIND[q.kind]),badge(STATUS[q.status]||['',q.status]),h('span',{},totalText(q)),h('span',{class:'small muted'},fmtDate(q.created_at)),
    isAdmin()?h('a',{href:`#/cotizaciones/historial?id=${q.id}`,onclick:scope},'Ver'):h('a',{href:`#/conversation/${q.conversation_id}`},'Ver conversación'))))]:[]),
   h('div',{class:'card stack'},h('h2',{},'Conversaciones y resúmenes'),h('p',{class:'help'},'Se muestran las últimas 100 conversaciones visibles. Para consultar todo el historial de cada una, ábrela.'),
    ...d.conversations.map(c=>h('details',{open:c.id===latest?.id},h('summary',{},`${c.channel_name} · ${c.chatbot_name||'Sin agente'} · ${fmtDate(c.last_message_at||c.created_at)}`),
     h('p',{class:'small'},c.assigned_name?`Atiende: ${c.assigned_name}`:'Sin persona asignada'),h('div',{class:'pre'},c.summary||'Todavía no tiene resumen. Puedes generarlo al abrir la conversación.'),
     ...(Object.keys(c.data||{}).length?[h('details',{},h('summary',{},'Datos guardados en esta conversación'),h('dl',{},...ordered(c.data).flatMap(([k,v])=>[h('dt',{},fieldLabel(k,cf)),h('dd',{},fieldText(cf.find(f=>f.key===k),v))])))]:[]),
     requestsCard(d.requests.filter(r=>r.conversation_id===c.id)),h('a',{class:'btn small',href:`#/conversation/${c.id}`},'Abrir conversación')))));
 };
 await load();
}
