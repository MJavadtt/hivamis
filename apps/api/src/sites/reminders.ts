import { normalizeIranMobile, OBLIGATION_KIND_LABELS, SITE_EVENT_LABELS, type ObligationKind, type SiteEvent, type SiteSettings } from '@hiva/contracts';
import { prisma } from '../db.js';
import { notify } from '../mail/notify.js';
import { sendText } from '../auth/sms.js';
import { formatJalali } from '../lib/jalali.js';
import { money } from '../lib/money.js';
import { eventOn, settingsOf } from './options.js';
import { holdersOf } from './people.js';
import { depositOf, OPEN } from './ledger.js';

/**
 * Rental reminders (ADR-103) — «ریمایندر، یادآوری اجاره‌داری».
 *
 * Once a day, and whenever someone asks, each organisation's open items are read against its own
 * intervals: so many days before a payment is due, so many after it fell due unpaid, before a contract
 * ends, while an approval or a closure waits. A day the run did not happen is caught up once — the
 * nearest interval crossed, not every one missed — and a reminder is sent once: the row recording it
 * is written first, under a unique key, and only the run that wrote it sends it.
 *
 * In the app (and through it the phone and the messenger) always; by SMS to the colleague's own mobile
 * when the organisation turns that on, with the provider's answer kept and a failure tried again.
 */

const DAY = 86_400_000;
const MAX_SMS_ATTEMPTS = 3;
/** Projects whose money is still running. */
const LIVE = ['CONTRACT_APPROVED', 'INSTALL_PLANNED', 'INSTALLING', 'ACTIVE', 'SETTLING', 'CLOSURE_PENDING'];

const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const daysBetween = (from: Date, to: Date) => Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY);
const amountFa = (v: unknown, currency: string) => `${money(v).toDecimalPlaces(0).toNumber().toLocaleString('en-US')} ${currency === 'IRR' ? 'ریال' : currency}`;

/** Before a date: the nearest interval at or above the days left. Null when none applies yet. */
export function beforeOffset(daysLeft: number, intervals: readonly number[]): number | null {
  if (daysLeft < 0) return null;
  const crossed = intervals.filter((t) => t >= daysLeft);
  return crossed.length ? Math.min(...crossed) : null;
}
/** After a date: the largest interval at or below the days gone, as a negative offset. */
export function afterOffset(daysGone: number, intervals: readonly number[]): number | null {
  if (daysGone <= 0) return null;
  const crossed = intervals.filter((t) => t <= daysGone);
  return crossed.length ? -Math.max(...crossed) : null;
}

interface Due {
  organizationId: string; siteProjectId: string | null; event: SiteEvent;
  subjectType: string; subjectId: string; dueDate: Date; offsetDays: number;
  recipients: string[]; title: string; body: string;
}

export interface ReminderRun { organizations: number; candidates: number; sent: number; sms: number; smsFailed: number; skipped: number }

