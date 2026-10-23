import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ALL_PERMISSIONS, OVERSIGHT_PERMISSIONS } from '@hiva/contracts';
import { call, closeApp, expectOk, get, login, patch, post, put, refreshWith, signIn } from './helpers.js';
import { prisma } from '../src/db.js';
import { HISTORY_COLUMNS } from '../src/auth/remove-user.js';
import { refusedWhileActing } from '../src/auth/plugin.js';

/**
 * The owner's report (2026-10-23): the system administrator makes people with a user name and a
 * password, gives them roles and controls each one's permissions, removes them, and — above every
 * other role — works in anyone's account: openly, with a reason, the person told, every action
 * recorded under the administrator's own name.
 */
const del = (url: string, token: string, payload?: unknown) => call('DELETE', url, { token, payload });

describe('The administrator’s hand on each account (owner’s report, 2026-10-23)', () => {
  let T: Record<string, string>;
  let id: Record<string, string>;

  beforeAll(async () => {
    T = { admin: await login('admin@hiva.local'), ceo: await login('ceo@hiva.local') };
    const users = await prisma.user.findMany({
      where: { email: { in: ['admin@hiva.local', 'ceo@hiva.local', 'designer@hiva.local', 'sales@hiva.local', 'media@hiva.local'] } },
      select: { id: true, email: true },
    });
    id = Object.fromEntries(users.map((u) => [u.email.split('@')[0]!, u.id]));
  });
  afterAll(closeApp);

  it('gives one person a permission their roles do not, withholds one they do — at once, without signing them out', async () => {
    const session = await signIn('designer@hiva.local');
    const mine = expectOk(await get(`/users/${id.designer}/permissions`, T.admin), 'read');
    const extra = ALL_PERMISSIONS.find((p) => !mine.fromRoles.includes(p) && !OVERSIGHT_PERMISSIONS.includes(p))!;
    const held = mine.fromRoles[0]!;
    expect((await put(`/users/${id.designer}/permissions`, T.ceo.replace(/./, 'x'), { grant: [extra] })).status).toBe(401);
    expectOk(await put(`/users/${id.designer}/permissions`, T.admin, { grant: [extra], deny: [held] }), 'set');

    // The token held before is refused at once; the refresh the app makes carries the change.
    expect((await get('/auth/me', session.access)).status).toBe(401);
    const fresh = await refreshWith(session.refresh);
    expect(fresh.status).toBe(200);
    const me = expectOk(await get('/auth/me', fresh.body.accessToken), 'me');
    expect(me.permissions).toContain(extra);
    expect(me.permissions).not.toContain(held);
    const now = expectOk(await get(`/users/${id.designer}/permissions`, T.admin), 'again');
    expect(now).toMatchObject({ grant: [extra], deny: [held] });
    expect(now.effective).toContain(extra);
    const row = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'PERMISSIONS_SET', entityId: id.designer } });
    expect(row.after).toMatchObject({ grant: [extra], deny: [held] });

    expectOk(await put(`/users/${id.designer}/permissions`, T.admin, { grant: [], deny: [] }), 'reset');
  });

  it('never narrows the system administrator, gives oversight only from one, and keeps their role theirs to give', async () => {
    expect((await put(`/users/${id.admin}/permissions`, T.admin, { deny: ['crm.lead.read'] })).body.error.code).toBe('SYSTEM_ADMIN_UNRESTRICTED');
    expect((await put(`/users/${id.designer}/permissions`, T.ceo, { grant: [OVERSIGHT_PERMISSIONS[0]] })).body.error.code).toBe('OVERSIGHT_GRANTOR_ONLY');
    expect((await put(`/users/${id.designer}/permissions`, T.admin, { grant: ['crm.lead.read'], deny: ['crm.lead.read'] })).body.error.code).toBe('GRANT_AND_DENY');
    // Above the managing director: the system administrator's role and account are a system administrator's.
    expect((await patch(`/users/${id.designer}`, T.ceo, { roleCodes: ['UNIT_MEMBER', 'SUPER_ADMIN'] })).status).toBe(403);
    expect((await patch(`/users/${id.admin}`, T.ceo, { fullName: 'کس دیگر' })).status).toBe(403);
    expect((await post(`/users/${id.admin}/deactivate`, T.ceo)).status).toBe(403);
    // And the organisation keeps one.
    expect((await patch(`/users/${id.admin}`, T.admin, { roleCodes: ['CEO'] })).body.error.code).toBe('LAST_SYSTEM_ADMIN');
  });

  it('makes a person with the administrator’s password, kept if the administrator says; sets another; changes their user name', async () => {
    const made = expectOk(await post('/users', T.admin, {
      email: 'New.Person@example.org', fullName: 'کاربر تازه', password: 'Strong-Pass-2026', departmentCode: 'CR', roleCodes: ['UNIT_MEMBER'], mustChangePassword: false,
    }), 'create');
    const first = await signIn('new.person@example.org', 'Strong-Pass-2026');
    expect(first.body.mustChangePassword).toBe(false);

    expectOk(await post(`/users/${made.id}/password`, T.admin, { password: 'Another-Pass-2026', mustChangePassword: true }), 'password');
    expect((await get('/auth/me', first.access)).status).toBe(401);
    expect((await call('POST', '/auth/login', { payload: { email: 'new.person@example.org', password: 'Strong-Pass-2026' } })).status).toBe(401);
    expect((await signIn('new.person@example.org', 'Another-Pass-2026')).body.mustChangePassword).toBe(true);
    expect((await post(`/users/${made.id}/password`, T.admin, { password: 'short' })).status).toBe(400);
    const set = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'PASSWORD_SET', entityId: made.id } });
    expect(JSON.stringify(set)).not.toContain('Another-Pass-2026');

    expect((await patch(`/users/${made.id}`, T.admin, { email: 'designer@hiva.local' })).body.error.code).toBe('EMAIL_TAKEN');
    expectOk(await patch(`/users/${made.id}`, T.admin, { email: 'renamed.person@example.org' }), 'rename');
    await signIn('renamed.person@example.org', 'Another-Pass-2026');
  });

  it('removes a person with history and keeps their name in it; deletes one with none outright', async () => {
    // Made and never used: nothing points at them.
    const unused = expectOk(await post('/users', T.admin, {
      email: 'unused@example.org', fullName: 'بی‌سابقه', password: 'Strong-Pass-2026', departmentCode: 'CR', roleCodes: ['UNIT_MEMBER'],
    }), 'create');
    expect(expectOk(await get(`/users/${unused.id}/removal`, T.admin), 'removal')).toEqual({ hasHistory: false });
    expect(expectOk(await del(`/users/${unused.id}`, T.admin), 'delete').result).toBe('deleted');
    expect(await prisma.user.findUnique({ where: { id: unused.id } })).toBeNull();

    // Someone who has signed in and worked: their name stays where they were.
    await signIn('sales@hiva.local');
    expect(expectOk(await get(`/users/${id.sales}/removal`, T.admin), 'removal')).toEqual({ hasHistory: true });
    expect(expectOk(await del(`/users/${id.sales}`, T.admin, { reason: 'پایان همکاری' }), 'remove').result).toBe('removed');
    const gone = await prisma.user.findUniqueOrThrow({ where: { id: id.sales } });
    expect(gone).toMatchObject({ isActive: false, fullName: 'الهام کریمی', email: `removed-${id.sales}@removed.invalid`, phone: null });
    expect(gone.deletedAt).not.toBeNull();
    expect((await call('POST', '/auth/login', { payload: { email: 'sales@hiva.local', password: 'Hiva@Dev2026!' } })).status).toBe(401);
    const listed = expectOk(await get('/users', T.admin, { pageSize: '200' }), 'list');
    expect(listed.items.map((u: { id: string }) => u.id)).not.toContain(id.sales);
    expect(await prisma.auditEvent.count({ where: { actorId: id.sales } })).toBeGreaterThan(0);
    const why = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'DELETE', entityType: 'user', entityId: id.sales } });
    expect(why).toMatchObject({ reason: 'پایان همکاری', after: { removed: 'removed' } });
    // The address is free for whoever comes next.
    expectOk(await post('/users', T.admin, {
      email: 'sales@hiva.local', fullName: 'فروش تازه', password: 'Strong-Pass-2026', departmentCode: 'S', roleCodes: ['SALES_REP'],
    }), 'reuse');

    expect((await del(`/users/${id.admin}`, T.admin)).body.error.code).toBe('SELF_REMOVE');
    expect((await del(`/users/${id.admin}`, T.ceo)).status).toBe(403);
  });

  it('counts as history every column that points at a person, but their own sessions, roles and links', () => {
    const cols = HISTORY_COLUMNS.map((c) => `${c.model}.${c.field}`);
    for (const c of ['Task.assigneeId', 'AuditEvent.actorId', 'FormApproval.approverId', 'Document.uploadedById', 'TimeEntry.userId']) expect(cols).toContain(c);
    for (const c of ['Session.userId', 'UserRole.userId', 'Notification.userId', 'PushSubscription.userId']) expect(cols).not.toContain(c);
  });

  it('lets the system administrator work in someone’s account — openly, recorded, and only so far', async () => {
    expect((await post(`/users/${id.designer}/act-as`, T.ceo, { reason: 'بررسی' })).status).toBe(403);
    expect((await post(`/users/${id.designer}/act-as`, T.admin, {})).status).toBe(400);
    expect((await post(`/users/${id.admin}/act-as`, T.admin, { reason: 'بررسی' })).body.error.code).toBe('SELF');

    const acting = expectOk(await post(`/users/${id.designer}/act-as`, T.admin, { reason: 'تأیید فرم‌های مانده در مرخصی' }), 'act');
    const me = expectOk(await get('/auth/me', acting.accessToken), 'me');
    expect(me).toMatchObject({ id: id.designer, actingAs: { by: { id: id.admin } }, offlineKey: null });

    // The person is told, and the history has the reason.
    expect(await prisma.notification.count({ where: { userId: id.designer, kind: 'ACCOUNT_ACTED_IN' } })).toBe(1);
    expect(await prisma.auditEvent.findFirstOrThrow({ where: { action: 'ACT_AS_STARTED', entityId: id.designer } }))
      .toMatchObject({ actorId: id.admin, reason: 'تأیید فرم‌های مانده در مرخصی' });

    // Whatever is done in the account names the administrator as who was at the keyboard.
    expect((await get('/audit-events', acting.accessToken)).status).toBe(403);
    expect(await prisma.auditEvent.findFirstOrThrow({ where: { action: 'PERMISSION_DENIED', actorId: id.designer }, orderBy: { createdAt: 'desc' } }))
      .toMatchObject({ impersonatorId: id.admin });

    // What only the person may do stays theirs.
    for (const [method, url] of [['POST', '/me/password'], ['GET', '/chat/conversations'], ['POST', '/push/subscriptions'], ['PATCH', '/auth/me/locale']] as const) {
      const res = await call(method, url, { token: acting.accessToken, payload: method === 'GET' ? undefined : {} });
      expect([method, url, res.body.error?.code]).toEqual([method, url, 'NOT_WHILE_ACTING']);
    }
    expect(refusedWhileActing('GET', '/api/v1/me/work')).toBe(false);
    expect(refusedWhileActing('POST', '/api/v1/forms/submissions')).toBe(false);

    // Back out: the token is over.
    expect((await post('/auth/act-as/end', acting.accessToken)).status).toBe(204);
    expect((await get('/auth/me', acting.accessToken)).status).toBe(401);
    expect(await prisma.auditEvent.count({ where: { action: 'ACT_AS_ENDED', actorId: id.admin, entityId: id.designer } })).toBe(1);
  });

  it('ends the session in the account as soon as its administrator no longer stands', async () => {
    const second = expectOk(await post('/users', T.admin, {
      email: 'second.admin@example.org', fullName: 'مدیر سیستم دوم', password: 'Strong-Pass-2026', departmentCode: 'M', roleCodes: ['SUPER_ADMIN'], mustChangePassword: false,
    }), 'second admin');
    const token = (await signIn('second.admin@example.org', 'Strong-Pass-2026')).access;
    const acting = expectOk(await post(`/users/${id.media}/act-as`, token, { reason: 'پیگیری سفارش رسانه' }), 'act');
    expect((await get('/auth/me', acting.accessToken)).status).toBe(200);
    // Nor may one administrator work in another's account.
    expect((await post(`/users/${id.admin}/act-as`, token, { reason: 'بررسی' })).body.error.code).toBe('NOT_ANOTHER_ADMIN');
    expectOk(await patch(`/users/${second.id}`, T.admin, { roleCodes: ['CEO'] }), 'demote');
    expect((await get('/auth/me', acting.accessToken)).status).toBe(401);
  });
});
