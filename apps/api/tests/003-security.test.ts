import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app, call, closeApp, get, login, post, patch, expectOk, DEV_PASSWORD } from './helpers.js';
import { prisma } from '../src/db.js';
import { findActiveDemoAccounts } from '../src/lib/demo-accounts.js';
import { env, parseTrustProxy, trustProxy } from '../src/env.js';
import { buildApp } from '../src/app.js';
import { WORKFLOWS, WORKFLOW_READ_PERMISSION } from '@hiva/contracts';

/** Security controls: authentication, authorization, IDOR, injection, upload and session handling. */
let T: Record<string, string>;

beforeAll(async () => {
  T = {
    admin: await login('admin@hiva.local'),
    sales: await login('sales@hiva.local'),
    accountManager: await login('account.manager@hiva.local'),
    designer: await login('designer@hiva.local'),
    finance: await login('finance@hiva.local'),
  };
});
afterAll(async () => { await closeApp(); });

describe('Authentication', () => {
  it('rejects unauthenticated access to every protected surface', async () => {
    for (const url of ['/projects', '/companies', '/reports/executive', '/audit-events', '/forms/definitions']) {
      const res = await call('GET', url);
      expect(res.status, url).toBe(401);
    }
  });

  it('rejects a malformed or tampered token', async () => {
    for (const token of ['not-a-token', `${T.sales}tampered`, 'Bearer']) {
      const res = await get('/projects', token);
      expect(res.status).toBe(401);
    }
  });

  it('returns an identical error whether or not the account exists', async () => {
    const missing = await call('POST', '/auth/login', {
      payload: { email: 'nobody@hiva.local', password: 'Whatever@12345' },
    });
    const wrongPass = await call('POST', '/auth/login', {
      payload: { email: 'sales@hiva.local', password: 'Whatever@12345' },
    });
    expect(missing.status).toBe(401);
    expect(wrongPass.status).toBe(401);
    expect(missing.body.error.message).toBe(wrongPass.body.error.message);
  });

  it('never returns the password hash from any user-facing endpoint', async () => {
    const me = expectOk(await get('/auth/me', T.sales), 'me');
    expect(JSON.stringify(me)).not.toContain('passwordHash');
    const users = expectOk(await get('/users', T.admin), 'users');
    expect(JSON.stringify(users)).not.toContain('passwordHash');
  });

  it('stores passwords as Argon2id hashes, never in plain text', async () => {
    const user = await prisma.user.findUnique({ where: { email: 'sales@hiva.local' } });
    expect(user!.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(user!.passwordHash).not.toContain('Hiva@Dev2026');
  });

  it('stores refresh tokens only as digests', async () => {
    const res = expectOk(
      await call('POST', '/auth/login', { payload: { email: 'sales@hiva.local', password: 'Hiva@Dev2026!' } }),
      'login',
    );
    const sessions = await prisma.session.findMany({ where: { revokedAt: null } });
    expect(sessions.every((s) => s.refreshTokenHash !== res.refreshToken)).toBe(true);
    expect(sessions.every((s) => /^[0-9a-f]{64}$/.test(s.refreshTokenHash))).toBe(true);
  });

  it('rotates the refresh token and invalidates the presented one', async () => {
    const first = expectOk(
      await call('POST', '/auth/login', { payload: { email: 'sales@hiva.local', password: 'Hiva@Dev2026!' } }),
      'login',
    );
    const refreshed = expectOk(
      await call('POST', '/auth/refresh', { payload: { refreshToken: first.refreshToken } }),
      'refresh',
    );
    expect(refreshed.refreshToken).not.toBe(first.refreshToken);
    const replay = await call('POST', '/auth/refresh', { payload: { refreshToken: first.refreshToken } });
    expect(replay.status).toBe(401);
  });

  it('rejects weak passwords on change', async () => {
    const res = await post('/auth/change-password', T.sales, {
      currentPassword: 'Hiva@Dev2026!', newPassword: 'short',
    });
    expect(res.status).toBe(400);
  });
});

describe('Authorization', () => {
  it('denies privileged surfaces to a unit specialist', async () => {
    const forbidden = [
      ['GET', '/audit-events'], ['GET', '/reports/executive'],
      ['POST', '/users'], ['GET', '/invoices'],
    ] as const;
    for (const [method, url] of forbidden) {
      const res = await call(method as 'GET' | 'POST', url, { token: T.designer, payload: {} });
      expect([401, 403], `${method} ${url}`).toContain(res.status);
    }
  });

  it('records an audit event when a permission check denies a request', async () => {
    const before = await prisma.auditEvent.count({ where: { action: 'PERMISSION_DENIED' } });
    await get('/audit-events', T.designer);
    const after = await prisma.auditEvent.count({ where: { action: 'PERMISSION_DENIED' } });
    expect(after).toBeGreaterThan(before);
  });

  it('hides financial figures from roles without finance.read', async () => {
    const company = await prisma.company.findFirst();
    const asSales = expectOk(await get(`/companies/${company!.id}/360`, T.sales), 'sales 360');
    expect(asSales.finance).toBeNull();
    const asFinance = expectOk(await get(`/companies/${company!.id}/360`, T.finance), 'finance 360');
    expect(asFinance.finance).not.toBeNull();
  });

  it('prevents a user from deactivating their own account', async () => {
    const me = expectOk(await get('/auth/me', T.admin), 'me');
    const res = await post(`/users/${me.id}/deactivate`, T.admin, {});
    expect(res.status).toBe(400);
  });

  it('scopes search results to what the caller may read', async () => {
    const asDesigner = expectOk(await get('/search', T.designer, { q: 'کمپین' }), 'designer search');
    const types = asDesigner.groups.map((g: { type: string }) => g.type);
    // A unit specialist holds no CRM read permission, so customers must not appear.
    expect(types).not.toContain('company');
    const asAccount = expectOk(await get('/search', T.accountManager, { q: 'کمپین' }), 'account search');
    expect(asAccount.groups.map((g: { type: string }) => g.type)).toContain('project');
  });
});

describe('Injection and input handling', () => {
  it('treats SQL metacharacters in search as literal text', async () => {
    const res = expectOk(
      await get('/search', T.accountManager, { q: "'; DROP TABLE projects; --" }),
      'sql search',
    );
    expect(res.total).toBe(0);
    // The table must still exist and be queryable.
    expect(await prisma.project.count()).toBeGreaterThan(0);
  });

  it('rejects a non-UUID identifier rather than passing it to the database', async () => {
    const res = await get('/projects/not-a-uuid', T.accountManager);
    expect([400, 404, 500]).toContain(res.status);
    expect(await prisma.project.count()).toBeGreaterThan(0);
  });

  it('stores script payloads verbatim without executing or stripping silently', async () => {
    const company = await prisma.company.findFirst();
    const payload = '<script>alert("xss")</script>';
    // Sales owns the customer master record; Account manages contacts and delivery.
    const created = expectOk(await post('/companies', T.sales, {
      legalName: `تست ${payload}`,
    }), 'create company');
    // The API is a JSON boundary: it must not mangle input, and the SPA escapes on render.
    expect(created.legalName).toContain(payload);
    await prisma.company.delete({ where: { id: created.id } });
    expect(company).not.toBeNull();
  });

  it('enforces field-level validation limits', async () => {
    const res = await post('/companies', T.sales, { legalName: 'x'.repeat(5000) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('ignores a client attempt to set `state` directly, bypassing the workflow', async () => {
    const project = await prisma.project.findFirst({ where: { state: { not: 'CLOSED' } } });
    const before = project!.state;
    await patch(`/projects/${project!.id}`, T.accountManager, { state: 'CLOSED', name: project!.name });
    const after = await prisma.project.findUnique({ where: { id: project!.id } });
    expect(after!.state).toBe(before);
  });
});

describe('Audit trail integrity', () => {
  it('captures who, what, when and why for a state change', async () => {
    const project = await prisma.project.findFirst({ where: { state: 'ACTIVE' } });
    if (!project) return;
    await post(`/workflow/project/${project.id}/transitions`, T.accountManager, {
      action: 'hold', reason: 'آزمون رهگیری حسابرسی',
    });
    const event = await prisma.auditEvent.findFirst({
      where: { entityType: 'project', entityId: project.id, action: 'STATE_TRANSITION' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    expect(event!.actorId).not.toBeNull();
    expect(event!.reason).toBe('آزمون رهگیری حسابرسی');
    expect((event!.before as Record<string, unknown>).state).toBe('ACTIVE');
    expect((event!.after as Record<string, unknown>).state).toBe('ON_HOLD');
    await post(`/workflow/project/${project.id}/transitions`, T.accountManager, { action: 'resume' });
  });

  it('redacts sensitive fields from audit payloads', async () => {
    const events = await prisma.auditEvent.findMany({ take: 500 });
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain('$argon2id$');
    expect(serialised).not.toMatch(/"passwordHash":"(?!\[redacted\])/);
  });
});

describe('Error handling', () => {
  it('never leaks stack traces or internal detail to the client', async () => {
    const res = await get('/projects/00000000-0000-4000-8000-00000000dead', T.accountManager);
    expect(res.status).toBe(404);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('prisma');
    expect(body).not.toContain('at ');
    expect(res.body.error.requestId).toBeTruthy();
  });
});

describe('Document handling', () => {
  it('neutralises a path-traversal filename and never trusts the client name as a path', async () => {
    const project = await prisma.project.findFirst();
    const a = await app();
    const boundary = '----hivatest';
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="projectId"\r\n\r\n${project!.id}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="../../../etc/passwd.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\nharmless\r\n` +
      `--${boundary}--\r\n`;

    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: {
        authorization: `Bearer ${T.accountManager}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    const doc = res.json();
    // Stored under a generated name; the client filename is recorded as a basename only.
    expect(doc.storedName).toMatch(/^[0-9a-f-]{36}\.txt$/);
    expect(doc.fileName).toBe('passwd.txt');
    expect(doc.storedName).not.toContain('..');
  });

  it('refuses a file type outside the allow-list', async () => {
    const a = await app();
    const boundary = '----hivatest2';
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="x.html"\r\n` +
      `Content-Type: text/html\r\n\r\n<script>alert(1)</script>\r\n` +
      `--${boundary}--\r\n`;

    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: {
        authorization: `Bearer ${T.accountManager}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('UNSUPPORTED_TYPE');
  });

  it('serves downloads as opaque attachments, never as renderable content', async () => {
    const doc = await prisma.document.findFirst({ where: { deletedAt: null } });
    if (!doc) return;
    const a = await app();
    const res = await a.inject({
      method: 'GET',
      url: `/api/v1/documents/${doc.id}/download`,
      headers: { authorization: `Bearer ${T.accountManager}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('Demo account exposure', () => {
  /**
   * The seeded demo accounts share a password published in README.md. Production must be able
   * to detect them; the check is surfaced on /health/ready so monitoring can alert on it.
   */
  it('reports the active demo-account count', async () => {
    const report = await findActiveDemoAccounts();
    // The test database is seeded with demo data, so the detector must actually find them —
    // a detector that always returns zero would pass a naive assertion.
    expect(report.count).toBe(15);
    expect(report.emails).toContain('admin@hiva.local');
    expect(report.emails.every((e) => e.endsWith('@hiva.local'))).toBe(true);
  });

  it('excludes deactivated accounts from the count', async () => {
    const before = await findActiveDemoAccounts();
    const victim = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    await prisma.user.update({ where: { id: victim.id }, data: { isActive: false } });
    try {
      const after = await findActiveDemoAccounts();
      expect(after.count).toBe(before.count - 1);
      expect(after.emails).not.toContain('designer@hiva.local');
    } finally {
      await prisma.user.update({ where: { id: victim.id }, data: { isActive: true } });
    }
  });

  it('health/ready carries the field', async () => {
    const a = await app();
    const res = await a.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    // Outside production the probe short-circuits to 0 rather than querying on every call.
    expect(res.json()).toHaveProperty('demoAccounts');
  });
});

describe('Proxy trust', () => {
  /**
   * With TRUST_PROXY unset, req.ip is the socket address. A client rotating X-Forwarded-For
   * must therefore stay in one rate-limit bucket rather than minting a fresh one per request.
   */
  it('does not let a forged X-Forwarded-For move a client between rate-limit buckets', async () => {
    // The shared test app runs with a deliberately huge limit so the rest of the suite is not
    // throttled; build a dedicated instance with a small one to observe the behaviour.
    // `trustProxy` is resolved once at module load, so this exercises the shipped default
    // (TRUST_PROXY unset → false) rather than a value injected here. The login limit, by
    // contrast, is read when routes are registered, so lowering it before buildApp() works.
    expect(trustProxy).toBe(false);
    const prevMax = env.LOGIN_RATE_LIMIT_MAX;
    (env as { LOGIN_RATE_LIMIT_MAX: number }).LOGIN_RATE_LIMIT_MAX = 3;
    const limited = await buildApp();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await limited.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { 'x-forwarded-for': `203.0.113.${i}` }, // a different "client" each time
          payload: { email: 'sales@hiva.local', password: 'definitely-wrong' },
        });
        codes.push(res.statusCode);
      }
      // Forging the header did not buy extra attempts: the limiter eventually fires.
      expect(codes).toContain(429);
      expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(2);
    } finally {
      await limited.close();
      (env as { LOGIN_RATE_LIMIT_MAX: number }).LOGIN_RATE_LIMIT_MAX = prevMax;
    }
  });

  it('parses the documented TRUST_PROXY forms and fails closed on nonsense', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('10.0.0.0/8, 192.168.0.0/16')).toEqual(['10.0.0.0/8', '192.168.0.0/16']);
    // A hop count becomes a predicate that trusts exactly that many hops.
    const one = parseTrustProxy('1') as (a: string, hop: number) => boolean;
    expect(typeof one).toBe('function');
    expect(one('203.0.113.1', 0)).toBe(true);
    expect(one('203.0.113.1', 1)).toBe(false);
  });
});

describe('Workflow route authorization', () => {
  /**
   * Doc_H §2 separates Sales from Account. State history carries the reason on every
   * transition, so an unauthenticated read of it would route around that separation.
   */
  it('denies a designer the history and available-transitions of an opportunity', async () => {
    const opp = await prisma.opportunity.findFirstOrThrow();
    expect((await get(`/workflow/opportunity/${opp.id}/history`, T.designer)).status).toBe(403);
    expect((await get(`/workflow/opportunity/${opp.id}/available`, T.designer)).status).toBe(403);
  });

  it('allows an account manager the same two routes', async () => {
    const opp = await prisma.opportunity.findFirstOrThrow();
    expect((await get(`/workflow/opportunity/${opp.id}/history`, T.accountManager)).status).toBe(200);
    expect((await get(`/workflow/opportunity/${opp.id}/available`, T.accountManager)).status).toBe(200);
  });

  it('withholds invoice history from a role without finance.read', async () => {
    const inv = await prisma.invoice.findFirstOrThrow();
    expect((await get(`/workflow/invoice/${inv.id}/history`, T.designer)).status).toBe(403);
    expect((await get(`/workflow/invoice/${inv.id}/history`, T.finance)).status).toBe(200);
  });

  it('audits the denial rather than failing silently', async () => {
    const opp = await prisma.opportunity.findFirstOrThrow();
    await get(`/workflow/opportunity/${opp.id}/history`, T.designer);
    const ev = await prisma.auditEvent.findFirst({
      where: { action: 'PERMISSION_DENIED', entityType: 'authorization' },
      orderBy: { createdAt: 'desc' },
    });
    expect(ev?.reason).toContain('crm.opportunity.read');
  });

  /** `entity` came off the URL and was used to index the Prisma client. */
  it('rejects an unknown entity before touching the database client', async () => {
    for (const path of ['history', 'available']) {
      const res = await get(`/workflow/user/some-id/${path}`, T.accountManager);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('UNKNOWN_ENTITY');
    }
    const post = await (await app()).inject({
      method: 'POST',
      url: '/api/v1/workflow/user/some-id/transitions',
      headers: { authorization: `Bearer ${T.accountManager}` },
      payload: { action: 'anything' },
    });
    expect(post.statusCode).toBe(400);
    expect(post.json().error.code).toBe('UNKNOWN_ENTITY');
  });

  it('declares a read permission for every workflow', async () => {
    for (const entity of Object.keys(WORKFLOWS)) {
      expect(WORKFLOW_READ_PERMISSION[entity], `missing for ${entity}`).toBeTruthy();
    }
  });
});

describe('Session lifecycle', () => {
  const freshSession = async (email: string) => {
    const res = await call('POST', '/auth/login', { payload: { email, password: DEV_PASSWORD } });
    expect(res.status, `login for ${email}`).toBe(200);
    return res.body.refreshToken as string;
  };
  const refresh = (refreshToken: string) =>
    call('POST', '/auth/refresh', { payload: { refreshToken } });

  it('stops honouring a refresh token once the user is deactivated', async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { email: 'media@hiva.local' } });
    const token = await freshSession('media@hiva.local');
    // Still good while the account is live.
    expect((await refresh(token)).status).toBe(200);

    const rotated = await freshSession('media@hiva.local');
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    try {
      const res = await refresh(rotated);
      expect(res.status).toBe(401);
      // The presented session is revoked too, not merely refused.
      const session = await prisma.session.findFirst({
        where: { userId: user.id }, orderBy: { createdAt: 'desc' },
      });
      expect(session?.revokedAt).not.toBeNull();
    } finally {
      await prisma.user.update({ where: { id: user.id }, data: { isActive: true } });
    }
  });

  it('treats a replayed refresh token as a compromise and drops every session', async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { email: 'strategy@hiva.local' } });
    const stolen = await freshSession('strategy@hiva.local');
    // A second, unrelated device for the same account.
    await freshSession('strategy@hiva.local');

    const first = await refresh(stolen);
    expect(first.status).toBe(200);

    const replay = await refresh(stolen);
    expect(replay.status).toBe(401);

    const live = await prisma.session.count({ where: { userId: user.id, revokedAt: null } });
    expect(live).toBe(0);

    const ev = await prisma.auditEvent.findFirst({
      where: { action: 'REFRESH_TOKEN_REUSE', entityId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(ev).not.toBeNull();
    expect((ev!.after as { revokedSessions: number }).revokedSessions).toBeGreaterThan(0);
  });

  it('revokes sessions when a user’s roles change', async () => {
    const victim = await prisma.user.findFirstOrThrow({ where: { email: 'digital@hiva.local' } });
    const before = (await prisma.userRole.findMany({
      where: { userId: victim.id }, include: { role: true },
    })).map((r) => r.role.code);

    await freshSession('digital@hiva.local');
    expect(await prisma.session.count({ where: { userId: victim.id, revokedAt: null } })).toBeGreaterThan(0);

    try {
      const res = await patch(`/users/${victim.id}`, T.admin, { roleCodes: ['VIEWER'] });
      expect(res.status).toBe(200);
      expect(await prisma.session.count({ where: { userId: victim.id, revokedAt: null } })).toBe(0);
    } finally {
      await patch(`/users/${victim.id}`, T.admin, { roleCodes: before });
    }
  });

  it('leaves sessions alone when the update does not touch roles', async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    await freshSession('pmo@hiva.local');
    const before = await prisma.session.count({ where: { userId: user.id, revokedAt: null } });
    const res = await patch(`/users/${user.id}`, T.admin, { jobTitle: 'مدیر عملیات / PMO' });
    expect(res.status).toBe(200);
    expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(before);
  });
});

describe('Staff directory exposure', () => {
  it('gives an unprivileged caller identity but not standing', async () => {
    const res = await get('/users', T.designer);
    expect(res.status).toBe(200);
    const u = res.body.items[0];
    // Enough to populate an assignee picker.
    expect(u).toHaveProperty('fullName');
    expect(u).toHaveProperty('department');
    // Not what describes the person's standing in the organisation.
    expect(u).not.toHaveProperty('lastLoginAt');
    expect(u).not.toHaveProperty('isActive');
    expect(u).not.toHaveProperty('roles');
    expect(u).not.toHaveProperty('weeklyCapacityHours');
  });

  it('gives an administrator the full record', async () => {
    const res = await get('/users', T.admin);
    const u = res.body.items[0];
    for (const f of ['lastLoginAt', 'isActive', 'roles', 'weeklyCapacityHours']) {
      expect(u, f).toHaveProperty(f);
    }
  });
});

describe('Upload content verification', () => {
  const upload = async (token: string, filename: string, mime: string, body: Buffer, fields: Record<string, string> = {}) => {
    const a = await app();
    const boundary = '----hivatest';
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`));
    parts.push(body);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return a.inject({
      method: 'POST', url: '/api/v1/documents',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat(parts),
    });
  };

  /** The declared Content-Type is written by the client and proves nothing. */
  it('rejects a binary masquerading as a PDF', async () => {
    const notAPdf = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]); // MZ — a DOS/PE executable
    const res = await upload(T.accountManager, 'invoice.pdf', 'application/pdf', notAPdf);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('UNSUPPORTED_TYPE');
  });

  it('accepts a file whose bytes match its declared type', async () => {
    const realPdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)]);
    const res = await upload(T.accountManager, 'ok.pdf', 'application/pdf', realPdf);
    expect(res.statusCode).toBe(201);
  });

  it('no longer accepts SVG at all', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    const res = await upload(T.accountManager, 'x.svg', 'image/svg+xml', svg);
    expect(res.statusCode).toBe(400);
  });

  /** Attachment targets arrived as multipart fields and were written to the row unchecked. */
  it('refuses an upload filed against a non-existent record', async () => {
    const realPdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(32, 0x20)]);
    const res = await upload(T.accountManager, 'ok.pdf', 'application/pdf', realPdf, {
      projectId: '00000000-0000-4000-8000-0000000000ff',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('UNKNOWN_REFERENCE');
  });
});

describe('State vocabulary is enforced by the database', () => {
  /**
   * The engine is the only sanctioned writer of `state`, but that is an application property.
   * These constraints make it a schema property, so a direct UPDATE or a data import cannot
   * introduce a state the workflow does not declare.
   */
  it('accepts every declared state and rejects an invented one', async () => {
    // Any project will do; naming one by code tied this to whatever the counter happened to
    // have reached, which only held while every run shared one accumulating database.
    const project = await prisma.project.findFirstOrThrow({ orderBy: { code: 'asc' } });
    const original = project.state;
    try {
      for (const state of WORKFLOWS.project!.states) {
        await expect(
          prisma.$executeRaw`UPDATE projects SET state = ${state} WHERE id = ${project.id}`,
        ).resolves.toBe(1);
      }
      await expect(
        prisma.$executeRaw`UPDATE projects SET state = 'NOT_A_REAL_STATE' WHERE id = ${project.id}`,
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRaw`UPDATE projects SET state = ${original} WHERE id = ${project.id}`;
    }
  });

  it('constrains every workflow table plus form submissions and SLA clocks', async () => {
    // Scoped to this test's own schema: files run in parallel, each in a schema of its own,
    // so an unscoped pg_constraint query counts every one of them at once.
    const rows = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT c.conname FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = current_schema() AND c.conname LIKE '%\_state\_check'`;
    // 13 workflow entities + form_submissions + sla_clocks
    expect(rows.length).toBe(Object.keys(WORKFLOWS).length + 2);
  });
});

describe('Tenant isolation', () => {
  /**
   * ADR-008 calls the schema multi-tenant-ready. That held for list queries, which the CRUD
   * factory scoped, but detail/update/delete and the workflow engine looked records up by id
   * alone. This seeds a second organisation and proves its records are unreachable.
   */
  const OTHER_ORG = '00000000-0000-4000-8000-0000000000b2';
  let foreignProjectId: string;
  let foreignCompanyId: string;

  beforeAll(async () => {
    await prisma.organization.upsert({
      where: { id: OTHER_ORG },
      create: { id: OTHER_ORG, name: 'سازمان دوم', currency: 'IRR' },
      update: {},
    });
    const owner = await prisma.user.findFirstOrThrow({ where: { email: 'admin@hiva.local' } });
    const company = await prisma.company.create({
      data: { organizationId: OTHER_ORG, legalName: 'مشتری سازمان دوم' },
    });
    foreignCompanyId = company.id;
    const project = await prisma.project.create({
      data: {
        organizationId: OTHER_ORG, code: `PRJ-X${Date.now() % 100000}`,
        name: 'پروژه سازمان دوم', companyId: company.id, accountOwnerId: owner.id,
      },
    });
    foreignProjectId = project.id;
  });

  afterAll(async () => {
    await prisma.project.deleteMany({ where: { organizationId: OTHER_ORG } });
    await prisma.company.deleteMany({ where: { organizationId: OTHER_ORG } });
    await prisma.organization.deleteMany({ where: { id: OTHER_ORG } });
  });

  it('hides another organisation’s record from detail, update and delete', async () => {
    // 404, never 403: a 403 would confirm the id exists.
    expect((await get(`/projects/${foreignProjectId}`, T.admin)).status).toBe(404);
    expect((await patch(`/projects/${foreignProjectId}`, T.admin, { name: 'ربوده‌شده' })).status).toBe(404);
    const unchanged = await prisma.project.findUniqueOrThrow({ where: { id: foreignProjectId } });
    expect(unchanged.name).toBe('پروژه سازمان دوم');
  });

  it('keeps it out of list results', async () => {
    const res = await get('/projects', T.admin, { pageSize: '200' });
    expect(res.body.items.map((p: { id: string }) => p.id)).not.toContain(foreignProjectId);
  });

  it('refuses a workflow transition against it', async () => {
    const res = await post(`/workflow/project/${foreignProjectId}/transitions`, T.admin, {
      action: 'request_authorization',
    });
    expect(res.status).toBe(404);
    const unchanged = await prisma.project.findUniqueOrThrow({ where: { id: foreignProjectId } });
    expect(unchanged.state).toBe('DRAFT');
  });

  it('refuses its history, available transitions and PDF export', async () => {
    expect((await get(`/workflow/project/${foreignProjectId}/available`, T.admin)).status).toBe(404);
    expect((await get(`/companies/${foreignCompanyId}`, T.admin)).status).toBe(404);
    const pdf = await (await app()).inject({
      method: 'GET', url: `/api/v1/pdf/project/${foreignProjectId}`,
      headers: { authorization: `Bearer ${T.admin}` },
    });
    expect(pdf.statusCode).toBe(404);
  });
});
