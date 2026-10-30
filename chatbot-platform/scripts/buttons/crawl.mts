/**
 * Recorrido «presionar todo»: en cada pantalla de un rol presiona cada control visible, uno por uno y desde la
 * pantalla recién abierta, y anota qué pasó (petición, cambio en la página, diálogo, navegación, descarga, error).
 * Los controles que aparecen al presionar otro (un editor, un menú) se presionan también, un nivel más abajo.
 * Un diálogo de confirmación se cierra con «Cancelar» y se comprueba que no escribió nada; después, el pase de
 * aceptación vuelve a abrir cada diálogo, lo acepta y comprueba que la acción se hizo.
 */
import type { BrowserContext, Page, Request } from 'playwright';

export type Control = {
  key: string; area: string; role: string; tag: string; type: string; name: string; href: string; target: string;
  disabled: boolean; via: string; sites: string[]; chain: string[]; dialogTitle: string;
};
export type Verdict = 'OK' | 'SIN EFECTO' | 'SIN MANEJADOR' | 'ERROR JS' | 'ERROR API' | 'ERROR SILENCIOSO' | 'RECHAZADO' | 'PÁGINA NO ENCONTRADA'
  | 'REDIRIGIDO' | 'MISMA PÁGINA' | 'CANCELAR ESCRIBIÓ' | 'NO SE PUDO PRESIONAR' | 'NO ENCONTRADO' | 'DESHABILITADO' | 'OMITIDO' | 'YA PROBADO'
  | 'ACEPTADO' | 'ACEPTAR SIN EFECTO' | 'NO SE ACEPTÓ' | 'SOLO INFORMATIVO';
export type Outcome = Control & {
  user: string; route: string; path: string[]; parents: Control[]; verdict: Verdict; effects: string[]; requests: string[]; note: string; final: string;
  dialog?: string;
};

/** No se presionan en el recorrido (cierran la sesión con la que se audita); los cubre su prueba por área. */
const SKIP: [RegExp, string][] = [
  [/^Cerrar sesión$/i, 'cierra la sesión de la auditoría'],
  [/cerrar (las |todas las )?(otras )?sesiones|cerrar las demás|cerrar sesión en todos|^Cerrar la sesión de /i, 'cierra la sesión de la auditoría (lo prueba el área global)'],
];
const CANCEL = /^(Cancelar|Cerrar|No|Listo|Entendido|Volver)$/;
/** Sin efecto y está bien: en la pantalla recién abierta no hay nada que hacer con ellos. */
const EXPECTED_NOOP: [RegExp, RegExp, string][] = [
  [/^Enviar$/, /^(conversations|playground)\.js:/, 'el cuadro de mensaje está vacío: no hay nada que enviar'],
  [/^Limpiar filtros$/, /^(logs|conversations)\.js:/, 'no hay filtros puestos'],
];
/**
 * Al aceptar, sin efecto y está bien: el pase solo llena lo vacío y no elige ni sube archivos (título del diálogo, sitio,
 * motivo). Antes de que cada navegador entrara con una sesión nueva, el admin llegaba aquí ya cambiado a agente (por el
 * recorrido del maestro) y estos diálogos no se alcanzaban.
 */
const EXPECTED_ACCEPT_NOOP: [RegExp, RegExp, string][] = [
  [/^Nombre del flujo$/, /^flowboard\.js:/, 'el nombre ya estaba escrito: guardarlo igual no cambia nada'],
  [/^Foto (de referencia|o archivo del mensaje)$/, /^flowboard\.js:/, 'sin elegir una foto o un archivo, «Usar este» no tiene qué usar'],
  [/^Importar contactos$/, /^contact-(workspace|fields)\.js:/, 'pide un archivo CSV: lo sube test:ux'],
];
const PROBLEMS: Verdict[] = ['SIN EFECTO', 'SIN MANEJADOR', 'ERROR JS', 'ERROR API', 'ERROR SILENCIOSO', 'PÁGINA NO ENCONTRADA', 'REDIRIGIDO', 'CANCELAR ESCRIBIÓ', 'NO SE PUDO PRESIONAR', 'ACEPTAR SIN EFECTO', 'NO SE ACEPTÓ'];
export const isProblem = (o: Outcome) => PROBLEMS.includes(o.verdict);

