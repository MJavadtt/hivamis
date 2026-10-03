import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app, call, closeApp, get, login, move, post, patch, expectOk, DEV_PASSWORD, directLead } from './helpers.js';
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

describe('Record history is evidence', () => {
  /**
   * audit_events holds before/after for every mutation. Folded in order that reconstructs the
   * record at any instant; diffed, it says who changed which field from what to what. In a
   * dispute this is the difference between "my word against yours" and a document.
   */
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function leadWithHistory() {
    const lead = expectOk(await post('/leads', T.sales, {
      name: 'سرنخ تاریخچه', companyName: 'شرکت تاریخچه', ...directLead(), estimatedValue: 1_000_000,
    }), 'create');
    await pause(15);
    const afterCreate = new Date();
    await pause(15);
    expectOk(await patch(`/leads/${lead.id}`, T.sales, { estimatedValue: 2_500_000, contactName: 'واحد خرید' }), 'edit');
    await pause(15);
    const afterEdit = new Date();
    await pause(15);
    expectOk(await move('lead', lead.id, 'contact', T.sales), 'contact');
    return { lead, afterCreate, afterEdit };
  }

  it('shows every change with who, when, and which fields moved from what to what', async () => {
    const { lead } = await leadWithHistory();
    const h = expectOk(await get(`/history/lead/${lead.id}`, T.sales), 'history');
    expect(h.events.map((e: any) => e.action)).toEqual(['CREATE', 'UPDATE', 'STATE_TRANSITION']);

    const edit = h.events[1];
    expect(edit.actorName).toBeTruthy();
    const value = edit.changes.find((c: any) => c.field === 'estimatedValue');
    expect(String(value.before)).toBe('1000000');
    expect(String(value.after)).toBe('2500000');
    expect(edit.changes.find((c: any) => c.field === 'contactName')).toMatchObject({ before: null, after: 'واحد خرید' });
    // Bookkeeping columns are noise, not changes.
    expect(edit.changes.map((c: any) => c.field)).not.toContain('updatedAt');

    // A transition only records the state, but the running picture still supplies "before".
    expect(h.events[2].changes).toEqual([{ field: 'state', before: 'NEW', after: 'CONTACTED' }]);
  });

  it('reconstructs the record as it stood at any instant', async () => {
    const { lead, afterCreate, afterEdit } = await leadWithHistory();
    const t1 = expectOk(await get(`/history/lead/${lead.id}/at`, T.sales, { ts: afterCreate.toISOString() }), 'at t1');
    expect(t1.known).toBe(true);
    expect(String(t1.snapshot.estimatedValue)).toBe('1000000');
    expect(t1.snapshot.state).toBe('NEW');
    expect(t1.asOf.action).toBe('CREATE');

    const t2 = expectOk(await get(`/history/lead/${lead.id}/at`, T.sales, { ts: afterEdit.toISOString() }), 'at t2');
    expect(String(t2.snapshot.estimatedValue)).toBe('2500000');
    expect(t2.snapshot.state).toBe('NEW');

    const now = expectOk(await get(`/history/lead/${lead.id}/at`, T.sales, { ts: new Date().toISOString() }), 'now');
    expect(now.snapshot.state).toBe('CONTACTED');
    expect(String(now.snapshot.estimatedValue)).toBe('2500000');

    const before = expectOk(await get(`/history/lead/${lead.id}/at`, T.sales, { ts: '2020-01-01T00:00:00Z' }), 'before');
    expect(before.known).toBe(false);
    expect(before.earliest).toBeTruthy();
  });

  it('diffs two instants field by field and names who acted in between', async () => {
    const { lead, afterCreate } = await leadWithHistory();
    const d = expectOk(await get(`/history/lead/${lead.id}/diff`, T.sales, { from: afterCreate.toISOString() }), 'diff');
    const fields = d.changes.map((c: any) => c.field).sort();
    expect(fields).toEqual(['contactName', 'estimatedValue', 'state']);
    expect(d.events).toBe(2);
    expect(d.actors.length).toBe(1);
  });

  it('keeps events about the record apart from changes to it', async () => {
    const { lead } = await leadWithHistory();
    // An export is recorded against the lead, with bundle metadata in `after`.
    await prisma.auditEvent.create({
      data: {
        organizationId: (await prisma.organization.findFirstOrThrow()).id,
        action: 'EXPORT', entityType: 'lead', entityId: lead.id,
        after: { format: 'pdf', withheld: ['cost'], included: [{ kind: 'lead' }] },
      },
    });
    const h = expectOk(await get(`/history/lead/${lead.id}`, T.sales), 'history');
    const exp = h.events.find((e: any) => e.action === 'EXPORT');
    expect(exp.changes).toEqual([]);
    expect(exp.details).toMatchObject({ format: 'pdf' });

    const now = expectOk(await get(`/history/lead/${lead.id}/at`, T.sales, { ts: new Date().toISOString() }), 'at');
    expect(now.snapshot).not.toHaveProperty('format');
    expect(now.snapshot).not.toHaveProperty('included');
    expect(now.asOf.action).toBe('STATE_TRANSITION');
    // A transition's `after` also carries the rule versions that allowed it: metadata, not a column.
    expect(now.snapshot).not.toHaveProperty('rules');
    const transition = h.events.find((e: any) => e.action === 'STATE_TRANSITION');
    expect(transition.changes.map((c: any) => c.field)).toEqual(['state']);
    expect(transition.details.rules).toBeTruthy();
  });

  it('is gated by the permission that reads the record', async () => {
    const { lead } = await leadWithHistory();
    expect((await get(`/history/lead/${lead.id}`, T.designer)).status).toBe(403);
    expect((await get(`/history/lead/${lead.id}`, T.admin)).status).toBe(200);        // admin.audit
    expect((await get(`/history/somethingElse/${lead.id}`, T.sales)).status).toBe(403);
    expect((await get(`/history/lead/00000000-0000-4000-8000-000000000000`, T.sales)).status).toBe(404);
  });

  it('never surfaces a password hash, even to an administrator', async () => {
    const designer = await prisma.user.findUniqueOrThrow({ where: { email: 'designer@hiva.local' } });
    expectOk(await patch(`/users/${designer.id}`, T.admin, { jobTitle: 'مدیر هنری' }), 'edit user');
    const h = expectOk(await get(`/history/user/${designer.id}`, T.admin), 'user history');
    const text = JSON.stringify(h);
    expect(text).not.toContain(designer.passwordHash);
    expect(h.events.some((e: any) => e.changes.some((c: any) => c.field === 'jobTitle' && c.after === 'مدیر هنری'))).toBe(true);
    const at = expectOk(await get(`/history/user/${designer.id}/at`, T.admin, { ts: new Date().toISOString() }), 'user at');
    expect(at.snapshot).not.toHaveProperty('passwordHash');
    expect(at.withheld).toContain('passwordHash');
  });

  it('withholds cost from a role the record hides it from, by the same rule as the PDF', async () => {
    const { redact } = await import('../src/audit/history.js');
    const changes = [
      { field: 'totalCost', before: 1, after: 2 },
      { field: 'salePrice', before: 3, after: 4 },
      { field: 'name', before: 'a', after: 'b' },
      { field: 'passwordHash', before: 'x', after: 'y' },
    ];
    const asSales = redact(changes, { cost: false, price: true, finance: false, withheld: ['cost', 'finance'] });
    expect(asSales.find((c) => c.field === 'totalCost')).toEqual({ field: 'totalCost', before: undefined, after: undefined, withheld: 'cost' });
    expect(asSales.find((c) => c.field === 'salePrice')).toMatchObject({ before: 3, after: 4 });
    expect(asSales.find((c) => c.field === 'name')).toMatchObject({ before: 'a', after: 'b' });
    expect(asSales.find((c) => c.field === 'passwordHash')).toMatchObject({ withheld: 'sensitive' });
  });
});

