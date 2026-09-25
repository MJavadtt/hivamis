/**
 * What the exchange rate has done to the books (roadmap #28).
 *
 * Every foreign figure was booked at the rate of its own day. This reads the distance between
 * that rate and two others: the rate a receivable was actually settled at (realised gain or loss —
 * money that has moved), and today's rate for what is still open (unrealised — what would move if
 * it were settled now). For a six-month contract in dollars, the second is the answer to "is this
 * project still profitable in rials?".
 *
 * Today's rate is the latest one recorded, however old; its age is shown beside it rather than
 * the figure being withheld, because a revaluation is an estimate and says so.
 */
import type { Prisma } from '@prisma/client';
import type { Tx } from '../db.js';
import { baseCurrency, currencyFa, D, findRate, SETTLED_EPSILON } from './fx.js';

const n = (d: Prisma.Decimal | null | undefined) => (d == null ? null : Number(d.toDecimalPlaces(2)));

export async function fxReport(tx: Tx, organizationId: string, window: { from: Date | null; to: Date | null }) {
  const base = await baseCurrency(tx, organizationId);
  const now = new Date();
  const current = new Map<string, Awaited<ReturnType<typeof findRate>>>();
  const rateNow = async (c: string) => {
    if (!current.has(c)) current.set(c, await findRate(tx, organizationId, c, now));
    return current.get(c) ?? null;
  };

  // ── Open receivables in another currency, booked vs today.
  const invoices = await tx.invoice.findMany({
    where: { organizationId, currency: { not: base }, state: { not: 'CANCELLED' } },
    select: {
      id: true, code: true, number: true, currency: true, fxRate: true, fxRateDate: true, issueDate: true, dueDate: true,
      originalTotal: true, originalPaidAmount: true, company: { select: { id: true, legalName: true } },
      project: { select: { id: true, code: true, name: true } },
    },
  });
  const receivables = [];
  for (const i of invoices) {
    const open = D(i.originalTotal ?? 0).sub(i.originalPaidAmount ?? 0);
    if (open.lte(SETTLED_EPSILON)) continue;
    const r = await rateNow(i.currency);
    const booked = open.mul(i.fxRate);
    const today = r ? open.mul(r.rate) : null;
    receivables.push({
      id: i.id, code: i.code, number: i.number, company: i.company, project: i.project, currency: i.currency,
      issueDate: i.issueDate, dueDate: i.dueDate, outstanding: n(open), bookedRate: n(i.fxRate), bookedRateDate: i.fxRateDate,
      bookedBase: n(booked), currentRate: r ? n(r.rate) : null, currentRateDate: r?.effectiveDate ?? null,
      currentBase: n(today), unrealised: today ? n(today.sub(booked)) : null,
    });
  }

  // ── Receipts against foreign invoices, at the rate they came in vs the rate they were booked at.
  const payments = await tx.payment.findMany({
    where: {
      organizationId, direction: 'IN', settledOriginal: { not: null },
      invoice: { currency: { not: base } },
      ...(window.from || window.to ? { occurredAt: { ...(window.from ? { gte: window.from } : {}), ...(window.to ? { lt: window.to } : {}) } } : {}),
    },
    select: {
      id: true, amount: true, currency: true, originalAmount: true, settledOriginal: true, occurredAt: true, fxRate: true,
      invoice: { select: { id: true, code: true, number: true, currency: true, fxRate: true, company: { select: { legalName: true } } } },
    },
    orderBy: { occurredAt: 'desc' },
  });
  const realised = payments.map((p) => {
    const booked = D(p.settledOriginal!).mul(p.invoice!.fxRate);
    return {
      id: p.id, occurredAt: p.occurredAt, invoice: p.invoice, currency: p.invoice!.currency, paidIn: p.currency,
      settled: n(p.settledOriginal), bookedBase: n(booked), receivedBase: n(p.amount), gainLoss: n(D(p.amount).sub(booked)),
    };
  });

  // ── Contracts written in another currency: their value as booked, and as it stands today.
  const contracts = await tx.contract.findMany({
    where: { organizationId, currency: { not: base }, state: { notIn: ['EXPIRED', 'TERMINATED'] } },
    select: { id: true, code: true, title: true, currency: true, contractValue: true, originalValue: true, fxRate: true, fxRateDate: true, state: true, project: { select: { id: true, code: true, name: true } } },
  });
  const contractRows = [];
  for (const c of contracts) {
    const r = await rateNow(c.currency);
    const today = r && c.originalValue ? D(c.originalValue).mul(r.rate) : null;
    contractRows.push({
      id: c.id, code: c.code, title: c.title, state: c.state, project: c.project, currency: c.currency,
      original: n(c.originalValue), bookedBase: n(c.contractValue), bookedRateDate: c.fxRateDate,
      currentBase: n(today), change: today ? n(today.sub(c.contractValue)) : null,
    });
  }

  // ── Costs declared in another currency: what they would cost in base today.
  const costs = await tx.costDeclaration.findMany({
    where: { organizationId, externalCurrency: { not: base } },
    select: {
      id: true, externalCurrency: true, externalCost: true, originalExternalCost: true, fxRateDate: true, departmentCode: true, createdAt: true,
      workOrder: { select: { id: true, code: true, title: true, project: { select: { id: true, code: true, name: true } } } },
    },
  });
  const costRows = [];
  for (const c of costs) {
    const r = await rateNow(c.externalCurrency);
    const today = r && c.originalExternalCost ? D(c.originalExternalCost).mul(r.rate) : null;
    costRows.push({
      id: c.id, workOrder: c.workOrder, departmentCode: c.departmentCode, currency: c.externalCurrency, declaredAt: c.createdAt,
      original: n(c.originalExternalCost), bookedBase: n(c.externalCost), bookedRateDate: c.fxRateDate,
      currentBase: n(today), change: today ? n(today.sub(c.externalCost)) : null,
    });
  }

  // ── Per currency, and the two totals that matter.
  const currencies = [...new Set([...receivables.map((r) => r.currency), ...realised.map((r) => r.currency), ...contractRows.map((r) => r.currency), ...costRows.map((r) => r.currency)])];
  const byCurrency: {
    currency: string; labelFa: string; currentRate: number | null; currentRateDate: Date | null; currentRateAgeDays: number | null;
    receivable: number; unrealised: number; realised: number; contracted: number; foreignCost: number;
  }[] = [];
  for (const c of currencies) {
    const r = await rateNow(c);
    const sum = (xs: (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
    byCurrency.push({
      currency: c, labelFa: currencyFa(c),
      currentRate: r ? n(r.rate) : null, currentRateDate: r?.effectiveDate ?? null, currentRateAgeDays: r?.ageDays ?? null,
      receivable: sum(receivables.filter((x) => x.currency === c).map((x) => x.outstanding)),
      unrealised: sum(receivables.filter((x) => x.currency === c).map((x) => x.unrealised)),
      realised: sum(realised.filter((x) => x.currency === c).map((x) => x.gainLoss)),
      contracted: sum(contractRows.filter((x) => x.currency === c).map((x) => x.original)),
      foreignCost: sum(costRows.filter((x) => x.currency === c).map((x) => x.original)),
    });
  }
  const total = (key: 'unrealised' | 'realised') => byCurrency.reduce((s, c) => s + c[key], 0);

  return {
    base, baseLabelFa: currencyFa(base), window,
    totals: { unrealised: total('unrealised'), realised: total('realised') },
    byCurrency, receivables, realised, contracts: contractRows, costs: costRows,
  };
}
