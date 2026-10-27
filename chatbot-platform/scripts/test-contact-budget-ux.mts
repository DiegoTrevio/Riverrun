/** Isolated browser acceptance for the contact workspace and account AI controls. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import pg from 'pg';
import {chromium} from 'playwright';
const url=new URL(process.env.TEST_DATABASE_URL??'postgres://chatbot:chatbot@127.0.0.1:5433/chatbot_test');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Solo PostgreSQL local');url.pathname='/postgres';
const admin=new pg.Client({connectionString:url.href});await admin.connect();const name='contact_budget_ux_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
url.pathname='/'+name;process.env.TEST_DATABASE_URL=url.href;
const {createHarness,pool,store}=await import('../test/harness.js');const {accountAi}=await import('../src/ai/budget.js');
const h=await createHarness();let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
const checks:string[]=[],errors:string[]=[],axe=fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'),'utf8');
try{
 await h.createBot({rules:{verify_facts:false},ai:{typing_simulation:false}});
 const other=await store.createAccount('Otro perfil de presupuesto');
 assert.equal((await h.authed('PUT',`/api/ai-budget?account_id=${other.id}`,{revision:0,settings:{monthly_usd:30}})).statusCode,200);
 const first=(await store.getChannel(h.channelId))!,second=await store.createChannel({account_id:h.accountId,chatbot_id:h.botId,type:'whatsapp',name:'Sucursal norte',config:{instance:'norte'}});
 const records=[];
 for(const channel of [first,second]){const c=await store.upsertContact(channel,'5215512345678','5215512345678','Ana');await store.updateContact(c.id,{name:'Ana',data:{pedido:channel===first?'Tacos':'Quesadillas'}});const conv=await store.getOrCreateConversation(channel,c.id);records.push({c,conv});}
 await store.insertContactTask({account_id:h.accountId,contact_id:records[0].c.id,conversation_id:records[0].conv.id,kind:'pendiente',body:'Confirmar entrega',due_on:null,created_by:null,created_via:'panel'});
 await pool.query('UPDATE conversations SET summary=$2 WHERE id=$1',[records[0].conv.id,'Ana pidió tacos y espera confirmar entrega.']);
 await h.app.listen({host:'127.0.0.1',port:0});const base=`http://127.0.0.1:${(h.app.server.address() as any).port}`;
 browser=await chromium.launch({...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1366,height:1000}}),ix=h.cookie.indexOf('=');await context.addCookies([{name:h.cookie.slice(0,ix),value:h.cookie.slice(ix+1),url:base}]);await context.addInitScript(id=>localStorage.setItem('cp-account',id),h.accountId);
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${base}/#/contacts`);await page.getByRole('heading',{name:'Contactos',exact:true}).waitFor();await page.getByRole('link',{name:'Ver ficha',exact:true}).waitFor();assert.equal(await page.locator('.main tbody tr').count(),1);checks.push('La lista reúne dos canales del mismo teléfono');
 await page.getByLabel('Mostrar',{exact:true}).selectOption('pending');await page.getByRole('link',{name:'Ver ficha',exact:true}).waitFor();
 await page.getByRole('button',{name:'Guardar esta vista',exact:true}).click();await page.locator('dialog input').fill('Pendientes del día');await page.locator('dialog').getByRole('button',{name:'Guardar',exact:true}).click();await page.getByLabel('Vista de contactos guardada').getByRole('option',{name:'Pendientes del día'}).waitFor({state:'attached'});checks.push('Filtro y vista personal guardados desde la interfaz');
 await page.getByRole('link',{name:'Ver ficha',exact:true}).click();await page.getByRole('heading',{name:'Ana',exact:true}).waitFor();await page.getByRole('link',{name:'Retomar conversación',exact:true}).waitFor();
 const data=page.locator('.card').filter({has:page.getByRole('heading',{name:'Datos y notas',exact:true})});await data.locator('summary').filter({hasText:'WhatsApp'}).click();await data.locator('summary').filter({hasText:'Sucursal norte'}).click();await data.getByText('Tacos',{exact:true}).waitFor();await data.getByText('Quesadillas',{exact:true}).waitFor();checks.push('Ficha con respuestas por canal, historial y pendientes');
 await page.getByLabel('Pendiente o nota',{exact:true}).fill('Enviar confirmación al equipo');await page.getByRole('button',{name:'Agregar',exact:true}).click();await page.getByText('Enviar confirmación al equipo',{exact:true}).waitFor();checks.push('Reutiliza el formulario de pendientes sin duplicar registros');
 assert.deepEqual(records.map(r=>r.c.id).sort(),(await pool.query('SELECT id FROM contacts WHERE account_id=$1',[h.accountId])).rows.map(r=>r.id).sort());
 await page.goto(`${base}/#/consumo`);await page.getByRole('heading',{name:'Presupuesto de este perfil'}).waitFor();await page.getByLabel('Límite mensual (USD)',{exact:true}).fill('0');await page.getByRole('button',{name:'Guardar presupuesto',exact:true}).click();await page.locator('dialog').getByRole('button',{name:'Continuar',exact:true}).click();await page.getByText('Presupuesto guardado',{exact:true}).waitFor();
 await page.getByLabel('Límite mensual (USD)',{exact:true}).waitFor();
 const policy=(await h.authed('GET',`/api/ai-budget?account_id=${h.accountId}`)).json();assert.equal(policy.settings.monthly_usd,0);
 const before=h.calls.length;await assert.rejects(()=>accountAi(h.ai,h.accountId,h.botId).complete({model:'openai/gpt-4.1-mini',messages:[{role:'user',content:'hola'}],json_schema:{name:'budget_case',schema:{}}}));assert.equal(h.calls.length,before);checks.push('Presupuesto guardado bloquea el proveedor antes de la llamada');
 const held=(await pool.query("INSERT INTO ai_spend(account_id,kind,models,state,cost_source) VALUES($1,'decision',ARRAY['sin-tarifa'],'unknown','unknown') RETURNING id",[h.accountId])).rows[0];
 await page.reload();await page.getByText('sin-tarifa',{exact:true}).waitFor();await page.getByLabel('Importe confirmado (USD)',{exact:true}).fill('0.001');await page.getByLabel('Motivo de la confirmación',{exact:true}).fill('Revisado en la factura del proveedor');await page.getByRole('button',{name:'Confirmar importe',exact:true}).click();await page.getByText('Importe confirmado',{exact:true}).waitFor();await page.getByRole('heading',{name:'Presupuesto de este perfil'}).waitFor();assert.equal((await pool.query('SELECT state FROM ai_spend WHERE id=$1',[held.id])).rows[0].state,'settled');checks.push('Un importe desconocido requiere confirmación explícita y conserva auditoría');
 await page.goto(`${base}/#/consumo?account_id=${other.id}`);await page.getByRole('heading',{name:'Presupuesto de este perfil'}).waitFor();assert.equal(await page.getByLabel('Límite mensual (USD)',{exact:true}).inputValue(),'30');
 await page.locator('#profile-switch').selectOption(h.accountId);await page.waitForFunction(()=>!location.hash.includes('account_id'));await page.getByRole('heading',{name:'Presupuesto de este perfil'}).waitFor();assert.equal(await page.getByLabel('Límite mensual (USD)',{exact:true}).inputValue(),'0');
 checks.push('El aviso abre el perfil correcto y permite cambiar de perfil sin quedarse fijado');
 for(const route of ['contacts',`contact/${records[0].c.id}`,'consumo'])for(const width of [1366,768,390]){
  await page.setViewportSize({width,height:1000});await page.goto(`${base}/#/${route}`);await page.locator('.main h1').waitFor();await page.evaluate(axe);
  const violations=await page.evaluate(async()=> (await (window as any).axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.filter((v:any)=>['serious','critical'].includes(v.impact)));assert.deepEqual(violations,[],`${route} a ${width}`);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`${route} sin desbordamiento a ${width}`);
 }
 checks.push('Contactos, ficha y presupuesto accesibles en computadora, tableta y móvil');assert.deepEqual(errors,[]);assert.equal(h.sent.length,0);process.stdout.write(JSON.stringify({checks,errors},null,2)+'\n');
}finally{await browser?.close();await h.app.close();await pool.end();await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();}