export async function runReminders(now = new Date(), onlyOrganizationId?: string): Promise<ReminderRun> {
  const out: ReminderRun = { organizations: 0, candidates: 0, sent: 0, sms: 0, smsFailed: 0, skipped: 0 };
  const orgs = await prisma.organization.findMany({ where: { isActive: true, ...(onlyOrganizationId ? { id: onlyOrganizationId } : {}) }, select: { id: true } });
  for (const org of orgs) {
    const settings = await settingsOf(org.id);
    if (!settings.reminders.enabled) continue;
    const due = await dueReminders(org.id, settings, now);
    if (!due.length) continue;
    out.organizations++;
    out.candidates += due.length;
    const phones = settings.reminders.smsToStaff ? await staffPhones(due.flatMap((d) => d.recipients)) : new Map<string, string>();
    for (const d of due) {
      for (const userId of new Set(d.recipients)) {
        if (await claim(d, 'IN_APP', userId, 'SENT')) {
          await notify({ userId, kind: 'SITE_REMINDER', title: d.title, body: d.body, entityType: d.siteProjectId ? 'siteProject' : null, entityId: d.siteProjectId, severity: d.offsetDays < 0 ? 'WARNING' : 'INFO' });
          out.sent++;
        } else out.skipped++;
        const phone = phones.get(userId);
        if (phone) {
          const row = await claim(d, 'SMS', phone, 'FAILED', 0);
          if (!row) continue;
          const outcome = await sendText(phone, `${d.title} — ${d.body}`.slice(0, 600));
          await prisma.siteReminder.update({ where: { id: row.id }, data: { status: outcome.status, attempts: 1, error: outcome.error, sentAt: outcome.status === 'FAILED' ? null : new Date() } });
          if (outcome.status === 'FAILED') out.smsFailed++; else out.sms++;
        }
      }
    }
  }
  // SMS that failed earlier, while they have attempts left.
  const retry = await prisma.siteReminder.findMany({
    where: { channel: 'SMS', status: 'FAILED', attempts: { lt: MAX_SMS_ATTEMPTS }, updatedAt: { lt: new Date(now.getTime() - 3_600_000) }, ...(onlyOrganizationId ? { organizationId: onlyOrganizationId } : {}) },
    take: 100,
  });
  for (const r of retry) {
    const outcome = await sendText(r.recipient, `${SITE_EVENT_LABELS[r.event as SiteEvent]?.fa ?? r.event} — ${formatJalali(r.dueDate)}`);
    await prisma.siteReminder.update({ where: { id: r.id }, data: { status: outcome.status, attempts: { increment: 1 }, error: outcome.error, sentAt: outcome.status === 'FAILED' ? null : new Date() } });
  }
  return out;
}

/**
 * Writes the reminder's row; null when another run already wrote it — that run sends it, this one does
 * not. Skipped on the unique key by the database itself, so a repeated run raises (and logs) nothing.
 */
async function claim(d: Due, channel: 'IN_APP' | 'SMS', recipient: string, status: string, attempts = 1) {
  const keyOf = { organizationId: d.organizationId, subjectType: d.subjectType, subjectId: d.subjectId, event: d.event, offsetDays: d.offsetDays, channel, recipient };
  const { count } = await prisma.siteReminder.createMany({
    data: [{ ...keyOf, siteProjectId: d.siteProjectId, dueDate: d.dueDate, status, attempts, sentAt: status === 'SENT' ? new Date() : null }],
    skipDuplicates: true,
  });
  if (!count) return null;
  return prisma.siteReminder.findUniqueOrThrow({ where: { organizationId_subjectType_subjectId_event_offsetDays_channel_recipient: keyOf }, select: { id: true } });
}

async function staffPhones(userIds: string[]) {
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(userIds)] }, isActive: true, deletedAt: null }, select: { id: true, phone: true } });
  return new Map(users.map((u) => [u.id, normalizeIranMobile(u.phone)]).filter((x): x is [string, string] => !!x[1]));
}