const isApi = (url: string) => /\/(api|zernio|webhook)\//.test(new URL(url).pathname);

/** Una pestaña instrumentada: qué pasa durante cada clic y cómo volver a la pantalla recién abierta. */
async function session(context: BrowserContext, base: string, log: (m: string) => void) {
  const page: Page = await context.newPage();
  page.setDefaultTimeout(8000);
  const seenSites = new Set<string>();
  let on = false; let inflight = 0; let lastActivity = 0;
  const ev = { requests: [] as Request[], status: [] as string[], pageErrors: [] as string[], popups: [] as string[], downloads: [] as string[], files: 0, native: [] as string[] };
  const reset = () => { ev.requests = []; ev.status = []; ev.pageErrors = []; ev.popups = []; ev.downloads = []; ev.files = 0; ev.native = []; };
  page.on('request', (r) => { if (!isApi(r.url())) return; inflight++; lastActivity = Date.now(); if (on) ev.requests.push(r); });
  const finished = (r: Request) => { if (!isApi(r.url())) return; inflight = Math.max(0, inflight - 1); lastActivity = Date.now(); };
  page.on('requestfinished', finished); page.on('requestfailed', finished);
  page.on('response', (r) => { if (on && isApi(r.url()) && r.status() >= 400) ev.status.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
  page.on('pageerror', (e) => { if (on) ev.pageErrors.push(e.message); else log(`  error JS fuera de un clic: ${e.message}`); });
  page.on('popup', async (p) => { ev.popups.push(p.url()); await p.close().catch(() => {}); });
  page.on('download', async (d) => { ev.downloads.push(d.suggestedFilename()); await d.cancel().catch(() => {}); });
  page.on('filechooser', () => { ev.files++; });
  page.on('dialog', async (d) => { ev.native.push(`${d.type()}: ${d.message()}`); if (d.type() === 'beforeunload') await d.accept(); else await d.dismiss(); });

  const settle = async (max = 5000) => {
    const start = Date.now();
    await page.waitForTimeout(200);
    while (Date.now() - start < max) {
      if (inflight === 0 && Date.now() - lastActivity > 300) return;
      await page.waitForTimeout(60);
    }
  };
  const ready = async () => {
    // El panel tiene su título en .main; las páginas públicas (reservar, ayuda) en main o en el cuerpo.
    await page.locator('.main h1, main h1, main h2, body > h1').first().waitFor({ timeout: 10000 });
    await page.locator('.main [aria-busy="true"]').first().waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    await settle(3000);
  };
  const collectSites = async () => { for (const s of await page.evaluate('__audit.allSites()').catch(() => []) as string[]) seenSites.add(s); };
  const fresh = async (route: string) => {
    // Una ruta con «/» es una página del servidor (reservar, precios, ayuda); las demás, pantallas del panel.
    const url = route.startsWith('/') ? `${base}${route}` : `${base}/#/${route}`;
    // Se descarta lo que quedó abierto (diálogos, Copiloto) pasando por otra ruta y volviendo.
    if (!page.url().startsWith(base) || route.startsWith('/')) { await page.goto('about:blank'); await page.goto(url); }
    else { await page.goto(`${base}/#/__auditoria`); await page.goto(url); }
    await page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d: any) => d.remove()); }).catch(() => {});
    await ready();
    await collectSites();
  };
  const controls = async () => (await page.evaluate('__audit.controls()')) as Control[];
  const mark = (key: string) => page.evaluate((k) => (window as any).__audit.mark(k), key) as Promise<boolean>;
  /** Presiona el control; 'unica' si es una lista sin otra opción que elegir. */
  const clickKey = async (c: Control): Promise<boolean | 'unica'> => {
    if (!(await mark(c.key))) return false;
    const target = page.locator('[data-audit-target]');
    if (c.tag === 'select') {
      const values = await target.evaluate((s: HTMLSelectElement) => ({ current: s.value, all: [...s.options].filter((o) => !o.disabled).map((o) => o.value) }));
      const next = values.all.find((v) => v !== values.current);
      if (next === undefined) return 'unica';
      await target.selectOption(next);
      return true;
    }
    // Un enlace que solo se ve con el foco (Saltar al contenido) se usa con el teclado, como lo usa quien lo necesita.
    if (!(await target.isVisible()) || await target.evaluate((el) => el.matches('.skip-link, .sr-only-focusable, a[href^="#contenido"]'))) {
      await target.focus(); await page.keyboard.press('Enter');
      return true;
    }
    await target.click({ timeout: 3000 });
    return true;
  };
  /** Abre la pantalla y repite los clics que llevan al control (p. ej. «Editar» antes de «Guardar»). */
  const reach = async (route: string, parents: Control[]) => {
    await fresh(route);
    for (const p of parents) { await clickKey(p); await settle(); }
    // Lo que se guarda solo un momento después (el lienzo guarda 900 ms después del último cambio) sale aquí, no en el clic.
    if (parents.length) { await page.waitForTimeout(1100); await settle(); }
  };
  const start = async () => { await page.evaluate('__audit.startClick()'); reset(); on = true; };
  const stop = async () => { await settle(); on = false; return page.url().startsWith(base) ? await page.evaluate('__audit.endClick()').catch(() => ({ hash: '' })) as any : { hash: '', external: page.url() }; };
  const describe = (fx: any, beforeHash: string) => [
    ev.requests.length ? `peticiones: ${ev.requests.map((r) => `${r.method()} ${new URL(r.url()).pathname}`).join(', ')}` : '',
    fx.hash && fx.hash !== beforeHash ? `navega a ${fx.hash}` : '', fx.external ? `salió a ${fx.external}` : '',
    fx.mutations ? `cambió la página (${fx.mutations})` : '', fx.stateChanged ? 'cambió su estado' : '', fx.focusMoved ? 'movió el foco' : '', fx.scrolled ? 'desplazó la página' : '',
    fx.dialogOpened ? `abrió el diálogo «${fx.dialogTitle}»` : '', fx.clipboard ? 'copió al portapapeles' : '', fx.printed ? 'imprimió' : '',
    ...(fx.opened || []).map((u: string) => `abrió ${u}`), ...ev.popups.map((u) => `ventana ${u}`), ...ev.downloads.map((f) => `descargó ${f}`),
    ev.files ? 'pidió un archivo' : '', ...ev.native.map((m) => `diálogo nativo ${m}`), fx.toast ? `aviso «${fx.toast}»` : '',
  ].filter(Boolean);
  return { page, ev, seenSites, settle, fresh, reach, controls, mark, clickKey, start, stop, describe, collectSites, setOn: (v: boolean) => { on = v; }, reset };
}

