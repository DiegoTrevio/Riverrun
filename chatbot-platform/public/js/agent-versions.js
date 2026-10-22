import { api, confirmAction, field, fill, h, run, select, state, text } from './core.js';
import { okMark } from './icons.js';
import { render } from './main.js';
import { discardDraft, draftModel, draftVersion, hasUnsavedDrafts, markDraftSaved } from './editing.js';

/**
 * Cambios que quedaron como borrador con la versión anterior del panel (antes guardar no aplicaba): se aplican o se
 * descartan con un clic. null si no hay nada pendiente.
 */
export function pendingChanges(bot,versions) {
  if(!versions.changed) return null;
  return h('div',{class:'banner warn',role:'status'},
    h('strong',{},'Tienes cambios guardados que todavía no usa tu agente. '),
    versions.conflict?'La configuración cambió después; descártalos y vuelve a hacerlos.':'Aplícalos para que tus clientes los vean, o descártalos.',' ',
    versions.conflict?null:h('button',{class:'primary small',onclick:async()=>{
      if(await run(()=>api('POST',`/api/chatbots/${bot.id}/version-apply`,{revision:versions.draft.revision}),'Cambios aplicados')) render();
    }},'Aplicar cambios'),' ',
    h('button',{class:'small',onclick:async()=>{
      if(!await confirmAction('¿Descartar esos cambios? El agente sigue como está ahora.')) return;
      if(await run(()=>api('POST',`/api/chatbots/${bot.id}/version-restore`,{revision:versions.draft.revision}),'Cambios descartados')) {
        ['general','personality','flow','rules','ai','questions','saved_messages'].forEach(k=>discardDraft(`${bot.id}:${k}`));render();
      }
    }},'Descartar'));
}

/** Historial: cada vez que se guardan cambios queda una versión; se puede volver a cualquiera. */
export function versionHistory(bot,versions) {
  const restore=async(release_id)=>{
    if(!await confirmAction('¿Volver a esta versión? Tu agente usará de inmediato esa configuración (el conocimiento, las fotos y las conexiones no cambian).')) return;
    const restored=await run(()=>api('POST',`/api/chatbots/${bot.id}/version-restore`,{revision:versions.draft.revision,release_id}));
    if(restored&&await run(()=>api('POST',`/api/chatbots/${bot.id}/version-apply`,{revision:restored.revision}),'Versión recuperada')) {
      ['general','personality','flow','rules','ai','questions','saved_messages'].forEach(k=>discardDraft(`${bot.id}:${k}`));render();
    }
  };
  return h('div',{class:'stack'},
    h('p',{class:'help'},'Cada vez que guardas cambios queda una versión. Si algo dejó de funcionar, vuelve a la anterior.'),
    versions.releases.length?h('div',{class:'stack'},versions.releases.map((v,i)=>h('div',{class:'row between'},
      h('span',{},`${new Date(v.created_at).toLocaleString()} · ${v.author_name}`,i===0?h('span',{class:'badge green',style:'margin-left:8px'},'En uso'):null),
      i===0?null:h('button',{class:'small',onclick:()=>restore(v.id)},'Volver a esta versión')))):h('p',{class:'small muted'},'Todavía no hay versiones guardadas.'));
}