/** Every reminder an organisation's items call for today, before anything is sent. */
export async function dueReminders(organizationId: string, s: SiteSettings, now: Date): Promise<Due[]> {
  const out: Due[] = [];
  const r = s.reminders;
  const finance = r.toFinance ? await holdersOf(organizationId, 'rental.manage', { inOwnRight: true }) : [];
  const moneyPeople = (responsibleId: string | null) => [...(r.toResponsible && responsibleId ? [responsibleId] : []), ...finance, ...r.userIds];

  /* payments: before they are due, and after, while unpaid */
  const obligations = await prisma.siteObligation.findMany({
    where: { organizationId, status: { in: [...OPEN] }, siteProject: { state: { in: LIVE } } },
    select: {
      id: true, kind: true, amount: true, settledAmount: true, currency: true, dueDate: true, siteProjectId: true,
      siteProject: { select: { name: true, code: true, responsibleId: true, venue: { select: { name: true } } } },
    },
    take: 10_000,
  });
  for (const o of obligations) {
    const left = daysBetween(now, o.dueDate);
    const kind = o.kind as ObligationKind;
    const before = beforeOffset(left, r.daysBefore);
    const after = afterOffset(-left, r.overdueDays);
    const event: SiteEvent | null = before !== null
      ? (kind === 'RENT' ? 'RENT_DUE' : kind === 'CHARGE' ? 'CHARGE_DUE' : 'PAYMENT_DUE')
      : after !== null ? (kind === 'RENT' ? 'RENT_OVERDUE' : kind === 'CHARGE' ? 'CHARGE_OVERDUE' : kind === 'PENALTY' ? 'PENALTY_OUTSTANDING' : 'PAYMENT_OVERDUE')
      : null;
    if (!event || !eventOn(s, event)) continue;
    const outstanding = money(o.amount).sub(money(o.settledAmount));
    out.push({
      organizationId, siteProjectId: o.siteProjectId, event, subjectType: 'siteObligation', subjectId: o.id, dueDate: o.dueDate,
      offsetDays: (before ?? after)!, recipients: moneyPeople(o.siteProject.responsibleId),
      title: `${SITE_EVENT_LABELS[event].fa}: ${o.siteProject.name}`,
      body: `${OBLIGATION_KIND_LABELS[kind].fa} ${o.siteProject.venue.name} — ${amountFa(outstanding, o.currency)}، سررسید ${formatJalali(o.dueDate)}${left < 0 ? ` (${-left} روز گذشته)` : left === 0 ? ' (امروز)' : ` (${left} روز مانده)`} · ${o.siteProject.code}`,
    });
  }

  /* contracts ending, and the deposit to come back after one ended */
  const projects = await prisma.siteProject.findMany({
    where: { organizationId, state: { in: LIVE }, contractEnd: { not: null } },
    select: { id: true, name: true, code: true, currency: true, responsibleId: true, contractEnd: true, venue: { select: { name: true } } },
    take: 5000,
  });
  for (const p of projects) {
    const left = daysBetween(now, p.contractEnd!);
    const before = beforeOffset(left, s.reminders.contractDays);
    if (before !== null && eventOn(s, 'CONTRACT_EXPIRY')) {
      out.push({
        organizationId, siteProjectId: p.id, event: 'CONTRACT_EXPIRY', subjectType: 'siteProject', subjectId: p.id, dueDate: p.contractEnd!, offsetDays: before,
        recipients: moneyPeople(p.responsibleId), title: `${SITE_EVENT_LABELS.CONTRACT_EXPIRY.fa}: ${p.name}`,
        body: `قرارداد ${p.venue.name} ${formatJalali(p.contractEnd!)} به پایان می‌رسد${left ? ` (${left} روز مانده)` : ' (امروز)'} — تمدید، مذاکرهٔ دوباره یا جمع‌آوری؟ · ${p.code}`,
      });
    }
    const gone = afterOffset(-left, s.reminders.overdueDays) ?? (left === 0 ? 0 : null);
    if (gone !== null && left <= 0 && eventOn(s, 'DEPOSIT_RETURN')) {
      const d = await depositOf(prisma, p.id);
      if (money(d.remaining).gt(0)) {
        out.push({
          organizationId, siteProjectId: p.id, event: 'DEPOSIT_RETURN', subjectType: 'siteProject', subjectId: p.id, dueDate: p.contractEnd!, offsetDays: gone,
          recipients: moneyPeople(p.responsibleId), title: `${SITE_EVENT_LABELS.DEPOSIT_RETURN.fa}: ${p.name}`,
          body: `ودیعهٔ ${amountFa(d.remaining, p.currency)} نزد ${p.venue.name} است؛ قرارداد ${formatJalali(p.contractEnd!)} تمام شد. · ${p.code}`,
        });
      }
    }
  }

  /* negotiation follow-ups: the day before, on the day, and after while not done */
  if (eventOn(s, 'FOLLOW_UP')) {
    const followUps = await prisma.siteNegotiation.findMany({
      where: { organizationId, followUpAt: { not: null }, followUpDoneAt: null, siteProject: { state: { notIn: ['CLOSED', 'CANCELLED'] } } },
      select: { id: true, followUpAt: true, nextAction: true, assigneeId: true, siteProjectId: true, siteProject: { select: { name: true, code: true, responsibleId: true } } },
      take: 5000,
    });
    for (const n of followUps) {
      const left = daysBetween(now, n.followUpAt!);
      const offset = beforeOffset(left, [1, 0]) ?? afterOffset(-left, s.reminders.overdueDays);
      const who = n.assigneeId ?? n.siteProject.responsibleId;
      if (offset === null || !who) continue;
      out.push({
        organizationId, siteProjectId: n.siteProjectId, event: 'FOLLOW_UP', subjectType: 'siteNegotiation', subjectId: n.id, dueDate: n.followUpAt!, offsetDays: offset,
        recipients: [who], title: `${SITE_EVENT_LABELS.FOLLOW_UP.fa}: ${n.siteProject.name}`,
        body: `${n.nextAction ?? 'پیگیری مذاکره'} — ${formatJalali(n.followUpAt!)} · ${n.siteProject.code}`,
      });
    }
  }

  /* what waits for someone's decision: a contract, the client's approval, a closure */
  const waiting = (since: Date) => afterOffset(daysBetween(since, now), s.reminders.waitingDays);
  if (eventOn(s, 'CONTRACT_APPROVAL')) {
    const pending = await prisma.siteContract.findMany({
      where: { organizationId, status: 'PENDING_APPROVAL', submittedAt: { not: null } },
      select: { id: true, version: true, submittedAt: true, siteProjectId: true, siteProject: { select: { name: true, code: true } } },
      take: 2000,
    });
    const approvers = pending.length ? await holdersOf(organizationId, 'site.contract.approve', { inOwnRight: true }) : [];
    for (const c of pending) {
      const offset = waiting(c.submittedAt!);
      if (offset === null || !approvers.length) continue;
      out.push({
        organizationId, siteProjectId: c.siteProjectId, event: 'CONTRACT_APPROVAL', subjectType: 'siteContract', subjectId: c.id, dueDate: c.submittedAt!, offsetDays: offset,
        recipients: approvers, title: `${SITE_EVENT_LABELS.CONTRACT_APPROVAL.fa}: ${c.siteProject.name}`,
        body: `نسخهٔ ${c.version} از ${formatJalali(c.submittedAt!)} منتظر تصمیم است · ${c.siteProject.code}`,
      });
    }
  }
  if (eventOn(s, 'EMPLOYER_APPROVAL')) {
    const unapproved = await prisma.siteProject.findMany({
      where: { organizationId, state: { in: ['INSTALLING', 'ACTIVE'] }, companyId: { not: null }, installedAt: { not: null }, approvals: { none: { kind: 'EMPLOYER', decision: 'APPROVED' } } },
      select: { id: true, name: true, code: true, responsibleId: true, installedAt: true },
      take: 2000,
    });
    for (const p of unapproved) {
      const offset = waiting(p.installedAt!);
      if (offset === null || !p.responsibleId) continue;
      out.push({
        organizationId, siteProjectId: p.id, event: 'EMPLOYER_APPROVAL', subjectType: 'siteProject', subjectId: p.id, dueDate: p.installedAt!, offsetDays: offset,
        recipients: [p.responsibleId], title: `${SITE_EVENT_LABELS.EMPLOYER_APPROVAL.fa}: ${p.name}`,
        body: `نصب ${formatJalali(p.installedAt!)} انجام شد و تأییدیهٔ کارفرما هنوز ثبت نشده است · ${p.code}`,
      });
    }
  }
  if (eventOn(s, 'CLOSURE_PENDING')) {
    const closing = await prisma.siteProject.findMany({ where: { organizationId, state: 'CLOSURE_PENDING' }, select: { id: true, name: true, code: true }, take: 2000 });
    const closers = closing.length ? await holdersOf(organizationId, 'site.close', { inOwnRight: true }) : [];
    for (const p of closing) {
      const asked = await prisma.stateTransition.findFirst({ where: { entityType: 'siteProject', entityId: p.id, toState: 'CLOSURE_PENDING' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      const offset = asked ? waiting(asked.createdAt) : null;
      if (offset === null || !closers.length) continue;
      out.push({
        organizationId, siteProjectId: p.id, event: 'CLOSURE_PENDING', subjectType: 'siteProject', subjectId: p.id, dueDate: asked!.createdAt, offsetDays: offset,
        recipients: closers, title: `${SITE_EVENT_LABELS.CLOSURE_PENDING.fa}: ${p.name}`, body: `درخواست بستن از ${formatJalali(asked!.createdAt)} منتظر تصمیم است · ${p.code}`,
      });
    }
  }
  return out;
}
