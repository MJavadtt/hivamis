import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app, call, closeApp, expectOk, get, login, post, refreshWith, signIn } from './helpers.js';
import { prisma } from '../src/db.js';
import { pruneIdempotencyKeys, KEEP_MS } from '../src/lib/idempotency.js';

/**
 * Audit F-7: what an offline queue needs from the server. A write sent again — because the answer
 * was lost on the way back — is done once and answered as the first time; a key is the sender's
 * and answers only the request it was made for; a refusal is not kept, so a fixed retry runs.
 * Notes on tasks, which a phone queues like the rest. And a key per sign-in for the page's
 * encrypted copy.
 */

async function send(token: string, url: string, payload: unknown, key?: string) {
  const res = await (await app()).inject({ method: 'POST', url: `/api/v1${url}`, payload: payload as object, headers: { authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) } });
  return { status: res.statusCode, replayed: res.headers['idempotent-replayed'], body: res.body ? JSON.parse(res.body) : null };
}
const key = () => `t-${crypto.randomUUID()}`;

describe('Offline replays (audit F-7)', () => {
  let designer: string, pmo: string, designerId: string, taskId: string, taskCode: string;

  beforeAll(async () => {
    [designer, pmo] = await Promise.all([login('designer@hiva.local'), login('pmo@hiva.local')]);
    const me = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    designerId = me.id;
    const project = await prisma.project.findFirstOrThrow({ where: { organizationId: me.organizationId }, orderBy: { code: 'asc' } });
    taskCode = `TSK-7${String(Date.now()).slice(-5)}`;
    taskId = (await prisma.task.create({ data: {
      organizationId: me.organizationId, code: taskCode, projectId: project.id, title: 'عکاسی صحنه', departmentCode: 'CR',
      sourceType: 'BRIEF', sourceRef: 'BRF-000007', createdById: me.id, assigneeId: me.id, state: 'IN_PROGRESS',
    } })).id;
  });
  afterAll(closeApp);

  it('does a time entry once however often it is sent, and answers again as the first time', async () => {
    const k = key();
    const body = { hours: 2.5, workedOn: '2026-10-12', note: 'سر صحنه' };
    const first = await send(designer, `/tasks/${taskId}/time`, body, k);
    expect(first.status).toBe(201);
    const again = await send(designer, `/tasks/${taskId}/time`, body, k);
    expect(again).toMatchObject({ status: 201, replayed: 'true' });
    expect(again.body).toEqual(first.body);
    expect(await prisma.timeEntry.count({ where: { taskId } })).toBe(1);
    // The same key on something else is refused; a malformed key too.
    expect((await send(designer, `/tasks/${taskId}/time`, { ...body, hours: 3 }, k)).body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await send(designer, `/tasks/${taskId}/time`, body, 'short')).body.error.code).toBe('IDEMPOTENCY_KEY_INVALID');
    // Without a key it is an ordinary write.
    expect((await send(designer, `/tasks/${taskId}/time`, body)).status).toBe(201);
    expect(await prisma.timeEntry.count({ where: { taskId } })).toBe(2);
  });

  it('keeps no refusal: fixed, the same key goes through', async () => {
    const k = key();
    expect((await send(designer, `/tasks/${taskId}/time`, { hours: 0 }, k)).status).toBe(400);
    expect(await prisma.idempotencyKey.count({ where: { key: k } })).toBe(0);
    // The body changed, so the key answers the new request — the refused one was let go.
    expect((await send(designer, `/tasks/${taskId}/time`, { hours: 1, workedOn: '2026-10-13' }, k)).status).toBe(201);
  });

  it('tells a second sender to wait while the first is running, and takes over one that died', async () => {
    const k = key();
    const me = await prisma.user.findUniqueOrThrow({ where: { id: designerId } });
    const body = { hours: 1, workedOn: '2026-10-11' };
    const hashed = await prisma.idempotencyKey.create({ data: { organizationId: me.organizationId, userId: designerId, key: k, method: 'POST', path: `/api/v1/tasks/${taskId}/time`, requestHash: 'x' } });
    // A different request on a key in use is still refused as reuse; the same one waits.
    expect((await send(designer, `/tasks/${taskId}/time`, body, k)).body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    await prisma.idempotencyKey.delete({ where: { id: hashed.id } });
    expect((await send(designer, `/tasks/${taskId}/time`, body, k)).status).toBe(201);
    await prisma.idempotencyKey.updateMany({ where: { key: k }, data: { completedAt: null, statusCode: null } });
    expect((await send(designer, `/tasks/${taskId}/time`, body, k)).body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    await prisma.idempotencyKey.updateMany({ where: { key: k }, data: { createdAt: new Date(Date.now() - 120_000) } });
    expect((await send(designer, `/tasks/${taskId}/time`, body, k)).status).toBe(201);
  });

  it('keeps one person’s keys apart from another’s', async () => {
    const k = key();
    await send(designer, `/tasks/${taskId}/comments`, { body: 'از من' }, k);
    const theirs = await send(pmo, `/tasks/${taskId}/comments`, { body: 'از من' }, k);
    expect(theirs.status).toBe(201);
    expect(theirs.replayed).toBeUndefined();
  });

  it('sends a queued submit once: the second arrival is the first answer, not “not in that state”', async () => {
    const k = key();
    const first = await send(designer, `/workflow/task/${taskId}/transitions`, { action: 'submit' }, k);
    expect(first.status).toBe(200);
    const again = await send(designer, `/workflow/task/${taskId}/transitions`, { action: 'submit' }, k);
    expect(again).toMatchObject({ status: 200, replayed: 'true' });
    expect(await prisma.stateTransition.count({ where: { entityId: taskId, action: 'submit' } })).toBe(1);
    // Without the key, the state has moved: the workflow says so.
    expect((await send(designer, `/workflow/task/${taskId}/transitions`, { action: 'submit' })).status).toBeGreaterThanOrEqual(400);
  });

  it('files a form once by its key', async () => {
    const k = key();
    // A traffic sheet, which Operations sends — kept as a draft.
    const body = { formCode: 'J85_TRAFFIC_SHEET', data: {}, asDraft: true };
    const first = await send(pmo, '/forms/submissions', body, k);
    expect(first.status).toBe(201);
    const again = await send(pmo, '/forms/submissions', body, k);
    expect(again).toMatchObject({ status: 201, replayed: 'true' });
    expect(again.body.id).toBe(first.body.id);
  });

  it('keeps notes on a task, for whoever may see it, and tells the assignee', async () => {
    const before = await prisma.notification.count({ where: { userId: designerId, kind: 'TASK_COMMENT' } });
    const c = expectOk(await post(`/tasks/${taskId}/comments`, pmo, { body: 'نور صحنهٔ دوم کم بود' }), 'comment');
    expect(c).toMatchObject({ body: 'نور صحنهٔ دوم کم بود', author: { fullName: 'فرشاد بهرامی' } });
    const list = expectOk(await get(`/tasks/${taskId}/comments`, designer), 'list');
    expect(list.at(-1)).toMatchObject({ id: c.id, author: { avatarUrl: null } });
    expect(await prisma.notification.count({ where: { userId: designerId, kind: 'TASK_COMMENT' } })).toBe(before + 1);
    expect((await post(`/tasks/${taskId}/comments`, pmo, { body: '   ' })).status).toBe(400);
    expect(await prisma.auditEvent.count({ where: { entityType: 'comment', entityId: c.id, action: 'CREATE' } })).toBe(1);
  });

  it('gives each sign-in its own key for the page’s offline copy, the same across its refreshes', async () => {
    const a = await signIn('designer@hiva.local');
    const keyA = expectOk(await get('/auth/me', a.access), 'me').offlineKey;
    expect(keyA).toMatch(/^[\w-]{43}$/);
    const renewed = await refreshWith(a.refresh);
    expect(expectOk(await get('/auth/me', renewed.body.accessToken), 'me').offlineKey).toBe(keyA);
    const b = await signIn('designer@hiva.local');
    expect(expectOk(await get('/auth/me', b.access), 'me').offlineKey).not.toBe(keyA);
    await call('POST', '/auth/logout', { token: a.access });
  });

  it('forgets kept answers after a week', async () => {
    const old = await prisma.idempotencyKey.findFirstOrThrow();
    await prisma.idempotencyKey.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - KEEP_MS - 1000) } });
    expect(await pruneIdempotencyKeys()).toBeGreaterThanOrEqual(1);
    expect(await prisma.idempotencyKey.count({ where: { id: old.id } })).toBe(0);
  });
});
