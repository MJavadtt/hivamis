import { Prisma } from '@prisma/client';
import { OBLIGATION_KIND_LABELS, type SiteSettings, type ObligationKind } from '@hiva/contracts';
import { prisma, type Tx } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { money, rounded, sumOf, ZERO, type Money } from '../lib/money.js';
import type { SiteActor } from './venues.js';
import { overridesRules } from './access.js';

/**
 * The rental ledger (ADR-103, module C).
 *
 * What is owed is a list of obligations: a month's rent, a month's service charge, the deposit, a
 * penalty. What was paid is a list of payments, never edited — a mistake is reversed with its reason.
 * Between them, allocations say which payment settled what; an obligation's `settledAmount` is the sum
 * of its live allocations, kept in the same transaction as they are written, and the database refuses
 * one settled beyond its amount. The deposit has its own ledger: what the venue keeps, what it gives
 * back — the deposit itself is never rewritten to show either.
 *
 * Every figure is a decimal from the column to the answer; nothing is added up in floating point.
 * Every write locks the project's row first, so two payments recorded at once are recorded one after
 * the other, against the balances the first left.
 */

export const OPEN = ['OPEN', 'PARTIAL'] as const;
const ctx = (a: SiteActor) => ({ organizationId: a.organizationId, actorId: a.id, ipAddress: a.ipAddress ?? null, requestId: a.requestId ?? null });

