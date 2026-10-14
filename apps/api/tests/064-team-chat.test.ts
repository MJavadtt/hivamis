import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  FULL_ACCESS_ROLES, OVERSIGHT_NOTICE, ROLE_PERMISSIONS, effectiveRoleMap, type RoleCode,
} from '@hiva/contracts';
import { app, call, closeApp, expectOk, get, login, patch, post, put } from './helpers.js';
import { prisma } from '../src/db.js';
import { liveBus, type LiveEvent } from '../src/live/bus.js';
import { provisionOrganization } from '../src/setup/tenant.js';
import { tenancy } from '../src/lib/tenant.js';
import { hashPassword } from '../src/auth/password.js';

/**
 * Audit F-5: team chat. Direct, group and channel conversations that answer only to their members;
 * unread counts; notices that name the writer, not the words; files shared as documents that only
 * members may open; live delivery to members alone. And oversight disclosed to everyone: nobody's
 * by default, given only by the system administrator, a reason for every look, and a record of each
 * look that the database will not let anyone change or delete.
 */

const del = (url: string, token: string) => call('DELETE', url, { token });
const id = async (email: string) => (await prisma.user.findFirstOrThrow({ where: { email } })).id;

async function upload(token: string, fields: Record<string, string>, file = Buffer.from('%PDF-1.4\n% chat\n'), name = 'brief.pdf', type = 'application/pdf') {
  const boundary = '----chat';
  const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  const payload = Buffer.concat([
    ...parts,
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), file, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await (await app()).inject({ method: 'POST', url: '/api/v1/documents', payload, headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

describe('Team chat (audit F-5)', () => {
  let designer: string, pmo: string, sales: string, admin: string, ceo: string;
  let designerId: string, pmoId: string, salesId: string, ceoId: string;
  let direct: string, group: string, channel: string;
  let other: { token: string };

  beforeAll(async () => {
    [designer, pmo, sales, admin, ceo] = await Promise.all(['designer', 'pmo', 'sales', 'admin', 'ceo'].map((u) => login(`${u}@hiva.local`)));
    [designerId, pmoId, salesId, ceoId] = await Promise.all(['designer', 'pmo', 'sales', 'ceo'].map((u) => id(`${u}@hiva.local`)));
    tenancy.mode = 'multi';
    const second = await provisionOrganization({ name: 'آژانس دیگر', slug: 'digar-chat', admin: { email: 'boss@digar-chat.ir', fullName: 'مدیر دیگر' } })
      .finally(() => { tenancy.mode = 'single'; });
    await prisma.user.update({ where: { id: second.admin.id }, data: { passwordHash: await hashPassword('Digar@Test2026!'), mustChangePassword: false, isActive: true } });
    other = { token: (await call('POST', '/auth/login', { payload: { email: 'boss@digar-chat.ir', password: 'Digar@Test2026!' } })).body.accessToken };
  });
  afterAll(closeApp);

  it('gives oversight to nobody by default — the full-access roles included', async () => {
    for (const [role, ps] of Object.entries(ROLE_PERMISSIONS)) expect(ps, role).not.toContain('chat.oversight');
    for (const role of FULL_ACCESS_ROLES) expect(effectiveRoleMap({ [role]: ['chat.oversight'] })[role as RoleCode]).not.toContain('chat.oversight');
    for (const token of [admin, ceo]) expect(expectOk(await get('/auth/me', token), 'me').permissions).not.toContain('chat.oversight');
    expect((await get('/chat/oversight/conversations', admin)).status).toBe(403);
    // Everyone chats; managers open channels.
    expect(ROLE_PERMISSIONS.VIEWER).toContain('chat.use');
    expect(ROLE_PERMISSIONS.PMO_MANAGER).toContain('chat.channel.create');
    expect(ROLE_PERMISSIONS.UNIT_MEMBER).not.toContain('chat.channel.create');
  });

  it('keeps the wording the owner confirmed', () => {
    expect(OVERSIGHT_NOTICE.fa).toBe('گفت‌وگوها روی سامانهٔ سازمان انجام می‌شود. مدیران مجاز ممکن است آن‌ها را بازبینی کنند؛ هر بازبینی با نام بازبین، زمان و دلیلش در سابقهٔ حسابرسی ثبت می‌شود و پاک‌شدنی نیست.');
    expect(OVERSIGHT_NOTICE.en).toContain('every review is recorded in the audit trail with the reviewer, the time and the reason, and cannot be deleted');
  });

  it('opens one direct conversation per pair, which nobody else can see', async () => {
    const made = await post('/chat/conversations', designer, { kind: 'DIRECT', memberIds: [pmoId] });
    expect(made.status).toBe(201);
    direct = made.body.id;
    // Asked again, from either side: the same one.
    expect(expectOk(await post('/chat/conversations', pmo, { kind: 'DIRECT', memberIds: [designerId] }), 'again')).toMatchObject({ id: direct, existing: true });
    expect(expectOk(await get(`/chat/conversations/${direct}`, pmo), 'read')).toMatchObject({ kind: 'DIRECT', peer: { id: designerId } });
    // Anyone else — here or in another organisation — finds nothing.
    for (const token of [sales, other.token]) {
      expect((await get(`/chat/conversations/${direct}`, token)).status).toBe(404);
      expect((await get(`/chat/conversations/${direct}/messages`, token)).status).toBe(404);
      expect((await post(`/chat/conversations/${direct}/messages`, token, { body: 'سلام' })).status).toBe(404);
    }
    expect((await post('/chat/conversations', designer, { kind: 'DIRECT', memberIds: [designerId] })).body.error.code).toBe('DIRECT_SELF');
  });

  it('counts what is unread, tells the other person who wrote but not what, once until read', async () => {
    const before = await prisma.notification.count({ where: { userId: pmoId, entityId: direct } });
    expectOk(await post(`/chat/conversations/${direct}/messages`, designer, { body: 'پیش‌نویس لوگو آماده است' }), 'send');
    expectOk(await post(`/chat/conversations/${direct}/messages`, designer, { body: 'نظرت چیست؟' }), 'send');
    await new Promise((r) => setTimeout(r, 300));
    const list = expectOk(await get('/chat/conversations', pmo), 'list');
    expect(list.find((c: any) => c.id === direct)).toMatchObject({ unread: 2, title: 'بهراد مهرنیا', lastMessage: { body: 'نظرت چیست؟' } });
    expect(expectOk(await get('/chat/unread', pmo), 'unread')).toMatchObject({ total: 2, conversations: 1 });
    // The writer's own messages are read.
    expect(expectOk(await get('/chat/conversations', designer), 'mine').find((c: any) => c.id === direct).unread).toBe(0);

    const notices = await prisma.notification.findMany({ where: { userId: pmoId, entityId: direct }, orderBy: { createdAt: 'asc' } });
    expect(notices.length - before).toBe(1);
    expect(notices.at(-1)).toMatchObject({ kind: 'CHAT_MESSAGE', entityType: 'chatConversation', title: 'پیام تازه از بهراد مهرنیا', body: null });

    expectOk(await post(`/chat/conversations/${direct}/read`, pmo), 'read');
    expect(expectOk(await get('/chat/unread', pmo), 'unread').total).toBe(0);
    expect(await prisma.notification.count({ where: { userId: pmoId, entityId: direct, readAt: null } })).toBe(0);
  });

  it('runs a group: its owner adds and removes, members cannot, and the last owner leaving hands it on', async () => {
    const made = expectOk(await post('/chat/conversations', pmo, { kind: 'GROUP', title: 'کمپین پاییز', memberIds: [designerId] }), 'group');
    group = made.id;
    expect((await post(`/chat/conversations/${group}/members`, designer, { userIds: [salesId] })).status).toBe(403);
    expectOk(await post(`/chat/conversations/${group}/members`, pmo, { userIds: [salesId] }), 'add');
    expect(expectOk(await get(`/chat/conversations/${group}`, sales), 'read').members.map((m: any) => m.id).sort()).toEqual([designerId, pmoId, salesId].sort());
    expectOk(await del(`/chat/conversations/${group}/members/${salesId}`, pmo), 'remove');
    expect((await get(`/chat/conversations/${group}`, sales)).status).toBe(404);
    // Someone of another organisation cannot be added.
    const stranger = (await prisma.user.findFirstOrThrow({ where: { email: 'boss@digar-chat.ir' } })).id;
    expect((await post(`/chat/conversations/${group}/members`, pmo, { userIds: [stranger] })).body.error.code).toBe('UNKNOWN_USER');

    expectOk(await post(`/chat/conversations/${group}/leave`, pmo), 'leave');
    expect(expectOk(await get(`/chat/conversations/${group}`, designer), 'read').members).toEqual([expect.objectContaining({ id: designerId, role: 'OWNER' })]);
    expect((await post(`/chat/conversations/${direct}/leave`, pmo)).body.error.code).toBe('DIRECT_FIXED');
  });

  it('opens channels to managers to make and to everyone to join; there one hears only what names one', async () => {
    expect((await post('/chat/conversations', designer, { kind: 'CHANNEL', title: 'اطلاعیه‌ها' })).status).toBe(403);
    channel = expectOk(await post('/chat/conversations', pmo, { kind: 'CHANNEL', title: 'اطلاعیه‌ها', topic: 'خبرهای آژانس' }), 'channel').id;
    expect(expectOk(await get('/chat/channels', sales), 'browse').find((c: any) => c.id === channel)).toMatchObject({ joined: false, memberCount: 1 });
    expect((await get(`/chat/conversations/${channel}/messages`, sales)).status).toBe(404);
    expectOk(await post(`/chat/conversations/${channel}/join`, sales), 'join');
    expectOk(await post(`/chat/conversations/${channel}/join`, designer), 'join');
    expect(expectOk(await get(`/chat/conversations/${channel}`, sales), 'me').me).toMatchObject({ notify: 'MENTIONS', role: 'MEMBER' });

    // Not named: nothing. Named: a notice of its own. Someone outside cannot be named.
    expectOk(await post(`/chat/conversations/${channel}/messages`, pmo, { body: 'جلسهٔ فردا ساعت ۱۰' }), 'send');
    const named = expectOk(await post(`/chat/conversations/${channel}/messages`, pmo, { body: '@الهام لطفاً صورتجلسه را بنویس', mentionIds: [salesId, ceoId] }), 'mention');
    expect(named.mentionIds).toEqual([salesId]);
    await new Promise((r) => setTimeout(r, 300));
    expect(await prisma.notification.findMany({ where: { userId: salesId, entityId: channel }, select: { kind: true, title: true } }))
      .toEqual([{ kind: 'CHAT_MENTION', title: 'فرشاد بهرامی در «اطلاعیه‌ها» شما را نام برد' }]);
    expect(await prisma.notification.count({ where: { userId: designerId, entityId: channel } })).toBe(0);

    // Muted: nothing at all, and it does not count in the sidebar.
    expectOk(await patch(`/chat/conversations/${channel}/me`, designer, { muted: true, notify: 'ALL' }), 'mute');
    expectOk(await post(`/chat/conversations/${channel}/messages`, pmo, { body: '@بهراد', mentionIds: [designerId] }), 'send');
    await new Promise((r) => setTimeout(r, 300));
    expect(await prisma.notification.count({ where: { userId: designerId, entityId: channel } })).toBe(0);
    expect(expectOk(await get('/chat/unread', designer), 'unread').total).toBe(0);
  });

  it('keeps what a message said before it was edited, and hides a deleted one from the conversation', async () => {
    const m = expectOk(await post(`/chat/conversations/${direct}/messages`, designer, { body: 'ساعت ۳' }), 'send');
    expect((await patch(`/chat/messages/${m.id}`, pmo, { body: 'ساعت ۵' })).status).toBe(403);
    expect(expectOk(await patch(`/chat/messages/${m.id}`, designer, { body: 'ساعت ۴' }), 'edit')).toMatchObject({ body: 'ساعت ۴', editedAt: expect.any(String) });
    expect(await prisma.chatMessageEdit.findMany({ where: { messageId: m.id }, select: { body: true } })).toEqual([{ body: 'ساعت ۳' }]);

    const reply = expectOk(await post(`/chat/conversations/${direct}/messages`, pmo, { body: 'باشد', replyToId: m.id }), 'reply');
    expect(reply.replyTo).toMatchObject({ id: m.id, body: 'ساعت ۴' });
    // A reply belongs to its own conversation.
    expect((await post(`/chat/conversations/${channel}/messages`, pmo, { body: 'x', replyToId: m.id })).body.error.code).toBe('UNKNOWN_REFERENCE');

    expect((await del(`/chat/messages/${m.id}`, pmo)).status).toBe(403);
    expectOk(await del(`/chat/messages/${m.id}`, designer), 'delete');
    const page = expectOk(await get(`/chat/conversations/${direct}/messages`, pmo), 'messages');
    expect(page.items.find((x: any) => x.id === m.id)).toMatchObject({ deleted: true, body: '' });
    expect(await prisma.chatMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ body: 'ساعت ۴', deletedAt: expect.any(Date) });

    // An owner takes down someone else's words in a channel — and that is recorded.
    const theirs = expectOk(await post(`/chat/conversations/${channel}/messages`, sales, { body: 'آگهی فروش ماشین' }), 'send');
    expectOk(await del(`/chat/messages/${theirs.id}`, pmo), 'moderate');
    expect(await prisma.auditEvent.count({ where: { action: 'DELETE', entityType: 'chatMessage', entityId: theirs.id } })).toBe(1);
  });

  it('links a record a message names, for a reader who may open it', async () => {
    const org = (await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } })).organizationId;
    const project = await prisma.project.findFirstOrThrow({ where: { organizationId: org }, orderBy: { code: 'asc' } });
    expectOk(await post(`/chat/conversations/${direct}/messages`, designer, { body: `برای ${project.code} و PRJ-999999 لطفاً` }), 'send');
    const page = expectOk(await get(`/chat/conversations/${direct}/messages`, pmo), 'messages');
    expect(page.records[project.code]).toMatchObject({ type: 'project', id: project.id });
    expect(page.records['PRJ-999999']).toBeUndefined();
  });

  it('shares a file as a document only members can open; the documents pages do not list or serve it', async () => {
    expect((await upload(sales, { chatConversationId: direct })).status).toBe(422);
    const up = await upload(designer, { chatConversationId: direct });
    expect(up.status).toBe(201);
    const file = up.body.id;
    expect((await upload(designer, { chatConversationId: direct, projectId: (await prisma.project.findFirstOrThrow()).id })).body.error.code).toBe('CHAT_FILE_ALONE');

    // Not yet sent: its uploader's alone.
    expect((await get(`/chat/files/${file}`, pmo)).status).toBe(404);
    expect((await post(`/chat/conversations/${group}/messages`, designer, { attachmentIds: [file] })).body.error.code).toBe('UNKNOWN_REFERENCE');
    const sent = expectOk(await post(`/chat/conversations/${direct}/messages`, designer, { attachmentIds: [file] }), 'send');
    expect(sent.attachments).toEqual([expect.objectContaining({ id: file, fileName: 'brief.pdf' })]);
    expect((await get(`/chat/files/${file}`, pmo)).status).toBe(200);
    expect((await get(`/chat/files/${file}`, sales)).status).toBe(404);

    // The documents routes treat it as not there — even for someone who holds every document permission.
    expect(expectOk(await get('/documents', ceo), 'documents').some((d: any) => d.id === file)).toBe(false);
    for (const p of ['download', 'preview', 'versions']) expect((await get(`/documents/${file}/${p}`, ceo)).status, p).toBe(404);
  });

  it('delivers live, to the conversation’s members alone', async () => {
    const heard: LiveEvent[] = [];
    const stop = liveBus.subscribe((e) => heard.push(e));
    await liveBus.ready();
    const m = expectOk(await post(`/chat/conversations/${direct}/messages`, pmo, { body: 'زنده' }), 'send');
    await new Promise((r) => setTimeout(r, 400));
    stop();
    // What the database announces carries no words.
    const e = heard.find((x) => x.t === 'chat' && x.message === m.id);
    expect(e).toMatchObject({ t: 'chat', conversation: direct, author: pmoId, op: 'insert' });
    expect(JSON.stringify(e)).not.toContain('زنده');
  });

  it('lets only the system administrator give oversight — not delegated, not on a key', async () => {
    const reviewer = expectOk(await post('/roles', admin, { nameFa: 'بازبین گفت‌وگو', nameEn: 'Conversation reviewer' }), 'role').code;
    // Someone else who manages roles cannot add it, copy it, or give a role that holds it.
    expect((await put(`/roles/${reviewer}/permissions`, ceo, { permissions: ['chat.oversight'] })).body.error.code).toBe('OVERSIGHT_GRANTOR_ONLY');
    expectOk(await put(`/roles/${reviewer}/permissions`, admin, { permissions: ['chat.oversight'] }), 'grant');
    expect((await post('/roles', ceo, { nameFa: 'رونوشت بازبین', nameEn: 'Copy', copyFrom: reviewer })).body.error.code).toBe('OVERSIGHT_GRANTOR_ONLY');
    expect((await patch(`/users/${salesId}`, ceo, { roleCodes: ['SALES_REP', reviewer] })).body.error.code).toBe('OVERSIGHT_GRANTOR_ONLY');
    expectOk(await patch(`/users/${ceoId}`, admin, { roleCodes: ['CEO', reviewer] }), 'give');
    ceo = await login('ceo@hiva.local');
    expect(expectOk(await get('/auth/me', ceo), 'me').permissions).toContain('chat.oversight');

    const later = new Date(Date.now() + 86_400_000).toISOString();
    expect((await post('/delegations', ceo, { toUserId: pmoId, permissions: ['chat.oversight'], startsAt: new Date().toISOString(), endsAt: later, reason: 'مرخصی' })).body.error.code).toBe('NOT_DELEGABLE');
    expect((await post('/admin/api-keys', ceo, { name: 'reviewer key', permissions: ['chat.oversight'] })).body.error.code).toBe('KEY_PERMISSION_NOT_GRANTABLE');
  });

  it('opens any conversation to a reviewer only for a stated reason, and records every look for good', async () => {
    const listed = expectOk(await get('/chat/oversight/conversations', ceo), 'list');
    expect(listed.map((c: any) => c.id)).toEqual(expect.arrayContaining([direct, group, channel]));
    expect(listed.find((c: any) => c.id === direct).members.map((m: any) => m.id).sort()).toEqual([designerId, pmoId].sort());
    expect(await prisma.auditEvent.count({ where: { actorId: ceoId, action: 'CHAT_OVERSIGHT_LIST' } })).toBe(1);

    expect((await post(`/chat/oversight/conversations/${direct}/view`, ceo, {})).status).toBe(400);
    expect((await post(`/chat/oversight/conversations/${direct}/view`, ceo, { reason: 'کوتاه' })).status).toBe(400);
    const reason = 'شکایت ثبت‌شدهٔ شمارهٔ ۱۲ دربارهٔ رفتار در گفت‌وگو';
    const view = expectOk(await post(`/chat/oversight/conversations/${direct}/view`, ceo, { reason }), 'view');
    // Read-only, all of it: a deleted message with what it said, an edited one with what it said before.
    const deleted = view.items.find((m: any) => m.deleted);
    expect(deleted).toMatchObject({ body: 'ساعت ۴', deletedAt: expect.any(String), edits: [{ body: 'ساعت ۳' }] });
    const row = await prisma.auditEvent.findFirstOrThrow({ where: { actorId: ceoId, action: 'CHAT_OVERSIGHT_VIEW', entityId: direct } });
    expect(row).toMatchObject({ reason, entityType: 'chatConversation' });
    // Another organisation's conversation does not exist for this reviewer.
    const theirs = expectOk(await post('/chat/conversations', other.token, { kind: 'CHANNEL', title: 'داخلی' }), 'theirs').id;
    expect((await post(`/chat/oversight/conversations/${theirs}/view`, ceo, { reason })).status).toBe(404);
    expect(expectOk(await get('/chat/oversight/conversations', ceo), 'list').some((c: any) => c.id === theirs)).toBe(false);

    // The record of the look cannot be changed, deleted, or emptied with the table.
    await expect(prisma.auditEvent.delete({ where: { id: row.id } })).rejects.toThrow(/cannot be changed or deleted/);
    await expect(prisma.auditEvent.update({ where: { id: row.id }, data: { reason: 'هیچ' } })).rejects.toThrow(/cannot be changed or deleted/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE "audit_events"')).rejects.toThrow(/cannot be removed/);
    expect(await prisma.auditEvent.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ reason });

    // Files too: a reason and a record for each.
    const file = (await prisma.document.findFirstOrThrow({ where: { chatConversationId: direct } })).id;
    expect((await post(`/chat/oversight/files/${file}`, ceo, {})).status).toBe(400);
    expect((await post(`/chat/oversight/files/${file}`, ceo, { reason })).status).toBe(200);
    expect(await prisma.auditEvent.count({ where: { actorId: ceoId, action: 'CHAT_OVERSIGHT_VIEW', entityType: 'document', entityId: file } })).toBe(1);
  });
});
