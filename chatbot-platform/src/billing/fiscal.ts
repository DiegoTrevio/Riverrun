/**
 * Datos fiscales del cliente para su CFDI 4.0: RFC (con dígito verificador), régimen según persona física o moral, uso del
 * CFDI permitido para ese régimen y código postal. Sin factura, sus pagos van a la factura global a público en general.
 */
import { z } from 'zod';
import { query, queryOne } from '../db.js';

export type Persona = 'fisica' | 'moral';

/** Catálogo c_RegimenFiscal del SAT: a qué tipo de persona aplica cada régimen. */
export const REGIMES: { code: string; label: string; for: Persona[] }[] = [
  { code: '601', label: 'General de Ley Personas Morales', for: ['moral'] },
  { code: '603', label: 'Personas Morales con Fines no Lucrativos', for: ['moral'] },
  { code: '605', label: 'Sueldos y Salarios e Ingresos Asimilados a Salarios', for: ['fisica'] },
  { code: '606', label: 'Arrendamiento', for: ['fisica'] },
  { code: '607', label: 'Régimen de Enajenación o Adquisición de Bienes', for: ['fisica'] },
  { code: '608', label: 'Demás ingresos', for: ['fisica'] },
  { code: '610', label: 'Residentes en el Extranjero sin Establecimiento Permanente en México', for: ['fisica', 'moral'] },
  { code: '611', label: 'Ingresos por Dividendos (socios y accionistas)', for: ['fisica'] },
  { code: '612', label: 'Personas Físicas con Actividades Empresariales y Profesionales', for: ['fisica'] },
  { code: '614', label: 'Ingresos por intereses', for: ['fisica'] },
  { code: '615', label: 'Régimen de los ingresos por obtención de premios', for: ['fisica'] },
  { code: '616', label: 'Sin obligaciones fiscales', for: ['fisica'] },
  { code: '620', label: 'Sociedades Cooperativas de Producción que optan por diferir sus ingresos', for: ['moral'] },
  { code: '621', label: 'Incorporación Fiscal', for: ['fisica'] },
  { code: '622', label: 'Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras', for: ['moral'] },
  { code: '623', label: 'Opcional para Grupos de Sociedades', for: ['moral'] },
  { code: '624', label: 'Coordinados', for: ['moral'] },
  { code: '625', label: 'Actividades Empresariales con ingresos a través de Plataformas Tecnológicas', for: ['fisica'] },
  { code: '626', label: 'Régimen Simplificado de Confianza (RESICO)', for: ['fisica', 'moral'] },
];

/** Usos del CFDI que aplican a una suscripción de software. «Gastos en general» solo en los regímenes que lo permiten. */
export const USES: { code: string; label: string; regimes: string[] | 'all' }[] = [
  { code: 'G03', label: 'Gastos en general', regimes: ['601', '603', '606', '612', '620', '621', '622', '623', '624', '625', '626'] },
  { code: 'S01', label: 'Sin efectos fiscales', regimes: 'all' },
];
export const usesFor = (regime: string) => USES.filter((u) => u.regimes === 'all' || u.regimes.includes(regime)).map((u) => u.code);

/** RFC genéricos del SAT (público en general y extranjeros): no sirven para una factura a nombre del cliente. */
const GENERIC = new Set(['XAXX010101000', 'XEXX010101000']);
const RFC_RE = /^([A-ZÑ&]{3,4})(\d{2})(\d{2})(\d{2})([A-Z\d]{2})([A\d])$/;
const DV_CHARS = '0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ Ñ';