export async function crawl(opts: {
  context: BrowserContext; base: string; user: string; routes: string[]; done: Map<string, Outcome>;
  log?: (msg: string) => void; maxChildren?: number;
}) {
  const { context, base, user, routes, done, log = () => {}, maxChildren = 40 } = opts;
  const out: Outcome[] = [];
  const s = await session(context, base, log);
  const { page, ev } = s;

  for (const route of routes) {
    try { await s.fresh(route); } catch (e: any) { log(`  ✗ no abrió ${route}: ${e.message.split('\n')[0]}`); continue; }
    const initial = await s.controls();
    const queue: { c: Control; parents: Control[] }[] = initial.map((c) => ({ c, parents: [] }));
    const known = new Set(initial.map((c) => c.key));
    let children = 0; let dirty = false;
    log(`${user} · ${route}: ${initial.length} controles`);
    while (queue.length) {
      const { c, parents } = queue.shift()!;
      // El mismo control (mismo sitio y nombre) ya se presionó en otra pantalla de este rol: no se repite.
      const doneKey = `${user}|${c.area === 'pagina' || c.area === 'dialogo' ? '' : c.area}|${c.sites[0] || c.href || c.tag}|${c.name}`;
      const record = (verdict: Verdict, extra: Partial<Outcome> = {}) => {
        const o: Outcome = { ...c, user, route, path: parents.map((p) => p.name), parents, verdict, effects: [], requests: [], note: '', final: '', ...extra };
        out.push(o);
        if (!['YA PROBADO', 'NO ENCONTRADO'].includes(verdict)) done.set(doneKey, o);
        if (isProblem(o)) log(`  ${verdict}: «${c.name}» (${c.sites[0] || c.href}) ${o.note}`);
        return o;
      };
      if (done.has(doneKey)) { record('YA PROBADO', { note: `en ${done.get(doneKey)!.route}` }); continue; }
      if (c.disabled) { record('DESHABILITADO'); continue; }
      const skip = SKIP.find(([re]) => re.test(c.name));
      if (skip) { record('OMITIDO', { note: skip[1] }); continue; }
      if (c.role === 'button' && !c.via && c.tag !== 'summary') { record('SIN MANEJADOR', { note: 'el botón no tiene manejador propio, de formulario ni de su contenedor' }); continue; }

      try {
        if (dirty || parents.length) await s.reach(route, parents);
        await page.evaluate('__audit.startNoise()'); await page.waitForTimeout(150);
        if (!(await s.mark(c.key))) { record('NO ENCONTRADO', { note: 'no está al volver a abrir la pantalla' }); dirty = true; continue; }
        const beforeHash = await page.evaluate(() => location.hash);
        const beforePath = new URL(page.url()).pathname;
        await s.start();
        let pressed: boolean | 'unica' = true;
        try { pressed = await s.clickKey(c); } catch (e: any) { s.setOn(false); record('NO SE PUDO PRESIONAR', { note: e.message.split('\n')[0] }); dirty = true; continue; }
        if (!pressed) { s.setOn(false); record('NO ENCONTRADO'); dirty = true; continue; }
        if (pressed === 'unica') { s.setOn(false); record('MISMA PÁGINA', { note: 'la lista no tiene otra opción que elegir' }); continue; }
        const fx = await s.stop();
        const writes = ev.requests.filter((r) => r.method() !== 'GET');
        const requests = ev.requests.map((r) => `${r.method()} ${new URL(r.url()).pathname}`);
        // Un enlace a otra página del servidor recarga el documento: eso ya es su efecto.
        const afterPath = page.url().startsWith(base) ? new URL(page.url()).pathname : '';
        const effects = [...s.describe(fx, beforeHash), afterPath && afterPath !== beforePath ? `abre ${afterPath}` : ''].filter(Boolean);
        // Sin sesión, lo del panel pide entrar: un 401 que termina en #/login es lo esperado.
        if (user === 'publico' && fx.hash === '#/login') ev.status = ev.status.filter((x) => !x.startsWith('401'));
        let verdict: Verdict = 'OK'; let note = '';
        if (ev.pageErrors.length) { verdict = 'ERROR JS'; note = ev.pageErrors.join(' | '); }
        else if (ev.status.some((x) => x.startsWith('5'))) { verdict = 'ERROR API'; note = ev.status.join(', '); }
        else if (ev.status.length && !fx.errors?.length && !fx.toast && !fx.dialogOpened && !fx.mutations) { verdict = 'ERROR SILENCIOSO'; note = `${ev.status.join(', ')} sin mensaje ni cambio en la pantalla`; }
        else if (ev.status.length) { verdict = 'RECHAZADO'; note = `${ev.status.join(', ')}: ${fx.errors?.[0] || fx.toast || (fx.dialogOpened ? `diálogo «${fx.dialogTitle}»` : 'la pantalla cambió')}`; }
        else if (fx.h1 === 'Página no encontrada') verdict = 'PÁGINA NO ENCONTRADA';
        else if (c.href.startsWith('#/') && fx.hash && decodeURI(fx.hash) !== decodeURI(c.href) && decodeURI(beforeHash) !== decodeURI(c.href) && !(c.href === '#/agentes?new=1' && fx.hash === '#/agentes/nuevo') && !(user === 'publico' && fx.hash === '#/login')) { verdict = 'REDIRIGIDO'; note = `${c.href} → ${fx.hash}`; }
        else if (!effects.length && c.href.startsWith('#') && decodeURI(c.href) === decodeURI(beforeHash)) verdict = 'MISMA PÁGINA';
        else if (!effects.length && c.href.startsWith('/') && new URL(c.href, base).pathname === beforePath) verdict = 'MISMA PÁGINA';
        else if (!effects.length && fx.alreadyActive) { verdict = 'MISMA PÁGINA'; note = 'ya estaba elegido'; }
        else if (!effects.length) {
          const expected = EXPECTED_NOOP.find(([name, site]) => name.test(c.name) && site.test(c.sites[0] || ''));
          if (expected) { verdict = 'MISMA PÁGINA'; note = expected[2]; } else verdict = 'SIN EFECTO';
        }
        let dialog = '';
        // Diálogo abierto: lo de adentro (menos aceptar, que va en su pase) se presiona después; Cancelar no debe escribir nada.
        if (fx.dialogOpened) {
          dialog = fx.dialogTitle || '(sin título)';
          if (parents.length === 0 && children < maxChildren) {
            const inside = (await s.controls()).filter((n) => n.area === 'dialogo' && !CANCEL.test(n.name));
            const accept = [...inside].reverse().find((n) => n.tag === 'button');
            for (const n of inside) {
              if (n === accept || known.has(n.key) || children >= maxChildren) continue;
              known.add(n.key); children++;
              queue.push({ c: n, parents: [...parents, c] });
            }
          }
          s.reset(); s.setOn(true);
          const dlg = page.locator('dialog[open]').last();
          const cancel = dlg.getByRole('button', { name: CANCEL }).first();
          if (await cancel.count()) await cancel.click({ timeout: 2000 }).catch(() => {}); else await page.keyboard.press('Escape');
          await s.settle(); s.setOn(false);
          const after = ev.requests.filter((r) => r.method() !== 'GET');
          if (after.length) { verdict = 'CANCELAR ESCRIBIÓ'; note = after.map((r) => `${r.method()} ${new URL(r.url()).pathname}`).join(', '); }
          if (await page.locator('dialog[open]').count()) note += ' (el diálogo no se cerró con Cancelar ni Escape)';
        }
        record(verdict, { effects, requests, note, final: fx.hash || fx.external || '', dialog });
        // Lo que apareció al presionarlo (sin navegar ni escribir) se presiona también, un nivel más abajo.
        const stayed = fx.hash === beforeHash && !writes.length && !fx.dialogOpened;
        if (stayed && parents.length === 0 && children < maxChildren && page.url().startsWith(base)) {
          for (const n of await s.controls()) {
            if (known.has(n.key) || children >= maxChildren) continue;
            known.add(n.key); children++;
            queue.push({ c: n, parents: [...parents, c] });
          }
        }
        dirty = effects.length > 0 || !page.url().startsWith(base);
        await s.collectSites();
      } catch (e: any) {
        s.setOn(false); dirty = true;
        record('NO SE PUDO PRESIONAR', { note: e.message.split('\n')[0] });
      }
    }
  }
  await page.close();
  return { outcomes: out, seenSites: s.seenSites };
}

