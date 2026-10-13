#!/usr/bin/env node
// Prueba de carga de SOLO LECTURA contra un stack de staging. Pega a /health, /health/ready, /health/functional y /metrics.
// No escribe, no envía mensajes y no llama a ningún proveedor: por eso puede correr sin riesgo de efectos reales.
//
// Se niega a correr salvo que se cumplan las tres condiciones:
//   1. BASE_URL apunta a loopback (127.0.0.1, localhost o ::1). Un staging remoto se alcanza con un túnel SSH:
//      ssh -L 3000:127.0.0.1:3000 servidor-staging
//   2. LOAD_TEST_TARGET=staging (confirmación explícita de que el destino es staging, no producción).
//   3. HEALTH_TOKEN definido (para /health/functional y /metrics).
//
// Uso:
//   LOAD_TEST_TARGET=staging HEALTH_TOKEN=... node scripts/load-test.mjs [--duration 30] [--concurrency 10] [--max-p95-ms 1000]
// Sale con código 1 si la tasa de errores supera 1% o el p95 supera --max-p95-ms.

const MAX_DURATION_S = 600;
const MAX_CONCURRENCY = 50;
const MAX_ERROR_RATE = 0.01;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function parseArgs(argv, env) {
  const out = { durationS: 30, concurrency: 10, maxP95Ms: 1000, baseUrl: env.BASE_URL || 'http://127.0.0.1:3000', token: env.HEALTH_TOKEN || '', target: env.LOAD_TEST_TARGET || '' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--duration') {
      out.durationS = Number(value);
      i++;
    } else if (flag === '--concurrency') {
      out.concurrency = Number(value);
      i++;
    } else if (flag === '--max-p95-ms') {
      out.maxP95Ms = Number(value);
      i++;
    } else {
      throw new Error(`Opción desconocida: ${flag}`);
    }
  }
  return out;
}

/** Devuelve el motivo por el que no se puede correr, o null si se puede. No hace ninguna petición. */
export function refusal(opts) {
  let host;
  try {
    host = new URL(opts.baseUrl).hostname;
  } catch {
    return 'BASE_URL no es una URL válida';
  }
  if (!LOOPBACK.has(host)) return `BASE_URL apunta a ${host}, que no es loopback. Usa un túnel SSH hacia el staging.`;
  if (opts.target !== 'staging') return 'Falta LOAD_TEST_TARGET=staging: la prueba solo corre contra staging, nunca contra producción.';
  if (!opts.token) return 'Falta HEALTH_TOKEN (para /health/functional y /metrics).';
  if (!(opts.durationS > 0 && opts.durationS <= MAX_DURATION_S)) return `--duration debe estar entre 1 y ${MAX_DURATION_S} segundos.`;
  if (!(opts.concurrency >= 1 && opts.concurrency <= MAX_CONCURRENCY)) return `--concurrency debe estar entre 1 y ${MAX_CONCURRENCY}.`;
  if (!(opts.maxP95Ms > 0)) return '--max-p95-ms debe ser positivo.';
  return null;
}

const ENDPOINTS = [
  { path: '/health', auth: false },
  { path: '/health/ready', auth: false },
  { path: '/health/functional', auth: true },
  { path: '/metrics', auth: true },
];

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)] * 10) / 10;
}

export function summarize(samples, durationS) {
  const byEndpoint = {};
  for (const e of ENDPOINTS) byEndpoint[e.path] = { requests: 0, errors: 0, latencies: [] };
  for (const s of samples) {
    const b = byEndpoint[s.path];
    b.requests++;
    if (s.error || !(s.status >= 200 && s.status < 300)) b.errors++;
    if (!s.error) b.latencies.push(s.ms);
  }
  const all = samples.filter((s) => !s.error).map((s) => s.ms).sort((a, b) => a - b);
  const errors = samples.filter((s) => s.error || !(s.status >= 200 && s.status < 300)).length;
  const endpoints = Object.fromEntries(
    Object.entries(byEndpoint).map(([path, b]) => {
      const sorted = [...b.latencies].sort((x, y) => x - y);
      return [path, { requests: b.requests, errors: b.errors, p50_ms: percentile(sorted, 50), p95_ms: percentile(sorted, 95), p99_ms: percentile(sorted, 99), max_ms: sorted.length ? Math.round(sorted[sorted.length - 1] * 10) / 10 : null }];
    }),
  );
  return {
    duration_s: durationS,
    requests: samples.length,
    requests_per_s: Math.round((samples.length / durationS) * 10) / 10,
    error_rate: samples.length ? Math.round((errors / samples.length) * 10000) / 10000 : 0,
    p50_ms: percentile(all, 50),
    p95_ms: percentile(all, 95),
    p99_ms: percentile(all, 99),
    endpoints,
  };
}

/** Verdicto: falla si la tasa de errores o el p95 general superan los umbrales. */
export function verdict(summary, maxP95Ms) {
  const problems = [];
  if (summary.error_rate > MAX_ERROR_RATE) problems.push(`tasa de errores ${(summary.error_rate * 100).toFixed(2)}% (máximo ${MAX_ERROR_RATE * 100}%)`);
  if (summary.p95_ms !== null && summary.p95_ms > maxP95Ms) problems.push(`p95 ${summary.p95_ms} ms (máximo ${maxP95Ms} ms)`);
  return problems;
}

async function run(opts) {
  const samples = [];
  const end = Date.now() + opts.durationS * 1000;
  let next = 0;
  const worker = async () => {
    while (Date.now() < end) {
      const ep = ENDPOINTS[next++ % ENDPOINTS.length];
      const t0 = performance.now();
      try {
        const res = await fetch(opts.baseUrl.replace(/\/$/, '') + ep.path, {
          method: 'GET',
          headers: ep.auth ? { authorization: `Bearer ${opts.token}` } : {},
          signal: AbortSignal.timeout(5000),
        });
        await res.arrayBuffer(); // se consume el cuerpo para liberar la conexión
        samples.push({ path: ep.path, status: res.status, ms: performance.now() - t0 });
      } catch (e) {
        samples.push({ path: ep.path, status: 0, ms: performance.now() - t0, error: e?.name === 'TimeoutError' ? 'timeout' : String(e?.message ?? e) });
      }
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  const seconds = (performance.now() - started) / 1000;
  return summarize(samples, Math.round(seconds * 10) / 10);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2), process.env);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const motivo = refusal(opts);
  if (motivo) {
    console.error(`No se ejecuta la prueba: ${motivo}`);
    process.exit(2);
  }
  console.error(`Prueba de carga de lectura: ${opts.durationS} s, ${opts.concurrency} conexiones, contra loopback (staging).`);
  const summary = await run(opts);
  console.log(JSON.stringify(summary, null, 2));
  const problems = verdict(summary, opts.maxP95Ms);
  if (problems.length) {
    console.error(`Resultado: NO CUMPLE. ${problems.join('; ')}.`);
    process.exit(1);
  }
  console.error('Resultado: cumple los umbrales.');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
