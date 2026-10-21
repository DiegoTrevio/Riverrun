/**
 * Word → PDF. Por defecto con LibreOffice en el mismo servidor: una conversión a la vez, con carpeta y perfil temporales
 * que se borran, límite de tiempo (se mata si se cuelga) y un reintento. Opcionalmente con un servicio Gotenberg
 * (QUOTE_PDF_URL). En pruebas, un convertidor falso que deja el texto del documento dentro del "PDF".
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
let queue: Promise<unknown> = Promise.resolve();

/** Una a la vez: LibreOffice usa mucha memoria y no conviene abrir varias copias. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

function sofficeConvert(docx: Buffer): Promise<Buffer> {
  return serial(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cotizacion-'));
    try {
      const input = path.join(dir, 'cotizacion.docx');
      await fs.writeFile(input, docx);
      await new Promise<void>((resolve, reject) => {
        execFile(config.quotes.sofficePath, [
          '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo',
          `-env:UserInstallation=file://${path.join(dir, 'perfil')}`,
          '--convert-to', 'pdf', '--outdir', dir, input,
        ], { timeout: config.quotes.timeoutMs, killSignal: 'SIGKILL', windowsHide: true, env: { ...process.env, HOME: dir } }, (err) => {
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
  });
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

/** Convierte un .docx a PDF; el mismo documento no se convierte dos veces seguidas. */
export async function docxToPdf(docx: Buffer): Promise<Buffer> {
  const key = crypto.createHash('sha256').update(docx).digest('hex');
  const hit = cache.get(key);
  if (hit) return hit;
  const convert = backend();
  let pdf: Buffer;
  try { pdf = await convert(docx); } catch { pdf = await convert(docx); }
  cache.set(key, pdf);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return pdf;
}

/** ¿Está instalado LibreOffice? (para la revisión de configuración). */
export function sofficeAvailable(): Promise<boolean> {
  return new Promise((resolve) => execFile(config.quotes.sofficePath, ['--version'], { timeout: 15000 }, (err) => resolve(!err)));
}
