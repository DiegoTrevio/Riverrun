import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, dbAvailable, pool, store } from './harness.js';
const { settleAgentTests } = await import('../src/agent-quality.js');
const ok=await dbAvailable();
const t=(name:string,fn:()=>Promise<void>)=>test(name,{skip:!ok&&'PostgreSQL de pruebas no disponible'},fn);
let h:Awaited<ReturnType<typeof createHarness>>;
before(async()=>{if(ok)h=await createHarness();});
beforeEach(async()=>{if(h){if(h.channelId)await pool.query('DELETE FROM channels WHERE id=$1',[h.channelId]);await h.createBot({rules:{verify_facts:false},personality:{emojis:'none'},ai:{typing_simulation:false}});h.reset();h.setScript(()=>({messages:['Con gusto te ayudo.']}));}});
after(async()=>{if(h)await h.app.close();await pool.end();});
const endpoint=(suffix:string)=>`/api/chatbots/${h.botId}/${suffix}`;
async function versions(){const r=await h.authed('GET',endpoint('versions'));assert.equal(r.statusCode,200,r.body);return r.json();}
async function draft(patch:unknown){const v=await versions(),r=await h.authed('PUT',endpoint('version-draft'),{revision:v.draft.revision,patch});assert.equal(r.statusCode,200,r.body);return r.json();}
async function suite(cases:any[]=[{name:'Saludo',turns:[{text:'hola',expect:{contains:['ayudo']}}]}]){const v=await versions(),r=await h.authed('PUT',endpoint('tests'),{revision:v.suite.revision,cases});assert.equal(r.statusCode,200,r.body);}
async function evaluate(){const v=await versions(),r=await h.authed('POST',endpoint('tests/run'),{revision:v.draft.revision});assert.equal(r.statusCode,202,r.body);await settleAgentTests();const result=await h.authed('GET',endpoint(`tests/runs/${r.json().id}`));assert.equal(result.statusCode,200,result.body);return result.json();}
async function publish(run:any){const v=await versions();return h.authed('POST',endpoint('version-publish'),{revision:v.draft.revision,run_id:run.id});}

