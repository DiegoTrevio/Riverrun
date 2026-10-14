import {api,h,run,poll,confirmAction} from './core.js';
export function receiptRecovery(channel) {
  const root=h('div',{'aria-live':'polite'});
  const refresh=async()=>{
    const rows=await api('GET',`/api/channels/${channel.id}/receipts`);
    const failed=rows.filter(r=>r.state==='dead');
    if(!failed.length){root.replaceChildren();return;}
    root.replaceChildren(h('details',{class:'card'},h('summary',{},`${failed.length} recepciones pendientes de revisión`),
      h('p',{},'Los mensajes recibidos están guardados. Si una recepción se interrumpió, revisa la conversación y atiende al cliente antes de confirmar.'),
      failed.map(r=>h('div',{class:'list-item'},h('p',{},`Recepción #${r.id} · ${r.attempts} intentos · ${r.reason==='receipt_interrupted'?'procesamiento interrumpido':'no se pudo procesar'}`),
        h('button',{class:'small',onclick:async()=>{if(r.reason==='receipt_interrupted'&&!await confirmAction('¿Ya revisaste y atendiste al cliente de esta recepción?'))return;
          await run(async()=>{await api('POST',`/api/channels/${channel.id}/receipts/${r.id}/recover`,{action:r.reason==='receipt_processing'?'retry':'acknowledge'});await refresh();});
        }},r.reason==='receipt_processing'?'Reintentar recepción':'Confirmar revisión')))));
  };
  void refresh().catch(()=>undefined);poll(refresh,10000,root);return root;
}