/** Holds the project's row for the rest of the transaction: its money is changed by one writer at a time. */
export async function lockProject(tx: Tx, organizationId: string, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM site_projects WHERE id = ${id} AND "organizationId" = ${organizationId} AND "archivedAt" IS NULL FOR UPDATE`;
  if (!rows.length) throw notFound('پروژهٔ استقرار');
  return tx.siteProject.findUniqueOrThrow({ where: { id } });
}

/** A project whose books are closed: nothing is paid, reversed or deducted on it any more — but by the system administrator. */
export function assertBooksOpen(p: { state: string; code: string }, actor?: SiteActor) {
  if (p.state === 'CLOSED' && !(actor && overridesRules(actor))) throw conflict('PROJECT_CLOSED', `پروژهٔ ${p.code} بسته شده است؛ حساب آن تغییر نمی‌کند.`);
}

const statusFor = (amount: Money, settled: Money) => (settled.gte(amount) ? 'SETTLED' : settled.gt(0) ? 'PARTIAL' : 'OPEN');

/** Adds `delta` (negative to take back) to what settled an obligation, and re-reads its status. */
async function settle(tx: Tx, obligationId: string, delta: Money) {
  const o = await tx.siteObligation.findUniqueOrThrow({ where: { id: obligationId } });
  const settled = money(o.settledAmount).add(delta);
  if (settled.lt(0) || settled.gt(money(o.amount))) {
    throw conflict('OVER_SETTLED', `«${o.description ?? OBLIGATION_KIND_LABELS[o.kind as ObligationKind].fa}» بیش از مبلغ خود تسویه نمی‌شود.`);
  }
  // A waived or void one stays as it was closed; a payment taken back from it reopens nothing.
  const status = ['WAIVED', 'VOID'].includes(o.status) ? o.status : statusFor(money(o.amount), settled);
  await tx.siteObligation.update({
    where: { id: o.id },
    data: { settledAmount: settled, status, closedAt: status === 'SETTLED' ? new Date() : ['WAIVED', 'VOID'].includes(status) ? o.closedAt : null },
  });
}

/* ── the deposit ─────────────────────────────────────────────────────────── */

export interface DepositSummary {
  /** What the contract says the deposit is. */
  original: string | null;
  /** What was actually paid to the venue as deposit: payments put against the deposit. */
  held: string;
  deductionsApproved: string;
  deductionsPending: string;
  refunded: string;
  /** held − approved deductions − refunded: what the venue still has to give back. */
  remaining: string;
  status: 'NONE' | 'HELD' | 'PARTIAL' | 'REFUNDED' | 'FORFEITED';
}

export async function depositOf(db: Tx | typeof prisma, siteProjectId: string): Promise<DepositSummary> {
  const [p, held, entries] = await Promise.all([
    db.siteProject.findUniqueOrThrow({ where: { id: siteProjectId }, select: { depositAmount: true } }),
    db.siteAllocation.aggregate({ _sum: { amount: true }, where: { reversedAt: null, paymentId: { not: null }, obligation: { siteProjectId, kind: 'DEPOSIT' } } }),
    db.siteDepositEntry.groupBy({ by: ['kind', 'status'], where: { siteProjectId }, _sum: { amount: true } }),
  ]);
  const sum = (kind: string, status: string) => money(entries.find((e) => e.kind === kind && e.status === status)?._sum.amount);
  const h = money(held._sum.amount), approved = sum('DEDUCTION', 'APPROVED'), pending = sum('DEDUCTION', 'PROPOSED'), refunded = sum('REFUND', 'APPROVED');
  const remaining = h.sub(approved).sub(refunded);
  const status: DepositSummary['status'] = h.lte(0) ? 'NONE'
    : remaining.gt(0) ? (refunded.gt(0) || approved.gt(0) ? 'PARTIAL' : 'HELD')
    : refunded.gt(0) ? 'REFUNDED' : 'FORFEITED';
  return {
    original: p.depositAmount ? rounded(p.depositAmount).toFixed(2) : null,
    held: h.toFixed(2), deductionsApproved: approved.toFixed(2), deductionsPending: pending.toFixed(2), refunded: refunded.toFixed(2),
    remaining: remaining.toFixed(2), status,
  };
}

/* ── balances ────────────────────────────────────────────────────────────── */

export interface Balances {
  currency: string;
  byKind: Record<string, { due: string; settled: string; waived: string; outstanding: string; overdue: string }>;
  due: string; settled: string; outstanding: string; overdue: string; upcoming30: string;
  /** Money paid to the venue (not reversed), money back from it, and paid but put against nothing. */
  paidOut: string; paidIn: string; credit: string;
  deposit: DepositSummary;
  costs: { installation: string; transport: string; fabrication: string; total: string };
}

/**
 * A project's books, defined once for every screen and report:
 *   due          what is owed in all, not counting a void item (a waived one counts, and shows as waived)
 *   settled      what payments and deposit deductions settled
 *   outstanding  due − settled, over items still open
 *   overdue      outstanding on items whose due date has passed
 *   credit       paid to the venue and put against nothing, less what it returned of it
 */
export async function balancesOf(db: Tx | typeof prisma, siteProjectId: string, now = new Date()): Promise<Balances> {
  const [p, obligations, payments, counters, creditUsed] = await Promise.all([
    db.siteProject.findUniqueOrThrow({ where: { id: siteProjectId }, select: { currency: true, installCost: true, transportCost: true } }),
    db.siteObligation.findMany({ where: { siteProjectId, status: { not: 'VOID' } }, select: { kind: true, amount: true, settledAmount: true, status: true, dueDate: true } }),
    db.sitePayment.findMany({ where: { siteProjectId, reversedAt: null }, select: { purpose: true, amount: true } }),
    db.siteCounter.findMany({ where: { siteProjectId }, select: { quantity: true, unitCost: true } }),
    db.siteAllocation.aggregate({ _sum: { amount: true }, where: { reversedAt: null, payment: { siteProjectId, reversedAt: null } } }),
  ]);
  const soon = new Date(now.getTime() + 30 * 86_400_000);
  const byKind: Balances['byKind'] = {};
  let due = ZERO, settled = ZERO, outstanding = ZERO, overdue = ZERO, upcoming = ZERO;
  for (const o of obligations) {
    const k = (byKind[o.kind] ??= { due: '0', settled: '0', waived: '0', outstanding: '0', overdue: '0' });
    const amount = money(o.amount), s = money(o.settledAmount), open = OPEN.includes(o.status as never) ? amount.sub(s) : ZERO;
    const late = open.gt(0) && o.dueDate < now ? open : ZERO;
    k.due = money(k.due).add(amount).toFixed(2);
    k.settled = money(k.settled).add(s).toFixed(2);
    if (o.status === 'WAIVED') k.waived = money(k.waived).add(amount.sub(s)).toFixed(2);
    k.outstanding = money(k.outstanding).add(open).toFixed(2);
    k.overdue = money(k.overdue).add(late).toFixed(2);
    due = due.add(amount); settled = settled.add(s); outstanding = outstanding.add(open); overdue = overdue.add(late);
    if (open.gt(0) && o.dueDate >= now && o.dueDate <= soon) upcoming = upcoming.add(open);
  }
  const paidOut = sumOf(payments.filter((x) => x.purpose === 'OBLIGATIONS').map((x) => x.amount));
  const paidIn = sumOf(payments.filter((x) => x.purpose !== 'OBLIGATIONS').map((x) => x.amount));
  const creditBack = sumOf(payments.filter((x) => x.purpose === 'CREDIT_REFUND').map((x) => x.amount));
  const credit = paidOut.sub(money(creditUsed._sum.amount)).sub(creditBack);
  const fabrication = sumOf(counters.map((c) => money(c.unitCost).mul(c.quantity)));
  const installation = money(p.installCost), transport = money(p.transportCost);
  return {
    currency: p.currency, byKind,
    due: due.toFixed(2), settled: settled.toFixed(2), outstanding: outstanding.toFixed(2), overdue: overdue.toFixed(2), upcoming30: upcoming.toFixed(2),
    paidOut: paidOut.toFixed(2), paidIn: paidIn.toFixed(2), credit: credit.toFixed(2),
    deposit: await depositOf(db, siteProjectId),
    costs: { installation: installation.toFixed(2), transport: transport.toFixed(2), fabrication: rounded(fabrication).toFixed(2), total: rounded(installation.add(transport).add(fabrication)).toFixed(2) },
  };
}

/* ── payments ────────────────────────────────────────────────────────────── */

export interface PaymentInput {
  purpose: 'OBLIGATIONS' | 'DEPOSIT_REFUND' | 'CREDIT_REFUND';
  amount: string; paidAt: Date; methodCode: string;
  reference?: string | null; chequeNumber?: string | null; chequeBank?: string | null; chequeDate?: Date | null; note?: string | null;
  allocations?: { obligationId: string; amount: string }[];
  clientKey: string;
}

/**
 * Records a payment and what it settles. Sent again with the same `clientKey`, it answers with the
 * payment already recorded and records nothing; the same key on a different payment is refused.
 */
export async function recordPayment(tx: Tx, actor: SiteActor, siteProjectId: string, input: PaymentInput, settings: SiteSettings) {
  const p = await lockProject(tx, actor.organizationId, siteProjectId);
  const before = await tx.sitePayment.findUnique({ where: { organizationId_clientKey: { organizationId: actor.organizationId, clientKey: input.clientKey } }, include: { allocations: true } });
  if (before) {
    const same = before.siteProjectId === siteProjectId && money(before.amount).eq(money(input.amount)) && before.purpose === input.purpose;
    if (!same) throw conflict('IDEMPOTENCY_MISMATCH', 'این شناسهٔ پرداخت پیش‌تر برای پرداخت دیگری به کار رفته است.');
    return { payment: before, replayed: true };
  }
  assertBooksOpen(p, actor);
  if (['DRAFT', 'CANCELLED'].includes(p.state) && !overridesRules(actor)) throw conflict('PROJECT_NOT_CONTRACTED', 'برای پروژه‌ای که هنوز پیش‌نویس است یا لغو شده پرداختی ثبت نمی‌شود.');
  if (!input.chequeNumber?.trim() && await isCheque(tx, actor.organizationId, input.methodCode)) {
    throw badRequest('VALIDATION_ERROR', 'برای پرداخت با چک، شمارهٔ چک را بنویسید.', { issues: [{ path: 'chequeNumber', message: 'شمارهٔ چک الزامی است' }] });
  }
  const amount = money(input.amount);
  const direction = input.purpose === 'OBLIGATIONS' ? 'OUT' : 'IN';

  // What it settles, decided before anything is written.
  let plan: { obligationId: string; amount: Money }[] = [];
  if (input.purpose === 'OBLIGATIONS') {
    const open = await tx.siteObligation.findMany({
      where: { siteProjectId, status: { in: [...OPEN] } },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    });
    if (input.allocations?.length) {
      const seen = new Set<string>();
      for (const a of input.allocations) {
        const o = open.find((x) => x.id === a.obligationId);
        if (!o) throw badRequest('UNKNOWN_OBLIGATION', 'یکی از اقلامی که پرداخت به آن نسبت داده شده در این پروژه باز نیست.', { obligationId: a.obligationId });
        if (seen.has(o.id)) throw badRequest('VALIDATION_ERROR', 'هر قلم یک بار در تخصیص می‌آید.');
        seen.add(o.id);
        const left = money(o.amount).sub(money(o.settledAmount));
        if (money(a.amount).gt(left)) throw conflict('OVER_ALLOCATED', `به «${o.description ?? OBLIGATION_KIND_LABELS[o.kind as ObligationKind].fa}» بیش از ماندهٔ آن (${left.toFixed(0)}) تخصیص داده شده است.`, { obligationId: o.id, outstanding: left.toFixed(2) });
        plan.push({ obligationId: o.id, amount: money(a.amount) });
      }
      if (sumOf(plan.map((x) => x.amount)).gt(amount)) throw badRequest('OVER_ALLOCATED', 'جمع تخصیص‌ها از مبلغ پرداخت بیشتر است.');
    } else {
      // Oldest first: what fell due first is paid first.
      let left = amount;
      for (const o of open) {
        if (left.lte(0)) break;
        const take = Prisma.Decimal.min(left, money(o.amount).sub(money(o.settledAmount)));
        if (take.gt(0)) { plan.push({ obligationId: o.id, amount: take }); left = left.sub(take); }
      }
    }
    const unallocated = amount.sub(sumOf(plan.map((x) => x.amount)));
    if (unallocated.gt(0) && settings.payments.overpayment === 'REJECT') {
      throw conflict('OVERPAYMENT', `این پرداخت ${unallocated.toFixed(0)} بیش از اقلامی است که به آن‌ها نسبت داده شده. مبلغ را کم کنید یا قلم دیگری (مثلاً جریمه یا هزینه) ثبت کنید.`, { unallocated: unallocated.toFixed(2) });
    }
  } else if (input.purpose === 'DEPOSIT_REFUND') {
    const d = await depositOf(tx, siteProjectId);
    if (amount.gt(money(d.remaining))) throw conflict('OVER_REFUND', `ماندهٔ ودیعه نزد مکان ${money(d.remaining).toFixed(0)} است؛ بیش از آن عودت ثبت نمی‌شود.`, { remaining: d.remaining });
  } else {
    const b = await balancesOf(tx, siteProjectId);
    if (amount.gt(money(b.credit))) throw conflict('OVER_REFUND', `اضافه‌پرداخت این پروژه ${money(b.credit).toFixed(0)} است؛ بیش از آن برگشت ثبت نمی‌شود.`, { credit: b.credit });
  }

  const payment = await tx.sitePayment.create({
    data: {
      organizationId: actor.organizationId, siteProjectId, direction, purpose: input.purpose, amount, currency: p.currency,
      paidAt: input.paidAt, methodCode: input.methodCode, reference: input.reference ?? null,
      chequeNumber: input.chequeNumber ?? null, chequeBank: input.chequeBank ?? null, chequeDate: input.chequeDate ?? null,
      note: input.note ?? null, clientKey: input.clientKey, recordedById: actor.id,
    },
  });
  for (const a of plan) {
    await tx.siteAllocation.create({ data: { organizationId: actor.organizationId, obligationId: a.obligationId, paymentId: payment.id, amount: a.amount } });
    await settle(tx, a.obligationId, a.amount);
  }
  if (input.purpose === 'DEPOSIT_REFUND') {
    await tx.siteDepositEntry.create({
      data: { organizationId: actor.organizationId, siteProjectId, kind: 'REFUND', amount, currency: p.currency, paymentId: payment.id, status: 'APPROVED', reason: input.note ?? null, recordedById: actor.id, decidedById: actor.id, decidedAt: new Date() },
    });
  }
  await audit({
    ...ctx(actor), action: 'PAYMENT_RECORDED', entityType: 'siteProject', entityId: siteProjectId,
    after: { paymentId: payment.id, purpose: input.purpose, amount: amount.toFixed(2), currency: p.currency, method: input.methodCode, reference: input.reference ?? null, allocations: plan.map((x) => ({ obligationId: x.obligationId, amount: x.amount.toFixed(2) })) },
  }, tx);
  return { payment: await tx.sitePayment.findUniqueOrThrow({ where: { id: payment.id }, include: { allocations: true } }), replayed: false };
}

async function isCheque(tx: Tx, organizationId: string, methodCode: string) {
  const o = await tx.siteOption.findUnique({ where: { organizationId_list_code: { organizationId, list: 'PAYMENT_METHOD', code: methodCode } }, select: { meta: true } });
  return !!(o?.meta as { isCheque?: boolean } | null)?.isCheque;
}

/** Takes a payment back: what it settled is open again, the deposit it returned is the venue's again. */
export async function reversePayment(tx: Tx, actor: SiteActor, paymentId: string, reason: string) {
  const found = await tx.sitePayment.findFirst({ where: { id: paymentId, organizationId: actor.organizationId } });
  if (!found) throw notFound('پرداخت');
  const p = await lockProject(tx, actor.organizationId, found.siteProjectId);
  assertBooksOpen(p, actor);
  const payment = await tx.sitePayment.findUniqueOrThrow({ where: { id: paymentId }, include: { allocations: { where: { reversedAt: null } } } });
  if (payment.reversedAt) throw conflict('ALREADY_REVERSED', 'این پرداخت پیش‌تر برگشت خورده است.');
  if (payment.purpose === 'OBLIGATIONS') {
    // Taking back a deposit payment cannot leave the venue owing back more than it was paid.
    const d = await depositOf(tx, p.id);
    const toDeposit = sumOf(await Promise.all(payment.allocations.map(async (a) =>
      (await tx.siteObligation.findUniqueOrThrow({ where: { id: a.obligationId }, select: { kind: true } })).kind === 'DEPOSIT' ? money(a.amount) : ZERO)));
    if (toDeposit.gt(money(d.remaining))) throw conflict('DEPOSIT_IN_USE', 'بخشی از ودیعهٔ این پرداخت کسر یا عودت شده است؛ نخست آن‌ها را برگردانید.');
  }
  const now = new Date();
  await tx.sitePayment.update({ where: { id: paymentId }, data: { reversedAt: now, reversedById: actor.id, reversalReason: reason } });
  for (const a of payment.allocations) {
    await tx.siteAllocation.update({ where: { id: a.id }, data: { reversedAt: now } });
    await settle(tx, a.obligationId, money(a.amount).neg());
  }
  await tx.siteDepositEntry.updateMany({ where: { paymentId, status: 'APPROVED' }, data: { status: 'VOID' } });
  await audit({ ...ctx(actor), action: 'PAYMENT_REVERSED', entityType: 'siteProject', entityId: p.id, reason, after: { paymentId, amount: money(payment.amount).toFixed(2) } }, tx);
  return tx.sitePayment.findUniqueOrThrow({ where: { id: paymentId } });
}

/* ── deposit deductions ──────────────────────────────────────────────────── */

export async function proposeDeduction(tx: Tx, actor: SiteActor, siteProjectId: string, input: { amount: string; reason: string; obligationId?: string | null }, settings: SiteSettings) {
  const p = await lockProject(tx, actor.organizationId, siteProjectId);
  assertBooksOpen(p, actor);
  const amount = money(input.amount);
  const d = await depositOf(tx, siteProjectId);
  const free = money(d.remaining).sub(money(d.deductionsPending));
  if (amount.gt(free)) throw conflict('OVER_DEDUCTION', `از ودیعه ${free.toFixed(0)} برای کسر مانده است.`, { available: free.toFixed(2) });
  if (input.obligationId) {
    const o = await tx.siteObligation.findFirst({ where: { id: input.obligationId, siteProjectId, status: { in: [...OPEN] } } });
    if (!o) throw badRequest('UNKNOWN_OBLIGATION', 'قلمی که کسر بابت آن است در این پروژه باز نیست.');
    const pending = await tx.siteDepositEntry.aggregate({ _sum: { amount: true }, where: { obligationId: o.id, status: 'PROPOSED' } });
    const left = money(o.amount).sub(money(o.settledAmount)).sub(money(pending._sum.amount));
    if (amount.gt(left)) throw conflict('OVER_ALLOCATED', `ماندهٔ این قلم ${left.toFixed(0)} است.`);
    if (o.kind === 'DEPOSIT') throw badRequest('VALIDATION_ERROR', 'کسر از ودیعه بابت خود ودیعه معنا ندارد.');
  }
  const entry = await tx.siteDepositEntry.create({
    data: {
      organizationId: actor.organizationId, siteProjectId, kind: 'DEDUCTION', amount, currency: p.currency, reason: input.reason,
      obligationId: input.obligationId ?? null, status: 'PROPOSED', recordedById: actor.id,
    },
  });
  await audit({ ...ctx(actor), action: 'DEPOSIT_DEDUCTION_PROPOSED', entityType: 'siteProject', entityId: siteProjectId, reason: input.reason, after: { entryId: entry.id, amount: amount.toFixed(2), obligationId: input.obligationId ?? null } }, tx);
  if (!settings.deposits.requireDeductionApproval) return decideDeduction(tx, actor, entry.id, 'APPROVE', 'بدون نیاز به تأیید (تنظیمات سازمان)', { self: true });
  return entry;
}

/**
 * Approves or rejects a deduction. Whoever recorded it does not approve it — unless the organisation
 * asks for no approval at all, when recording it is the decision.
 */
export async function decideDeduction(tx: Tx, actor: SiteActor, entryId: string, decision: 'APPROVE' | 'REJECT', comment: string | null | undefined, opts: { self?: boolean; systemAdmin?: boolean } = {}) {
  const found = await tx.siteDepositEntry.findFirst({ where: { id: entryId, organizationId: actor.organizationId, kind: 'DEDUCTION' } });
  if (!found) throw notFound('کسر از ودیعه');
  const p = await lockProject(tx, actor.organizationId, found.siteProjectId);
  assertBooksOpen(p, actor);
  const entry = await tx.siteDepositEntry.findUniqueOrThrow({ where: { id: entryId } });
  if (entry.status !== 'PROPOSED') throw conflict('ALREADY_DECIDED', 'دربارهٔ این کسر پیش‌تر تصمیم گرفته شده است.');
  if (!opts.self && !opts.systemAdmin && entry.recordedById === actor.id) {
    throw new AppError(403, 'SEPARATION_OF_DUTIES', 'کسری را که خودتان ثبت کرده‌اید، همکار دیگری تأیید می‌کند.');
  }
  const now = new Date();
  if (decision === 'APPROVE') {
    const d = await depositOf(tx, p.id);
    if (money(entry.amount).gt(money(d.remaining))) throw conflict('OVER_DEDUCTION', `ماندهٔ ودیعه ${money(d.remaining).toFixed(0)} است.`);
    if (entry.obligationId) {
      const o = await tx.siteObligation.findUniqueOrThrow({ where: { id: entry.obligationId } });
      if (!OPEN.includes(o.status as never)) throw conflict('OBLIGATION_CLOSED', 'قلمی که کسر بابت آن بود دیگر باز نیست.');
      await tx.siteAllocation.create({ data: { organizationId: actor.organizationId, obligationId: o.id, depositEntryId: entry.id, amount: entry.amount } });
      await settle(tx, o.id, money(entry.amount));
    }
  }
  const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  const after = await tx.siteDepositEntry.update({ where: { id: entryId }, data: { status, decidedById: actor.id, decidedAt: now, decisionComment: comment ?? null } });
  await tx.siteApproval.create({
    data: {
      organizationId: actor.organizationId, siteProjectId: p.id, kind: 'DEDUCTION', subjectId: entryId,
      decision: status, comment: comment ?? null, decidedById: actor.id, decidedAt: now, recordedById: actor.id,
    },
  });
  await audit({ ...ctx(actor), action: decision === 'APPROVE' ? 'DEPOSIT_DEDUCTION_APPROVED' : 'DEPOSIT_DEDUCTION_REJECTED', entityType: 'siteProject', entityId: p.id, reason: comment ?? null, after: { entryId, amount: money(entry.amount).toFixed(2) } }, tx);
  return after;
}
