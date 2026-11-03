/** IN-7: las conversiones a PDF van por turnos entre cuentas y cada cuenta tiene un tope de conversiones en espera. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { docxToPdf, setPdfConverter, MAX_PENDING_PER_ACCOUNT, PdfQueueFull } = await import('../src/quotes/pdf.js');

test('una cuenta con muchas conversiones no deja esperando a otra; pasada la fila, la sexta se rechaza', async () => {
  const order: string[] = [];
  setPdfConverter(async (docx) => {
    order.push(docx.toString());
    await new Promise((r) => setTimeout(r, 5));
    return Buffer.from('%PDF-1.4\n');
  });
  try {
    const a = Array.from({ length: MAX_PENDING_PER_ACCOUNT }, (_, i) => docxToPdf(Buffer.from(`A${i}`), 'cuenta-a'));
    await assert.rejects(docxToPdf(Buffer.from('A-extra'), 'cuenta-a'), (e: unknown) => e instanceof PdfQueueFull);
    const b = docxToPdf(Buffer.from('B0'), 'cuenta-b');
    await Promise.all([...a, b]);
    // La de la cuenta B entra en el segundo o tercer turno, no al final de las cinco de A.
    assert.ok(order.indexOf('B0') <= 2, order.join(','));
    assert.equal(order.filter((x) => x.startsWith('A')).length, MAX_PENDING_PER_ACCOUNT);
  } finally {
    setPdfConverter(null);
  }
});

test('IN-6: LibreOffice corre sin las variables del backend (llaves, contraseñas, base de datos)', async () => {
  const { sofficeEnv } = await import('../src/quotes/pdf.js');
  process.env.SESSION_SECRET_PRUEBA = 'no-debe-pasar';
  const env = sofficeEnv('/tmp/x');
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'SAL_USE_VCLPLUGIN', 'TMPDIR']);
  assert.ok(!JSON.stringify(env).includes('no-debe-pasar'));
  delete process.env.SESSION_SECRET_PRUEBA;
});
