import { z } from 'zod';
import { GENERATED_SECRETS, VENDOR_SECRETS, databaseUrlProblem, secretProblem } from './lib/secrets.js';

/**
 * `<number><s|m|h|d>`. Validated here rather than at use: ttlToMs used to fall back to seven
 * days on anything it could not parse, so a typo in ACCESS_TOKEN_TTL silently granted access
 * tokens a 7-day lifetime instead of 15 minutes, with nothing logged.
 */
const ttl = (label: string) =>
  z.string().regex(/^\d+[smhd]$/, `${label} باید به شکل <عدد><s|m|h|d> باشد — مثال: 15m یا 7d`);

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /** Where the web app is served — the base of links sent outside (roadmap #35). Defaults to the first CORS origin. */
  PUBLIC_APP_URL: z.string().default(''),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: ttl('ACCESS_TOKEN_TTL').default('15m'),
  REFRESH_TOKEN_TTL: ttl('REFRESH_TOKEN_TTL').default('7d'),
  STORAGE_DIR: z.string().default('./storage'),
  /**
   * Where the operator installs extensions — modules that add guards and effects to the workflow
   * engine without forking it (roadmap #47). Read once at boot; unset, nothing is loaded. Code
   * here runs with the API's own rights, so it is set on the server, never from the app.
   */
  EXTENSIONS_DIR: z.string().optional(),
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
  /**
   * Semantic memory (roadmap #21). Any OpenAI-shaped /embeddings endpoint — hosted, or a local
   * Ollama / LM Studio / vLLM, which is what an on-prem deployment with no egress will use.
   * Left empty, the system embeds locally and says so on every result.
   */
  EMBEDDING_URL: z.string().default(''),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_API_KEY: z.string().default(''),
  /**
   * Meeting recordings to text (roadmap #23): any OpenAI-shaped /audio/transcriptions endpoint —
   * a hosted service, or a whisper server on the organisation's own network. Empty means the
   * minutes are drafted from typed notes only, and the app says so.
   */
  TRANSCRIPTION_URL: z.string().default(''),
  TRANSCRIPTION_MODEL: z.string().default('whisper-1'),
  TRANSCRIPTION_API_KEY: z.string().default(''),
  /**
   * Roadmap #28: how old an exchange rate may be and still convert a new amount. The rial moves
   * daily; converting today's invoice at last month's rate would book a figure nobody agreed to.
   */
  FX_MAX_RATE_AGE_DAYS: z.coerce.number().int().min(0).max(365).default(7),
  /**
   * Roadmap #46: let webhooks call addresses on the internal network. Off by default — a webhook
   * URL is an admin's input that the server will call, and internal addresses are where SSRF lands.
   * Turn on only for on-premise installations whose receivers live on the same network.
   */
  WEBHOOK_ALLOW_PRIVATE: z.string().transform((v) => v === 'true').default('false'),
  /**
   * Audit SEC-8: production refuses to start while a demo account (@hiva.local) is active. `true`
   * starts it anyway, and says so at fatal on every boot — for the hour it takes to clear them, not
   * as a setting to keep.
   */
  ALLOW_DEMO_ACCOUNTS: z.string().transform((v) => v === 'true').default('false'),
  /**
   * Roadmap #32 — سامانهٔ مؤدیان. `off`: e-invoices are prepared and queued, nothing is sent.
   * `sandbox`: an in-process stand-in (not the tax authority). `live`: the direct API, which needs
   * the taxpayer's registered private key (and certificate) — see docs/operations.md.
   */
  MOADIAN_MODE: z.enum(['off', 'sandbox', 'live']).default('off'),
  /**
   * Contract e-signature (roadmap #36). `sandbox` is an in-process stand-in whose signatures are
   * labelled as such and carry no legal weight; `http` is a provider behind the documented REST
   * contract. Unset: sandbox outside production, off in production.
   */
  ESIGN_MODE: z.enum(['off', 'sandbox', 'http']).optional(),
  ESIGN_URL: z.string().default(''),
  ESIGN_API_KEY: z.string().default(''),
  ESIGN_WEBHOOK_SECRET: z.string().default(''),
  /**
   * Messenger (roadmap #40). `sandbox` — an in-app stand-in chat; `bale` / `telegram` — a bot on a
   * Telegram-compatible Bot API. Unset: sandbox outside production, off in production.
   */
  MESSENGER_MODE: z.enum(['off', 'sandbox', 'bale', 'telegram']).optional(),
  MESSENGER_BOT_TOKEN: z.string().default(''),
  /** The Bot API base; defaults to the provider's own (https://tapi.bale.ai, https://api.telegram.org). */
  MESSENGER_API_URL: z.string().default(''),
  MESSENGER_BOT_USERNAME: z.string().default(''),
  MESSENGER_WEBHOOK_SECRET: z.string().default(''),
  MOADIAN_URL: z.string().default('https://tp.tax.gov.ir/requestsmanager/api/v2/'),
  MOADIAN_PRIVATE_KEY_PATH: z.string().default(''),
  MOADIAN_CERTIFICATE_PATH: z.string().default(''),
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

  // Outbound mail. Several Doc_H SLAs are four working hours; a warning that only exists inside
  // an app the owner may not have open is not a warning.
  MAIL_ENABLED: z.string().transform((v) => v === 'true').default('false'),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: z.string().transform((v) => v === 'true').default('false'),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_FROM: z.string().default(''),

  /**
   * Web Push (roadmap #49). The VAPID pair names this server to the browsers' push services; left
   * empty, the installation makes one and keeps it in `server_keys`. Changing it later silences
   * every phone until its owner opens the app again, so a production installation sets it once.
   * VAPID_SUBJECT is a mailto: or https: contact the push services may use (Apple requires one).
   */
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default(''),
  /**
   * The push services a subscription may point at — host names, each matching itself and its
   * subdomains. A subscription's endpoint is an address the server will POST to, so it is held to
   * the browsers' own services rather than trusted: anything else is where SSRF would land.
   */
  PUSH_SERVICE_HOSTS: z.string().default('fcm.googleapis.com,android.googleapis.com,push.services.mozilla.com,web.push.apple.com,notify.windows.com'),
  /**
   * `on` sends each push as it is made and retries what failed; `off` records them and sends
   * nothing — for an installation with no route to the browsers' push services, and for tests.
   */
  PUSH_DELIVERY: z.enum(['on', 'off']).default('on'),
  /**
   * SMS for one-time codes (Hivamis task 4). `sandbox` keeps messages in the database for the outbox;
   * `kavenegar` uses Kavenegar's verify/lookup with SMS_TEMPLATE; `http` POSTs { to, text } to SMS_URL
   * with SMS_API_KEY as a bearer. Unset: sandbox in development with one organisation; off in production
   * or with several, where signing in by mobile is then not offered — and an explicit sandbox is refused
   * at start (audit SEC-6).
   */
  SMS_MODE: z.enum(['off', 'sandbox', 'kavenegar', 'http']).optional(),
  SMS_API_KEY: z.string().default(''),
  SMS_TEMPLATE: z.string().default(''),
  SMS_URL: z.string().default(''),
  /**
   * Google sign-in (OpenID Connect). Off until a client id and secret are set; the redirect URI to
   * register is PUBLIC_APP_URL + /api/v1/auth/google/callback. GOOGLE_ALLOWED_DOMAINS (comma list)
   * limits who may ask to join with Google to those email domains.
   */
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_ALLOWED_DOMAINS: z.string().default(''),
  GOOGLE_AUTH_URL: z.string().default('https://accounts.google.com/o/oauth2/v2/auth'),
  GOOGLE_TOKEN_URL: z.string().default('https://oauth2.googleapis.com/token'),
  GOOGLE_JWKS_URL: z.string().default('https://www.googleapis.com/oauth2/v3/certs'),
  GOOGLE_ISSUER: z.string().default('https://accounts.google.com'),
  /**
   * The chat assistant (Hivamis task 5): a local model served by Ollama — free, on the organisation's
   * own machine, no per-message cost. `off` hides it. CHAT_CONCURRENCY is how many answers the model
   * writes at once; the rest wait their turn (a laptop-class machine manages one).
   */
  CHAT_MODE: z.enum(['off', 'ollama']).default('ollama'),
  OLLAMA_URL: z.string().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().default('qwen3:14b'),
  CHAT_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  /** The guide's videos (Hivamis task 8): a screen recording is larger than a document, so it has its own limit. */
  GUIDE_VIDEO_MAX_MB: z.coerce.number().int().min(1).max(2048).default(200),
  /**
   * Roadmap #50. On start, bring every organisation's reference data — roles, units, SLA policies,
   * the form catalogue — up to this version of the code. `off` leaves it to `cli reference:sync`.
   */
  REFERENCE_SYNC: z.enum(['on', 'off']).default('on'),
  /**
   * `single`: one organisation, as before. `multi`: several on one installation; a request that
   * names no signed-in user (sign-in, asking to join, Google) finds its organisation by host name.
   */
  TENANT_MODE: z.enum(['single', 'multi']).default('single'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast and loudly — a mis-set secret must never silently fall back to a default.
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// Audit SEC-7: a placeholder or a hand-typed secret stops the API, with the command that makes a real one.
const weak = [...GENERATED_SECRETS, ...VENDOR_SECRETS]
  .map((name) => secretProblem(name, (parsed.data as Record<string, unknown>)[name] as string | undefined))
  .concat(databaseUrlProblem(parsed.data.DATABASE_URL))
  .filter((p): p is string => p !== null);
if (weak.length) {
  console.error('Invalid environment configuration:');
  for (const p of weak) console.error(`  ${p}`);
  process.exit(1);
}

// Audit SEC-6: the sandbox keeps every code where an administrator can read it — a stand-in on a
// developer's machine, never where people sign in for real, nor where several organisations share it.
if (parsed.data.SMS_MODE === 'sandbox' && (parsed.data.NODE_ENV === 'production' || parsed.data.TENANT_MODE === 'multi')) {
  console.error('Invalid environment configuration:');
  console.error('  SMS_MODE=sandbox keeps every sign-in code where an administrator can read it; it is refused with ' +
    'NODE_ENV=production or TENANT_MODE=multi — set SMS_MODE to kavenegar, http or off');
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

/**
 * Same contract as aiEnabled: the flag alone is not enough, the settings it needs must be
 * present too. With it off, every notification still lands in-app and nothing throws.
 */
export const mailEnabled =
  env.MAIL_ENABLED && env.SMTP_HOST.length > 0 && env.SMTP_FROM.length > 0;

/** How one-time codes travel; `off` means no signing in or joining by mobile. The sandbox is a development default only. */
export const smsMode: 'off' | 'sandbox' | 'kavenegar' | 'http' =
  env.SMS_MODE ?? (env.NODE_ENV === 'production' || env.TENANT_MODE === 'multi' ? 'off' : 'sandbox');

/** Google sign-in needs both halves of its client credentials. */
export const googleEnabled = env.GOOGLE_CLIENT_ID.length > 0 && env.GOOGLE_CLIENT_SECRET.length > 0;
