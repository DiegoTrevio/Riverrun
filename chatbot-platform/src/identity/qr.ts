/** El código QR que se escanea con la app de autenticación, como imagen SVG lista para un <img> (la CSP permite data:). */
import qrcode from 'qrcode-generator';

export function qrDataUri(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
