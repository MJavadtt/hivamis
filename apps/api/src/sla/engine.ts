import type { Tx } from '../db.js';
import { prisma } from '../db.js';
import { addBusinessHours, businessHoursBetween, DEFAULT_CALENDAR, type Calendar } from '../lib/business-calendar.js';
import { appUrl, notify, slaBreachMail, slaWarningMail } from '../mail/notify.js';
import type { MailBody } from '../mail/templates.js';

/**
 * Keyed by organisation, not a single slot. The cache previously held one calendar for the whole
 * process, so a second organisation would inherit the first one's working week and holidays for
 * up to a minute — and SLA due dates computed from the wrong calendar are silently wrong.
 */
const cachedCalendars = new Map<string, { at: number; cal: Calendar }>();
const CALENDAR_TTL_MS = 60_000;

/** Loads the organisation's working week + holidays; cached briefly to keep the tick cheap. */
export async function loadCalendar(organizationId: string, tx: Tx = prisma): Promise<Calendar> {
  const hit = cachedCalendars.get(organizationId);
  if (hit && Date.now() - hit.at < CALENDAR_TTL_MS) return hit.cal;
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
  cachedCalendars.set(organizationId, { at: Date.now(), cal });
  return cal;
}

export function resetCalendarCache(): void {
  cachedCalendars.clear();
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
  if (running.length === 0) return { warned: 0, breached: 0 };

  // One calendar per organisation, not one per clock: the tick spans tenants and each has its
  // own working week and holidays.
  const calendars = new Map<string, Calendar>();
  for (const orgId of new Set(running.map((c) => c.organizationId))) {
    calendars.set(orgId, await loadCalendar(orgId));
  }

  const toBreach: string[] = [];
  const toWarn: string[] = [];
  const notifications: { clock: (typeof running)[number]; kind: 'SLA_BREACH' | 'SLA_WARNING' }[] = [];

  for (const clock of running) {
    if (now > clock.dueAt && clock.state !== 'BREACHED') {
      toBreach.push(clock.id);
      notifications.push({ clock, kind: 'SLA_BREACH' });
      continue;
    }

    /**
     * Consumption is measured in WORKING hours, not wall-clock.
     *
     * The ratio used to be (now - startedAt) / (dueAt - startedAt), both calendar durations. A
     * clock opened Wednesday 17:00 under a 4-working-hour policy is due Saturday — so by Thursday
     * noon the wall-clock ratio was already past warnAt and the owner was told the deadline was
     * nearly up, in the middle of the Thursday–Friday weekend, having consumed zero working
     * hours. False alarms teach people to ignore real ones.
     */
    const cal = calendars.get(clock.organizationId) ?? DEFAULT_CALENDAR;
    const consumed = businessHoursBetween(clock.startedAt, now, cal);
    const budget = Number(clock.policy.hours);
    const ratio = budget > 0 ? consumed / budget : 1;

    if (ratio >= Number(clock.policy.warnAt) && clock.state === 'RUNNING') {
      toWarn.push(clock.id);
      notifications.push({ clock, kind: 'SLA_WARNING' });
    }
  }

  // Two statements instead of one UPDATE per clock.
  if (toBreach.length) {
    await prisma.slaClock.updateMany({
      where: { id: { in: toBreach } },
      data: { state: 'BREACHED', breachedAt: now },
    });
  }
  if (toWarn.length) {
    await prisma.slaClock.updateMany({
      where: { id: { in: toWarn } },
      data: { state: 'AT_RISK', warnedAt: now },
    });
  }

  // Notifications stay per-clock: each names its own policy and entity.
  for (const { clock, kind } of notifications) {
    const url = appUrl(`/${clock.entityType}s/${clock.entityId}`);
    await notifyOwner(
      clock.ownerId,
      kind === 'SLA_BREACH'
        ? {
            kind: 'SLA_BREACH',
            title: `نقض SLA — ${clock.policy.labelFa}`,
            body: `مهلت «${clock.policy.labelFa}» برای ${clock.entityType} گذشته است.`,
            entityType: clock.entityType, entityId: clock.entityId, severity: 'CRITICAL',
          }
        : {
            kind: 'SLA_WARNING',
            title: `هشدار SLA — ${clock.policy.labelFa}`,
            body: `مهلت «${clock.policy.labelFa}» رو به اتمام است.`,
            entityType: clock.entityType, entityId: clock.entityId, severity: 'WARNING',
          },
      kind === 'SLA_BREACH'
        ? slaBreachMail({
            policyFa: clock.policy.labelFa, entityFa: clock.entityType,
            code: clock.entityId.slice(0, 8), url,
          })
        : slaWarningMail({
            policyFa: clock.policy.labelFa, entityFa: clock.entityType,
            code: clock.entityId.slice(0, 8),
            remainingFa: 'کمتر از یک‌چهارم مهلت', url,
          }),
    );
  }

  return { warned: toWarn.length, breached: toBreach.length };
}

/**
 * Routed through the shared notifier so a four-working-hour deadline can reach someone who does
 * not have the app open — which is most of them, most of the time.
 */
async function notifyOwner(
  userId: string | null,
  n: { kind: string; title: string; body: string; entityType: string; entityId: string; severity: string },
  mail?: MailBody,
): Promise<void> {
  await notify({ userId, ...n, mail });
}
