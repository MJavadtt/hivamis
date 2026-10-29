import type { SiteProject } from '@prisma/client';
import type { SiteSettings } from '@hiva/contracts';
import type { Tx } from '../db.js';
import { conflict } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { jalaliOf, jalaliStart, jalaliMonthLength } from '../lib/jalali.js';
import { money, rounded, type Money } from '../lib/money.js';
import { lockProject } from './ledger.js';
import type { SiteActor } from './venues.js';
import { overridesRules } from './access.js';

/**
 * The rental schedule (ADR-103): from the contract's terms, what falls due and when — the deposit at
 * the start, then the rent and the service charge period by period, a period being a Persian month
 * from the day the contract began (۱۵ مهر to ۱۵ آبان), the last cut at the contract's end.
 *
 * A part-period is charged for its days or as a whole month, as the organisation decides
 * (settings.schedule.proration). Daily rent is the day's rate times the period's days. Each item has a
 * key — its kind and its period's first day — so building the schedule again makes nothing twice: it
 * adds what is missing, corrects an unpaid item whose terms changed, voids an unpaid one the contract
 * no longer covers, and leaves alone anything already paid, saying so.
 */

const DAY = 86_400_000;
const days = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY);
const ymd = (d: Date) => { const j = jalaliOf(d); return `${j.y}-${String(j.m).padStart(2, '0')}-${String(j.d).padStart(2, '0')}`; };
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

