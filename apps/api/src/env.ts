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
  MAX_UPLOAD_MB: z.coerce.number().int().default(25),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  AI_MODEL: z.string().default('claude-sonnet-4-5'),
  AI_ENABLED: z.string().transform((v) => v === 'true').default('false'),
  JOBS_ENABLED: z.string().transform((v) => v === 'true').default('true'),
  /** Requests per minute per user/IP across the API. */
  RATE_LIMIT_MAX: z.coerce.number().int().default(300),
  /** Login attempts per minute per IP — deliberately tight to slow credential stuffing. */
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().default(10),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast and loudly — a mis-set secret must never silently fall back to a default.
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
/** AI features require BOTH the flag and a key; either alone leaves the subsystem disabled. */
export const aiEnabled = env.AI_ENABLED && env.ANTHROPIC_API_KEY.length > 0;
