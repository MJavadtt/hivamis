#!/usr/bin/env node
/**
 * Load harness for the endpoints most likely to fall over first.
 *
 *   node bench/run.mjs                       # all targets, 1/10/50 concurrent
 *   node bench/run.mjs --targets=executive   # one target
 *   node bench/run.mjs --connections=10      # one concurrency level
 *   node bench/run.mjs --duration=15
 *
 * Expects the API running in production mode and the load dataset generated:
 *   pnpm --filter @hiva/api exec tsx prisma/generate-load-data.ts
 */
import autocannon from 'autocannon';

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=')[1] : d;
};

const BASE = arg('base', 'http://localhost:4000');
const DURATION = Number(arg('duration', 10));
const LEVELS = arg('connections', '1,10,50').split(',').map(Number);

const TARGETS = {
  // Aggregates the whole portfolio; the CEO's landing page.
  executive: { path: '/api/v1/reports/executive', as: 'ceo@hiva.local' },
  // Returns all 130 form definitions including each one's full field schema.
  forms: { path: '/api/v1/forms/definitions', as: 'account.manager@hiva.local' },
  units: { path: '/api/v1/reports/units', as: 'pmo@hiva.local' },
  dataQuality: { path: '/api/v1/reports/data-quality', as: 'pmo@hiva.local' },
  // The most expensive write-side operation: Chromium, landscape, multi-page.
  pdfExecutive: { path: '/api/v1/pdf/executive-report/all', as: 'ceo@hiva.local' },
};

const wanted = arg('targets', Object.keys(TARGETS).join(',')).split(',');

async function token(email) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: process.env.BENCH_PASSWORD ?? 'Hiva@Dev2026!' }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  return (await res.json()).accessToken;
}

const ms = (n) => `${n.toFixed(0)}ms`.padStart(8);

for (const name of wanted) {
  const target = TARGETS[name];
  if (!target) { console.error(`unknown target: ${name}`); continue; }
  const auth = `Bearer ${await token(target.as)}`;
  console.log(`\n── ${name}  ${target.path}`);
  // autocannon reports p97_5 rather than p95; it is the nearest published percentile.
  console.log('   conn   p50    p97.5      p99      max     req/s   non-2xx');

  for (const connections of LEVELS) {
    const r = await autocannon({
      url: `${BASE}${target.path}`,
      connections,
      duration: DURATION,
      headers: { authorization: auth },
      // PDF rendering is deliberately concurrency-limited; give it room to queue.
      timeout: name.startsWith('pdf') ? 60 : 20,
    });
    const bad = r.non2xx + r.errors;
    console.log(
      `   ${String(connections).padStart(4)} ${ms(r.latency.p50)} ${ms(r.latency.p97_5)} ` +
      `${ms(r.latency.p99)} ${ms(r.latency.max)} ${String(Math.round(r.requests.average)).padStart(8)}` +
      `${String(bad).padStart(10)}${bad ? '  ← FAILURES' : ''}`,
    );
  }
}
