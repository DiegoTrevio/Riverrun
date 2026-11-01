/**
 * Facturapi (PAC): timbra los CFDI 4.0, los busca por nuestra referencia y entrega el PDF y el XML. Tu CSD, régimen y
 * serie se configuran en tu organización de Facturapi; aquí solo va la clave secreta.
 */
import { config } from '../config.js';
import { credentialAllowed } from '../outbound-guard.js';
import { ProviderError } from './types.js';

const cfg = () => config.billing.cfdi;
/** Claves de pruebas de Facturapi: timbran sin validez ante el SAT. Las de producción empiezan por sk_live_. */
const TEST_KEYS = ['sk_test_'];

export interface CfdiReceiver {
  rfc: string;
  legal_name: string;
  tax_regime: string;
  zip: string;
  cfdi_use: string;
  email: string;
}

export interface CfdiLine {
  description: string;
  /** Importe con IVA incluido, en centavos. */
  cents: number;
}

export interface CfdiDocument {
  /** Nuestra referencia (id de la fila): con ella se busca antes de reintentar, para no timbrar dos veces. */
  externalId: string;
  type: 'I' | 'E';
  receiver: CfdiReceiver;
  lines: CfdiLine[];
  paymentForm: string;
  taxPercent: number;
  /** Nota de crédito: UUID del CFDI que corrige. */
  relatedUuid?: string;
  /** Factura global a público en general. */
  global?: { months: string; year: number };
  /** Pago en otra moneda: su moneda y el tipo de cambio (pesos por unidad) (PAY-9). En pesos, sin esto. */
  currency?: string;
  exchangeRate?: number;
}

export interface IssuedCfdi {
  id: string;
  uuid: string;
  series: string;
  folio: string;
}

export interface InvoiceProvider {
  enabled(): boolean;
  issue(doc: CfdiDocument): Promise<IssuedCfdi>;
  findByExternal(externalId: string): Promise<IssuedCfdi | null>;
  download(id: string, format: 'pdf' | 'xml'): Promise<Buffer>;
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown, raw = false): Promise<any> {
  if (!credentialAllowed(cfg().apiKey, TEST_KEYS)) throw new ProviderError('Facturapi: en este entorno (OUTBOUND_MODE=sandbox) solo se usan claves de prueba');
  const res = await fetch(cfg().apiUrl + path, {
    method,
    headers: { authorization: `Bearer ${cfg().apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => {
    throw new ProviderError(e?.name === 'TimeoutError' ? 'Facturapi no respondió a tiempo' : 'No se pudo conectar con Facturapi');
  });
  if (raw && res.ok) return Buffer.from(await res.arrayBuffer());
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(`Facturapi: ${data?.message ?? `HTTP ${res.status}`}`, res.status);
  return data;
}

const issued = (d: any): IssuedCfdi => ({ id: String(d.id), uuid: String(d.uuid ?? ''), series: String(d.series ?? ''), folio: d.folio_number == null ? '' : String(d.folio_number) });

/** Cuerpo de la factura para Facturapi (exportado para las pruebas). */
export function invoiceBody(doc: CfdiDocument) {
  const r = doc.receiver;
  return {
    type: doc.type,
    external_id: doc.externalId,
    customer: { legal_name: r.legal_name, tax_id: r.rfc, tax_system: r.tax_regime, ...(r.email ? { email: r.email } : {}), address: { zip: r.zip } },
    items: doc.lines.map((l) => ({
      quantity: 1,
      product: {
        description: l.description,
        product_key: cfg().productKey,
        unit_key: 'E48',
        // Con IVA incluido: el CFDI suma exactamente lo que se cobró.
        price: l.cents / 100,
        tax_included: true,
        taxes: doc.taxPercent > 0 ? [{ type: 'IVA', rate: doc.taxPercent / 100 }] : [],
      },
    })),
    use: r.cfdi_use,
    payment_form: doc.paymentForm,
    ...(doc.type === 'I' ? { payment_method: 'PUE' } : {}),
    ...(doc.relatedUuid ? { related_documents: [{ relationship: '01', documents: [doc.relatedUuid] }] } : {}),
    ...(doc.global ? { global: { periodicity: 'month', months: doc.global.months, year: doc.global.year } } : {}),
    ...(doc.currency && doc.currency !== 'MXN' ? { currency: doc.currency, exchange: doc.exchangeRate } : {}),
  };
}

export const facturapi: InvoiceProvider = {
  enabled: () => !!cfg().apiKey && credentialAllowed(cfg().apiKey, TEST_KEYS),
  issue: async (doc) => issued(await call('POST', '/invoices', invoiceBody(doc))),
  async findByExternal(externalId) {
    const page = await call('GET', `/invoices?external_id=${encodeURIComponent(externalId)}&limit=10`);
    const hit = (page?.data ?? []).find((d: any) => d?.external_id === externalId && d?.status !== 'canceled');
    return hit ? issued(hit) : null;
  },
  download: (id, format) => call('GET', `/invoices/${encodeURIComponent(id)}/${format}`, undefined, true),
};
