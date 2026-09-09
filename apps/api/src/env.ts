import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('7d'),
  STORAGE_DIR: z.string().default('./storage'),
  /**
   * Absolute path to the Chromium/Chrome binary the PDF engine drives. Left unset in local
   * development, where the renderer probes the Playwright cache and the usual system paths;
   * set explicitly in the container so resolution never depends on a filesystem probe.
   */
  PDF_BROWSER_PATH: z.string().optional(),
  MAX_UPLOAD_MB: z.coerce.number().int().default(25),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  AI_MODEL: z.string().default('claude-sonnet-4-5'),
  AI_ENABLED: z.string().transform((v) => v === 'true').default('false'),
  JOBS_ENABLED: z.string().transform((v) => v === 'true').default('true'),
  /** Requests per minute per user/IP across the API. */
  RATE_LIMIT_MAX: z.coerce.number().int().default(300),
  /** Login attempts per minute per IP — deliberately tight to slow credential stuffing. */
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().default(10),
  /**
   * Which proxies may set X-Forwarded-For. Defaults to `false` so a misconfigured deployment
   * fails closed: with no trusted proxy, req.ip is the socket address and a forged header
   * cannot move a client between rate-limit buckets.
   *
   *   false              trust nothing (default)
   *   <n>                trust n hops — `1` behind a single reverse proxy
   *   <cidr>[,<cidr>…]   trust these addresses only
   *   true               trust any client-supplied header (unsafe; only behind a proxy that
   *                      strips the header itself)
   */
  TRUST_PROXY: z.string().default('false'),
  /** Simultaneous Chromium renders. Each costs roughly 150MB of RSS while it runs. */
  PDF_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  /** Queue depth as a multiple of PDF_MAX_CONCURRENCY; beyond it, callers get 503 immediately. */
  PDF_QUEUE_FACTOR: z.coerce.number().int().min(1).max(20).default(4),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast and loudly — a mis-set secret must never silently fall back to a default.
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

/**
 * Fastify's `trustProxy` accepts a boolean, an address list, or a predicate. It has no number
 * form in its type, so a hop count is expressed as the predicate it means: trust the first N
 * hops of the forwarding chain and nothing beyond them.
 *
 * Anything unparseable resolves to `false` rather than being guessed at — silently trusting a
 * malformed value is the exact failure this setting exists to prevent.
 */
export function parseTrustProxy(raw: string): boolean | string[] | ((addr: string, hop: number) => boolean) {
  const v = raw.trim();
  if (v === '' || v.toLowerCase() === 'false') return false;
  if (v.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    if (hops === 0) return false;
    return (_address: string, hop: number) => hop < hops;
  }
  const list = v.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : false;
}

export const trustProxy = parseTrustProxy(env.TRUST_PROXY);
/** AI features require BOTH the flag and a key; either alone leaves the subsystem disabled. */
export const aiEnabled = env.AI_ENABLED && env.ANTHROPIC_API_KEY.length > 0;
