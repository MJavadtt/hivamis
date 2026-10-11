import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app, call, closeApp, get, login, post, upload, tinyPdf, expectOk, patch, createContact } from './helpers.js';
import { prisma } from '../src/db.js';
import { nextCode } from '../src/lib/codes.js';
import { clientMail } from '../src/mail/client.js';

const PASSWORD = 'Portal-Client-2026';
const as = (token: string) => ({ token });
const pget = (url: string, token: string) => call('GET', url, as(token));
const ppost = (url: string, token: string, payload?: unknown) => call('POST', url, { token, payload });
const tokenOf = (link: string) => link.split('/portal/invite/')[1]!;

describe('The client portal', () => {
  let T: Record<string, string>;
  let companyId: string, projectId: string, otherProjectId: string, draftProjectId: string, deliverableId: string;
  let maryam: string, ali: string, noEmail: string;
  let client: string, colleague: string;
  const original = { ...clientMail };

  beforeAll(async () => {
    clientMail.enabled = () => false;
    T = { am: await login('account.manager@hiva.local'), designer: await login('designer@hiva.local') };
    const org = await prisma.organization.findFirstOrThrow();
    const owner = await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } });
    companyId = (await prisma.company.create({ data: { organizationId: org.id, legalName: 'شرکت پورتال آزمون', brandName: 'پورتالیا', accountOwnerId: owner.id } })).id;
    const mkProject = async (name: string, state: string, cid = companyId) => (await prisma.project.create({
      data: { organizationId: org.id, code: await nextCode(prisma, 'project'), name, companyId: cid, accountOwnerId: owner.id, state, objective: 'افزایش آگاهی از برند', plannedBudget: 900_000_000 },
    })).id;
    projectId = await mkProject('کمپین پاییزی', 'ACTIVE');
    draftProjectId = await mkProject('پیش‌نویس داخلی', 'DRAFT');
    const other = await prisma.company.findFirstOrThrow({ where: { id: { not: companyId } } });
    otherProjectId = await mkProject('پروژهٔ مشتری دیگر', 'ACTIVE', other.id);
    await prisma.milestone.createMany({ data: [
      { projectId, name: 'راه‌اندازی', dueDate: new Date(Date.now() - 5 * 86_400_000), completedAt: new Date(), revenueShare: 40 },
      { projectId, name: 'موج دوم', dueDate: new Date(Date.now() + 20 * 86_400_000) },
    ] });
    deliverableId = (await prisma.deliverable.create({ data: { organizationId: org.id, code: await nextCode(prisma, 'deliverable'), projectId, name: 'تیزر ۳۰ ثانیه', departmentCode: 'CR', version: 'v2', state: 'DELIVERED', deliveredAt: new Date() } })).id;
    await prisma.deliverable.create({ data: { organizationId: org.id, code: await nextCode(prisma, 'deliverable'), projectId, name: 'پوستر', departmentCode: 'CR', state: 'IN_QC' } });
    const contact = (fullName: string, email: string | null) => createContact({ companyId, fullName, email }).then((c) => c.id);
    maryam = await contact('مریم احمدی', 'Maryam@Portalia.example');
    ali = await contact('علی رضایی', 'ali@portalia.example');
    noEmail = await contact('بی‌ایمیل', null);
  });
  afterAll(async () => { Object.assign(clientMail, original); await closeApp(); });

  it('is opened to a contact by Account alone, by invitation — the link handed over once when mail is off', async () => {
    expect((await post('/portal-users', T.designer, { contactId: maryam })).status).toBe(403);
    expect((await post('/portal-users', T.am, { contactId: noEmail })).body.error.code).toBe('PORTAL_CONTACT_EMAIL');
    const r = expectOk(await post('/portal-users', T.am, { contactId: maryam }), 'invite');
    expect(r.user).toMatchObject({ email: 'maryam@portalia.example', status: 'INVITED' });
    expect(r.user.passwordHash).toBeUndefined();
    expect(r.user.inviteTokenHash).toBeUndefined();
    expect(r.link).toMatch(/\/portal\/invite\/[\w-]{43}$/);

    expect((await ppost('/portal/auth/accept', '', { token: tokenOf(r.link), password: 'short' })).status).toBe(400);
    const accepted = expectOk(await ppost('/portal/auth/accept', '', { token: tokenOf(r.link), password: PASSWORD }), 'accept');
    client = accepted.token;
    expect((await ppost('/portal/auth/accept', '', { token: tokenOf(r.link), password: PASSWORD })).body.error.code).toBe('PORTAL_INVITE_INVALID');

    const r2 = expectOk(await post('/portal-users', T.am, { contactId: ali }), 'colleague');
    colleague = expectOk(await ppost('/portal/auth/accept', '', { token: tokenOf(r2.link), password: PASSWORD }), 'accept 2').token;
    const listed = expectOk(await get('/portal-users', T.am, { companyId }), 'list');
    expect(listed.map((u: any) => u.status)).toEqual(['ACTIVE', 'ACTIVE']);
  });

  it('keeps the two identities apart: a portal token opens nothing of the app, a staff token nothing of the portal', async () => {
    expect((await get('/projects', client)).status).toBe(401);
    expect((await pget('/portal/home', T.am)).status).toBe(401);
    expect((await pget('/portal/home', '')).status).toBe(401);
  });

  it('signs in by email and password, the same answer for every failure, and slows wrong tries without locking anyone out', async () => {
    expectOk(await ppost('/portal/auth/login', '', { email: 'MARYAM@portalia.example', password: PASSWORD }), 'login');
    const unknown = await ppost('/portal/auth/login', '', { email: 'nobody@portalia.example', password: PASSWORD });
    const wrong = await ppost('/portal/auth/login', '', { email: 'ali@portalia.example', password: 'Wrong-Password-1' });
    expect([unknown.status, wrong.status]).toEqual([401, 401]);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
    // Audit SEC-10: this network slows down for the address — the same for one with no account.
    const tries = async (email: string) => {
      const out: number[] = [];
      for (let i = 0; i < 4; i++) out.push((await ppost('/portal/auth/login', '', { email, password: 'Wrong-Password-1' })).status);
      return out;
    };
    expect(await tries('ali@portalia.example')).toEqual([401, 401, 401, 429]);
    expect(await tries('nobody@portalia.example')).toEqual([401, 401, 401, 429]);
    // Ali, from their own network, is not locked out.
    const elsewhere = await (await app()).inject({ method: 'POST', url: '/api/v1/portal/auth/login', remoteAddress: '198.51.100.20', payload: { email: 'ali@portalia.example', password: PASSWORD } });
    expect(elsewhere.statusCode).toBe(200);
    expect((await prisma.portalUser.findUniqueOrThrow({ where: { email: 'ali@portalia.example' } })).lockedUntil).toBeNull();
    await prisma.signInFailure.deleteMany({ where: { identifier: { startsWith: 'portal:' } } });
  });

  it('shows only the company’s authorised projects, and none of what is internal', async () => {
    const h = expectOk(await pget('/portal/home', client), 'home');
    expect(h.me).toMatchObject({ name: 'مریم احمدی', company: 'پورتالیا' });
    expect(h.projects.map((p: any) => p.id)).toEqual([projectId]);
    expect(h.projects[0].milestones).toEqual({ done: 1, total: 2 });
    expect((await pget(`/portal/projects/${draftProjectId}`, client)).status).toBe(404);
    expect((await pget(`/portal/projects/${otherProjectId}`, client)).status).toBe(404);

    const p = expectOk(await pget(`/portal/projects/${projectId}`, client), 'project');
    expect(p.project).toMatchObject({ name: 'کمپین پاییزی', objective: 'افزایش آگاهی از برند', stateFa: expect.any(String) });
    expect(p.deliverables.map((d: any) => [d.name, d.clientState])).toEqual([['تیزر ۳۰ ثانیه', 'DELIVERED'], ['پوستر', 'IN_PROGRESS']]);
    const text = JSON.stringify(p);
    for (const internal of ['plannedBudget', '900000000', 'revenueShare', 'departmentCode', 'accountOwner']) expect(text).not.toContain(internal);
  });

  it('shows a file only once Account shares it — only a project’s own files, and only its own company’s', async () => {
    const f = expectOk(await upload(T.am, { name: 'media-plan.pdf', type: 'application/pdf', content: tinyPdf('plan') }, { projectId }), 'upload').id;
    const other = expectOk(await upload(T.am, { name: 'other.pdf', type: 'application/pdf', content: tinyPdf('x') }, { projectId: otherProjectId }), 'other').id;
    const loose = expectOk(await upload(T.am, { name: 'company.pdf', type: 'application/pdf', content: tinyPdf('c') }, { companyId }), 'loose').id;
    expect(expectOk(await pget(`/portal/projects/${projectId}`, client), 'before').documents).toEqual([]);
    expect((await pget(`/portal/documents/${f}`, client)).status).toBe(404);

    expect((await patch(`/documents/${f}/client-visibility`, T.designer, { clientVisible: true })).status).toBe(403);
    expect((await patch(`/documents/${loose}/client-visibility`, T.am, { clientVisible: true })).body.error.code).toBe('PORTAL_NOT_PROJECT_FILE');
    expectOk(await patch(`/documents/${f}/client-visibility`, T.am, { clientVisible: true }), 'share');
    expectOk(await patch(`/documents/${other}/client-visibility`, T.am, { clientVisible: true }), 'share other');
    expect(expectOk(await pget(`/portal/projects/${projectId}`, client), 'after').documents.map((d: any) => d.id)).toEqual([f]);
    const dl = await pget(`/portal/documents/${f}`, client);
    expect(dl.status).toBe(200);
    expect(dl.body).toBe(tinyPdf('plan'));
    expect((await pget(`/portal/documents/${other}`, client)).status).toBe(404);
    const files = expectOk(await get(`/projects/${projectId}/client-files`, T.am), 'staff list');
    expect(files.find((x: any) => x.id === f).clientVisible).toBe(true);
  });

  it('carries a conversation with Account on each project, and tells the account owner', async () => {
    expectOk(await ppost(`/portal/projects/${projectId}/messages`, client, { body: 'زمان پخش موج دوم قطعی شد؟' }), 'client message');
    expect((await ppost(`/portal/projects/${otherProjectId}/messages`, client, { body: 'x' })).status).toBe(404);
    const owner = await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } });
    expect(await prisma.notification.count({ where: { userId: owner.id, kind: 'PORTAL_MESSAGE', entityId: projectId } })).toBe(1);
    expect((await post(`/projects/${projectId}/portal-messages`, T.designer, { body: 'سلام' })).status).toBe(403);
    expectOk(await post(`/projects/${projectId}/portal-messages`, T.am, { body: 'بله، از شنبه.' }), 'reply');
    const staff = expectOk(await get(`/projects/${projectId}/portal-messages`, T.am), 'staff thread');
    expect(staff.portalUsers).toBe(2);
    const thread = expectOk(await pget(`/portal/projects/${projectId}`, client), 'thread').messages;
    expect(thread.map((m: any) => [m.fromClient, m.author])).toEqual([[true, 'مریم احمدی'], [false, 'رضا شریفی']]);
  });

  it('gives the weekly report in its client version only — for its own projects', async () => {
    const org = await prisma.organization.findFirstOrThrow();
    const creator = await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } });
    const mk = async (pid: string) => (await prisma.statusReport.create({
      data: { organizationId: org.id, code: await nextCode(prisma, 'statusReport'), projectId: pid, period: 'هفتهٔ دوم مهر', progress: 'طبق برنامه', financialStatus: 'حاشیهٔ سود ۳۲٪', createdById: creator.id },
    })).id;
    const mine = await mk(projectId);
    const theirs = await mk(otherProjectId);
    expect(expectOk(await pget(`/portal/projects/${projectId}`, client), 'reports').reports.map((r: any) => r.id)).toEqual([mine]);
    const pdf = await pget(`/portal/status-reports/${mine}`, client);
    expect(pdf.status).toBe(200);
    expect(String(pdf.body).startsWith('%PDF')).toBe(true);
    expect((await pget(`/portal/status-reports/${theirs}`, client)).status).toBe(404);
  }, 60_000);

  it('lets the addressee — and only the addressee — decide an approval from the portal, recorded as a portal decision', async () => {
    const file = expectOk(await upload(T.am, { name: 'teaser.pdf', type: 'application/pdf', content: tinyPdf('teaser') }, { deliverableId }), 'file').id;
    const a = expectOk(await post('/client-approvals', T.am, { subjectType: 'DELIVERABLE', subjectId: deliverableId, contactId: maryam }), 'request');
    const home = expectOk(await pget('/portal/home', client), 'home');
    expect(home.approvals).toEqual([expect.objectContaining({ id: a.id, forMe: true, title: 'تیزر ۳۰ ثانیه' })]);
    expect(expectOk(await pget('/portal/home', colleague), 'colleague home').approvals[0].forMe).toBe(false);

    expect(expectOk(await pget(`/portal/approvals/${a.id}`, colleague), 'colleague view')).toMatchObject({ forMe: false, verification: 'PORTAL' });
    expect((await pget(`/portal/approvals/${a.id}/files/${file}`, colleague)).status).toBe(403);
    const d = { decision: 'APPROVE', signerName: 'علی رضایی', confirm: true };
    expect((await ppost(`/portal/approvals/${a.id}/decision`, colleague, d)).status).toBe(403);

    expect((await pget(`/portal/approvals/${a.id}/files/${file}`, client)).status).toBe(200);
    const done = expectOk(await ppost(`/portal/approvals/${a.id}/decision`, client, { ...d, signerName: 'مریم احمدی' }), 'decide');
    expect(done.status).toBe('APPROVED');
    const row = await prisma.clientApproval.findUniqueOrThrow({ where: { id: a.id } });
    const me = await prisma.portalUser.findUniqueOrThrow({ where: { email: 'maryam@portalia.example' } });
    expect(row).toMatchObject({ verification: 'PORTAL' });
    expect((row.evidence as any).portalUserId).toBe(me.id);
    expect((await prisma.deliverable.findUniqueOrThrow({ where: { id: deliverableId } })).state).toBe('ACCEPTED');
    expect(expectOk(await get(`/client-approvals/${a.id}/verify`, T.am), 'verify').ok).toBe(true);
  });

  it('ends every session at once when Account disables the account — and a new invitation is a password reset', async () => {
    const u = await prisma.portalUser.findUniqueOrThrow({ where: { email: 'maryam@portalia.example' } });
    expectOk(await post(`/portal-users/${u.id}/disable`, T.am), 'disable');
    expect((await pget('/portal/home', client)).status).toBe(401);
    expect((await ppost('/portal/auth/login', '', { email: 'maryam@portalia.example', password: PASSWORD })).status).toBe(401);
    const again = expectOk(await post(`/portal-users/${u.id}/reinvite`, T.am), 'reinvite');
    expect(again.user.status).toBe('INVITED');
    const fresh = expectOk(await ppost('/portal/auth/accept', '', { token: tokenOf(again.link), password: 'Another-Portal-2026' }), 'reset');
    expect((await pget('/portal/home', fresh.token)).status).toBe(200);
    expect((await ppost('/portal/auth/login', '', { email: 'maryam@portalia.example', password: PASSWORD })).status).toBe(401);
  });
});
