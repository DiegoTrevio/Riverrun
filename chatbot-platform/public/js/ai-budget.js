import { api, check, confirmAction, field, fmtDate, h, num, run, select, text } from './core.js';
import { render } from './main.js';
import { withAcct } from './session.js';
const money=n=>Number(n)>0&&Number(n)<0.0001?'US$<0.0001':`US$${Number(n||0).toFixed(4)}`;
export async function budgetCard() {
 const current=await api('GET',withAcct('/api/ai-budget')),model=JSON.parse(JSON.stringify(current.settings));
 const limits=h('div',{class:'stack'}),prices=h('div',{class:'stack'});
 const moneyInput=(object,key)=>h('input',{type:'number',min:0,max:1000000,step:0.01,value:object[key]??'',placeholder:'Sin límite',oninput:e=>{object[key]=e.target.value===''?null:Number(e.target.value);}});
 const drawLimits=()=>limits.replaceChildren(...model.models.map((m,i)=>h('div',{class:'row'},field('Modelo',text(m,'model')),field('Periodo',select(m,'period',[['month','Mes (UTC)'],['day','Día (UTC)']])),field('Límite (USD)',num(m,'limit_usd',{min:0,step:0.01})),h('button',{class:'small',onclick:()=>{model.models.splice(i,1);drawLimits();}},'Quitar límite'))));
 const drawPrices=()=>prices.replaceChildren(...model.prices.map((p,i)=>h('div',{class:'stack'},field('Modelo o prefijo',text(p,'model')),h('div',{class:'grid'},field('Entrada por millón de tokens (USD)',num(p,'input_per_mtok',{min:0,step:0.001})),field('Salida por millón de tokens (USD)',num(p,'output_per_mtok',{min:0,step:0.001}))),check(p,'is_free','Confirmo que este modelo es gratuito'),h('button',{class:'small',onclick:()=>{model.prices.splice(i,1);drawPrices();}},'Quitar precio'))));
 drawLimits();drawPrices();
 const month=current.usage.find(s=>s.period==='month')||{},day=current.usage.find(s=>s.period==='day')||{};
 let saving=false;
 return h('div',{class:'card stack'},h('h2',{style:'margin:0'},'Presupuesto de este perfil'),h('p',{class:'help'},'Un límite diario o mensual (en UTC) que detiene las llamadas de IA al agotarse. La atención manual, las citas y los envíos programados siguen funcionando.'),
  h('div',{class:'grid'},h('div',{},h('strong',{},'Mes actual'),h('p',{},`${money(month.reported_usd)} informados por el proveedor · ${money(month.estimated_usd)} estimados o confirmados`),h('p',{class:'small'},`${money(month.held_usd)} reservados · ${month.unknown||0} importes sin determinar`)),h('div',{},h('strong',{},'Hoy'),h('p',{},`${money(day.committed_usd)} gastados o reservados`),h('p',{class:'small'},`${day.unknown||0} importes sin determinar`))),
  h('div',{class:'grid'},field('Límite mensual (USD)',moneyInput(model,'monthly_usd'),'Vacío conserva el uso sin límite. Con 0 se bloquean nuevas llamadas con costo.'),field('Límite diario (USD)',moneyInput(model,'daily_usd'))),
  h('details',{},h('summary',{},'Límites por modelo y ajustes de estimación'),h('div',{class:'stack',style:'margin-top:16px'},field('Máximo de tokens de salida por respuesta con presupuesto',num(model,'max_output_tokens',{min:256,max:16000})),limits,
   h('button',{onclick:()=>{if(model.models.length>=20)return;model.models.push({model:'',period:'month',limit_usd:10});drawLimits();}},'Agregar límite por modelo'),
   h('p',{class:'help'},'Se usan los precios del master; si tu modelo cobra distinto, decláralo aquí. Sin precio conocido, la llamada se bloquea cuando hay límite. Son estimaciones, no una factura.'),prices,
   h('button',{onclick:()=>{if(model.prices.length>=20)return;model.prices.push({model:'',input_per_mtok:null,output_per_mtok:null,per_audio_minute:0,is_free:false});drawPrices();}},'Agregar precio propio'))),
  h('button',{class:'primary',onclick:async e=>{
   if(saving)return;if(!await confirmAction('¿Guardar este presupuesto? Los límites aplican a las nuevas llamadas de este perfil, incluidos resúmenes, importaciones y pruebas.'))return;
   saving=true;e.target.disabled=true;try{if(await run(()=>api('PUT',withAcct('/api/ai-budget'),{revision:current.revision,settings:model}),'Presupuesto guardado'))render();}finally{saving=false;e.target.disabled=false;}
  }},'Guardar presupuesto'),
  h('details',{open:current.review.some(r=>r.state!=='reserved')},h('summary',{},`Importes pendientes de revisión (${current.review.length}${current.review.length===100?'+':''})`),h('p',{class:'help'},'Una llamada incierta conserva su reserva para no gastar dos veces. Confirma el importe solo después de revisarlo con el proveedor.'),
   ...current.review.map(r=>{
    const check={amount_usd:r.charged_usd??r.reserved_usd??0,note:''};
    return h('div',{class:'stack'},h('strong',{},r.models.join(', ')),h('p',{class:'small'},`${fmtDate(r.created_at)} · ${r.state==='reserved'?'En curso':r.state==='unknown'?'Precio desconocido':'Resultado incierto'} · reserva: ${r.reserved_usd===null?'no determinada':money(r.reserved_usd)}`),
     ...(r.state==='reserved'?[h('p',{class:'help'},'Si el proceso se interrumpió, la reserva se conserva. Revísala tras el periodo de espera.')]:[]),
     ...(r.state!=='reserved'?[field('Importe confirmado (USD)',num(check,'amount_usd',{min:0,step:0.0001})),field('Motivo de la confirmación',text(check,'note',{placeholder:'Ej. Revisado con el proveedor'})),h('button',{class:'small',onclick:async()=>{if(await run(()=>api('POST',withAcct(`/api/ai-budget/review/${r.id}`),{...check,amount_usd:Number(check.amount_usd)}),'Importe confirmado'))render();}},'Confirmar importe')]:[]));
   })),
  h('p',{class:'help'},'Las reservas pueden superar el costo final, y una llamada ya enviada puede terminar después de cambiar el límite. Con presupuesto, el audio sin duración verificada no se envía.'));
}