t('guardar un borrador no cambia el agente ni crea una versión publicada',async()=>{
 const initial=await versions();await draft({personality:{prompt:'BORRADOR PRIVADO'},name:'Nombre nuevo'});
 const live=await store.getChatbot(h.botId),fresh=await versions();
 assert.equal(live!.name,'Hotel Palmas');assert.notEqual(live!.personality.prompt,'BORRADOR PRIVADO');
 assert.equal(fresh.draft_bot.personality.prompt,'BORRADOR PRIVADO');assert.equal(fresh.releases.length,initial.releases.length);assert.equal(fresh.changed,true);
 assert.equal((await h.authed('POST',endpoint('version-publish'),{revision:fresh.draft.revision,run_id:crypto.randomUUID()})).statusCode,409);
});
t('la revisión optimista evita sobrescribir cambios desde otra sesión',async()=>{
 const v=await versions();await draft({name:'Primer borrador'});
 const r=await h.authed('PUT',endpoint('version-draft'),{revision:v.draft.revision,patch:{name:'Segundo borrador'}});assert.equal(r.statusCode,409);
 assert.equal((await versions()).draft.configuration.name,'Primer borrador');
});
t('las pruebas usan las instrucciones del borrador y publican una sola versión con autor',async()=>{
 await draft({name:'Publicado',personality:{prompt:'INSTRUCCION SOLO DEL BORRADOR'}});await suite();
 h.setScript(req=>{assert.match(JSON.stringify(req.messages),/INSTRUCCION SOLO DEL BORRADOR/);return {messages:['Con gusto te ayudo.']};});
 const initial=await versions(),result=await evaluate();assert.equal(result.status,'passed',JSON.stringify(result.results));assert.equal(result.calls,1);assert.deepEqual(result.models,['openai/gpt-4.1-mini']);
 assert.equal(h.sent.length,0);assert.equal((await publish(result)).statusCode,200);
 const final=await versions();assert.equal(final.releases.length,initial.releases.length+1);assert.equal(final.releases[0].author_name,'admin@test.mx');assert.equal(final.changed,false);assert.equal((await store.getChatbot(h.botId))!.name,'Publicado');
 assert.equal((await publish(result)).statusCode,409);
});
t('la evaluación no deja contactos, conversaciones o canales sintéticos',async()=>{
 const before=(await pool.query('SELECT (SELECT count(*) FROM contacts) contacts,(SELECT count(*) FROM conversations) conversations,(SELECT count(*) FROM channels) channels')).rows[0];
 await suite();assert.equal((await evaluate()).status,'passed');
 const after=(await pool.query('SELECT (SELECT count(*) FROM contacts) contacts,(SELECT count(*) FROM conversations) conversations,(SELECT count(*) FROM channels) channels')).rows[0];assert.deepEqual(after,before);
});
t('cambiar el conocimiento invalida la aprobación y bloquea la publicación',async()=>{
 await draft({name:'Cambio'});await suite();const result=await evaluate();assert.equal(result.status,'passed');
 await store.upsertKnowledge(h.botId,{title:'Cambio de tarifa',content:'Tarifa actual: $999'});
 assert.equal((await versions()).can_publish,false);assert.equal((await publish(result)).statusCode,409);
});
t('cambiar los casos o el modelo invalida los resultados anteriores',async()=>{
 await draft({name:'Cambio'});await suite();const result=await evaluate();assert.equal(result.status,'passed');
 await suite([{name:'Otra prueba',turns:[{text:'hola',expect:{contains:['gusto']}}]}]);assert.equal((await publish(result)).statusCode,409);
 const next=await evaluate();assert.equal(next.status,'passed');await draft({ai:{model:'openai/gpt-4.1'}});assert.equal((await publish(next)).statusCode,409);
});
t('los fallos del proveedor y respuestas de respaldo no aprueban una prueba',async()=>{
 await suite([{name:'Sin errores',turns:[{text:'hola',expect:{not_contains:['prohibido']}}]}]);h.setScript(()=>new Error('Proveedor no disponible: clave secreta'));
 const result=await evaluate();assert.notEqual(result.status,'passed');assert.equal((await versions()).can_publish,false);assert.ok(result.results.some((r:any)=>!r.passed));assert.doesNotMatch(JSON.stringify(result),/clave secreta/);
});
t('restaurar una versión crea un borrador y requiere aprobar nuevas pruebas',async()=>{
 const old=(await versions()).releases[0];await draft({name:'Nuevo'});await suite();assert.equal((await publish(await evaluate())).statusCode,200);
 const v=await versions(),r=await h.authed('POST',endpoint('version-restore'),{revision:v.draft.revision,release_id:old.id});assert.equal(r.statusCode,200,r.body);
 assert.equal((await store.getChatbot(h.botId))!.name,'Nuevo');assert.equal((await versions()).draft_bot.name,'Hotel Palmas');assert.equal((await versions()).can_publish,false);
 assert.equal((await publish(await evaluate())).statusCode,200);assert.equal((await store.getChatbot(h.botId))!.name,'Hotel Palmas');
});
t('una edición de la API compatible se registra y evita publicar sobre otra versión',async()=>{
 await draft({name:'Borrador'});await suite();const result=await evaluate();
 const r=await h.authed('PUT',`/api/chatbots/${h.botId}`,{name:'Cambio directo'});assert.equal(r.statusCode,200);assert.equal((await versions()).conflict,true);assert.equal((await publish(result)).statusCode,409);
 assert.equal((await versions()).releases[0].author_name,'admin@test.mx');
});
t('pausar y encender son operaciones inmediatas sin crear una versión de configuración',async()=>{
 const v=await versions();assert.equal((await h.authed('PUT',`/api/chatbots/${h.botId}`,{active:false})).statusCode,200);
 assert.equal((await versions()).releases.length,v.releases.length);assert.equal((await versions()).conflict,false);
});
t('las fotos automáticas se comprueban por resultado del envío del motor',async()=>{
 await h.uploadImage('menu','Menú',{mode:'rules',keywords:['menu']});
 await suite([{name:'Menú',turns:[{text:'quiero el menu',expect:{image_codes:['menu']}}]}]);
 const result=await evaluate();assert.equal(result.status,'passed',JSON.stringify(result.results));assert.equal(h.sent.length,0);
});
t('las transferencias y las palabras de activación usan las reglas del borrador',async()=>{
 await draft({rules:{handoff_keywords:['asesor'],activation:{mode:'keywords',on_keywords:['pedido']}}});
 await suite([{name:'Espera activación',turns:[{text:'hola',expect:{action:'paused'}}]},{name:'Transfiere',turns:[{text:'pedido asesor',expect:{action:'handoff'}}]}]);
 const result=await evaluate();assert.equal(result.status,'passed',JSON.stringify(result.results));assert.equal(h.calls.length,0);
});
t('guardar respuestas del cliente se verifica en el contacto aislado',async()=>{
 await suite([{name:'Nombre',turns:[{text:'Me llamo Ana',expect:{data:{nombre:'Ana'}}}]}]);
 h.setScript(async()=>{const msg=(await pool.query("SELECT id FROM messages WHERE direction='in' ORDER BY id DESC LIMIT 1")).rows[0];return {messages:['Con gusto te ayudo.'],save_data:[{field:'nombre',value:'Ana',source_message_id:msg.id}]};});
 const result=await evaluate();assert.equal(result.status,'passed',JSON.stringify(result.results));
});
t('la exportación de Promptfoo conserva la identidad del borrador y los casos sin credenciales',async()=>{
 await suite();const r=await h.authed('GET',endpoint('tests/promptfoo'));assert.equal(r.statusCode,200,r.body);
 const config=r.json();assert.equal(config.tests.length,1);assert.equal(config.tests[0].vars.agent_id,h.botId);assert.match(config.providers[0],/agent-cases-provider/);assert.doesNotMatch(r.body,/secreto123|SESSION_COOKIE/);
});

