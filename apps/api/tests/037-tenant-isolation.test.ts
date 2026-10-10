import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WORKFLOWS } from '@hiva/contracts';
import { app, closeApp } from './helpers.js';
import { tenancy } from '../src/lib/tenant.js';
import { DOCUMENT_POLICIES } from '../src/pdf/access.js';
import {
  TENANT_MODELS, fingerprints, foreignKeyValues, idsByModel, leaked, ownedIds, routesOf, snapshot,
  tableForSegment, tableOf, twoOrgs, type TwoOrgs,
} from './helpers/two-orgs.js';

/**
 * Audit P0-1: no organisation reaches another's data, through any route.
 *
 * Two organisations share the installation. Everyone in A — the administrator, who holds every
 * permission, and a sales representative — calls every route the server answers, with B's ids
 * wherever a route takes one and B's ids in every foreign key a payload or query string can carry.
 *
 * - No answer may contain anything of B's: a row id, a business code, an email.
 * - No call may change anything of B's: every row B owns is checksummed before and after.
 *
 * The routes come from the server itself and B's rows from Prisma's model description, so a route or
 * a model added later is covered without anyone remembering to.
 */

/** Streams never finish, Google leaves the site, and some calls would end the caller's own session. */
const SKIP = [
  /\/stream\b/, /\/live\b/, /\/events$/, /\/google\/(start|callback)/, /\/sse\b/, /^\/api\/v1\/health/, /^\/health/,
  /\/auth\/(logout|login|refresh|phone|activation|ticket|signup)/, /\/ai\/chat$/,
];
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

/**
 * What the sweep finds today, before Phase 1 of the audit. Each fix removes its line; the lists end
 * empty. The test fails both ways — on a leak not listed, and on a listed one that no longer leaks —
 * so a fix cannot forget to say so, and a regression cannot hide behind the list.
 */
const KNOWN_READ: string[] = [];
const KNOWN_WRITE: string[] = [];
const KNOWN_CHANGED: string[] = [
  'closure_checklists', 'messenger_messages',
];
const keysOf = (lines: string[]) => [...new Set(lines.map((l) => l.split(/ as |\?/)[0]!))].sort();

