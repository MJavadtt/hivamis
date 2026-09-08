import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app, call, closeApp, get, login, post, patch, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';
import { findActiveDemoAccounts } from '../src/lib/demo-accounts.js';

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