export function agentTestsCard(bot,versions) {
  const key=`${bot.id}:agent-tests`;
  const suite=draftModel(key,versions.suite,false);
  const box=h('div',{class:'card stack'}),cases=h('div',{class:'stack'}),results=h('div',{role:'status','aria-live':'polite'});
  let busy=false;
  const showRun=(r)=>fill(results,h('strong',{},r.status==='running'?'Evaluando tu agente…':r.status==='passed'?'Todas las pruebas aprobadas':r.status==='failed'?'Hay resultados que corregir':'No se completó la evaluación'),
    ...(r.results||[]).map(test=>h('details',{open:!test.passed},h('summary',{},okMark(test.passed),' ',test.name),
      ...(test.error?[h('p',{class:'error'},test.error)]:[]),...(test.turns||[]).map(t=>h('div',{class:'stack'},h('strong',{},`Turno ${t.turn}`),h('p',{class:'pre'},t.actual.text||'(sin respuesta)'),
        h('p',{class:'small muted'},`Acción: ${t.actual.action}. Fotos: ${t.actual.images.join(', ')||'ninguna'}. Reserva: ${t.actual.booked?'simulada':'ninguna'}.`),
        h('pre',{class:'pre small'},JSON.stringify(t.actual.data,null,2)),...t.failures.map(f=>h('p',{class:'error'},f)))))),
    h('p',{class:'small muted'},`Modelos: ${(r.models||[]).join(', ')||'sin llamadas'}. Llamadas: ${r.calls}. Tokens: ${Number(r.input_tokens)+Number(r.output_tokens)}. Costo informado por el proveedor: ${r.cost_usd===null?'no disponible':`$${Number(r.cost_usd).toFixed(4)} USD`}.`));
  const draw=()=>fill(cases,...suite.cases.map((c,index)=>{
    const final=c.turns[c.turns.length-1],expected=final.expect||{contains:[],not_contains:[],image_codes:[],data:{}};
    final.expect=expected;
    const input=h('textarea',{'aria-label':`Mensajes del cliente, prueba ${index+1}`,rows:4,value:c.turns.map(t=>t.text).join('\n'),oninput:e=>{
      c.turns=e.target.value.split('\n').map((t,i,all)=>({text:t,...(i===all.length-1?{expect:expected}:{})}));
    }});
    const list=(k,label)=>field(label,h('input',{value:(expected[k]||[]).join(' | '),oninput:e=>{expected[k]=e.target.value.split('|').map(x=>x.trim()).filter(Boolean);}}));
    const data=field('Datos que debe guardar (una línea por dato: nombre=Ana)',h('textarea',{rows:2,value:Object.entries(expected.data||{}).map(([k,v])=>`${k}=${v}`).join('\n'),oninput:e=>{
      expected.data=Object.fromEntries(e.target.value.split('\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim()];}));
    }}));
    const behavior={action:expected.action||'',booked:expected.booked===undefined?'':String(expected.booked)};
    const action=select(behavior,'action',[['','Sin comprobar'],['reply','Responder'],['reply_with_image','Responder con foto'],['handoff','Pasar a una persona'],['no_reply','No responder'],['paused','Quedar en pausa']]);
    action.addEventListener('change',()=>{if(behavior.action)expected.action=behavior.action;else delete expected.action;});
    const booking=select(behavior,'booked',[['','Sin comprobar'],['true','Generar reserva simulada'],['false','No generar reserva']]);
    booking.addEventListener('change',()=>{if(behavior.booked)expected.booked=behavior.booked==='true';else delete expected.booked;});
    return h('details',{open:suite.cases.length===1},h('summary',{},`${index+1}. ${c.name||'Nueva prueba'}`),h('div',{class:'stack',style:'margin-top:16px'},
      field('Nombre de la prueba',text(c,'name')),field('Mensajes del cliente, uno por línea',input,'La respuesta esperada se comprueba en el último turno. No uses datos personales reales.'),
      h('div',{class:'grid'},list('contains','La respuesta debe incluir (separa frases con |)'),field('Acción esperada',action)),
      h('details',{},h('summary',{},'Fotos, datos, reservas y frases que debe evitar'),h('div',{class:'stack',style:'margin-top:16px'},list('image_codes','Códigos de fotos que debe enviar (separa con |)'),data,field('Reserva',booking),list('not_contains','La respuesta debe evitar (separa con |)'))),
      h('button',{class:'danger small',onclick:()=>{suite.cases.splice(index,1);draw();}},'Eliminar prueba')));
  }));
  const save=async()=>{
    const submitted=JSON.parse(JSON.stringify(suite));
    const r=await run(()=>api('PUT',`/api/chatbots/${bot.id}/tests`,submitted),'Pruebas guardadas');
    if(r){
      if(r.revision!==suite.revision)versions.can_publish=false;
      suite.revision=r.revision;
      markDraftSaved(key,JSON.stringify({...submitted,revision:r.revision}),r);
    }
    return r;
  };
  const execute=h('button',{class:'primary',onclick:async()=>{
    if(busy)return;busy=true;execute.disabled=true;
    fill(results,h('p',{class:'help'},'Guardando pruebas y preparando la evaluación…'));
    try {
      if(!await save()){fill(results,h('p',{class:'error'},'No se guardaron las pruebas. Conservamos tus cambios para que vuelvas a intentarlo.'));return;}
      if(hasUnsavedDrafts([key])){fill(results,h('p',{class:'help'},'Cambiaste las pruebas mientras se guardaban. Guarda los cambios recientes antes de ejecutarlas.'));return;}
      const current=await api('GET',`/api/chatbots/${bot.id}/versions`);
      const started=await run(()=>api('POST',`/api/chatbots/${bot.id}/tests/run`,{revision:current.draft.revision}));
      if(!started){fill(results,h('p',{class:'error'},'No se inició la evaluación. Revisa el aviso y vuelve a intentarlo.'));return;}
      showRun(started);
      const poll=async()=>{const r=await api('GET',`/api/chatbots/${bot.id}/tests/runs/${started.id}`);showRun(r);if(r.status==='running'&&box.isConnected){const timer=setTimeout(()=>poll().catch(()=>{busy=false;execute.disabled=false;fill(results,h('p',{class:'error'},'No se pudo consultar el resultado. Recarga para comprobar el estado de las pruebas.'));}),1500);state.timers.push(()=>clearTimeout(timer));}else{busy=false;execute.disabled=false;}};
      await poll();
    }catch{fill(results,h('p',{class:'error'},'No se pudo consultar la evaluación. Recarga para comprobar el estado de las pruebas.'));}
    finally{if(!results.textContent.includes('Evaluando')){busy=false;execute.disabled=false;}}
  }},'Guardar y ejecutar pruebas');
  draw();
  box.append(h('h2',{style:'margin:0'},'Pruebas automáticas'),h('p',{class:'help'},'Opcional: guarda conversaciones de ejemplo y compruébalas cuando cambies tu agente. Se usa tu proveedor de IA; puede generar costo. Las fotos se simulan y las reservas no ocupan tu agenda. Máximo 10 casos, 6 turnos por caso y 40 llamadas por ejecución.'),cases,
    h('div',{class:'row'},h('button',{onclick:()=>{if(suite.cases.length>=10)return;suite.cases.push({name:'Nueva prueba',turns:[{text:'',expect:{contains:[],not_contains:[],image_codes:[],data:{}}}]});draw();}},'Agregar prueba'),h('button',{onclick:save},'Guardar pruebas'),execute,h('a',{href:`/api/chatbots/${bot.id}/tests/promptfoo`,download:'agent-promptfoo.json'},'Exportar a Promptfoo')),results);
  if(versions.runs[0])showRun(versions.runs[0]);
  return box;
}