t('una reserva se valida con horarios reales y no crea citas ni trabajos de producción',async()=>{
 const response=await h.authed('POST','/api/services',{account_id:h.accountId,name:'Visita',duration_minutes:30,min_notice_minutes:0,max_days_ahead:5,notify_team:false,reminders:[]});assert.equal(response.statusCode,200,response.body);
 const service=response.json();await draft({rules:{booking_enabled:true}});
 await h.uploadImage('indicaciones','Indicaciones',{mode:'rules',on_booking:true});
 await suite([{name:'Reserva',turns:[{text:'quiero agendar una visita en un horario disponible',expect:{booked:true,image_codes:['indicaciones']}}]}]);
 h.setScript(req=>{const prompt=String(req.messages[0].content),slot=[...prompt.matchAll(/`(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})` \(/g)].at(-1)?.[1];assert.ok(slot,'hay horarios reales en el contexto');return {messages:['Con gusto, quedó agendada tu visita.'],booking:{action:'book',service_id:service.id,slot,appointment_id:''}};});
 const before=(await pool.query('SELECT (SELECT count(*) FROM appointments) appointments,(SELECT count(*) FROM jobs) jobs')).rows[0];
 const result=await evaluate();assert.equal(result.status,'passed',JSON.stringify(result.results));
 const after=(await pool.query('SELECT (SELECT count(*) FROM appointments) appointments,(SELECT count(*) FROM jobs) jobs')).rows[0];assert.deepEqual(after,before);assert.equal(h.sent.length,0);
});

t('reordenar etapas se prueba sin mover fotos en vivo y se puede revertir con historial',async()=>{
 const steps=[{title:'Inicio',description:'Primera'},{title:'Final',description:'Segunda'}];
 assert.equal((await h.authed('PUT',`/api/chatbots/${h.botId}`,{flow:{steps}})).statusCode,200);
 const image=await h.uploadImage('etapa','Etapa final',{mode:'rules',flow_steps:[2]});
 // Capture the catalog as part of a release, as the legacy API has always allowed.
 assert.equal((await h.authed('PUT',`/api/chatbots/${h.botId}`,{name:'Con etapas'})).statusCode,200);
 const original=(await versions()).releases[0];
 await draft({flow:{steps:[steps[1],steps[0]]},flow_step_map:[2,1]});
 assert.deepEqual((await store.getImage(image.id))!.send_when.flow_steps,[2]);
 await suite([{name:'Etapa',turns:[{text:'hola',expect:{image_codes:['etapa']}}]}]);
 h.setScript(()=>({messages:['Con gusto te ayudo.'],flow_step:1}));
 let result=await evaluate();assert.equal(result.status,'passed',JSON.stringify(result.results));const n=(await versions()).releases.length;
 assert.equal((await publish(result)).statusCode,200);assert.deepEqual((await store.getImage(image.id))!.send_when.flow_steps,[1]);assert.equal((await versions()).releases.length,n+1);
 let v=await versions();assert.equal((await h.authed('POST',endpoint('version-restore'),{revision:v.draft.revision,release_id:original.id})).statusCode,200);
 h.setScript(()=>({messages:['Con gusto te ayudo.'],flow_step:2}));
 result=await evaluate();assert.equal(result.status,'passed',JSON.stringify(result.results));assert.equal((await publish(result)).statusCode,200);assert.deepEqual((await store.getImage(image.id))!.send_when.flow_steps,[2]);
});

t('las pruebas requieren resultados esperados y no aceptan suites vacías para publicar',async()=>{
 const v=await versions();assert.equal((await h.authed('POST',endpoint('tests/run'),{revision:v.draft.revision})).statusCode,400);
 assert.equal((await h.authed('PUT',endpoint('tests'),{revision:v.suite.revision,cases:[{name:'Sin comprobación',turns:[{text:'hola',expect:{}}]}]})).statusCode,400);
});

t('dos ejecuciones simultáneas no duplican consumo y una edición no afecta una prueba en curso',async()=>{
 await draft({personality:{prompt:'INSTRUCCION AISLADA'}});await suite();
 let release!:()=>void,started!:()=>void;const wait=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);
 h.setScript(async req=>{assert.match(JSON.stringify(req.messages),/INSTRUCCION AISLADA/);started();await wait;return {messages:['Con gusto te ayudo.']};});
 const v=await versions(),run=await h.authed('POST',endpoint('tests/run'),{revision:v.draft.revision});assert.equal(run.statusCode,202);await entered;
 try { assert.equal((await h.authed('POST',endpoint('tests/run'),{revision:v.draft.revision})).statusCode,409);await draft({personality:{prompt:'SIGUIENTE BORRADOR'}});assert.notEqual((await store.getChatbot(h.botId))!.personality.prompt,'INSTRUCCION AISLADA'); }
 finally {release();await settleAgentTests();}
 const r=(await h.authed('GET',endpoint(`tests/runs/${run.json().id}`))).json();assert.equal(r.status,'passed');assert.equal((await publish(r)).statusCode,409);
});