/** Qué tanto rompe aceptar un diálogo: lo que borra el agente, un canal o la cuenta va al final. */
export function blastRadius(o: Outcome) {
  const text = `${o.name} ${o.dialog} ${o.route}`;
  if (/eliminar (el )?(agente|perfil|cuenta)|borrar mi cuenta|eliminar$/i.test(o.name) && /^(bot\/|accounts)/.test(o.route)) return 4;
  if (/^accounts|^users/.test(o.route) && /eliminar|desactivar|pausar/i.test(text)) return 3;
  if (/eliminar canal|desconectar|vincular de nuevo|cambiar (de )?número|rotar|regenerar|reiniciar conversaciones/i.test(text)) return 2;
  if (/eliminar|borrar|quitar|cancelar|detener/i.test(text)) return 1;
  return 0;
}

/**
 * Pase de aceptación: vuelve a abrir cada diálogo que encontró el recorrido y lo acepta (escribiendo lo que pide,
 * como el nombre o BORRAR). La acción debe escribir en el servidor y cerrar el diálogo con un aviso o un cambio.
 */
export async function acceptDialogs(opts: { context: BrowserContext; base: string; items: Outcome[]; log?: (msg: string) => void }) {
  const { context, base, items, log = () => {} } = opts;
  const s = await session(context, base, log);
  const { page, ev } = s;
  const out: Outcome[] = [];
  for (const item of [...items].sort((a, b) => blastRadius(a) - blastRadius(b))) {
    const record = (verdict: Verdict, extra: Partial<Outcome> = {}) => {
      const o: Outcome = { ...item, verdict, effects: [], requests: [], note: '', final: '', ...extra };
      out.push(o);
      if (isProblem(o)) log(`  ${verdict} al aceptar «${item.dialog}» de «${item.name}» (${item.route}) ${o.note}`);
    };
    try {
      await s.reach(item.route, item.parents);
      if (!(await s.clickKey(item))) { record('NO ENCONTRADO', { note: 'el control ya no está (otra aceptación lo borró)' }); continue; }
      await s.settle();
      const dlg = page.locator('dialog[open]').last();
      if (!(await dlg.count())) { record('NO ENCONTRADO', { note: 'esta vez no abrió el diálogo' }); continue; }
      const text = (await dlg.innerText()).replace(/\s+/g, ' ');
      const buttons = dlg.getByRole('button');
      const names = (await buttons.allInnerTexts()).map((t) => t.trim());
      const acceptName = [...names].reverse().find((n) => n && !CANCEL.test(n));
      if (!acceptName) { record('SOLO INFORMATIVO', { note: `botones: ${names.join(', ')}` }); continue; }
      // Lo que pide escribir para confirmar: «nombre», BORRAR… Si no pide nada, un texto de prueba en lo obligatorio.
      const asked = text.match(/escribe\s+(?:«([^»]+)»|"([^"]+)"|([A-ZÁÉÍÓÚÑ]{3,}))/i);
      for (const input of await dlg.locator('input:visible:not([type=checkbox]):not([type=radio]):not([type=file]), textarea:visible').all()) {
        if (await input.inputValue()) continue;
        const type = await input.getAttribute('type');
        const value = asked ? asked[1] || asked[2] || asked[3] : type === 'number' ? '1' : type === 'date' ? new Date(Date.now() + 86400_000).toISOString().slice(0, 10) : type === 'email' ? 'auditoria@prueba.test' : 'Prueba de la auditoría';
        await input.fill(value).catch(() => {});
      }
      const beforeHash = await page.evaluate(() => location.hash);
      await s.start();
      await dlg.getByRole('button', { name: acceptName, exact: true }).last().click({ timeout: 3000 });
      const fx = await s.stop();
      const writes = ev.requests.filter((r) => r.method() !== 'GET');
      const requests = ev.requests.map((r) => `${r.method()} ${new URL(r.url()).pathname}`);
      const stillOpen = await page.locator('dialog[open]').count();
      const effects = s.describe(fx, beforeHash);
      let verdict: Verdict = 'ACEPTADO'; let note = `«${acceptName}»`;
      if (ev.pageErrors.length) { verdict = 'ERROR JS'; note += `: ${ev.pageErrors.join(' | ')}`; }
      else if (ev.status.some((x) => x.startsWith('5'))) { verdict = 'ERROR API'; note += `: ${ev.status.join(', ')}`; }
      else if (ev.status.length && !fx.errors?.length && !fx.toast) { verdict = 'ERROR SILENCIOSO'; note += `: ${ev.status.join(', ')} sin mensaje`; }
      else if (ev.status.length) { verdict = 'RECHAZADO'; note += `: ${ev.status.join(', ')} · ${fx.errors?.[0] || fx.toast}`; }
      else if (stillOpen && !writes.length) { verdict = 'NO SE ACEPTÓ'; note += ` (el diálogo sigue abierto${fx.errors?.length ? `: ${fx.errors[0]}` : ''})`; }
      // Lo escrito para confirmar no le sirvió (p. ej. «Límites» pide mensajes=1000) y lo dijo: es una validación.
      else if (!writes.length && (fx.toast || fx.errors?.length)) { verdict = 'RECHAZADO'; note += `: ${fx.toast || fx.errors[0]}`; }
      else if (!writes.length && !fx.opened?.length && !ev.downloads.length && fx.hash === beforeHash && !fx.mutations) { verdict = 'ACEPTAR SIN EFECTO'; note += ' no envió nada al servidor ni cambió la página'; }
      const expected = (verdict === 'ACEPTAR SIN EFECTO' || verdict === 'NO SE ACEPTÓ') && EXPECTED_ACCEPT_NOOP.find(([title, site]) => title.test(item.dialog || '') && site.test(item.sites[0] || ''));
      if (expected) { verdict = 'SOLO INFORMATIVO'; note = `«${acceptName}»: ${expected[2]}`; if (stillOpen) await page.keyboard.press('Escape').catch(() => {}); }
      record(verdict, { effects, requests, note, final: fx.hash || '' });
    } catch (e: any) {
      s.setOn(false);
      record('NO SE PUDO PRESIONAR', { note: e.message.split('\n')[0] });
    }
  }
  await page.close();
  return out;
}
