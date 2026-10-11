import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { call, closeApp, get, patch, post } from './helpers.js';
import { prisma } from '../src/db.js';
import { tenancy } from '../src/lib/tenant.js';
import { sandboxChat } from '../src/messenger/service.js';
import { twoOrgs, type TwoOrgs } from './helpers/two-orgs.js';

/**
 * Audit SEC-2b: what the sweep of every unscoped query turned up beyond contacts and allocations.
 * Each case is a route that reached another organisation's record through an id in its path, its
 * body or a form's field — and now answers as if the record did not exist.
 */
describe('References across organisations (audit SEC-2b)', () => {
  let orgs: TwoOrgs;
  let bProject: { id: string; companyId: string };
  let bUser: { id: string };
  let A: string;

  beforeAll(async () => {
    orgs = await twoOrgs();
    A = orgs.a.full.token;
    bProject = await prisma.project.findFirstOrThrow({ where: { organizationId: orgs.b.id }, select: { id: true, companyId: true } });
    bUser = await prisma.user.findFirstOrThrow({ where: { organizationId: orgs.b.id, email: 'pmo@hiva.local' }, select: { id: true } });
  }, 120_000);
  afterAll(async () => { tenancy.mode = 'single'; await closeApp(); });

  const closureOf = () => prisma.closureChecklist.findUnique({ where: { projectId: bProject.id } });

  it('keeps another organisation’s closure checklist out of reach: read, edited, or ticked by a feedback or a lesson', async () => {
    const before = await closureOf();
    expect((await get(`/projects/${bProject.id}/closure`, A)).status).toBe(404);
    expect((await patch(`/projects/${bProject.id}/closure`, A, { finalQcDone: true })).status).toBe(404);
    const feedback = await post('/feedbacks', A, { projectId: bProject.id, csat: 5, nps: 10 });
    expect(feedback.body.error.code).toBe('UNKNOWN_REFERENCE');
    const lesson = await post('/lessons-learned', A, { projectId: bProject.id, title: 'درس', category: 'PROCESS', situation: 'شرح', lesson: 'درس', recommendation: 'توصیه' });
    expect(lesson.body.error.code).toBe('UNKNOWN_REFERENCE');
    expect(await closureOf()).toEqual(before);
  });

  it('refuses a form that names another organisation’s project — its binding would write there', async () => {
    const sent = await post('/forms/submissions', A, {
      formCode: 'M121_LESSONS_LEARNED',
      data: { projectId: bProject.id, title: 'درس', category: 'PROCESS', situation: 'شرح', lesson: 'درس', recommendation: 'توصیه' },
    });
    expect(sent.status).toBe(422);
    expect(sent.body.error).toMatchObject({ code: 'UNKNOWN_REFERENCE', details: { field: 'projectId' } });
    expect(await prisma.formSubmission.count({ where: { organizationId: orgs.a.id } })).toBe(0);
  });

  it('lets no approver decide another organisation’s form, whatever their role', async () => {
    const definition = await prisma.formDefinition.findFirstOrThrow({ where: { organizationId: orgs.b.id, code: 'M121_LESSONS_LEARNED' } });
    const pending = await prisma.formSubmission.create({
      data: {
        organizationId: orgs.b.id, code: 'FRM-B-PENDING', definitionId: definition.id, definitionVersion: definition.version,
        data: {}, state: 'PENDING_APPROVAL', requiredRoles: ['SUPER_ADMIN'], currentRoles: ['SUPER_ADMIN'], submittedById: bUser.id, submittedAt: new Date(),
      },
    });
    // A's administrator holds SUPER_ADMIN — the very role this submission waits for, in B.
    const decided = await post(`/forms/submissions/${pending.id}/decision`, A, { decision: 'APPROVE' });
    expect(decided.status).toBe(404);
    expect((await prisma.formSubmission.findUniqueOrThrow({ where: { id: pending.id } })).state).toBe('PENDING_APPROVAL');
  });

  it('keeps another organisation’s RACI matrix as it was', async () => {
    const before = await prisma.raciAssignment.findMany({ where: { projectId: bProject.id }, orderBy: { id: 'asc' } });
    const res = await post(`/projects/${bProject.id}/raci`, A, { entries: [{ activity: 'نفوذ', departmentCode: 'A', raciRole: 'R' }] });
    expect(res.status).toBe(404);
    expect(await prisma.raciAssignment.findMany({ where: { projectId: bProject.id }, orderBy: { id: 'asc' } })).toEqual(before);
  });

  it('checks every id a hand-written create carries: invoices, meetings, QC reviews, activities', async () => {
    const invoice = await post('/invoices', A, { kind: 'INVOICE', companyId: bProject.companyId, number: '1', issueDate: '2026-10-10', lines: [{ description: 'x', quantity: 1, unitPrice: 1 }], taxPercent: 0 });
    expect(invoice.body.error.code).toBe('UNKNOWN_REFERENCE');
    const meeting = await post('/meetings', A, { projectId: bProject.id, kind: 'INTERNAL', subject: 'جلسه', heldAt: '2026-10-10T08:00:00Z', attendees: 'من و تو', actions: [] });
    expect(meeting.body.error.code).toBe('UNKNOWN_REFERENCE');
    const deliverable = await prisma.deliverable.findFirstOrThrow({ where: { organizationId: orgs.b.id } });
    const review = await post('/qc-reviews', A, { level: 'ACCOUNT', deliverableId: deliverable.id, verdict: 'FAILED', checklist: {}, findings: 'x' });
    expect(review.body.error.code).toBe('UNKNOWN_REFERENCE');
    expect(await prisma.revision.count({ where: { deliverableId: deliverable.id, organizationId: orgs.a.id } })).toBe(0);
    const activity = await post('/activities', A, { kind: 'CALL', occurredAt: '2026-10-10T08:00:00Z', summary: 'تماس', companyId: bProject.companyId });
    expect(activity.body.error.code).toBe('UNKNOWN_REFERENCE');
  });

  it('lends authority only from within the organisation', async () => {
    const res = await post('/delegations', A, {
      fromUserId: bUser.id, toUserId: (await prisma.user.findFirstOrThrow({ where: { email: 'rep@alef.test' } })).id,
      permissions: ['task.read'], startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), reason: 'x',
    });
    expect(res.status).toBe(404);
  });

  it('files a sandbox chat under the organisation of the person on the page, not the installation’s first', async () => {
    const me = await prisma.user.findFirstOrThrow({ where: { email: 'boss@alef.test' } });
    expect((await post('/messenger/sandbox/send', A, { text: 'سلام' })).status).toBe(200);
    const filed = await prisma.messengerMessage.findMany({ where: { chatId: sandboxChat(me.id) } });
    expect(filed.length).toBeGreaterThan(0);
    expect(filed.every((m) => m.organizationId === orgs.a.id)).toBe(true);
  });

  it('shows a project’s own clocks in its 360 view — its records’, and nothing of another organisation’s', async () => {
    const company = await prisma.company.create({ data: { organizationId: orgs.a.id, legalName: 'مشتری الف' } });
    const owner = await prisma.user.findFirstOrThrow({ where: { email: 'boss@alef.test' } });
    const project = await prisma.project.create({ data: { organizationId: orgs.a.id, code: 'PRJ-ALEF', name: 'پروژهٔ الف', companyId: company.id, accountOwnerId: owner.id } });
    const deliverable = await prisma.deliverable.create({ data: { organizationId: orgs.a.id, code: 'DLV-ALEF', projectId: project.id, name: 'خروجی', departmentCode: 'CR' } });
    const policy = await prisma.slaPolicy.findFirstOrThrow({ where: { organizationId: orgs.a.id } });
    const now = new Date();
    const clock = (entityType: string, entityId: string, organizationId: string, policyId: string) => prisma.slaClock.create({
      data: { organizationId, policyId, entityType, entityId, state: 'RUNNING', dueAt: new Date(now.getTime() + 86_400_000) },
    });
    const own = await clock('deliverable', deliverable.id, orgs.a.id, policy.id);
    const bPolicy = await prisma.slaPolicy.findFirstOrThrow({ where: { organizationId: orgs.b.id } });
    const theirs = await clock('project', bProject.id, orgs.b.id, bPolicy.id);
    const view = await get(`/projects/${project.id}/360`, A);
    expect(view.status).toBe(200);
    const ids = view.body.slaClocks.map((c: { id: string }) => c.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(theirs.id);
  });

  it('keeps the closure checklist’s change in the audit trail, in the same transaction', async () => {
    const mine = await prisma.project.findFirstOrThrow({ where: { organizationId: orgs.b.id } });
    expect((await patch(`/projects/${mine.id}/closure`, orgs.b.full.token, { notes: 'یادداشت' })).status).toBe(200);
    expect(await prisma.auditEvent.count({ where: { organizationId: orgs.b.id, entityType: 'closureChecklist', action: 'UPDATE' } })).toBeGreaterThan(0);
    void call;
  });
});
