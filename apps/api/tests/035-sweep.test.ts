import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app, call, closeApp, login } from './helpers.js';
import { prisma } from '../src/db.js';

/**
 * Hivamis task 10 — the sweep. Every GET the API answers, asked by people in every kind of role:
 * a refusal, a "not found" or a validation error is an answer; a 5xx is a bug. Routes with an id are
 * given a real one, taken from the list beside them. The test reads the routes from the server
 * itself, so a route added later is swept too.
 */

interface Route { method: string; url: string }

/** Fastify's route tree, flattened: a child's path is its parent's plus its own segment. */
function routesOf(server: FastifyInstance): Route[] {
  const out: Route[] = [];
  const stack: string[] = [];
  for (const line of server.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = /^((?:│ {3}| {4})*)(?:├── |└── )(.*?)(?: \(([^)]*)\))?$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    const full = (stack[depth - 1] ?? '') + m[2];
    stack[depth] = full;
    for (const method of m[3]?.split(', ') ?? []) out.push({ method, url: full });
  }
  return out;
}

const ROLES = ['admin@hiva.local', 'ceo@hiva.local', 'pmo@hiva.local', 'sales@hiva.local', 'account@hiva.local', 'designer@hiva.local', 'finance@hiva.local', 'legal@hiva.local'];
/** Long-lived streams and the redirect into Google answer by never finishing or by leaving. */
const SKIP = [/\/stream\b/, /\/live\b/, /\/events$/, /\/google\/(start|callback)/, /\/sse\b/, /^\/health/];
/** Rendering a PDF needs a browser; without one the answer is a deliberate 503, not a fault. */
const MAY_BE_UNAVAILABLE = [/\/pdf\//];

describe('The sweep', () => {
  let server: FastifyInstance;
  let tokens: Record<string, string>;
  let routes: Route[];

  beforeAll(async () => {
    server = await app();
    tokens = Object.fromEntries(await Promise.all(ROLES.map(async (r) => [r, await login(r)] as const)));
    routes = routesOf(server).filter((r) => r.method === 'GET' && r.url.startsWith('/api/v1/') && !SKIP.some((s) => s.test(r.url)));
  }, 60_000);
  afterAll(closeApp);

  it('finds the routes', () => {
    expect(routes.length).toBeGreaterThan(150);
    expect(routes.some((r) => r.url === '/api/v1/projects/:id')).toBe(true);
  });

  it('answers every GET, for every role, without a server error', async () => {
    const failures: string[] = [];
    const statuses: Record<number, number> = {};
    const ids = new Map<string, string | null>();
    /** A real id for `/x/:id…`, from the list `/x`, read as the most-permitted reader. */
    const idFor = async (base: string): Promise<string | null> => {
      if (ids.has(base)) return ids.get(base)!;
      const res = await server.inject({ method: 'GET', url: base, headers: { authorization: `Bearer ${tokens['admin@hiva.local']}` } });
      let id: string | null = null;
      try {
        const body = res.json() as unknown;
        const rows = Array.isArray(body) ? body : ((body as { items?: unknown[] })?.items ?? []);
        id = ((rows[0] as { id?: string } | undefined)?.id) ?? null;
      } catch { /* not JSON */ }
      ids.set(base, id);
      return id;
    };

    for (const route of routes) {
      let url = route.url;
      const params = url.match(/:\w+/g) ?? [];
      if (params.length > 1) continue;
      if (params.length === 1) {
        const base = url.slice(0, url.indexOf(params[0]!) - 1);
        const id = await idFor(base);
        url = url.replace(params[0]!, id ?? '00000000-0000-4000-8000-000000000000');
      }
      for (const role of ROLES) {
        const res = await server.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tokens[role]}` } });
        statuses[res.statusCode] = (statuses[res.statusCode] ?? 0) + 1;
        const allowed503 = res.statusCode === 503 && MAY_BE_UNAVAILABLE.some((p) => p.test(url));
        if (res.statusCode >= 500 && !allowed503) failures.push(`${res.statusCode} ${role} GET ${url} — ${res.body.slice(0, 160)}`);
      }
    }
    expect(failures).toEqual([]);
    // Not a sweep of refusals: most answers are answers, and most records were found by a real id.
    const total = Object.values(statuses).reduce((a, b) => a + b, 0);
    expect((statuses[200] ?? 0) / total).toBeGreaterThan(0.5);
    expect([...ids.values()].filter(Boolean).length).toBeGreaterThan(15);
    if (process.env.SWEEP_REPORT) console.log(JSON.stringify({ routes: routes.length, statuses, idsFound: [...ids.values()].filter(Boolean).length, idsMissing: [...ids].filter(([, v]) => !v).map(([k]) => k) }));
  }, 600_000);

  it('spends a refresh token once, even when it is presented twice at the same moment', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'media@hiva.local' } });
    const first = await call('POST', '/auth/login', { payload: { email: 'media@hiva.local', password: 'Hiva@Dev2026!' } });
    const token = first.body.refreshToken as string;
    const before = await prisma.session.count({ where: { userId: user.id } });
    const [a, b] = await Promise.all([1, 2].map(() => call('POST', '/auth/refresh', { payload: { refreshToken: token } })));
    // One rotation wins. Before, both did, and the account gained two sessions from one token.
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(before + 1);
    // The second presentation is the replay it is.
    expect(await prisma.auditEvent.count({ where: { actorId: user.id, action: 'REFRESH_TOKEN_REUSE' } })).toBe(1);
    expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  });
});
