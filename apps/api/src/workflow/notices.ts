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
  if (out.entity === 'booking') return bookingNotices(out, actor);

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

/**
 * Who hears about a booking's move (audit F-9). The approver, when one waits on them; the organiser,
 * when the approver has answered; the participants, once it is certain or once it is called off.
 * Each notice names the booking's code and time — the bot shows it with the buttons that act on it.
 */
export async function bookingNotices(out: TransitionOutcome, actor: { id: string; organizationId: string }): Promise<void> {
  if (out.entity !== 'booking') return;
  const r = out.record;
  const org = await prisma.organization.findUnique({ where: { id: actor.organizationId }, select: { timezone: true } });
  const when = new Intl.DateTimeFormat('fa-IR', { timeZone: org?.timezone ?? 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const room = r.roomId ? (await prisma.bookableResource.findUnique({ where: { id: r.roomId }, select: { name: true } }))?.name : r.placeNote;
  const at = `${when.format(new Date(r.startsAt))}${room ? `، ${room}` : ''}`;
  const base = { entityType: 'booking', entityId: out.id, severity: 'INFO' as const };
  const participants = async () => (await prisma.bookingParticipant.findMany({ where: { bookingId: out.id }, select: { userId: true } })).map((p) => p.userId);

  if ((out.action === 'submit' || out.action === 'reschedule') && r.approverId) {
    await notify({ ...base, userId: r.approverId, kind: 'BOOKING_APPROVAL_REQUIRED', title: `درخواست رزرو جلسه: ${r.title}`, body: `${r.code} — ${at}. تأیید یا رد کنید.` });
  }
  if (out.action === 'approve') {
    await notify({ ...base, userId: r.organizerId, kind: 'BOOKING_APPROVED', title: `رزرو تأیید شد: ${r.title}`, body: `${r.code} — ${at}. برای نگه داشتن اتاق و افراد، قطعی‌اش کنید.` });
  }
  if (out.action === 'request_changes' || out.action === 'reject') {
    await notify({
      ...base, userId: r.organizerId, kind: out.action === 'reject' ? 'BOOKING_REJECTED' : 'BOOKING_CHANGES_REQUESTED',
      title: `${out.action === 'reject' ? 'رزرو رد شد' : 'رزرو نیازمند اصلاح است'}: ${r.title}`, body: `${r.code} — ${r.decisionNote ?? ''}`.trim(),
    });
  }
  if (out.action === 'confirm') {
    for (const userId of await participants()) {
      await notify({ ...base, userId, kind: 'BOOKING_INVITED', title: `دعوت به جلسه: ${r.title}`, body: `${r.code} — ${at}.` });
    }
  }
  if (out.action === 'cancel') {
    const told = new Set([...(out.fromState === 'CONFIRMED' ? await participants() : []), ...(out.fromState === 'PENDING_APPROVAL' && r.approverId ? [r.approverId] : []), r.organizerId]);
    told.delete(actor.id);
    for (const userId of told) {
      await notify({ ...base, userId, kind: 'BOOKING_CANCELLED', title: `جلسه لغو شد: ${r.title}`, body: `${r.code} — ${at}. ${r.cancelReason ?? ''}`.trim() });
    }
  }
}
