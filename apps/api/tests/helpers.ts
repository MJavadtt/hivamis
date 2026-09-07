import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

export const DEV_PASSWORD = 'Hiva@Dev2026!';

let cached: FastifyInstance | null = null;

export async function app(): Promise<FastifyInstance> {
  if (!cached) {
    cached = await buildApp();
    await cached.ready();
  }
  return cached;
}

export async function closeApp(): Promise<void> {
  await cached?.close();
  cached = null;
  await prisma.$disconnect();
}

export async function login(email: string): Promise<string> {
  const a = await app();
  const res = await a.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: DEV_PASSWORD },
  });
  if (res.statusCode !== 200) {
    throw new Error(`login failed for ${email}: ${res.statusCode} ${res.body}`);
  }
  return res.json().accessToken as string;
}

export interface CallOptions {
  token?: string;
  payload?: unknown;
  query?: Record<string, string>;
}

export async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  opts: CallOptions = {},
) {
  const a = await app();
  const res = await a.inject({
    method,
    url: url.startsWith('/api') ? url : `/api/v1${url}`,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    payload: opts.payload as never,
    query: opts.query,
  });
  let body: any = null;
  try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
  return { status: res.statusCode, body };
}

export const get = (url: string, token: string, query?: Record<string, string>) =>
  call('GET', url, { token, query });
export const post = (url: string, token: string, payload?: unknown) =>
  call('POST', url, { token, payload });
export const patch = (url: string, token: string, payload?: unknown) =>
  call('PATCH', url, { token, payload });

/** Drive an entity through the workflow engine. */
export const move = (entity: string, id: string, action: string, token: string, reason?: string, payload?: Record<string, unknown>) =>
  post(`/workflow/${entity}/${id}/transitions`, token, { action, reason, payload });

/** Assert helper that surfaces the API's Persian error message when a call fails. */
export function expectOk(res: { status: number; body: any }, context: string): any {
  if (res.status >= 400) {
    throw new Error(
      `${context} → HTTP ${res.status}: ${res.body?.error?.message ?? JSON.stringify(res.body)}` +
      (res.body?.error?.details ? `\n  details: ${JSON.stringify(res.body.error.details)}` : ''),
    );
  }
  return res.body;
}
