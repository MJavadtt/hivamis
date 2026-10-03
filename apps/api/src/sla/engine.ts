import type { Tx } from '../db.js';
import { prisma } from '../db.js';
import { addBusinessHours, businessHoursBetween, DEFAULT_CALENDAR, type Calendar } from '../lib/business-calendar.js';
import { appUrl, notify, slaBreachMail, slaWarningMail } from '../mail/notify.js';
import type { MailBody } from '../mail/templates.js';
import type { SlaPauseKind } from '@hiva/contracts';

/**
 * Keyed by organisation, department and person — one calendar per scope, cached briefly to keep
 * the tick cheap. The cache previously held one calendar for the whole process, so a second
 * organisation would inherit the first one's working week and holidays for up to a minute — and
 * SLA due dates computed from the wrong calendar are silently wrong.
 */
const cachedCalendars = new Map<string, { at: number; cal: Calendar }>();
const CALENDAR_TTL_MS = 60_000;

export interface CalendarScope {
  /** Narrow to a unit: its working days and hours override the organisation's. */
  departmentCode?: string | null;
  /** Narrow to a person: their overrides beat the unit's, and their leaves are days off. */
  userId?: string | null;
}

/** The day span of a leave as YYYY-MM-DD strings, inclusive. */
function leaveDays(from: Date, to: Date): string[] {
  const days: string[] = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  for (let guard = 0; d <= end && guard < 400; guard++, d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

/**
 * The working calendar in force for a scope (roadmap #13). Inheritance is organisation →
 * department → person: a field set on a narrower scope wins, a null one inherits. A person's
 * leaves are added to the holidays, so they have no working hours on those days — which is what
 * makes a clock they own stop consuming budget while they are away.
 */
export async function loadCalendar(
  organizationId: string, scopeOrTx?: CalendarScope | Tx, maybeTx?: Tx,
): Promise<Calendar> {
  // Backwards compatible with the old (organizationId, tx) signature.
  const scope: CalendarScope = scopeOrTx && !('organization' in (scopeOrTx as object)) ? (scopeOrTx as CalendarScope) : {};
  const tx: Tx = (scopeOrTx && 'organization' in (scopeOrTx as object) ? (scopeOrTx as Tx) : maybeTx) ?? prisma;

  const key = `${organizationId}|${scope.departmentCode ?? ''}|${scope.userId ?? ''}`;
  const hit = cachedCalendars.get(key);
  if (hit && Date.now() - hit.at < CALENDAR_TTL_MS) return hit.cal;

  const org = await tx.organization.findUnique({ where: { id: organizationId }, include: { holidays: true } });
  let cal: Calendar = org
    ? {
        workingDays: org.workingDays,
        startHour: org.workStartHour,
        endHour: org.workEndHour,
        breakHours: org.breakHours,
        holidays: new Set(org.holidays.map((h) => h.date.toISOString().slice(0, 10))),
      }
    : { ...DEFAULT_CALENDAR, holidays: new Set() };

  // A person's department is the one on their record unless the caller says otherwise.
  let departmentCode = scope.departmentCode ?? null;
  const user = scope.userId
    ? await tx.user.findUnique({
        where: { id: scope.userId },
        select: {
          workingDays: true, workStartHour: true, workEndHour: true,
          department: { select: { code: true } }, leaves: { select: { from: true, to: true } },
        },
      })
    : null;
  if (user) departmentCode ??= user.department?.code ?? null;
  if (departmentCode) {
    const dept = await tx.department.findFirst({
      where: { organizationId, code: departmentCode },
      select: { workingDays: true, workStartHour: true, workEndHour: true, breakHours: true },
    });
    if (dept) {
      cal = {
        ...cal,
        workingDays: dept.workingDays.length ? dept.workingDays : cal.workingDays,
        startHour: dept.workStartHour ?? cal.startHour,
        endHour: dept.workEndHour ?? cal.endHour,
        breakHours: dept.breakHours ?? cal.breakHours,
      };
    }
  }
  if (user) {
    const holidays = new Set(cal.holidays);
    for (const l of user.leaves) for (const day of leaveDays(l.from, l.to)) holidays.add(day);
    cal = {
      ...cal,
      workingDays: user.workingDays.length ? user.workingDays : cal.workingDays,
      startHour: user.workStartHour ?? cal.startHour,
      endHour: user.workEndHour ?? cal.endHour,
      holidays,
    };
  }

  cachedCalendars.set(key, { at: Date.now(), cal });
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
      // A paused clock is still open; starting the policy again would give it a twin.
      state: { in: ['RUNNING', 'AT_RISK', 'PAUSED'] },
    },
  });
  if (existing) return;

  // The owner's calendar, when there is one: a deadline is measured in the hours of whoever
  // has to meet it, not the organisation's average.
  const cal = await loadCalendar(input.organizationId, { userId: input.ownerId ?? null }, tx);
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
  now = new Date(),
): Promise<void> {
  if (policyCodes.length === 0) return;
  const policies = await tx.slaPolicy.findMany({ where: { code: { in: [...policyCodes] } } });
  if (policies.length === 0) return;

  const clocks = await tx.slaClock.findMany({
    where: {
      policyId: { in: policies.map((p) => p.id) },
      entityType,
      entityId,
      state: { in: ['RUNNING', 'AT_RISK', 'PAUSED'] },
    },
  });

  for (let clock of clocks) {
    // A clock stopped while paused is evaluated as if the pause had just ended: the wait is
    // credited back before the deadline is judged, otherwise "waiting on the client" would
    // count against whoever closed the work.
    if (clock.state === 'PAUSED') clock = await closePause(tx, clock, now, null);
    await tx.slaClock.update({
      where: { id: clock.id },
      data: { stoppedAt: now, state: now <= clock.dueAt ? 'MET' : 'BREACHED', breachedAt: now > clock.dueAt ? (clock.breachedAt ?? now) : clock.breachedAt },
    });
  }
}