t('las expectativas por turno comprueban preguntas en orden y datos del cliente',async()=>{
 await draft({data_fields:[{key:'nombre',label:'Nombre',type:'name',required:true,question:'¿Cómo te llamas?'},{key:'fecha',label:'Fecha',type:'text',required:true,question:'¿Qué día llegas?'}]});
 await suite([{name:'Preguntas',turns:[{text:'hola',expect:{contains:['¿Cómo te llamas?']}},{text:'Ana López',expect:{contains:['¿Qué día llegas?'],data:{nombre:'Ana López'}}}]}]);
 h.setScript((_,index)=>index===0?{messages:['¿Cómo te llamas?']}:{messages:['¿Qué día llegas?'],save_data:[{field:'nombre',value:'Ana López'}]});
 const result=await evaluate();assert.equal(result.status,'passed',JSON.stringify(result.results));assert.equal(result.results[0].turns.length,2);
});

t('un proceso interrumpido se marca como error y limpia el canal de evaluación al revisar el estado',async()=>{
 const v=await versions();const old=(await pool.query("INSERT INTO agent_test_runs(chatbot_id,draft_revision,signature,status,created_at) VALUES($1,$2,'interrumpido','running',now()-interval '6 minutes') RETURNING id",[h.botId,v.draft.revision])).rows[0];
 const channel=await store.createChannel({account_id:h.accountId,chatbot_id:h.botId,type:'playground',name:'Evaluación abandonada',config:{evaluation_run_id:old.id}});
 const c=await store.upsertContact(channel,'evaluacion-abandonada','','');await store.getOrCreateConversation(channel,c.id);
 const result=(await h.authed('GET',endpoint(`tests/runs/${old.id}`))).json();assert.equal(result.status,'error');assert.match(result.results[0].error,/interrumpió/);assert.equal(await store.getChannel(channel.id),null);assert.equal(await store.getContact(c.id),null);
});

t('una aprobación caducada no permite publicar',async()=>{
 await draft({name:'Pendiente'});await suite();const result=await evaluate();assert.equal(result.status,'passed');
 await pool.query("UPDATE agent_test_runs SET created_at=now()-interval '25 hours' WHERE id=$1",[result.id]);assert.equal((await versions()).can_publish,false);assert.equal((await publish(result)).statusCode,409);
});

