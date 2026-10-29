/**
 * Guardia de red del servidor durante la auditoría: el servidor corre en este mismo proceso, así que toda conexión
 * saliente pasa por net.Socket#connect (fetch, nodemailer, imapflow, pg). Solo se permite la máquina local (la base de
 * pruebas y los servicios simulados del arnés); lo demás se rechaza y se anota para el informe.
 */
import net from 'node:net';

export const blocked: { host: string; port: number; at: string }[] = [];
const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1', '']);

export function installNetworkGuard() {
  const connect = net.Socket.prototype.connect as (...args: any[]) => net.Socket;
  (net.Socket.prototype as any).connect = function (this: net.Socket, ...args: any[]) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const opts = typeof first === 'object' && first !== null ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
    const host = String(opts.host ?? '');
    if (opts.path === undefined && !LOCAL.has(host)) {
      blocked.push({ host, port: Number(opts.port), at: (new Error().stack || '').split('\n').slice(2, 6).map((l) => l.trim()).join(' ← ') });
      process.nextTick(() => this.destroy(Object.assign(new Error(`Conexión bloqueada por la auditoría: ${host}:${opts.port}`), { code: 'ECONNREFUSED' })));
      return this;
    }
    return connect.apply(this, args);
  };
}
