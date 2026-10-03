/**
 * Who hears about a move once it has happened (roadmap #49). Two moves hand someone work whose
 * deadline is hours: an issued work order goes to its owner to accept, and a submitted deliverable
 * waits for its own unit's check before Account sees it. Until now both waited in a queue for
 * whoever happened to open it.
 *
 * Sent after the commit, never inside it: a notice about a move that rolled back would be a lie.
 */
import { prisma } from '../db.js';
import { notify } from '../mail/notify.js';
import type { TransitionOutcome } from './engine.js';

const at = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', weekday: 'long', hour: '2-digit', minute: '2-digit' });

export async function noticesAfter(out: TransitionOutcome, actor: { id: string; organizationId: string }): Promise<void> {
  const r = out.record;

  if (out.entity === 'workOrder' && (out.action === 'issue' || out.action === 'clarify') && r.ownerId && r.ownerId !== actor.id) {
    // The deadline as the clock has it — the organisation may have changed the four hours (#48).
    const clock = await prisma.slaClock.findFirst({
      where: { entityType: 'workOrder', entityId: out.id, state: { in: ['RUNNING', 'AT_RISK'] }, policy: { code: 'SLA_TASK_ACCEPTANCE' } },
      select: { dueAt: true }, orderBy: { createdAt: 'desc' },
    });
    const due = clock ? ` مهلت پذیرش: ${at.format(clock.dueAt)}.` : '';
    await notify({
      userId: r.ownerId,
      kind: out.action === 'issue' ? 'WORK_ORDER_ISSUED' : 'WORK_ORDER_CLARIFIED',
      title: out.action === 'issue' ? `سفارش کار تازه: ${r.title}` : `ابهام سفارش رفع شد: ${r.title}`,
      body: out.action === 'issue'
        ? `${r.code} — بپذیرید یا ابهام را اعلام کنید.${due}`
        : `${r.code} — پاسخ ابهام آمد و مهلت پذیرش دوباره روان است.${due}`,
      entityType: 'workOrder', entityId: out.id, severity: 'INFO',
    });
  }

  if (out.entity === 'deliverable' && out.action === 'submit') {
    // Level-1 QC is the unit manager's (Doc_H §9) — every member holds qc.unit to see the queue,
    // but the phone that buzzes is the manager's, and their delegate's in the unit while they are
    // away (the queue is the unit's, so a notice elsewhere would lead nowhere). Without a manager
    // on record, whoever holds the unit-manager role there.
    const now = new Date();
    const dept = await prisma.department.findFirst({ where: { organizationId: actor.organizationId, code: r.departmentCode }, select: { managerId: true } });
    const standIns = dept?.managerId
      ? (await prisma.delegation.findMany({
          where: { fromUserId: dept.managerId, permissions: { has: 'qc.unit' }, revokedAt: null, startsAt: { lte: now }, endsAt: { gte: now } },
          select: { toUserId: true },
        })).map((d) => d.toUserId)
      : [];
    const reviewers = await prisma.user.findMany({
      where: {
        organizationId: actor.organizationId, isActive: true, deletedAt: null,
        AND: [
          { id: { not: actor.id } },
          dept?.managerId
            ? { OR: [{ id: dept.managerId, roles: { some: { role: { permissions: { some: { permission: { code: 'qc.unit' } } } } } } }, { id: { in: standIns }, department: { code: r.departmentCode } }] }
            : { department: { code: r.departmentCode }, roles: { some: { role: { code: 'UNIT_MANAGER' } } } },
        ],
      },
      select: { id: true }, take: 10,
    });
    for (const u of reviewers) {
      await notify({
        userId: u.id, kind: 'QC_UNIT_REQUIRED',
        title: `QC واحد: ${r.name}`,
        body: `${r.code} تحویل شد؛ پیش از اکانت، بررسی واحد را می‌خواهد.`,
        entityType: 'deliverable', entityId: out.id, severity: 'INFO',
      });
    }
  }
}
