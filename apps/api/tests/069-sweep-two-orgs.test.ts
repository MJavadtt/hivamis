import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app, closeApp } from './helpers.js';
import { fillTenant, routesOf, twoOrgs, type TwoOrgs } from './helpers/two-orgs.js';

/**
 * Audit Phase 6 — the task-10 sweep, in both organisations of the two-organisation fixture. Every GET
 * the API answers, asked in A (provisioned fresh) and in B (the seeded one), by each organisation's
 * full-access user and an ordinary one, with ids taken from that organisation's own lists: a refusal,
 * a "not found" or a validation error is an answer; a 5xx is a bug — in either organisation.
 */

const SKIP = [/\/stream\b/, /\/live\b/, /\/events$/, /\/google\/(start|callback)/, /\/sse\b/, /^\/api\/v1\/health/];
const MAY_BE_UNAVAILABLE = [/\/pdf\//];

describe('The sweep, in both organisations', () => {
  let server: FastifyInstance;
  let orgs: TwoOrgs;
  let routes: { method: string; url: string }[];

  beforeAll(async () => {
    server = await app();
    orgs = await twoOrgs();
    // A, too, holds a row of every kind, so its ids are found as B's are.
    await fillTenant(orgs.a.id);
    routes = routesOf(server).filter((r) => r.method === 'GET' && r.url.startsWith('/api/v1/') && !SKIP.some((s) => s.test(r.url)));
  }, 120_000);
  afterAll(closeApp);

  for (const which of ['a', 'b'] as const) {
    it(`answers every GET in organisation ${which.toUpperCase()}, for its full and ordinary users, without a server error`, async () => {
      const org = orgs[which];
      const failures: string[] = [];
      const statuses: Record<number, number> = {};
      const ids = new Map<string, string | null>();
      const idFor = async (base: string): Promise<string | null> => {
        if (ids.has(base)) return ids.get(base)!;
        const res = await server.inject({ method: 'GET', url: base, headers: { authorization: `Bearer ${org.full.token}` } });
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
          url = url.replace(params[0]!, (await idFor(base)) ?? '00000000-0000-4000-8000-000000000000');
        }
        for (const who of [org.full, org.ordinary]) {
          let res = await server.inject({ method: 'GET', url, headers: { authorization: `Bearer ${who.token}` } });
          if (res.statusCode === 401) res = await server.inject({ method: 'GET', url, headers: { authorization: `Bearer ${await orgs.relogin(who)}` } });
          statuses[res.statusCode] = (statuses[res.statusCode] ?? 0) + 1;
          const allowed503 = res.statusCode === 503 && MAY_BE_UNAVAILABLE.some((p) => p.test(url));
          if (res.statusCode >= 500 && !allowed503) failures.push(`${res.statusCode} ${who.email} GET ${url} — ${res.body.slice(0, 160)}`);
        }
      }
      expect(failures).toEqual([]);
      const total = Object.values(statuses).reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThan(300);
      expect((statuses[200] ?? 0) / total).toBeGreaterThan(0.4);
      expect([...ids.values()].filter(Boolean).length).toBeGreaterThan(10);
      if (process.env.SWEEP_REPORT) console.log(which, JSON.stringify({ routes: routes.length, statuses, idsFound: [...ids.values()].filter(Boolean).length }));
    }, 600_000);
  }
});