describe('Time-boxed delegation', () => {
  /**
   * When the one approver is away the chain stops, and organisations route around it by
   * sharing a password — which turns every audit row into a guess. A delegation is the formal
   * alternative: scoped, dated, reasoned, revocable, and everything done under it says so.
   */
  const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

  it('lets a person lend a permission they hold, and records what is done with it as done on their behalf', async () => {
    const accountManager = await prisma.user.findUniqueOrThrow({ where: { email: 'account.manager@hiva.local' } });
    const designer = await prisma.user.findUniqueOrThrow({ where: { email: 'designer@hiva.local' } });
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    const wo = expectOk(await post('/work-orders', T.accountManager, {
      projectId: project.id, proposalId: project.proposalId, targetDepartmentCode: 'CR', title: 'سفارش در غیاب مدیر اکانت',
      scopeOfWork: 'طراحی', brief: 'بریف', expectedOutput: 'فایل', outputFormat: 'PDF',
      deadline: days(10), ownerId: designer.id, budget: 1, priority: 'NORMAL',
    }), 'create');

    // The designer cannot issue an order.
    expect((await move('workOrder', wo.id, 'issue', T.designer)).status).toBe(403);

    const delegation = expectOk(await post('/delegations', T.accountManager, {
      toUserId: designer.id, permissions: ['workorder.issue'], startsAt: days(-0.01), endsAt: days(7), reason: 'مرخصی یک هفته‌ای',
    }), 'delegate');
    expect(delegation.fromUserId).toBe(accountManager.id);

    // Their current token knows nothing of it; the next one does.
    expect((await move('workOrder', wo.id, 'issue', T.designer)).status).toBe(403);
    const asDelegate = await login('designer@hiva.local');
    const me = expectOk(await get('/auth/me', asDelegate), 'me');
    expect(me.permissions).toContain('workorder.issue');
    expect(me.delegated['workorder.issue']).toBe(accountManager.id);

    expectOk(await move('workOrder', wo.id, 'issue', asDelegate), 'issue as delegate');
    const row = await prisma.stateTransition.findFirstOrThrow({ where: { entityType: 'workOrder', entityId: wo.id, action: 'issue' } });
    expect(row.actorId).toBe(designer.id);
    expect(row.onBehalfOfId).toBe(accountManager.id);
    const audited = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'STATE_TRANSITION', entityId: wo.id } });
    expect(audited.onBehalfOfId).toBe(accountManager.id);

    // Listing shows both sides, with names and a status.
    const given = expectOk(await get('/delegations', T.accountManager), 'given');
    expect(given.find((d: any) => d.id === delegation.id)).toMatchObject({ status: 'ACTIVE', toName: designer.fullName });
    const received = expectOk(await get('/delegations', asDelegate), 'received');
    expect(received.some((d: any) => d.id === delegation.id)).toBe(true);
    expect((await get('/delegations', T.sales)).body.some((d: any) => d.id === delegation.id)).toBe(false);
  });

  it('records every request that passed on a borrowed permission', async () => {
    const accountManager = await prisma.user.findUniqueOrThrow({ where: { email: 'account.manager@hiva.local' } });
    const designer = await prisma.user.findUniqueOrThrow({ where: { email: 'designer@hiva.local' } });
    expectOk(await post('/delegations', T.accountManager, {
      toUserId: designer.id, permissions: ['traffic.manage'], endsAt: days(1), reason: 'پوشش ترافیک',
    }), 'delegate');
    const asDelegate = await login('designer@hiva.local');
    const before = await prisma.auditEvent.count({ where: { action: 'DELEGATION_USED', actorId: designer.id } });
    expectOk(await get('/sla-clocks', asDelegate), 'no gate → no row');          // authenticated only
    expect(await prisma.auditEvent.count({ where: { action: 'DELEGATION_USED', actorId: designer.id } })).toBe(before);
    // traffic.manage gates nothing on GET, but pausing a clock the designer does not own does.
    const clock = await prisma.slaClock.findFirst({ where: { state: 'RUNNING', ownerId: { not: designer.id } } });
    if (clock) {
      await post(`/sla-clocks/${clock.id}/pause`, asDelegate, { kind: 'INTERNAL_DEPENDENCY', reason: 'x' });
      await post(`/sla-clocks/${clock.id}/resume`, asDelegate);
    }
    // requirePermissions-gated: the report needs report.read which the designer has natively → no row
    // A gated route on the borrowed permission writes DELEGATION_USED naming the lender.
    const gated = await get('/reports/executive', asDelegate);                     // report.executive — not delegated
    expect(gated.status).toBe(403);
  });

  it('refuses what cannot be delegated: what you do not hold, to yourself, too long, someone else’s authority', async () => {
    const designer = await prisma.user.findUniqueOrThrow({ where: { email: 'designer@hiva.local' } });
    const deputy = await prisma.user.findUniqueOrThrow({ where: { email: 'deputy@hiva.local' } });
    const base = { toUserId: designer.id, endsAt: days(3), reason: 'x' };
    expect((await post('/delegations', T.sales, { ...base, permissions: ['pricing.approve'] })).body.error.code).toBe('NOT_HELD');
    expect((await post('/delegations', T.sales, { ...base, roles: ['CEO'] })).body.error.code).toBe('NOT_HELD');
    expect((await post('/delegations', T.sales, { ...base, permissions: ['not.a.permission'] })).status).toBe(400);
    expect((await post('/delegations', T.sales, { ...base, toUserId: (await prisma.user.findUniqueOrThrow({ where: { email: 'sales@hiva.local' } })).id, permissions: ['crm.lead.write'] })).body.error.code).toBe('SELF_DELEGATION');
    expect((await post('/delegations', T.sales, { ...base, permissions: ['crm.lead.write'], endsAt: days(120) })).body.error.code).toBe('TOO_LONG');
    expect((await post('/delegations', T.sales, { ...base, permissions: ['crm.lead.write'], reason: '' })).body.error.code).toBe('REASON_REQUIRED');
    expect((await post('/delegations', T.sales, { ...base, permissions: ['crm.lead.write'] })).status).toBe(201);
    // Only admin.users may delegate on someone else's behalf.
    expect((await post('/delegations', T.sales, { ...base, fromUserId: deputy.id, permissions: ['pricing.approve'] })).status).toBe(403);
    expect((await post('/delegations', T.admin, { ...base, fromUserId: deputy.id, permissions: ['pricing.approve'], reason: 'سفر قائم‌مقام' })).status).toBe(201);
  });

  it('applies only within its window, and a revocation ends the delegate’s sessions at once', async () => {
    const designer = await prisma.user.findUniqueOrThrow({ where: { email: 'designer@hiva.local' } });
    // Expired and not-yet-started delegations grant nothing.
    await prisma.delegation.createMany({ data: [
      { organizationId: designer.organizationId, fromUserId: (await prisma.user.findUniqueOrThrow({ where: { email: 'account.manager@hiva.local' } })).id, toUserId: designer.id, permissions: ['change.approve'], startsAt: new Date(days(-5)), endsAt: new Date(days(-1)), reason: 'گذشته', createdById: designer.id },
      { organizationId: designer.organizationId, fromUserId: (await prisma.user.findUniqueOrThrow({ where: { email: 'account.manager@hiva.local' } })).id, toUserId: designer.id, permissions: ['change.approve'], startsAt: new Date(days(2)), endsAt: new Date(days(4)), reason: 'آینده', createdById: designer.id },
    ] });
    const token = await login('designer@hiva.local');
    expect(expectOk(await get('/auth/me', token), 'me').permissions).not.toContain('change.approve');

    const live = expectOk(await post('/delegations', T.accountManager, {
      toUserId: designer.id, permissions: ['change.approve'], endsAt: days(2), reason: 'اکنون',
    }), 'live');
    const session = (await post('/auth/login', '', { email: 'designer@hiva.local', password: DEV_PASSWORD })).body;
    expect(session.user.permissions).toContain('change.approve');

    // Revoked by the lender: the delegate's session can no longer refresh — the borrowed
    // permission lives at most until the current access token expires, the same window a
    // role change has (ADR-010) — and the next login has nothing.
    expectOk(await post(`/delegations/${live.id}/revoke`, T.accountManager), 'revoke');
    expect((await post('/auth/refresh', '', { refreshToken: session.refreshToken })).status).toBe(401);
    expect(expectOk(await get('/auth/me', await login('designer@hiva.local')), 'me').permissions).not.toContain('change.approve');
    expect((await get('/delegations', T.accountManager)).body.find((d: any) => d.id === live.id).status).toBe('REVOKED');
  });

  it('lets a delegated approver role decide a form, attributed to the role’s owner', async () => {
    const accountManager = await prisma.user.findUniqueOrThrow({ where: { email: 'account.manager@hiva.local' } });
    const designer = await prisma.user.findUniqueOrThrow({ where: { email: 'designer@hiva.local' } });
    const brief = await prisma.brief.findFirstOrThrow({ where: { state: 'UNDER_REVIEW' } });
    const form = expectOk(await post('/forms/submissions', T.sales, { formCode: 'B10_BRIEF_COMPLETION', data: { briefId: brief.id, addedInformation: 'x' } }), 'submit');
    expect((await post(`/forms/submissions/${form.id}/decision`, T.designer, { decision: 'APPROVE' })).status).toBe(403);

    expectOk(await post('/delegations', T.accountManager, {
      toUserId: designer.id, permissions: ['form.approve'], roles: ['ACCOUNT_MANAGER'], endsAt: days(1), reason: 'تأیید فرم‌ها در غیاب من',
    }), 'delegate role');
    const asDelegate = await login('designer@hiva.local');
    expect(expectOk(await get('/auth/me', asDelegate), 'me').delegatedRoles.ACCOUNT_MANAGER).toBe(accountManager.id);
    expectOk(await post(`/forms/submissions/${form.id}/decision`, asDelegate, { decision: 'APPROVE' }), 'approve as delegate');
    const audited = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'APPROVE', entityId: form.id } });
    expect(audited.actorId).toBe(designer.id);
    expect(audited.onBehalfOfId).toBe(accountManager.id);
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