/** Dígito verificador del RFC (módulo 11 del SAT; a la persona moral se le antepone un espacio). */
export function rfcCheckDigit(rfc: string) {
  const base = (rfc.length === 12 ? ` ${rfc}` : rfc).slice(0, 12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += DV_CHARS.indexOf(base[i]) * (13 - i);
  const d = 11 - (sum % 11);
  return d === 11 ? '0' : d === 10 ? 'A' : String(d);
}

export const personaOf = (rfc: string): Persona => (rfc.length === 12 ? 'moral' : 'fisica');

/** Por qué un RFC no sirve (vacío si sirve). */
export function rfcProblem(raw: string): string {
  const rfc = raw.trim().toUpperCase();
  if (GENERIC.has(rfc)) return 'Ese es el RFC genérico de público en general: para facturar a tu nombre usa tu propio RFC';
  const m = RFC_RE.exec(rfc);
  if (!m || (m[1].length === 3) !== (rfc.length === 12)) return 'El RFC tiene 12 caracteres (empresa) o 13 (persona física)';
  const [mm, dd] = [Number(m[3]), Number(m[4])];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return 'La fecha del RFC no es válida: revisa los 6 números';
  if (rfcCheckDigit(rfc) !== rfc.at(-1)) return 'Ese RFC no es válido: revisa la homoclave (los últimos 3 caracteres)';
  return '';
}

/** Quita el régimen societario de la razón social (CFDI 4.0 la pide tal cual en la constancia, sin «S.A. de C.V.»). */
export function cleanLegalName(name: string) {
  return name.trim().toUpperCase().replace(/\s+/g, ' ')
    .replace(/[,\s]+(S\.?\s?A\.?\s?P\.?\s?I\.?|S\.?\s?A\.?|S\.?\s?DE\s?R\.?\s?L\.?|S\.?\s?C\.?|A\.?\s?C\.?|S\.?\s?A\.?\s?S\.?)(\s+DE\s+C\.?\s?V\.?)?\.?$/, '')
    .trim();
}

export const FiscalSchema = z.object({
  wants_invoice: z.boolean(),
  rfc: z.string().trim().toUpperCase().max(13).default(''),
  legal_name: z.string().max(300).default(''),
  tax_regime: z.string().max(3).default(''),
  zip: z.string().trim().max(5).default(''),
  cfdi_use: z.string().max(4).default(''),
  invoice_email: z.union([z.literal(''), z.string().trim().toLowerCase().email('Correo de facturas no válido').max(200)]).default(''),
}).superRefine((d, ctx) => {
  // Sin factura no se exige nada: lo capturado se conserva por si la pide después.
  if (!d.wants_invoice) return;
  const bad = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  const rfcIssue = rfcProblem(d.rfc);
  if (rfcIssue) bad('rfc', rfcIssue);
  if (!cleanLegalName(d.legal_name)) bad('legal_name', 'Escribe tu nombre o razón social como aparece en tu Constancia de Situación Fiscal');
  const regime = REGIMES.find((r) => r.code === d.tax_regime);
  if (!regime) bad('tax_regime', 'Elige tu régimen fiscal');
  else if (!rfcIssue && !regime.for.includes(personaOf(d.rfc))) bad('tax_regime', personaOf(d.rfc) === 'moral' ? 'Ese régimen es de personas físicas y tu RFC es de empresa' : 'Ese régimen es de empresas y tu RFC es de persona física');
  if (!/^\d{5}$/.test(d.zip)) bad('zip', 'El código postal tiene 5 números (el de tu domicilio fiscal)');
  if (regime && !usesFor(regime.code).includes(d.cfdi_use)) bad('cfdi_use', 'Ese uso del CFDI no aplica a tu régimen');
});
export type FiscalInput = z.infer<typeof FiscalSchema>;

export interface Fiscal extends FiscalInput { account_id: string; updated_at: Date | null }

const EMPTY = { wants_invoice: false, rfc: '', legal_name: '', tax_regime: '', zip: '', cfdi_use: '', invoice_email: '' };

export async function getFiscal(accountId: string): Promise<Fiscal> {
  return (await queryOne<Fiscal>(`SELECT * FROM account_fiscal WHERE account_id = $1`, [accountId])) ?? { ...EMPTY, account_id: accountId, updated_at: null };
}

/** Datos completos y válidos para facturar a nombre del cliente. */
export const fiscalComplete = (f: FiscalInput) => FiscalSchema.safeParse({ ...f, wants_invoice: true }).success;

export async function saveFiscal(accountId: string, userId: string | null, d: FiscalInput) {
  const v = { ...d, legal_name: d.wants_invoice ? cleanLegalName(d.legal_name) : d.legal_name.trim().toUpperCase() };
  await query(
    `INSERT INTO account_fiscal (account_id, wants_invoice, rfc, legal_name, tax_regime, zip, cfdi_use, invoice_email, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (account_id) DO UPDATE SET wants_invoice = $2, rfc = $3, legal_name = $4, tax_regime = $5, zip = $6, cfdi_use = $7,
       invoice_email = $8, updated_by = $9, updated_at = now()`,
    [accountId, v.wants_invoice, v.rfc, v.legal_name, v.tax_regime, v.zip, v.cfdi_use, v.invoice_email, userId],
  );
  return getFiscal(accountId);
}
