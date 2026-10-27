/** Independent synthetic database; safe to run alongside the regression suite. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import pg from 'pg';
import {chromium} from 'playwright';
const url=new URL(process.env.TEST_DATABASE_URL??'postgres://chatbot:chatbot@127.0.0.1:5433/chatbot_test');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Solo PostgreSQL local de pruebas.');
url.pathname='/postgres';const admin=new pg.Client({connectionString:url.href});await admin.connect();
const name='semantic_ux_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
url.pathname='/'+name;process.env.TEST_DATABASE_URL=url.href;
const {createHarness,pool,store,waitFor}=await import('../test/harness.js');
const {config}=await import('../src/config.js');config.openai.apiKey='synthetic-provider';config.knowledgeSearch.enabled=false;
const h=await createHarness();let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
const output='data/semantic-ux-results';fs.mkdirSync(output,{recursive:true});
const axe=fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'),'utf8');
const errors:string[]=[];const results:any={checks:[],screens:[],errors};
try {
 await h.createBot({ai:{typing_simulation:false}});
 const v=Array.from({length:1536},(_,i)=>i===0?1:0);h.ai.embed=async(texts,model)=>({vectors:texts.map(()=>v),model,input_tokens:10,latency_ms:1,cost_usd:0.00001});
 await store.upsertKnowledge(h.botId,{title:'Tarifa autorizada',content:'La habitación cuesta $1,650.',source_url:'https://example.com/tarifas'});
 await h.app.listen({host:'127.0.0.1',port:0});const base=`http://127.0.0.1:${(h.app.server.address() as any).port}`;
 browser=await chromium.launch({...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1366,height:1000}});const ix=h.cookie.indexOf('=');
 await context.addCookies([{name:h.cookie.slice(0,ix),value:h.cookie.slice(ix+1),url:base}]);await context.addInitScript(id=>localStorage.setItem('cp-account',id),h.accountId);
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${base}/#/bot/${h.botId}/conocimiento`);
 const wizard=page.locator('details').filter({has:page.getByText('Búsqueda por significado · preparar, probar y activar',{exact:true})});await wizard.locator('summary').click();
 const check=async(label:string)=>{await page.evaluate(axe);const violations=await page.evaluate(async()=> (await (window as any).axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.filter((v:any)=>['serious','critical'].includes(v.impact)));assert.deepEqual(violations,[]);results.checks.push(label);};
 await check('Asistente desactivado accesible');assert.equal(await wizard.getByRole('button',{name:'Activar para este perfil',exact:true}).isDisabled(),true);
 await wizard.getByRole('button',{name:'Comprobar proveedor',exact:true}).click();await wizard.getByRole('button',{name:'Preparar conocimiento',exact:true}).waitFor({state:'visible'});
 await waitFor(async()=>!(await wizard.getByRole('button',{name:'Preparar conocimiento',exact:true}).isDisabled()));
 await wizard.getByRole('button',{name:'Preparar conocimiento',exact:true}).click();
 await waitFor(async()=>!(await wizard.getByRole('button',{name:'Comparar búsqueda',exact:true}).isDisabled()));
 await wizard.getByLabel('Pregunta de prueba',{exact:true}).fill('¿Cuánto vale una estancia?');await wizard.getByRole('button',{name:'Comparar búsqueda',exact:true}).click();
 await wizard.getByRole('heading',{name:'Por significado',exact:true}).waitFor();assert.equal(await wizard.getByRole('link',{name:'Ver fuente',exact:true}).getAttribute('href'),'https://example.com/tarifas');
 await waitFor(async()=>!(await wizard.getByRole('button',{name:'Activar para este perfil',exact:true}).isDisabled()));
 await wizard.getByRole('button',{name:'Activar para este perfil',exact:true}).click();await wizard.getByRole('button',{name:'Volver a búsqueda por palabras',exact:true}).waitFor();
 assert.equal((await h.authed('GET',`/api/chatbots/${h.botId}/semantic`)).json().enabled,true);await check('Comprobación, preparación, comparación y activación funcionan desde navegador');
 await page.screenshot({path:`${output}/activated-desktop.png`,fullPage:true});results.screens.push('activated-desktop.png');
 for(const width of [390,768]) {await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));await check(`Sin desbordamiento y accesible a ${width}px`);}
 await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`${output}/activated-mobile.png`,fullPage:true});results.screens.push('activated-mobile.png');
 await wizard.getByRole('button',{name:'Volver a búsqueda por palabras',exact:true}).click();await wizard.getByRole('button',{name:'Activar para este perfil',exact:true}).waitFor();assert.equal((await h.authed('GET',`/api/chatbots/${h.botId}/semantic`)).json().enabled,false);results.checks.push('Rollback del perfil desde navegador');
 assert.ok(!(await wizard.innerText()).includes('null'),'No hay valores internos visibles en el asistente');
 assert.deepEqual(errors,[]);console.log(JSON.stringify(results));
} finally {
 fs.writeFileSync(`${output}/results.json`,JSON.stringify(results,null,2));await browser?.close();await h.app.close();await pool.end();await admin.query(`DROP DATABASE "${name}" WITH(FORCE)`);await admin.end();
}
