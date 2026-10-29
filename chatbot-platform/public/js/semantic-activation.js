import { api, field, h, poll, run, text, num } from './core.js';
export async function semanticActivation(bot) {
  const path=`/api/chatbots/${bot.id}/semantic`;
  let status=await api('GET',path);
  const root=h('details',{class:'card'},h('summary',{},'Búsqueda por significado · preparar, probar y activar'));
  const content=h('div',{});root.append(content);
  const settings={daily_token_budget:status.daily_token_budget,query:''};
  const refresh=async()=>{status=await api('GET',path);draw();};
  const action=(label,route,body,disabled=false)=>h('button',{class:'small',disabled,onclick:async()=>{await run(async()=>{await api('POST',path+route,body());await refresh();});}},label);
  const causes={budget_exhausted:'presupuesto diario agotado',invalid_embedding:'el modelo devolvió un vector incompatible',storage_failed:'no se pudo guardar el índice',provider_auth:'el proveedor rechazó la autenticación',provider_rate_limit:'el proveedor limitó las solicitudes',provider_unavailable:'el proveedor no está disponible',embedding_busy:'otra preparación está en curso'};
  const draw=()=>{
    content.replaceChildren(
      h('p',{class:'help'},'Aplica a todos los agentes del perfil. Prepara y compara antes de activar; puedes volver a la búsqueda por palabras cuando quieras.'),
      h('p',{role:'status'},status.enabled?'Activa para este perfil':status.preparing?'Preparando · las conversaciones siguen con búsqueda por palabras':'Desactivada · búsqueda por palabras'),
      h('p',{},`1. Base de datos: ${status.database.ready?'pgvector disponible':'requiere configuración del servidor'}. Proveedor: ${status.verified_model===status.model?'comprobado':'pendiente de comprobar'}.`),
      action('Comprobar proveedor','/verify',()=>({}),!status.database.ready||!status.provider_configured||status.force_off),
      h('p',{},`2. Documentos: ${status.indexed_items} preparados · ${status.pending_items} pendientes. Modelo: ${status.model}.`),
      field('Presupuesto diario máximo de tokens de embeddings',num(settings,'daily_token_budget',{min:100,max:10000000,step:100}),'Incluye preparación y consultas. Se reserva un límite conservador; los intentos fallidos también consumen la reserva.'),
      h('p',{class:'help'},`Reserva usada hoy: ${status.reserved_tokens}. Estimación máxima de preparación: ${status.estimate.token_ceiling} tokens${status.estimate.upper_estimated_usd===null?' · precio sin configurar':` · aproximadamente $${status.estimate.upper_estimated_usd.toFixed(4)} USD al precio indicado`}. El proveedor puede aplicar otro precio. La estimación incluye documentos completos de agentes pendientes y puede sobreestimar el trabajo restante.`),
      action('Preparar conocimiento','/prepare',()=>({daily_token_budget:Number(settings.daily_token_budget)}),status.verified_model!==status.model||status.force_off),
      ...status.errors.map(e=>h('p',{class:'help'},`${e.title}: ${causes[e.error_code]||'no se pudo generar o guardar el índice'}. Intentos: ${e.attempts}. Se reintentará automáticamente.`)),
      h('p',{},'3. Prueba con una pregunta real y compara las fuentes recuperadas.'),
      field('Pregunta de prueba',text(settings,'query',{placeholder:'Ej. ¿Qué incluye el servicio?'})),
      h('button',{class:'small',disabled:!status.preparing||status.pending_items>0,onclick:async()=>{
        await run(async()=>{const result=await api('POST',path+'/test',{query:settings.query});results.replaceChildren(
          h('h3',{},'Por significado'),...result.semantic.map(k=>h('div',{class:'card'},h('strong',{},k.title),h('p',{style:'white-space:pre-wrap'},k.content),k.source_url&&/^https?:\/\//i.test(k.source_url)?h('a',{href:k.source_url,target:'_blank',rel:'noopener'},'Ver fuente'):null)),
          h('h3',{},'Por palabras'),...result.lexical.map(k=>h('div',{class:'card'},h('strong',{},k.title),h('p',{},k.content))));await refresh();});
      }},'Comparar búsqueda'),
      h('p',{},'4. Activa cuando la preparación esté completa y la comparación sea satisfactoria.'),
      h('button',{class:status.enabled?'small':'primary',disabled:!status.enabled&&!status.ready,onclick:async()=>{
        await run(async()=>{await api('PUT',path,{enabled:!status.enabled});await refresh();});
      }},status.enabled?'Volver a búsqueda por palabras':'Activar para este perfil'),
      ...(status.force_off?[h('p',{class:'help'},'El operador ha aplicado una pausa global. Puedes desactivar; la activación queda suspendida.')]:[]),
      ...(!status.provider_configured?[h('p',{class:'help'},'Pide al administrador de la instalación que configure el proveedor de IA para poder comprobarlo.')]:[]),
    );
  };
  const results=h('div',{'aria-live':'polite'});root.append(results);
  draw();
  poll(async()=>{if(status.preparing&&status.pending_items) await refresh();},10000,root);
  return root;
}
