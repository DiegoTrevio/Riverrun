/** Browser + Promptfoo acceptance against a uniquely named, local synthetic database. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { chromium } from 'playwright';
const url=new URL(process.env.TEST_DATABASE_URL??'postgres://chatbot:chatbot@127.0.0.1:5433/chatbot_test');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Solo PostgreSQL local sintético');
url.pathname='/postgres';const admin=new pg.Client({connectionString:url.href});await admin.connect();
const name='agent_ux_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
url.pathname='/'+name;process.env.TEST_DATABASE_URL=url.href;
const {createHarness,pool,store}=await import('../test/harness.js');
const h=await createHarness();let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
const checks:string[]=[],errors:string[]=[];
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'riverrun-agent-eval-'));
const axe=fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'),'utf8');
try {
 await h.createBot({rules:{verify_facts:false},personality:{emojis:'none'}});h.setScript(()=>({messages:['Con gusto te ayudo.']}));
 await h.app.listen({host:'127.0.0.1',port:0});const base=`http://127.0.0.1:${(h.app.server.address() as any).port}`;
 browser=await chromium.launch({...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1366,height:1000}}),ix=h.cookie.indexOf('=');
 await context.addCookies([{name:h.cookie.slice(0,ix),value:h.cookie.slice(ix+1),url:base}]);await context.addInitScript(id=>localStorage.setItem('cp-account',id),h.accountId);
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${base}/#/bot/${h.botId}/instrucciones`);await page.getByRole('heading',{name:'Hotel Palmas'}).waitFor();
 // Guardar = aplicar: sin pasos extra ni pruebas obligatorias.
 await page.getByLabel('Nombre del agente',{exact:true}).fill('Agente guardado y aplicado');
 await page.getByRole('button',{name:'Guardar cambios',exact:true}).first().click();
 await page.getByText('Cambios guardados ✅',{exact:true}).waitFor();await page.getByRole('heading',{name:'Agente guardado y aplicado'}).waitFor();
 assert.equal((await store.getChatbot(h.botId))!.name,'Agente guardado y aplicado');checks.push('Guardar aplica los cambios de inmediato');
 await page.getByText('Opciones avanzadas',{exact:true}).click();await page.getByText('Historial de versiones',{exact:true}).click();
 await page.getByText('En uso',{exact:true}).waitFor();checks.push('Cada guardado queda en el historial de versiones');
 // Pruebas automáticas: opcionales, en Probar.
 await page.getByRole('link',{name:'Probar',exact:true}).first().click();
 await page.getByText('Pruebas automáticas (opcional)',{exact:true}).click();await page.getByRole('heading',{name:'Pruebas automáticas'}).waitFor();
 await page.getByRole('button',{name:'Agregar prueba',exact:true}).click();
 await page.getByLabel('Nombre de la prueba',{exact:true}).fill('Saludo del negocio');
 await page.getByLabel('Mensajes del cliente, uno por línea',{exact:true}).fill('hola');
 await page.getByLabel('La respuesta debe incluir (separa frases con |)',{exact:true}).fill('ayudo');
 await page.getByRole('button',{name:'Guardar y ejecutar pruebas',exact:true}).click();
 await page.getByText('✓ Todas las pruebas aprobadas',{exact:true}).waitFor();checks.push('Crear y ejecutar un caso desde la interfaz');
 // A late response must acknowledge only the submitted cases, preserving edits made while saving.
 let release!:()=>void,entered!:()=>void;const hold=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>entered=r);
 await page.route(`**/api/chatbots/${h.botId}/tests`,async route=>{const response=await route.fetch();entered();await hold;await route.fulfill({response});});
 await page.getByRole('button',{name:'Guardar pruebas',exact:true}).click();await waiting;
 await page.getByLabel('La respuesta debe incluir (separa frases con |)',{exact:true}).fill('gusto');release();
 await page.waitForTimeout(250);await page.unrouteAll({behavior:'wait'});
 assert.equal(await page.getByLabel('La respuesta debe incluir (separa frases con |)',{exact:true}).inputValue(),'gusto');
 assert.deepEqual((await h.authed('GET',`/api/chatbots/${h.botId}/tests`)).json().cases[0].turns[0].expect.contains,['ayudo']);
 await page.getByRole('button',{name:'Guardar y ejecutar pruebas',exact:true}).click();await page.getByText('✓ Todas las pruebas aprobadas',{exact:true}).waitFor();
 checks.push('Una respuesta de guardado tardía conserva las ediciones nuevas');
 await page.getByRole('link',{name:'Instrucciones',exact:true}).click();await page.getByLabel('Nombre del agente',{exact:true}).waitFor();
 await page.getByLabel('Nombre del agente',{exact:true}).fill('Segundo cambio');await page.getByRole('button',{name:'Guardar cambios',exact:true}).first().click();
 await page.getByRole('heading',{name:'Segundo cambio'}).waitFor();assert.equal((await store.getChatbot(h.botId))!.name,'Segundo cambio');
 const configuration=(await h.authed('GET',`/api/chatbots/${h.botId}/tests/promptfoo`)).json();
 configuration.providers=[`file://${path.resolve('evals/agent-cases-provider.mjs')}`];
 const evalFile=path.join(temporary,'cases.json');fs.writeFileSync(evalFile,JSON.stringify(configuration));
 const code=await new Promise<number>((resolve,reject)=>{const child=spawn(process.execPath,['node_modules/promptfoo/dist/src/entrypoint.js','eval','-c',evalFile,'--no-cache','--max-concurrency','1'],{env:{...process.env,RIVERRUN_APP_URL:base,RIVERRUN_SESSION_COOKIE:h.cookie,PROMPTFOO_DISABLE_TELEMETRY:'1',PROMPTFOO_CONFIG_DIR:path.join(temporary,'promptfoo')},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>process.stdout.write(b));child.stderr.on('data',b=>process.stderr.write(b));child.on('error',reject);child.on('close',c=>resolve(c??1));});
 assert.equal(code,0);checks.push('Promptfoo ejecuta el mismo caso guardado con el motor real');
 await page.reload();await page.getByLabel('Nombre del agente',{exact:true}).fill('Sin guardar todavía');await page.waitForTimeout(200);
 assert.equal((await store.getChatbot(h.botId))!.name,'Segundo cambio');checks.push('Lo que no se guarda no llega a los clientes');
 for(const tab of ['instrucciones','probar']) {
  await page.goto(`${base}/#/bot/${h.botId}/${tab}`);await page.getByRole('heading',{name:'Segundo cambio'}).waitFor();
  for(const width of [1366,768,390]) {
   await page.setViewportSize({width,height:1000});await page.addScriptTag({content:axe});
   const violations=await page.evaluate(async()=> (await (window as any).axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.filter((v:any)=>['serious','critical'].includes(v.impact)));
   assert.deepEqual(violations,[],`${tab} a ${width}px`);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`Sin desbordamiento a ${width}`);
  }
 }
 checks.push('Accesibilidad y ausencia de desbordamiento en computadora, tableta y móvil');assert.deepEqual(errors,[]);assert.equal(h.sent.length,0);
 process.stdout.write(JSON.stringify({checks,errors},null,2)+'\n');
} finally {
 await browser?.close();await h.app.close();await pool.end();fs.rmSync(temporary,{recursive:true,force:true});
 await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();
}