/** The same day `n` Persian months on — the month's last day when it has fewer. */
export function addJalaliMonths(d: Date, n: number): Date {
  const j = jalaliOf(d);
  let m = j.m + n, y = j.y;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  const out = jalaliStart(y, m, Math.min(j.d, jalaliMonthLength(y, m)));
  // Keep the time of day the contract's dates carry, so a period's edges are the contract's own.
  out.setHours(d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  return out;
}

export interface PlannedItem {
  scheduleKey: string;
  kind: 'RENT' | 'CHARGE' | 'DEPOSIT';
  /** None: an item the schedule made is read from its kind and its period, in the reader's language. */
  description: null;
  periodStart: Date | null;
  periodEnd: Date | null;
  dueDate: Date;
  amount: string;
}

type Terms = Pick<SiteProject, 'contractStart' | 'contractEnd' | 'depositAmount' | 'rentAmount' | 'rentPeriod' | 'rentDueDay' | 'chargeAmount' | 'chargeDueDay'>;

/** What the terms make due, without touching the database. */
export function buildSchedule(t: Terms, settings: SiteSettings): PlannedItem[] {
  if (!t.contractStart || !t.contractEnd || t.contractEnd <= t.contractStart) return [];
  const start = t.contractStart, end = t.contractEnd;
  const out: PlannedItem[] = [];
  if (money(t.depositAmount).gt(0)) {
    out.push({ scheduleKey: 'DEPOSIT', kind: 'DEPOSIT', description: null, periodStart: null, periodEnd: null, dueDate: start, amount: rounded(t.depositAmount).toFixed(2) });
  }

  const periods: { from: Date; to: Date; full: number }[] = [];
  for (let i = 0; i < 1200; i++) {
    const from = addJalaliMonths(start, i);
    if (from >= end) break;
    const fullTo = addJalaliMonths(start, i + 1);
    periods.push({ from, to: fullTo < end ? fullTo : end, full: days(from, fullTo) });
  }
  const share = (base: Money, p: { from: Date; to: Date; full: number }) =>
    settings.schedule.proration === 'FULL' || days(p.from, p.to) >= p.full ? base : base.mul(days(p.from, p.to)).div(p.full);

  const rent = money(t.rentAmount);
  if (rent.gt(0)) {
    if (t.rentPeriod === 'ONCE') {
      out.push({ scheduleKey: `RENT:${ymd(start)}`, kind: 'RENT', description: null, periodStart: start, periodEnd: end, dueDate: addDays(start, t.rentDueDay ?? 0), amount: rounded(rent).toFixed(2) });
    } else {
      for (const p of periods) {
        const amount = t.rentPeriod === 'DAILY' ? rent.mul(days(p.from, p.to)) : share(rent, p);
        out.push({ scheduleKey: `RENT:${ymd(p.from)}`, kind: 'RENT', description: null, periodStart: p.from, periodEnd: p.to, dueDate: addDays(p.from, t.rentDueDay ?? 0), amount: rounded(amount).toFixed(2) });
      }
    }
  }
  const charge = money(t.chargeAmount);
  if (charge.gt(0)) {
    for (const p of periods) {
      out.push({ scheduleKey: `CHARGE:${ymd(p.from)}`, kind: 'CHARGE', description: null, periodStart: p.from, periodEnd: p.to, dueDate: addDays(p.from, t.chargeDueDay ?? 0), amount: rounded(share(charge, p)).toFixed(2) });
    }
  }
  return out.filter((x) => money(x.amount).gt(0));
}

export interface ScheduleOutcome {
  create: PlannedItem[];
  update: (PlannedItem & { id: string; was: { amount: string; dueDate: Date } })[];
  void: { id: string; scheduleKey: string; amount: string; dueDate: Date }[];
  /** Items the terms would change but that are already paid in part or whole: left as they are. */
  kept: { id: string; scheduleKey: string; reason: string }[];
  dryRun: boolean;
}

/** States in which the schedule can be built: the contract approved, and the project not yet closed. */
export const SCHEDULE_STATES = ['CONTRACT_APPROVED', 'INSTALL_PLANNED', 'INSTALLING', 'ACTIVE', 'SETTLING'];

export async function applySchedule(tx: Tx, actor: SiteActor, siteProjectId: string, settings: SiteSettings, dryRun: boolean): Promise<ScheduleOutcome> {
  const p = await lockProject(tx, actor.organizationId, siteProjectId);
  if (!dryRun && !SCHEDULE_STATES.includes(p.state) && !overridesRules(actor)) {
    throw conflict('SCHEDULE_NOT_READY', 'جدول اجاره پس از تأیید قرارداد ساخته می‌شود، و برای پروژهٔ بسته یا لغوشده نه.');
  }
  const planned = buildSchedule(p, settings);
  if (!planned.length) throw conflict('SCHEDULE_NOT_READY', 'برای ساخت جدول، آغاز و پایان قرارداد و دست‌کم یکی از ودیعه، اجاره یا شارژ لازم است.');

  const existing = await tx.siteObligation.findMany({ where: { siteProjectId, scheduleKey: { not: null } } });
  const out: ScheduleOutcome = { create: [], update: [], void: [], kept: [], dryRun };
  for (const item of planned) {
    const e = existing.find((x) => x.scheduleKey === item.scheduleKey);
    if (!e || e.status === 'VOID') { if (!e) out.create.push(item); else out.kept.push({ id: e.id, scheduleKey: item.scheduleKey, reason: 'باطل شده بود' }); continue; }
    const changed = !money(e.amount).eq(money(item.amount)) || e.dueDate.getTime() !== item.dueDate.getTime();
    if (!changed) continue;
    if (e.status === 'OPEN' && money(e.settledAmount).eq(0)) out.update.push({ ...item, id: e.id, was: { amount: money(e.amount).toFixed(2), dueDate: e.dueDate } });
    else out.kept.push({ id: e.id, scheduleKey: item.scheduleKey, reason: 'پرداخت یا تسویه شده است' });
  }
  for (const e of existing) {
    if (planned.some((x) => x.scheduleKey === e.scheduleKey) || e.status === 'VOID') continue;
    if (e.status === 'OPEN' && money(e.settledAmount).eq(0)) out.void.push({ id: e.id, scheduleKey: e.scheduleKey!, amount: money(e.amount).toFixed(2), dueDate: e.dueDate });
    else out.kept.push({ id: e.id, scheduleKey: e.scheduleKey!, reason: 'خارج از دورهٔ قرارداد ولی پرداخت شده است' });
  }
  if (dryRun) return out;

  for (const item of out.create) {
    await tx.siteObligation.create({
      data: {
        organizationId: actor.organizationId, siteProjectId, kind: item.kind, description: item.description,
        periodStart: item.periodStart, periodEnd: item.periodEnd, dueDate: item.dueDate, amount: item.amount, currency: p.currency,
        scheduleKey: item.scheduleKey, source: 'SCHEDULE', createdById: actor.id,
      },
    });
  }
  for (const u of out.update) {
    await tx.siteObligation.update({ where: { id: u.id }, data: { amount: u.amount, dueDate: u.dueDate, periodStart: u.periodStart, periodEnd: u.periodEnd } });
  }
  for (const v of out.void) {
    await tx.siteObligation.update({ where: { id: v.id }, data: { status: 'VOID', closeReason: 'دورهٔ قرارداد تغییر کرد', closedAt: new Date() } });
  }
  await tx.siteProject.update({ where: { id: siteProjectId }, data: { scheduleGeneratedAt: new Date() } });
  await audit({
    organizationId: actor.organizationId, actorId: actor.id, ipAddress: actor.ipAddress ?? null, requestId: actor.requestId ?? null,
    action: 'SCHEDULE_GENERATED', entityType: 'siteProject', entityId: siteProjectId,
    after: {
      created: out.create.length, updated: out.update.map((u) => ({ key: u.scheduleKey, from: u.was.amount, to: u.amount })),
      voided: out.void.map((v) => v.scheduleKey), kept: out.kept.map((k) => k.scheduleKey),
    },
  }, tx);
  return out;
}
