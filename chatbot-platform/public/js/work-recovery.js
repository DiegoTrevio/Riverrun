import { api,h,run,poll,confirmAction } from './core.js';
import { isAdmin } from './session.js';
export function workRecovery(id) {
  const root=h('div',{'aria-live':'polite'});
  const refresh=async()=>{
    const status=await api('GET',`/api/conversations/${id}/work`);
    if(status.work?.state!=='dead') {root.replaceChildren();return;}
    const uncertain=status.work.reason!=='processing_error';
    root.replaceChildren(h('div',{class:'card'},h('strong',{},uncertain?'Respuesta interrumpida · necesita revisión':'No se pudo responder automáticamente'),
      h('p',{},uncertain?'Revisa lo que recibió el cliente antes de continuar. Un envío puede haber llegado aunque no tengamos su confirmación. Atiende lo pendiente a mano y confirma la revisión.':'Los mensajes siguen guardados. Puedes reintentar después de resolver el problema del proveedor.'),
      isAdmin()?h('button',{class:'small',onclick:async()=>{
        if(uncertain&&!await confirmAction('¿Ya revisaste la conversación y atendiste todos los mensajes pendientes? Esto evita repetirlos automáticamente.')) return;
        await run(async()=>{await api('POST',`/api/conversations/${id}/work/recover`,{action:uncertain?'acknowledge':'retry',review_up_to:status.review_up_to});await refresh();});
      }},uncertain?'Confirmar revisión y atención':'Reintentar respuesta'):null));
  };
  void refresh().catch(()=>undefined);
  poll(refresh,10000,root);
  return root;
}
