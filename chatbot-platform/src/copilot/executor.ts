/**
 * Ejecutor del Copiloto: cada herramienta llama a una ruta del panel dentro del mismo proceso (`app.inject`) con la
 * sesión de quien la pidió. Así los permisos, la validación, los límites y los efectos son los mismos que en el panel.
 * El modelo nunca elige la URL ni el método: las herramientas arman su ruta con `path` (ids validados).
 */
export type ToolErrorCode = 'datos_invalidos' | 'sin_permiso' | 'no_encontrado' | 'conflicto' | 'limite' | 'error' | 'sesion' | 'no_disponible';

export class ToolError extends Error {
  constructor(public code: ToolErrorCode, message: string, public issues: string[] = [], public status?: number) {
    super(message);
  }
}

export type Inject = (o: {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  payload?: string;
  headers: Record<string, string>;
  remoteAddress?: string;
}) => Promise<{ statusCode: number; body: string }>;

export interface Caller {
  get<T = any>(url: string): Promise<T>;
  send<T = any>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T>;
}

/** Parte de una ruta: solo ids, números y nombres simples (nunca una barra, un `..` ni un `?` del modelo). */
const SAFE = /^[0-9A-Za-z_-]{1,80}$/;

/** Ruta con sus partes validadas: path`/api/contacts/${id}/profile`. */
export function path(strings: TemplateStringsArray, ...values: (string | number)[]): string {
  return strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = String(values[i - 1]);
    if (!SAFE.test(v)) throw new ToolError('datos_invalidos', `Identificador inválido: ${v.slice(0, 40)}`);
    return out + encodeURIComponent(v) + s;
  }, '');
}

/** Cadena de consulta sin valores vacíos. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

const MESSAGES: Record<number, ToolErrorCode> = { 400: 'datos_invalidos', 401: 'sesion', 403: 'sin_permiso', 404: 'no_encontrado', 409: 'conflicto', 410: 'conflicto', 422: 'datos_invalidos', 429: 'limite' };

/** Campos que dicen de qué cuenta es un registro (para el superadmin, que puede ver todas). */
const NESTED = ['contact', 'conversation', 'bot', 'chatbot', 'board', 'quote', 'receivable', 'appointment', 'campaign'];

function accountOf(value: any): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.account_id === 'string') return value.account_id;
  for (const k of NESTED) if (value[k] && typeof value[k] === 'object' && typeof value[k].account_id === 'string') return value[k].account_id;
  return null;
}

/**
 * El superadmin puede leer registros de cualquier cuenta: lo que no sea de la cuenta del hilo se descarta, y si la
 * respuesta entera es de otra cuenta, «no encontrado».
 */
export function keepAccount<T>(value: T, accountId: string): T {
  if (Array.isArray(value)) return value.filter((v) => { const a = accountOf(v); return !a || a === accountId; }) as T;
  const own = accountOf(value);
  if (own && own !== accountId) throw new ToolError('no_encontrado', 'No encontrado');
  if (value && typeof value === 'object' && Array.isArray((value as any).items)) return { ...value, items: keepAccount((value as any).items, accountId) };
  return value;
}

export function makeCaller(o: { inject: Inject; cookie: string; accountId: string; superadmin: boolean; ip?: string; actionId?: string }): Caller {
  const headers: Record<string, string> = { cookie: o.cookie, 'user-agent': 'riverrun-copilot', ...(o.actionId ? { 'x-copilot-action': o.actionId } : {}) };
  // El superadmin trabaja en la cuenta del hilo: cada llamada la lleva en la consulta (y en el cuerpo, donde la leen).
  const scoped = (url: string) => (o.superadmin ? url + (url.includes('?') ? '&' : '?') + `account_id=${encodeURIComponent(o.accountId)}` : url);
  const withAccount = (body: unknown) => (o.superadmin && body && typeof body === 'object' && !Array.isArray(body) && !('account_id' in (body as object)) ? { ...(body as object), account_id: o.accountId } : body);
  async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) {
    if (!url.startsWith('/api/')) throw new ToolError('no_disponible', 'Ruta no permitida');
    const payload = body === undefined ? undefined : JSON.stringify(withAccount(body));
    const res = await o.inject({ method, url: scoped(url), payload, headers: payload === undefined ? headers : { ...headers, 'content-type': 'application/json' }, remoteAddress: o.ip });
    let json: any = null;
    try { json = res.body ? JSON.parse(res.body) : null; } catch { json = null; }
    if (res.statusCode >= 200 && res.statusCode < 300) return json;
    const code = MESSAGES[res.statusCode] ?? 'error';
    const message = typeof json?.error === 'string' ? json.error : code === 'error' ? 'La acción falló en el servidor' : 'No se pudo';
    const issues = Array.isArray(json?.issues) ? json.issues.map(String).slice(0, 8) : [];
    throw new ToolError(code, message, issues, res.statusCode);
  }
  return {
    async get(url) {
      const json = await call('GET', url);
      return o.superadmin ? keepAccount(json, o.accountId) : json;
    },
    async send(method, url, body) {
      return call(method, url, body);
    },
  };
}