export interface PauseSlaInput {
  entityType: string;
  entityId: string;
  /** Restrict to these policies; omit to pause every running clock on the entity. */
  policyCodes?: readonly string[];
  kind: SlaPauseKind;
  reason: string;
  actorId: string | null;
  /** Injectable for tests, like `tickSlaClocks(now)`; the calendar arithmetic needs fixed dates. */
  at?: Date;
}

/**
 * Pause the running clocks on an entity. The budget is untouched; the time until resume is
 * simply not counted. Every pause carries a kind and a reason because the whole point is to
 * be able to say, later, how much of a deadline was spent waiting on whom.
 */
export async function pauseSla(tx: Tx, input: PauseSlaInput): Promise<number> {
  const clocks = await tx.slaClock.findMany({
    where: {
      entityType: input.entityType,
      entityId: input.entityId,
      state: { in: ['RUNNING', 'AT_RISK'] },
      ...(input.policyCodes?.length ? { policy: { code: { in: [...input.policyCodes] } } } : {}),
    },
  });
  const now = input.at ?? new Date();
  for (const clock of clocks) {
    await tx.slaClock.update({ where: { id: clock.id }, data: { state: 'PAUSED', pausedAt: now } });
    await tx.slaPause.create({
      data: {
        organizationId: clock.organizationId, clockId: clock.id,
        kind: input.kind, reason: input.reason, pausedAt: now, pausedById: input.actorId,
      },
    });
  }
  return clocks.length;
}