describe('Tenant isolation (audit P0-1)', () => {
  let server: FastifyInstance;
  let orgs: TwoOrgs & { filled: string[] };
  let fp: Awaited<ReturnType<typeof fingerprints>>;
  let fk: Record<string, string>;
  let concrete: { method: string; route: string; url: string }[];
  let before: Map<string, string>;

  beforeAll(async () => {
    server = await app();
    orgs = await twoOrgs();
    fk = await foreignKeyValues(orgs.b.id);
    const bIds = await idsByModel(orgs.b.id);
    const routes = routesOf(server).filter((r) => r.url.startsWith('/api/v1/') && r.method !== 'HEAD' && r.method !== 'OPTIONS' && !SKIP.some((s) => s.test(r.url)));
    const gets = new Set(routes.filter((r) => r.method === 'GET').map((r) => r.url));

    // B's ids for each parameter, found the way a client would: the list beside the route, read as B.
    const lists = new Map<string, any[]>();
    const listOf = async (path: string): Promise<any[]> => {
      if (!lists.has(path)) {
        let rows: any[] = [];
        if (gets.has(path)) {
          const res = await server.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${orgs.b.full.token}` } });
          try {
            const body = res.json() as any;
            rows = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items
              : (Object.values(body ?? {}).find((x) => Array.isArray(x)) as any[] | undefined) ?? [];
          } catch { /* not JSON */ }
        }
        lists.set(path, rows);
      }
      return lists.get(path)!;
    };
    const valueFor = async (prefix: string, param: string, segment: string, parent: string): Promise<string> => {
      const rows = await listOf(prefix);
      const row = rows.find((r) => r && typeof r === 'object');
      if (row) {
        const v = param === 'id' ? row.id : row[param] ?? (param === 'code' ? row.code : row.id);
        if (typeof v === 'string' && v) return v;
      }
      if (param === 'code') return 'A01_LEAD';
      const table = tableForSegment(segment, parent);
      const model = TENANT_MODELS.find((m) => tableOf(m) === table);
      if (model && bIds.get(model.name)) return bIds.get(model.name)!;
      return fk[param] ?? UNKNOWN;
    };
    /** A parameter that names a kind of thing is tried with every kind. */
    const kindsFor = (param: string, before: string): string[] | null => {
      if (param === 'entity' || param === 'entityType') return Object.keys(WORKFLOWS);
      if (param === 'kind' && before === 'pdf') return Object.keys(DOCUMENT_POLICIES);
      return null;
    };
    /** What a PDF kind is a document of. */
    const PDF_TABLE: Record<string, string> = { 'closure-report': 'project', 'executive-report': 'project', 'qc-review': 'qc-review' };

    concrete = [];
    for (const r of routes) {
      const parts = r.url.split('/');
      let variants: string[][] = [[]];
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]!;
        if (!p.startsWith(':')) { for (const v of variants) v.push(p); continue; }
        const param = p.slice(1);
        const kinds = kindsFor(param, parts[i - 1] ?? '');
        if (kinds) { variants = variants.flatMap((v) => kinds.map((k) => [...v, k])); continue; }
        for (const v of variants) {
          const prefix = v.join('/');
          let segment = v[v.length - 1] ?? '';
          const parent = v[v.length - 2] ?? '';
          if (param === 'action' && WORKFLOWS[v[v.length - 3] ?? '']) {
            v.push(WORKFLOWS[v[v.length - 3]!]!.transitions[0]!.action);
            continue;
          }
          segment = PDF_TABLE[segment] ?? segment;
          v.push(await valueFor(prefix, param, segment, parent));
        }
      }
      for (const v of variants) concrete.push({ method: r.method, route: r.url, url: v.join('/') });
    }
    fp = await fingerprints(orgs.b.id);
    // The import template's hint says «مثلاً PRJ-000002»: an example the app prints, not B's project.
    fp.codes.delete('PRJ-000002');
    before = await snapshot(orgs.b.id);
  }, 300_000);
  afterAll(async () => { tenancy.mode = 'single'; await closeApp(); });

  /** Calls as one of A's users; a token retired mid-sweep (A changing its own roles) is renewed once. */
  const asA = async (who: { email: string; token: string }, method: string, url: string, payload?: unknown, query?: Record<string, string>) => {
    const send = () => server.inject({
      method: method as any, url, query,
      headers: { authorization: `Bearer ${who.token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    });
    let res = await send();
    if (res.statusCode === 401) { await orgs.relogin(who); res = await send(); }
    return res;
  };

  it('gives B one row of every tenant-owned kind, so every route has something of B’s to leak', async () => {
    const owned = await ownedIds(orgs.b.id);
    const empty = TENANT_MODELS
      .filter((m) => m.fields.some((f) => f.name === 'id') && !owned.get(tableOf(m))?.size)
      .map((m) => m.name);
    expect(empty).toEqual([]);
    expect(concrete.length).toBeGreaterThan(300);
    expect(fp.ids.size).toBeGreaterThan(100);
    // Nearly every route that takes an id is given one of B's, not a placeholder that proves nothing.
    // Tokens, secrets and import kinds are not records; every id-like parameter should be one of B's.
    const withIds = concrete.filter((c) => /\/:(\w*id|id)\b/i.test(c.route));
    const placeholders = withIds.filter((c) => c.url.includes(UNKNOWN));
    if (process.env.ISOLATION_TRACE) console.log(`UNRESOLVED ${placeholders.map((c) => `${c.method} ${c.route}`).join('\n')}`);
    expect(placeholders.length / withIds.length).toBeLessThan(0.1);
  });

  it('lets nobody in A read anything of B’s, by any GET, with B’s ids in the path or the query', async () => {
    const leaks: string[] = [];
    for (const c of concrete.filter((x) => x.method === 'GET')) {
      for (const who of [orgs.a.full, orgs.a.ordinary]) {
        const plain = await asA(who, 'GET', c.url);
        const found = leaked(plain.body, fp, c.url);
        if (found.length) leaks.push(`GET ${c.route} as ${who.email} → ${plain.statusCode}: ${found.slice(0, 3).join(', ')}`);
        if (plain.statusCode >= 500 && !/\/pdf\//.test(c.url)) leaks.push(`GET ${c.route} as ${who.email} → ${plain.statusCode}`);
        if (c.url.includes(':') || c.route.includes(':')) continue;
        // A list filtered by B's ids must come back empty, not filtered into B.
        const filtered = await asA(who, 'GET', c.url, undefined, fk);
        const viaQuery = leaked(filtered.body, fp, JSON.stringify(fk));
        if (viaQuery.length) leaks.push(`GET ${c.route}?<B ids> as ${who.email} → ${filtered.statusCode}: ${viaQuery.slice(0, 3).join(', ')}`);
      }
    }
    expect(keysOf(leaks), leaks.join('\n')).toEqual(KNOWN_READ);
  }, 600_000);

  it('lets nobody in A change anything of B’s, by any write, and never answers one with B’s data', async () => {
    const leaks: string[] = [];
    const rich = {
      ...fk, name: 'الف', title: 'الف', fullName: 'الف', legalName: 'الف', description: 'الف', note: 'الف', notes: 'الف',
      reason: 'الف', comment: 'الف', body: 'الف', text: 'الف', content: 'الف', label: 'الف', amount: 1, hours: 1, quantity: 1,
      value: 1, email: 'x@alef.test', phone: '09121234567', date: '2026-10-10', dueDate: '2026-12-01', startDate: '2026-10-10',
      endDate: '2026-12-01', ids: Object.values(fk), userIds: Object.values(fk),
    };
    let traced = before;
    for (const c of concrete.filter((x) => x.method !== 'GET')) {
      const entity = /\/workflow\/(\w+)\//.exec(c.url)?.[1];
      const actions = entity ? [...new Set(WORKFLOWS[entity]!.transitions.map((t) => t.action))] : [];
      const payloads: unknown[] = [{}, rich, ...actions.map((action) => ({ action, reason: 'الف' }))];
      for (const who of [orgs.a.full, orgs.a.ordinary]) {
        for (const payload of payloads) {
          const res = await asA(who, c.method, c.url, c.method === 'DELETE' ? undefined : payload);
          const found = leaked(res.body, fp, c.url + JSON.stringify(payload));
          if (found.length) leaks.push(`${c.method} ${c.route} as ${who.email} → ${res.statusCode}: ${found.slice(0, 3).join(', ')}`);
        }
      }
      // ISOLATION_TRACE=1 names the route behind each change (slow: a snapshot per route).
      if (process.env.ISOLATION_TRACE) {
        const now = await snapshot(orgs.b.id);
        const moved = [...new Set([...traced.keys(), ...now.keys()])].filter((k) => traced.get(k) !== now.get(k));
        if (moved.length) console.log(`TRACE ${c.method} ${c.route}: ${[...new Set(moved.map((k) => k.split('/')[0]))].join(', ')}`);
        traced = now;
      }
    }
    const after = await snapshot(orgs.b.id);
    const changed = [...new Set([...before.keys(), ...after.keys()])]
      .filter((k) => before.get(k) !== after.get(k))
      .map((k) => `${before.has(k) ? (after.has(k) ? 'changed' : 'removed') : 'added'} ${k.split('/')[0]}`);
    // Both at once: a write that leaks and a write that changes B are reported together.
    const tables = [...new Set(changed.map((c) => c.split(' ')[1]!))].sort();
    expect({ leaks: keysOf(leaks), changed: tables }, [...leaks, ...changed].join('\n'))
      .toEqual({ leaks: KNOWN_WRITE, changed: KNOWN_CHANGED });
  }, 900_000);
});
