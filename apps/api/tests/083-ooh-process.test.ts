import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeApp, get, login, move, post } from './helpers.js';
import { prisma } from '../src/db.js';
import { nextCode } from '../src/lib/codes.js';

/**
 * The owner's «فرآیند محیطی» (2026-11-02, ADR-120). A proposal the media unit worked on is approved by
 * that unit's manager after pricing, before final QC; one it did not work on goes to final QC as before.
 * Only the media unit's manager approves or sends back, and sending back takes a reason. A deliverable
 * says what it is — an out-of-home display's artwork or one of its reports — and the order it is made under.
 */

describe('The media manager’s approval of a proposal (فرآیند محیطی)', () => {
  const T: Record<string, string> = {};
  let orgId: string;
  let projectId: string;

  /** A priced proposal, with or without an order to the media unit. */
  async function priced(withMedia: boolean) {
    const brief = await prisma.brief.findFirstOrThrow({ where: { organizationId: orgId } });
    const proposal = await prisma.proposal.create({
      data: { organizationId: orgId, code: await nextCode(prisma, 'proposal'), briefId: brief.id, title: `پروپوزال ${withMedia ? 'محیطی' : 'بی‌رسانه'}`, state: 'PRICING', salePrice: 100, pricedAt: new Date() },
    });
    if (withMedia) {
      const owner = await prisma.user.findFirstOrThrow({ where: { email: 'media@hiva.local' } });
      await prisma.workOrder.create({
        data: {
          organizationId: orgId, code: await nextCode(prisma, 'workOrder'), projectId, proposalId: proposal.id, targetDepartmentCode: 'ME',
          title: 'پیشنهاد بیلبورد', scopeOfWork: 'x', brief: 'y', expectedOutput: 'z', outputFormat: 'PDF', deadline: new Date(), ownerId: owner.id, state: 'COMPLETED',
        },
      });
    }
    return proposal.id;
  }

  beforeAll(async () => {
    T.accountManager = await login('account.manager@hiva.local');
    T.media = await login('media@hiva.local');
    T.creative = await login('creative@hiva.local');
    const project = await prisma.project.findFirstOrThrow({ where: { company: { legalName: { not: '' } } } });
    orgId = project.organizationId;
    projectId = project.id;
  }, 60_000);
  afterAll(closeApp);

  it('sends a proposal the media unit worked on to its manager, not straight to final QC', async () => {
    const id = await priced(true);
    const skip = await move('proposal', id, 'send_to_final_qc', T.accountManager);
    expect(skip.status).toBe(422);
    expect(JSON.stringify(skip.body)).toContain('مدیر واحد رسانه');
    expect((await move('proposal', id, 'send_to_unit_approval', T.accountManager)).status).toBe(200);
    expect((await prisma.proposal.findUniqueOrThrow({ where: { id } })).state).toBe('UNIT_APPROVAL');
  });

  it('lets only the media unit’s manager approve, and asks a reason to send it back', async () => {
    const id = await priced(true);
    await move('proposal', id, 'send_to_unit_approval', T.accountManager);
    // Another unit's manager holds the permission but is not the media unit's.
    expect((await move('proposal', id, 'unit_approve', T.creative)).status).toBe(422);
    // The account manager holds every permission, and still is not.
    expect((await move('proposal', id, 'unit_approve', T.accountManager)).status).toBe(422);
    expect((await move('proposal', id, 'unit_return', T.media)).status).toBe(400);
    expect((await move('proposal', id, 'unit_return', T.media, 'قیمت بیلبوردها با نرخ امسال نمی‌خواند')).status).toBe(200);
    expect((await prisma.proposal.findUniqueOrThrow({ where: { id } })).state).toBe('PRICING');
    await move('proposal', id, 'send_to_unit_approval', T.accountManager);
    expect((await move('proposal', id, 'unit_approve', T.media)).status).toBe(200);
    expect((await prisma.proposal.findUniqueOrThrow({ where: { id } })).state).toBe('FINAL_QC');
  });

  it('puts the approval in the media manager’s work, and nobody else’s', async () => {
    const id = await priced(true);
    await move('proposal', id, 'send_to_unit_approval', T.accountManager);
    const mine = await get('/me/work', T.media);
    const item = mine.body.items.find((i: { entityId: string }) => i.entityId === id);
    expect(item).toMatchObject({ kind: 'unitApproval', entityType: 'proposal', state: 'UNIT_APPROVAL' });
    expect(item.availableTransitions.map((t: { action: string }) => t.action).sort()).toEqual(['unit_approve', 'unit_return']);
    const theirs = await get('/me/work', T.creative);
    expect(theirs.body.items.some((i: { entityId: string }) => i.entityId === id)).toBe(false);
  });

  it('leaves a proposal the media unit did not work on on its old road', async () => {
    const id = await priced(false);
    expect((await move('proposal', id, 'send_to_unit_approval', T.accountManager)).status).toBe(422);
    expect((await move('proposal', id, 'send_to_final_qc', T.accountManager)).status).toBe(200);
  });

  it('records what a deliverable is and the order it is made under', async () => {
    const order = await prisma.workOrder.findFirstOrThrow({ where: { projectId, targetDepartmentCode: 'ME' } });
    const res = await post('/deliverables', T.accountManager, {
      projectId, workOrderId: order.id, kind: 'OOH_START_REPORT', name: 'گزارش شروع اکران', departmentCode: 'ME',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'OOH_START_REPORT', workOrderId: order.id });
    expect((await post('/deliverables', T.accountManager, { projectId, kind: 'SOMETHING_ELSE', name: 'x x', departmentCode: 'ME' })).status).toBe(400);
  });
});
