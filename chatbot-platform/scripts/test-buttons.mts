/**
 * Auditoría de botones: presiona cada control del panel con cada rol (PostgreSQL AISLADO, servicios simulados y un
 * navegador real) y cruza lo presionado con el inventario del código. Nada sale de la máquina: el navegador y el
 * servidor bloquean y anotan cualquier conexión externa. El arnés reinicia public.
 *
 * BUTTONS_REPORT_ONLY=1 escribe el informe sin fallar; BUTTONS_WORKERS reparte las pantallas del admin (3 por omisión).
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { installNetworkGuard, blocked } from './buttons/network-guard.mts';
installNetworkGuard();
const { chromium } = await import('playwright');
const { createHarness, pool } = await import('../test/harness.js');
const { seedUxFixture } = await import('./ux-fixture.mts');
const { INIT_SCRIPT } = await import('./buttons/instrument.mts');
const { crawl, acceptDialogs, isProblem } = await import('./buttons/crawl.mts');
const { staticInventory, matchSite, ACTION_EVENTS } = await import('./buttons/inventory.mts');
const { runAreas } = await import('./buttons/areas.mts');
type Outcome = import('./buttons/crawl.mts').Outcome;

assert.ok(process.env.TEST_DATABASE_URL, 'Define TEST_DATABASE_URL para una base de pruebas aislada; el arnés reinicia public.');
const output = path.resolve('data/button-audit'); fs.mkdirSync(output, { recursive: true });
const started = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)} s] ${msg}`);
const h = await createHarness(); let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const external: string[] = [];
const outcomes: Outcome[] = [];
const seen = new Set<string>();
const areaResults: import('./buttons/areas.mts').AreaResult[] = [];
try {
  const f = await seedUxFixture(h);
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const address: any = h.app.server.address(); const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  const contextFor = async (role: string, options: any = {}) => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
    const cookie = f.login[role].cookie; const ix = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, ix), value: cookie.slice(ix + 1), url: base }]);
    if (role === 'superadmin') await context.addInitScript((id: string) => localStorage.setItem('cp-account', id), h.accountId);
    await context.addInitScript(INIT_SCRIPT);
    // Nada sale de la máquina: lo que no sea el servidor local se bloquea y queda anotado.
    await context.route((url) => !url.href.startsWith(base) && !/^(data|blob|about):/.test(url.protocol), (route) => { external.push(route.request().url()); return route.abort('blockedbyclient'); });
    return context;
  };
  const bot = h.botId;
  // Además de las pantallas de test:ux, las que ninguna prueba abría.
  const extra = {
    admin: [`bot/${bot}/avisos`, `bot/${bot}/cotizaciones`, 'cotizaciones', 'cotizaciones/precios', 'cotizaciones/formatos', 'cotizaciones/historial', 'cotizaciones/ajustes', 'agenda/citas', `contact/${f.conv.contact_id}`, 'empezar'],
    agent: ['contacts', `contact/${f.conv.contact_id}`, 'comentarios'],
    superadmin: ['negocio', 'cobros', 'consumo', 'logs', 'notifications'],
  };
  const only = process.env.BUTTONS_ONLY || '';
  // Primero el pase funcional por área (cada área prepara sus datos); después el recorrido, que borra al aceptar.
  if (only !== 'recorrido') areaResults.push(...await runAreas({ h, f, base, pool, contextFor }, log));
  const done = new Map<string, Outcome>();
  const workers = Math.max(1, Number(process.env.BUTTONS_WORKERS || 3));
  // El agente va primero: el recorrido del admin presiona los controles de «Mi equipo» (rol, desactivar) sobre él.
  for (const role of (only === 'areas' ? [] : ['agent', 'admin', 'superadmin']) as ('admin' | 'agent' | 'superadmin')[]) {
    const routes = [...f.routes[role], ...extra[role]];
    // Las pantallas del admin se reparten entre varias pestañas a la vez; los demás roles van en una.
    const lanes = role === 'admin' ? workers : 1;
    const shares = Array.from({ length: lanes }, (_, i) => routes.filter((_, j) => j % lanes === i));
    await Promise.all(shares.map(async (share) => {
      const context = await contextFor(role);
      const r = await crawl({ context, base, user: role, routes: share, done, log });
      outcomes.push(...r.outcomes); r.seenSites.forEach((s) => seen.add(s));
      await context.close();
    }));
    log(`${role}: ${outcomes.filter((o) => o.user === role).length} controles anotados`);
  }
  // Aceptar cada diálogo que se abrió (lo que más borra, al final de cada rol).
  for (const role of (only === 'areas' ? [] : ['agent', 'admin', 'superadmin']) as ('admin' | 'agent' | 'superadmin')[]) {
    const items = outcomes.filter((o) => o.user === role && o.dialog && o.verdict !== 'CANCELAR ESCRIBIÓ');
    if (!items.length) continue;
    const context = await contextFor(role);
    const accepted = await acceptDialogs({ context, base, items, log });
    outcomes.push(...accepted.map((o) => ({ ...o, user: `${role} (aceptar)` })));
    await context.close();
    log(`${role}: ${accepted.length} diálogos aceptados`);
  }

  // Cobertura: cada sitio del código, ¿se presionó, solo se vio o nunca apareció?
  const inventory = staticInventory().filter((s) => s.events.some((e) => ACTION_EVENTS.includes(e)));
  const pressedVerdicts = new Set(['OK', 'SIN EFECTO', 'ERROR JS', 'ERROR API', 'ERROR SILENCIOSO', 'RECHAZADO', 'PÁGINA NO ENCONTRADA', 'REDIRIGIDO', 'MISMA PÁGINA', 'CANCELAR ESCRIBIÓ', 'ACEPTADO', 'ACEPTAR SIN EFECTO', 'NO SE ACEPTÓ']);
  const status = new Map<string, string>();
  const mark = (site: string, value: string) => {
    const [file, line] = site.split(':'); const s = matchSite(inventory, file, Number(line));
    if (!s) return;
    if (value === 'presionado' || !status.has(s.site)) status.set(s.site, value);
  };
  for (const s of seen) mark(s.split('@')[1], 'visto');
  for (const o of outcomes) if (pressedVerdicts.has(o.verdict)) o.sites.forEach((s) => mark(s, 'presionado'));
  const coverage = inventory.map((s) => ({ ...s, status: status.get(s.site) || 'no apareció' }));
  const count = (v: string) => coverage.filter((c) => c.status === v).length;
  const verdicts = Object.fromEntries(Object.entries(Object.groupBy(outcomes, (o) => o.verdict)).map(([k, v]) => [k, v!.length]));
  const problems = outcomes.filter(isProblem);
  const report = {
    duration_s: Math.round((Date.now() - started) / 1000), verdicts,
    coverage: { sites: inventory.length, pressed: count('presionado'), seen_not_pressed: count('visto'), never_seen: count('no apareció') },
    blocked: { browser: [...new Set(external)], server: blocked }, areas: areaResults, problems, outcomes, coverage_sites: coverage,
  };
  const areaFailures = areaResults.flatMap((a) => [...a.failed.map((x) => `${a.area}: ${x.check} — ${x.error}`), ...a.pageErrors.map((e) => `${a.area}: error JS ${e}`)]);
  log(`Áreas: ${areaResults.reduce((n, a) => n + a.passed.length, 0)} comprobaciones bien, ${areaFailures.length} con problema`);
  fs.writeFileSync(`${output}/results.json`, JSON.stringify(report, null, 2));
  log(`Veredictos: ${JSON.stringify(verdicts)}`);
  log(`Cobertura: ${report.coverage.pressed}/${inventory.length} sitios presionados, ${report.coverage.seen_not_pressed} solo vistos, ${report.coverage.never_seen} sin aparecer`);
  log(`Conexiones bloqueadas: navegador ${report.blocked.browser.length}, servidor ${blocked.length}`);
  for (const p of problems) log(`  ${p.verdict} · ${p.user} · ${p.route} · «${p.name}» ${p.sites[0] || p.href} ${p.note}`);
  for (const a of areaFailures) log(`  ÁREA · ${a}`);
  if (!process.env.BUTTONS_REPORT_ONLY) {
    assert.deepEqual(areaFailures, [], 'Comprobaciones por área que fallaron');
    assert.deepEqual(problems.map((p) => `${p.verdict} · ${p.user} · ${p.route} · «${p.name}» ${p.sites[0] || p.href} ${p.note}`), [], 'Controles que no hacen lo que dicen');
    assert.deepEqual(blocked, [], 'El servidor intentó conectarse fuera de la máquina');
  }
} finally {
  await browser?.close(); await h.app.close(); await pool.end();
}
