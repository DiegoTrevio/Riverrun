/**
 * ¿Los correos van a llegar? Revisa el dominio del remitente (MAIL_FROM): SPF, DKIM y DMARC en el DNS, y, con Resend,
 * si su API dice que el dominio está verificado. Sin secretos en la respuesta: solo lo que el superadmin necesita para
 * poner los registros que faltan.
 */
import { promises as dns } from 'node:dns';
import { config } from './config.js';

export type Txt = (host: string) => Promise<string[][]>;
export interface DnsCheck { id: 'spf' | 'dkim' | 'dmarc'; label: string; host: string; ok: boolean | null; detail: string }
export interface ResendDomain { status: 'verified' | 'pending' | 'failed' | 'not_found' | 'unknown'; detail: string }
export interface MailStatus {
  provider: 'smtp' | 'resend' | '';
  enabled: boolean;
  from: string;
  domain: string;
  /** El remitente es de localhost o no tiene dominio: casi todo irá a spam o será rechazado. */
  bad_from: boolean;
  dns: DnsCheck[];
  resend: ResendDomain | null;
}

/** Dominio de la dirección de MAIL_FROM ("Marca <hola@dominio.mx>" → "dominio.mx"). */
export function fromDomain(from = config.mail.from): string {
  const addr = /<([^>]+)>/.exec(from)?.[1] ?? from;
  return (/@([^@\s>]+)$/.exec(addr.trim())?.[1] ?? '').toLowerCase();
}

const TIMEOUT_MS = 4000;
async function txt(resolve: Txt, host: string): Promise<string[] | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const rows = await Promise.race([
      resolve(host),
      new Promise<never>((_, no) => { timer = setTimeout(() => no(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), TIMEOUT_MS); }),
    ]);
    return rows.map((parts) => parts.join(''));
  } catch (e: any) {
    // Sin registro: lista vacía. Otro error (DNS caído, tiempo): no se sabe.
    return e?.code === 'ENOTFOUND' || e?.code === 'ENODATA' ? [] : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Registros del dominio. Con Resend, los que pide su panel: DKIM en resend._domainkey y SPF en el subdominio send
 * (el «return path»). Con otro SMTP, el SPF va en el dominio y el selector de DKIM depende del proveedor.
 */
export async function dnsChecks(domain: string, provider: MailStatus['provider'], resolve: Txt = dns.resolveTxt): Promise<DnsCheck[]> {
  const resend = provider === 'resend';
  const spfHost = resend ? `send.${domain}` : domain;
  const dkimHost = `resend._domainkey.${domain}`;
  const dmarcHost = `_dmarc.${domain}`;
  const [spf, dkim, dmarc] = await Promise.all([txt(resolve, spfHost), resend ? txt(resolve, dkimHost) : Promise.resolve(null), txt(resolve, dmarcHost)]);
  const spfRec = spf?.find((r) => /^v=spf1\b/i.test(r));
  const sesOk = !!spfRec && /include:amazonses\.com/i.test(spfRec);
  const out: DnsCheck[] = [{
    id: 'spf', label: 'SPF', host: spfHost,
    ok: spf === null ? null : !!spfRec && (!resend || sesOk),
    detail: spf === null ? 'No se pudo consultar el DNS'
      : !spfRec ? `Falta el registro TXT «v=spf1 …»${resend ? ' que da Resend (include:amazonses.com)' : ' de tu proveedor de correo'}`
        : resend && !sesOk ? 'Hay SPF, pero no incluye amazonses.com (el que pide Resend)' : spfRec,
  }];
  if (resend) {
    const key = dkim?.find((r) => /\bp=[A-Za-z0-9+/]/.test(r));
    out.push({ id: 'dkim', label: 'DKIM', host: dkimHost, ok: dkim === null ? null : !!key, detail: dkim === null ? 'No se pudo consultar el DNS' : key ? 'Llave publicada' : 'Falta el registro TXT de DKIM que da Resend' });
  } else {
    out.push({ id: 'dkim', label: 'DKIM', host: `<selector>._domainkey.${domain}`, ok: null, detail: 'El nombre del registro depende de tu proveedor: revisa que lo hayas publicado' });
  }
  const dmarcRec = dmarc?.find((r) => /^v=DMARC1\b/i.test(r));
  out.push({
    id: 'dmarc', label: 'DMARC', host: dmarcHost, ok: dmarc === null ? null : !!dmarcRec,
    detail: dmarc === null ? 'No se pudo consultar el DNS' : dmarcRec ?? 'Falta: Gmail y Yahoo lo piden. Mínimo: «v=DMARC1; p=none;»',
  });
  return out;
}

/** Lo que dice Resend del dominio. Una llave «solo envío» no puede leer dominios: entonces se informa sin saberlo. */
export async function resendDomainStatus(domain: string, key = config.mail.resendApiKey, fetchImpl: typeof fetch = fetch): Promise<ResendDomain> {
  try {
    const res = await fetchImpl('https://api.resend.com/domains', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000) });
    if (res.status === 401 || res.status === 403) {
      return { status: 'unknown', detail: res.status === 401 ? 'Resend rechaza la llave (RESEND_API_KEY)' : 'La llave solo puede enviar: revisa el dominio en resend.com → Domains' };
    }
    if (!res.ok) return { status: 'unknown', detail: `Resend respondió ${res.status}` };
    const body = (await res.json()) as { data?: { name?: string; status?: string }[] };
    const d = body.data?.find((x) => String(x.name).toLowerCase() === domain);
    if (!d) return { status: 'not_found', detail: `El dominio ${domain} no está dado de alta en Resend: agrégalo en resend.com → Domains` };
    if (d.status === 'verified') return { status: 'verified', detail: 'Verificado en Resend' };
    if (d.status === 'failed') return { status: 'failed', detail: 'Resend no encontró los registros: revisa el DNS y vuelve a verificar' };
    return { status: 'pending', detail: 'Resend aún no lo verifica (puede tardar mientras se propaga el DNS)' };
  } catch (e: any) {
    return { status: 'unknown', detail: `No se pudo consultar Resend: ${e?.message ?? e}` };
  }
}

export async function mailStatus(o: { resolve?: Txt; fetchImpl?: typeof fetch } = {}): Promise<MailStatus> {
  const domain = fromDomain();
  const provider = config.mail.provider;
  const bad = !domain || domain === 'localhost' || !domain.includes('.');
  return {
    provider,
    enabled: !!config.mail.smtpUrl,
    from: config.mail.from,
    domain,
    bad_from: bad,
    dns: bad ? [] : await dnsChecks(domain, provider, o.resolve),
    resend: provider === 'resend' && !bad ? await resendDomainStatus(domain, config.mail.resendApiKey, o.fetchImpl) : null,
  };
}
