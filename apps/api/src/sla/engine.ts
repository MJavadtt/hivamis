import type { Tx } from '../db.js';
import { prisma } from '../db.js';
import { addBusinessHours, DEFAULT_CALENDAR, type Calendar } from '../lib/business-calendar.js';

let cachedCalendar: { at: number; cal: Calendar } | null = null;
const CALENDAR_TTL_MS = 60_000;

/** Loads the organisation's working week + holidays; cached briefly to keep the tick cheap. */
export async function loadCalendar(organizationId: string, tx: Tx = prisma): Promise<Calendar> {
  if (cachedCalendar && Date.now() - cachedCalendar.at < CALENDAR_TTL_MS) return cachedCalendar.cal;
  const org = await tx.organization.findUnique({
    where: { id: organizationId },
    include: { holidays: true },
  });
  const cal: Calendar = org
    ? {
        workingDays: org.workingDays,
        startHour: org.workStartHour,
        endHour: org.workEndHour,
        breakHours: org.breakHours,
        holidays: new Set(org.holidays.map((h) => h.date.toISOString().slice(0, 10))),
      }
    : DEFAULT_CALENDAR;
  cachedCalendar = { at: Date.now(), cal };
  return cal;
}

export function resetCalendarCache(): void {
  cachedCalendar = null;
}

export interface StartSlaInput {
  organizationId: string;
  policyCode: string;
  entityType: string;
  entityId: string;
  ownerId?: string | null;
}

/**
 * Start an SLA clock. `dueAt` is computed in *working* hours against the organisation calendar,
 * matching Doc_H's «۴ ساعت کاری» / «۱ روز کاری» phrasing.
 * Re-starting an already-running clock for the same policy+entity is a no-op.
 */
export async function startSla(tx: Tx, input: StartSlaInput): Promise<void> {
  const policy = await tx.slaPolicy.findUnique({ where: { code: input.policyCode } });
  if (!policy || !policy.isActive) return;

  const existing = await tx.slaClock.findFirst({
    where: {
      policyId: policy.id,
      entityType: input.entityType,
      entityId: input.entityId,
      state: { in: ['RUNNING', 'AT_RISK'] },
    },
  });
  if (existing) return;

  const cal = await loadCalendar(input.organizationId, tx);
  const startedAt = new Date();
  const dueAt = addBusinessHours(startedAt, Number(policy.hours), cal);

  await tx.slaClock.create({
    data: {
      organizationId: input.organizationId,
      policyId: policy.id,
      entityType: input.entityType,
      entityId: input.entityId,
      startedAt,
      dueAt,
      ownerId: input.ownerId ?? null,
      state: 'RUNNING',
    },
  });
}

/** Stop the named clocks on an entity, recording whether they were met or already breached. */
export async function stopSla(
  tx: Tx,
  policyCodes: readonly string[],
  entityType: string,
  entityId: string,
): Promise<void> {
  if (policyCodes.length === 0) return;
  const policies = await tx.slaPolicy.findMany({ where: { code: { in: [...policyCodes] } } });
  if (policies.length === 0) return;
  const now = new Date();

  const clocks = await tx.slaClock.findMany({
    where: {
      policyId: { in: policies.map((p) => p.id) },
      entityType,
      entityId,
      state: { in: ['RUNNING', 'AT_RISK', 'PAUSED'] },
    },
  });

  for (const clock of clocks) {
    await tx.slaClock.update({
      where: { id: clock.id },
      data: { stoppedAt: now, state: now <= clock.dueAt ? 'MET' : 'BREACHED', breachedAt: now > clock.dueAt ? (clock.breachedAt ?? now) : clock.breachedAt },
    });
  }
}

export async function cancelSla(tx: Tx, entityType: string, entityId: string): Promise<void> {
  await tx.slaClock.updateMany({
    where: { entityType, entityId, state: { in: ['RUNNING', 'AT_RISK', 'PAUSED'] } },
    data: { state: 'CANCELLED', stoppedAt: new Date() },
  });
}

export interface SlaTickResult {
  warned: number;
  breached: number;
}

/**
 * Move running clocks into AT_RISK / BREACHED and notify the owner.
 * Invoked on a schedule by the job runner and callable directly from tests.
 */
export async function tickSlaClocks(now = new Date()): Promise<SlaTickResult> {
  const running = await prisma.slaClock.findMany({
    where: { state: { in: ['RUNNING', 'AT_RISK'] } },
    include: { policy: true },
  });

  let warned = 0;
  let breached = 0;

  for (const clock of running) {
    const totalMs = clock.dueAt.getTime() - clock.startedAt.getTime();
    const elapsedMs = now.getTime() - clock.startedAt.getTime();
    const ratio = totalMs > 0 ? elapsedMs / totalMs : 1;

    if (now > clock.dueAt && clock.state !== 'BREACHED') {
      await prisma.slaClock.update({
        where: { id: clock.id },
        data: { state: 'BREACHED', breachedAt: now },
      });
      breached++;
      await notifyOwner(clock.ownerId, {
        kind: 'SLA_BREACH',
        title: `نقض SLA — ${clock.policy.labelFa}`,
        body: `مهلت «${clock.policy.labelFa}» برای ${clock.entityType} گذشته است.`,
        entityType: clock.entityType,
        entityId: clock.entityId,
        severity: 'CRITICAL',
      });
      continue;
    }

    if (ratio >= Number(clock.policy.warnAt) && clock.state === 'RUNNING') {
      await prisma.slaClock.update({
        where: { id: clock.id },
        data: { state: 'AT_RISK', warnedAt: now },
      });
      warned++;
      await notifyOwner(clock.ownerId, {
        kind: 'SLA_WARNING',
        title: `هشدار SLA — ${clock.policy.labelFa}`,
        body: `مهلت «${clock.policy.labelFa}» رو به اتمام است.`,
        entityType: clock.entityType,
        entityId: clock.entityId,
        severity: 'WARNING',
      });
    }
  }

  return { warned, breached };
}

async function notifyOwner(
  userId: string | null,
  n: { kind: string; title: string; body: string; entityType: string; entityId: string; severity: string },
): Promise<void> {
  if (!userId) return;
  await prisma.notification.create({ data: { userId, ...n } }).catch(() => undefined);
}
