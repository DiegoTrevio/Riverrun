/**
 * Word → PDF. En producción (docker-compose) con el contenedor `pdf` (Gotenberg): LibreOffice corre aparte, sin los
 * secretos del backend y en una red sin salida a internet (IN-6). Sin él, con LibreOffice en el mismo servidor, con un
 * entorno mínimo (sin las variables del backend), carpeta y perfil temporales que se borran, límite de tiempo y un
 * reintento. En pruebas, un convertidor falso que deja el texto del documento dentro del "PDF".
 *
 * IN-7: una cola por cuenta, atendidas por turnos (una conversión a la vez): una cuenta que manda muchas no deja
 * esperando a las demás, y cada cuenta tiene un tope de conversiones en espera.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { docxText } from './template.js';

const CACHE_SIZE = 20;
const cache = new Map<string, Buffer>();
/** Conversiones en espera por cuenta, como máximo. */
export const MAX_PENDING_PER_ACCOUNT = 5;

export class PdfQueueFull extends Error {
  readonly statusCode = 429;
  constructor() { super('Hay muchas cotizaciones generándose para esta cuenta; intenta en un momento.'); }
}

type Job = { run: () => Promise<void> };
const waiting = new Map<string, Job[]>(); // cuenta → sus conversiones en espera (el orden de las cuentas es el turno)
const pending = new Map<string, number>(); // cuenta → conversiones sin terminar (en espera o en curso)
let busy = false;

function pump() {
  if (busy) return;
  const next = waiting.entries().next();
  if (next.done) return;
  const [account, jobs] = next.value;
  const job = jobs.shift()!;
  // Por turnos: la cuenta que acaba de pasar se va al final de la fila (si le quedan).
  waiting.delete(account);
  if (jobs.length) waiting.set(account, jobs);
  busy = true;
  void job.run().finally(() => { busy = false; pump(); });
}

/** Una a la vez (LibreOffice usa mucha memoria), por turnos entre cuentas. */
function fair<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const n = pending.get(accountId) ?? 0;
  if (n >= MAX_PENDING_PER_ACCOUNT) return Promise.reject(new PdfQueueFull());
  pending.set(accountId, n + 1);
  const done = () => { const left = (pending.get(accountId) ?? 1) - 1; if (left > 0) pending.set(accountId, left); else pending.delete(accountId); };
  const jobs = waiting.get(accountId) ?? [];
  return new Promise<T>((resolve, reject) => {
    jobs.push({ run: () => fn().then((v) => { done(); resolve(v); }, (e) => { done(); reject(e); }) });
    if (!waiting.has(accountId)) waiting.set(accountId, jobs);
    pump();
  });
}

/** IN-6: LibreOffice no hereda las variables del backend (llaves, contraseñas, DATABASE_URL). */
export const sofficeEnv = (home: string) => {
  const { PATH: path_, LANG: lang } = process.env; // del sistema, no de la configuración de la app
  return { PATH: path_ ?? '/usr/local/bin:/usr/bin:/bin', HOME: home, TMPDIR: home, LANG: lang ?? 'C.UTF-8', SAL_USE_VCLPLUGIN: 'svp' };
};

function sofficeConvert(docx: Buffer): Promise<Buffer> {
  return (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cotizacion-'));
    try {
      const input = path.join(dir, 'cotizacion.docx');
      await fs.writeFile(input, docx);
      await new Promise<void>((resolve, reject) => {
        execFile(config.quotes.sofficePath, [
          '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo',
          `-env:UserInstallation=file://${path.join(dir, 'perfil')}`,
          '--convert-to', 'pdf', '--outdir', dir, input,
        ], { timeout: config.quotes.timeoutMs, killSignal: 'SIGKILL', windowsHide: true, env: sofficeEnv(dir) }, (err) => {
          if (err) reject(new Error((err as any).killed ? 'LibreOffice tardó demasiado en generar el PDF' : `LibreOffice no generó el PDF: ${err.message.slice(0, 200)}`));
          else resolve();
        });
      });
      const pdf = await fs.readFile(path.join(dir, 'cotizacion.pdf')).catch(() => null);
      if (!pdf || pdf.subarray(0, 4).toString('latin1') !== '%PDF') throw new Error('LibreOffice no generó el PDF');
      return pdf;
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  })();
}

async function gotenbergConvert(docx: Buffer): Promise<Buffer> {
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(docx)]), 'cotizacion.docx');
  const res = await fetch(`${config.quotes.pdfUrl}/forms/libreoffice/convert`, { method: 'POST', body: form, signal: AbortSignal.timeout(config.quotes.timeoutMs) });
  if (!res.ok) throw new Error(`El servicio de PDF respondió ${res.status}`);
  const pdf = Buffer.from(await res.arrayBuffer());
  if (pdf.subarray(0, 4).toString('latin1') !== '%PDF') throw new Error('El servicio de PDF no devolvió un PDF');
  return pdf;
}

/** Para pruebas: un PDF mínimo con el texto del documento, para poder revisar qué dice. */
function fakeConvert(docx: Buffer): Promise<Buffer> {
  return Promise.resolve(Buffer.from(`%PDF-1.4\n%prueba\n${docxText(docx)}\n%%EOF\n`, 'utf8'));
}

let override: ((docx: Buffer) => Promise<Buffer>) | null = null;
/** Pruebas: reemplaza el convertidor (p. ej. para simular fallas). `null` regresa al configurado. */
export function setPdfConverter(fn: ((docx: Buffer) => Promise<Buffer>) | null) { override = fn; cache.clear(); }

const backend = (): ((docx: Buffer) => Promise<Buffer>) =>
  override ?? (config.quotes.pdfBackend === 'fake' ? fakeConvert : config.quotes.pdfBackend === 'gotenberg' ? gotenbergConvert : sofficeConvert);

/** Convierte un .docx a PDF en la cola de su cuenta; el mismo documento no se convierte dos veces seguidas. */
export async function docxToPdf(docx: Buffer, accountId = ''): Promise<Buffer> {
  const key = crypto.createHash('sha256').update(docx).digest('hex');
  const hit = cache.get(key);
  if (hit) return hit;
  const convert = backend();
  const pdf = await fair(accountId, async () => {
    try { return await convert(docx); } catch { return await convert(docx); }
  });
  cache.set(key, pdf);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return pdf;
}

/** ¿Está instalado LibreOffice? (para la revisión de configuración). */
export function sofficeAvailable(): Promise<boolean> {
  return new Promise((resolve) => execFile(config.quotes.sofficePath, ['--version'], { timeout: 15000 }, (err) => resolve(!err)));
}