/** Resume the paused clocks on an entity; the deadline moves out by exactly the working hours paused. */
export async function resumeSla(
  tx: Tx,
  entityType: string,
  entityId: string,
  actorId: string | null,
  policyCodes?: readonly string[],
  now = new Date(),
): Promise<number> {
  const clocks = await tx.slaClock.findMany({
    where: {
      entityType, entityId, state: 'PAUSED',
      ...(policyCodes?.length ? { policy: { code: { in: [...policyCodes] } } } : {}),
    },
  });
  for (const clock of clocks) {
    const resumed = await closePause(tx, clock, now, actorId);
    // Not RUNNING unconditionally: if the clock had already been warned before the pause, the
    // warning is still true and re-issuing it on the next tick would be noise.
    await tx.slaClock.update({
      where: { id: clock.id },
      data: { state: resumed.warnedAt ? 'AT_RISK' : 'RUNNING' },
    });
  }
  return clocks.length;
}

type ClockRow = Awaited<ReturnType<Tx['slaClock']['findFirstOrThrow']>>;

/**
 * Close the open pause on a clock: fix the pause's length in working hours, add it to the
 * clock's totals, and push dueAt out by the same amount. Pushing dueAt is what keeps the rest
 * of the engine oblivious to pauses — `now > dueAt` still means breached.
 */
async function closePause(tx: Tx, clock: ClockRow, now: Date, actorId: string | null): Promise<ClockRow> {
  const pausedAt = clock.pausedAt ?? now;
  const cal = await loadCalendar(clock.organizationId, { userId: clock.ownerId }, tx);
  const hours = businessHoursBetween(pausedAt, now, cal);
  const seconds = Math.max(0, Math.round((now.getTime() - pausedAt.getTime()) / 1000));

  await tx.slaPause.updateMany({
    where: { clockId: clock.id, resumedAt: null },
    data: { resumedAt: now, businessHours: hours, resumedById: actorId },
  });
  return tx.slaClock.update({
    where: { id: clock.id },
    data: {
      pausedAt: null,
      pausedSeconds: clock.pausedSeconds + seconds,
      pausedHours: Number(clock.pausedHours) + hours,
      dueAt: addBusinessHours(clock.dueAt, hours, cal),
    },
  });
}

export async function cancelSla(tx: Tx, entityType: string, entityId: string): Promise<void> {
  const now = new Date();
  await tx.slaPause.updateMany({
    where: { clock: { entityType, entityId, state: 'PAUSED' }, resumedAt: null },
    data: { resumedAt: now },
  });
  await tx.slaClock.updateMany({
    where: { entityType, entityId, state: { in: ['RUNNING', 'AT_RISK', 'PAUSED'] } },
    data: { state: 'CANCELLED', stoppedAt: now, pausedAt: null },
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

  // One calendar per (organisation, owner), not one per clock: the tick spans tenants, each
  // with its own working week, and an owner may be in a unit that keeps different hours or be
  // on leave.
  const calendars = new Map<string, Calendar>();
  for (const c of running) {
    const key = `${c.organizationId}|${c.ownerId ?? ''}`;
    if (!calendars.has(key)) calendars.set(key, await loadCalendar(c.organizationId, { userId: c.ownerId }));
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
    const cal = calendars.get(`${clock.organizationId}|${clock.ownerId ?? ''}`) ?? DEFAULT_CALENDAR;
    // Paused hours were never the owner's to spend; dueAt has already been pushed out by them.
    const consumed = businessHoursBetween(clock.startedAt, now, cal) - Number(clock.pausedHours);
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
            entityType: clock.entityType, entityId: clock.entityId, severity: 'CRITICAL', policyCode: clock.policy.code,
          }
        : {
            kind: 'SLA_WARNING',
            title: `هشدار SLA — ${clock.policy.labelFa}`,
            body: `مهلت «${clock.policy.labelFa}» رو به اتمام است.`,
            entityType: clock.entityType, entityId: clock.entityId, severity: 'WARNING', policyCode: clock.policy.code,
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
  n: { kind: string; title: string; body: string; entityType: string; entityId: string; severity: string; policyCode: string },
  mail?: MailBody,
): Promise<void> {
  await notify({ userId, ...n, mail });
}