t('las reservas de un caso se pueden cancelar en memoria sin tocar la agenda',async()=>{
 const r=await h.authed('POST','/api/services',{account_id:h.accountId,name:'Visita cancelable',min_notice_minutes:0,max_days_ahead:5,notify_team:false,reminders:[]});assert.equal(r.statusCode,200,r.body);
 const service=r.json();await draft({rules:{booking_enabled:true}});
 await suite([{name:'Reserva y cancela',turns:[{text:'quiero agendar una visita',expect:{booked:true}},{text:'cancela mi visita por favor',expect:{booked:false,contains:['cancelada']}}]}]);
 h.setScript((req,index)=>{
  const prompt=String(req.messages[0].content);
  if(index===0){const slot=[...prompt.matchAll(/`(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})` \(/g)].at(-1)![1];return {messages:['Con gusto, quedó agendada tu visita.'],booking:{action:'book',service_id:service.id,slot,appointment_id:''}};}
  const id=prompt.split('Citas del cliente (próximas):')[1]?.match(/ID `([^`]+)`/)?.[1];assert.ok(id);
  return {messages:['Tu visita quedó cancelada.'],booking:{action:'cancel',service_id:'',slot:'',appointment_id:id}};
 });
 const before=(await pool.query('SELECT count(*) AS n FROM appointments')).rows[0].n;
 const result=await evaluate();assert.equal(result.status,'passed',JSON.stringify(result.results));assert.equal((await pool.query('SELECT count(*) AS n FROM appointments')).rows[0].n,before);
});

t('guardar casos idénticos conserva su revisión y una aprobación vigente',async()=>{
 await suite();const result=await evaluate();assert.equal(result.status,'passed');
 const v=await versions(),r=await h.authed('PUT',endpoint('tests'),v.suite);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().revision,v.suite.revision);assert.equal((await versions()).can_publish,true);
});

async function applyChanges(patch:unknown={}){const v=await versions();return h.authed('POST',endpoint('version-apply'),{revision:v.draft.revision,patch});}
t('guardar y aplicar: el cambio llega de inmediato, sin pruebas, y queda en el historial con su autor',async()=>{
 const initial=await versions();
 const r=await applyChanges({name:'Aplicado al guardar',personality:{prompt:'INSTRUCCION APLICADA'}});assert.equal(r.statusCode,200,r.body);
 const live=(await store.getChatbot(h.botId))!;assert.equal(live.name,'Aplicado al guardar');assert.equal(live.personality.prompt,'INSTRUCCION APLICADA');
 const fresh=await versions();assert.equal(fresh.changed,false);assert.equal(fresh.releases.length,initial.releases.length+1);assert.equal(fresh.releases[0].author_name,'admin@test.mx');
 // Una revisión vieja (otra pestaña) no sobrescribe.
 assert.equal((await h.authed('POST',endpoint('version-apply'),{revision:initial.draft.revision,patch:{name:'Pestaña vieja'}})).statusCode,409);
 assert.equal((await store.getChatbot(h.botId))!.name,'Aplicado al guardar');
});
t('guardar y aplicar parte de la configuración actual si cambió por otra vía y no había cambios pendientes',async()=>{
 await versions(); // el panel ya estaba abierto
 assert.equal((await h.authed('PUT',`/api/chatbots/${h.botId}`,{name:'Desde el asistente de creación'})).statusCode,200);
 assert.equal((await versions()).conflict,true);
 const r=await applyChanges({personality:{prompt:'SOLO CAMBIO LAS INSTRUCCIONES'}});assert.equal(r.statusCode,200,r.body);
 const live=(await store.getChatbot(h.botId))!;assert.equal(live.name,'Desde el asistente de creación','no se pierde el cambio hecho por otra vía');assert.equal(live.personality.prompt,'SOLO CAMBIO LAS INSTRUCCIONES');
 assert.equal((await versions()).conflict,false);
});
t('cambios pendientes de un borrador anterior: se aplican con un clic o chocan si la configuración cambió',async()=>{
 await draft({name:'Pendiente de antes'});
 assert.equal((await applyChanges()).statusCode,200);assert.equal((await store.getChatbot(h.botId))!.name,'Pendiente de antes');
 await draft({name:'Otro pendiente'});
 assert.equal((await h.authed('PUT',`/api/chatbots/${h.botId}`,{name:'Cambio directo'})).statusCode,200);
 assert.equal((await applyChanges({personality:{prompt:'x'}})).statusCode,409);assert.equal((await store.getChatbot(h.botId))!.name,'Cambio directo');
});
t('volver a una versión del historial la aplica de inmediato',async()=>{
 assert.equal((await applyChanges({name:'Versión A'})).statusCode,200);const a=(await versions()).releases[0];
 assert.equal((await applyChanges({name:'Versión B'})).statusCode,200);
 const v=await versions(),restored=await h.authed('POST',endpoint('version-restore'),{revision:v.draft.revision,release_id:a.id});assert.equal(restored.statusCode,200,restored.body);
 assert.equal((await h.authed('POST',endpoint('version-apply'),{revision:restored.json().revision})).statusCode,200);
 assert.equal((await store.getChatbot(h.botId))!.name,'Versión A');
});
