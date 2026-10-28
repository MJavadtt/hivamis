import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { jalaliOf } from '../lib/jalali.js';
import { money, ZERO } from '../lib/money.js';
import { completenessOf } from './venues.js';

/**
 * Reports on venues, deployment projects and rentals (ADR-103) — «گزارشات متنوع». Every figure is the
 * database's sum of the ledger's own rows, defined once (METRICS), in the currency it was written in:
 * amounts in different currencies are listed side by side, never added together.
 */

export interface ReportFilter { from?: Date; to?: Date; province?: string; city?: string; venueId?: string; siteProjectId?: string }

export const METRICS = {
  due: 'جمع مبالغ اقلامی که سررسیدشان در بازه است، بی‌اقلام باطل‌شده (بخشوده‌ها جدا هم نشان داده می‌شوند)',
  settled: 'آنچه از همان اقلام با پرداخت یا کسر از ودیعه تسویه شده',
  outstanding: 'مانده: مبلغ منهای تسویه‌شده، در اقلامی که هنوز باز است',
  overdue: 'ماندهٔ اقلامی که سررسیدشان گذشته است',
  forecast: 'ماندهٔ اقلامی که سررسیدشان هنوز نرسیده — پیش‌بینی پرداخت',
  paid: 'پرداخت‌های ثبت‌شده به مکان‌ها در بازه، بی‌پرداخت‌های برگشت‌خورده',
  depositHeld: 'ودیعه‌ای که واقعاً پرداخت شده، منهای کسرهای تأییدشده و عودت‌ها',
  depositEligible: 'ودیعهٔ نزد مکان در پروژه‌هایی که قراردادشان تمام شده یا در تسویه‌اند',
  depositRefunded: 'ودیعه‌ای که مکان پس داده است',
} as const;

const DAY = 86_400_000;

function projectWhere(organizationId: string, f: ReportFilter): Prisma.SiteProjectWhereInput {
  return {
    organizationId,
    ...(f.siteProjectId ? { id: f.siteProjectId } : {}),
    ...(f.venueId ? { venueId: f.venueId } : {}),
    ...(f.province || f.city ? { venue: { ...(f.province ? { province: f.province } : {}), ...(f.city ? { city: f.city } : {}) } } : {}),
  };
}

const counted = <T extends string>(rows: { key: T | null; n: number }[]) => rows.filter((r) => r.key).sort((a, b) => b.n - a.n);

/* ── venues ──────────────────────────────────────────────────────────────── */

export async function venueReport(organizationId: string, f: ReportFilter) {
  const where: Prisma.VenueWhereInput = {
    organizationId, archivedAt: null, mergedIntoId: null,
    ...(f.province ? { province: f.province } : {}), ...(f.city ? { city: f.city } : {}),
  };
  const [total, active, byProvince, byCity, byType, byGrade, venues] = await Promise.all([
    prisma.venue.count({ where }),
    prisma.venue.count({ where: { ...where, isActive: true } }),
    prisma.venue.groupBy({ by: ['province'], where, _count: { _all: true } }),
    prisma.venue.groupBy({ by: ['province', 'city'], where, _count: { _all: true } }),
    prisma.venue.groupBy({ by: ['typeCode'], where, _count: { _all: true } }),
    prisma.venue.groupBy({ by: ['gradeCode'], where, _count: { _all: true } }),
    prisma.venue.findMany({
      where,
      select: {
        id: true, code: true, name: true, city: true, province: true, address: true, phone: true, gradeCode: true, audienceCodes: true,
        _count: { select: { contacts: { where: { archivedAt: null } }, documents: { where: { deletedAt: null, supersededAt: null, mimeType: { startsWith: 'image/' } } } } },
        siteProjects: { select: { state: true } },
      },
      take: 20_000,
    }),
  ]);
  const audiences = new Map<string, number>();
  for (const v of venues) for (const a of v.audienceCodes) audiences.set(a, (audiences.get(a) ?? 0) + 1);
  const live = ['ACTIVE', 'INSTALLING', 'INSTALL_PLANNED', 'CONTRACT_APPROVED', 'SETTLING'];
  const rows = venues.map((v) => ({
    id: v.id, code: v.code, name: v.name, city: v.city, province: v.province,
    completeness: completenessOf(v, v._count.contacts, v._count.documents),
    projects: v.siteProjects.length, activeProjects: v.siteProjects.filter((p) => live.includes(p.state)).length,
    closedProjects: v.siteProjects.filter((p) => p.state === 'CLOSED').length,
  }));
  return {
    total, active,
    byProvince: counted(byProvince.map((r) => ({ key: r.province, n: r._count._all }))),
    byCity: byCity.map((r) => ({ province: r.province, city: r.city, n: r._count._all })).sort((a, b) => b.n - a.n),
    byType: counted(byType.map((r) => ({ key: r.typeCode, n: r._count._all }))),
    byGrade: counted(byGrade.map((r) => ({ key: r.gradeCode ?? 'NONE', n: r._count._all }))),
    byAudience: [...audiences].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n),
    incomplete: rows.filter((r) => r.completeness.score < 100).sort((a, b) => a.completeness.score - b.completeness.score).slice(0, 200),
    incompleteCount: rows.filter((r) => r.completeness.score < 100).length,
    withoutActiveProject: rows.filter((r) => !r.activeProjects).length,
    utilization: rows.filter((r) => r.projects).sort((a, b) => b.projects - a.projects).slice(0, 100),
  };
}

/* ── projects ────────────────────────────────────────────────────────────── */

export async function projectReport(organizationId: string, f: ReportFilter, now = new Date()) {
  const where = projectWhere(organizationId, f);
  const soon = new Date(now.getTime() + 30 * DAY), expiring = new Date(now.getTime() + 60 * DAY);
  const pick = { id: true, code: true, name: true, state: true, venue: { select: { name: true, city: true } } } as const;
  const [byState, byCooperation, projects, awaiting, upcoming, delayed, ending, costs, counters] = await Promise.all([
    prisma.siteProject.groupBy({ by: ['state'], where, _count: { _all: true } }),
    prisma.siteProject.groupBy({ by: ['cooperationCode'], where, _count: { _all: true } }),
    prisma.siteProject.findMany({ where, select: { state: true, venue: { select: { province: true, city: true } } }, take: 20_000 }),
    prisma.siteContract.findMany({ where: { organizationId, status: 'PENDING_APPROVAL', siteProject: where }, select: { id: true, version: true, submittedAt: true, siteProject: { select: pick } }, orderBy: { submittedAt: 'asc' }, take: 200 }),
    prisma.siteProject.findMany({ where: { ...where, installedAt: null, installPlannedAt: { gte: now, lte: soon }, state: { notIn: ['CLOSED', 'CANCELLED'] } }, select: { ...pick, installPlannedAt: true }, orderBy: { installPlannedAt: 'asc' }, take: 200 }),
    prisma.siteProject.findMany({ where: { ...where, installedAt: null, installPlannedAt: { lt: now }, state: { notIn: ['CLOSED', 'CANCELLED'] } }, select: { ...pick, installPlannedAt: true }, orderBy: { installPlannedAt: 'asc' }, take: 200 }),
    prisma.siteProject.findMany({ where: { ...where, contractEnd: { gte: now, lte: expiring }, state: { in: ['ACTIVE', 'SETTLING', 'INSTALLING', 'INSTALL_PLANNED', 'CONTRACT_APPROVED'] } }, select: { ...pick, contractEnd: true }, orderBy: { contractEnd: 'asc' }, take: 200 }),
    prisma.siteProject.groupBy({ by: ['currency'], where: { ...where, state: { not: 'CANCELLED' } }, _sum: { installCost: true, transportCost: true }, _count: { _all: true } }),
    prisma.siteCounter.findMany({ where: { siteProject: { ...where, state: { not: 'CANCELLED' } } }, select: { quantity: true, unitCost: true, siteProject: { select: { currency: true } } }, take: 50_000 }),
  ]);
  const fabrication = new Map<string, { cost: Prisma.Decimal; counters: number }>();
  for (const c of counters) {
    const k = c.siteProject.currency;
    const f2 = fabrication.get(k) ?? { cost: ZERO, counters: 0 };
    fabrication.set(k, { cost: f2.cost.add(money(c.unitCost).mul(c.quantity)), counters: f2.counters + c.quantity });
  }
  const tally = (key: (p: (typeof projects)[number]) => string) => {
    const m = new Map<string, number>();
    for (const p of projects) m.set(key(p), (m.get(key(p)) ?? 0) + 1);
    return [...m].map(([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n);
  };
  const groups = { pending: ['DRAFT', 'EVALUATION', 'NEGOTIATION', 'TERMS_AGREED', 'CONTRACT_PENDING', 'CONTRACT_APPROVED', 'INSTALL_PLANNED', 'INSTALLING'], active: ['ACTIVE', 'SETTLING', 'CLOSURE_PENDING'], completed: ['CLOSED'], cancelled: ['CANCELLED'] };
  const inGroup = (states: string[]) => byState.filter((s) => states.includes(s.state)).reduce((n, s) => n + s._count._all, 0);
  return {
    byState: byState.map((s) => ({ key: s.state, n: s._count._all })),
    groups: { pending: inGroup(groups.pending), active: inGroup(groups.active), completed: inGroup(groups.completed), cancelled: inGroup(groups.cancelled) },
    byCooperation: counted(byCooperation.map((r) => ({ key: r.cooperationCode ?? 'NONE', n: r._count._all }))),
    byProvince: tally((p) => p.venue.province), byCity: tally((p) => `${p.venue.city}`),
    awaitingApproval: awaiting.map((c) => ({ contractId: c.id, version: c.version, submittedAt: c.submittedAt, ...c.siteProject })),
    upcomingInstallations: upcoming, delayedInstallations: delayed.map((p) => ({ ...p, daysLate: Math.floor((now.getTime() - p.installPlannedAt!.getTime()) / DAY) })),
    expiringContracts: ending,
    costs: costs.map((c) => ({
      currency: c.currency, projects: c._count._all,
      installation: money(c._sum.installCost).toFixed(2), transport: money(c._sum.transportCost).toFixed(2),
      fabrication: (fabrication.get(c.currency)?.cost ?? ZERO).toFixed(2), counters: fabrication.get(c.currency)?.counters ?? 0,
    })),
  };
}

/* ── rentals and money ───────────────────────────────────────────────────── */

export async function rentalReport(organizationId: string, f: ReportFilter, now = new Date()) {
  const projects = projectWhere(organizationId, f);
  const dueIn: Prisma.SiteObligationWhereInput = {
    organizationId, status: { not: 'VOID' }, siteProject: projects,
    ...(f.from || f.to ? { dueDate: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
  };
  const open: Prisma.SiteObligationWhereInput = { ...dueIn, status: { in: ['OPEN', 'PARTIAL'] } };
  const [all, waived, outstanding, overdue, paidRows, upcomingList, overdueList, settlement, deposits] = await Promise.all([
    prisma.siteObligation.groupBy({ by: ['currency', 'kind'], where: dueIn, _sum: { amount: true, settledAmount: true }, _count: { _all: true } }),
    prisma.siteObligation.groupBy({ by: ['currency', 'kind'], where: { ...dueIn, status: 'WAIVED' }, _sum: { amount: true, settledAmount: true } }),
    prisma.siteObligation.groupBy({ by: ['currency', 'kind'], where: open, _sum: { amount: true, settledAmount: true } }),
    prisma.siteObligation.groupBy({ by: ['currency', 'kind'], where: { ...open, dueDate: { lt: now, ...(f.from ? { gte: f.from } : {}) } }, _sum: { amount: true, settledAmount: true } }),
    prisma.sitePayment.findMany({
      where: { organizationId, reversedAt: null, siteProject: projects, ...(f.from || f.to ? { paidAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}) },
      select: { amount: true, currency: true, purpose: true, paidAt: true, siteProject: { select: { id: true, code: true, name: true, venue: { select: { id: true, name: true } } } } },
      orderBy: { paidAt: 'asc' }, take: 50_000,
    }),
    prisma.siteObligation.findMany({ where: { ...open, dueDate: { gte: now, lte: new Date(now.getTime() + 30 * DAY) } }, select: obligationPick, orderBy: { dueDate: 'asc' }, take: 300 }),
    prisma.siteObligation.findMany({ where: { ...open, dueDate: { lt: now } }, select: obligationPick, orderBy: { dueDate: 'asc' }, take: 300 }),
    prisma.siteProject.findMany({
      where: { ...projects, state: { in: ['ACTIVE', 'SETTLING', 'CLOSURE_PENDING', 'CLOSED'] } },
      select: { id: true, code: true, name: true, state: true, currency: true, installCost: true, transportCost: true, venue: { select: { name: true } },
        obligations: { where: { status: { in: ['OPEN', 'PARTIAL'] } }, select: { amount: true, settledAmount: true } },
        counters: { select: { quantity: true, unitCost: true } } },
      take: 2000,
    }),
    depositRows(organizationId, f),
  ]);

  const sumKey = (rows: { currency: string; kind: string; _sum: { amount: Prisma.Decimal | null; settledAmount: Prisma.Decimal | null } }[]) => rows.map((r) => ({
    currency: r.currency, kind: r.kind,
    amount: money(r._sum.amount).toFixed(2), settled: money(r._sum.settledAmount).toFixed(2),
    open: money(r._sum.amount).sub(money(r._sum.settledAmount)).toFixed(2),
  }));
  const months = new Map<string, { month: string; currency: string; out: Prisma.Decimal; in: Prisma.Decimal }>();
  const byVenue = new Map<string, { venueId: string; venue: string; currency: string; paid: Prisma.Decimal; payments: number }>();
  for (const p of paidRows) {
    const j = jalaliOf(p.paidAt);
    const key = `${j.y}-${String(j.m).padStart(2, '0')}|${p.currency}`;
    const m = months.get(key) ?? { month: key.split('|')[0]!, currency: p.currency, out: ZERO, in: ZERO };
    if (p.purpose === 'OBLIGATIONS') m.out = m.out.add(money(p.amount)); else m.in = m.in.add(money(p.amount));
    months.set(key, m);
    if (p.purpose === 'OBLIGATIONS') {
      const vk = `${p.siteProject.venue.id}|${p.currency}`;
      const v = byVenue.get(vk) ?? { venueId: p.siteProject.venue.id, venue: p.siteProject.venue.name, currency: p.currency, paid: ZERO, payments: 0 };
      v.paid = v.paid.add(money(p.amount)); v.payments++;
      byVenue.set(vk, v);
    }
  }
  return {
    definitions: METRICS,
    obligations: sumKey(all), waived: sumKey(waived), outstanding: sumKey(outstanding), overdue: sumKey(overdue),
    cashflow: [...months.values()].map((m) => ({ month: m.month, currency: m.currency, out: m.out.toFixed(2), in: m.in.toFixed(2), net: m.out.sub(m.in).toFixed(2) })).sort((a, b) => a.month.localeCompare(b.month)),
    paidByVenue: [...byVenue.values()].map((v) => ({ ...v, paid: v.paid.toFixed(2) })).sort((a, b) => money(b.paid).cmp(money(a.paid))),
    upcoming: upcomingList.map(obligationRow), overdueItems: overdueList.map(obligationRow),
    settlement: settlement.map((p) => {
      const open2 = p.obligations.reduce((s, o) => s.add(money(o.amount).sub(money(o.settledAmount))), ZERO);
      const fabrication = p.counters.reduce((s, c) => s.add(money(c.unitCost).mul(c.quantity)), ZERO);
      const d = deposits.find((x) => x.id === p.id);
      return {
        id: p.id, code: p.code, name: p.name, state: p.state, currency: p.currency, venue: p.venue.name,
        outstanding: open2.toFixed(2), depositRemaining: d ? d.remaining : '0.00',
        costs: { installation: money(p.installCost).toFixed(2), transport: money(p.transportCost).toFixed(2), fabrication: fabrication.toFixed(2), total: money(p.installCost).add(money(p.transportCost)).add(fabrication).toFixed(2) },
        settled: open2.eq(0) && (!d || money(d.remaining).eq(0)),
      };
    }),
    deposits: {
      byCurrency: [...deposits.reduce((m, d) => {
        const t = m.get(d.currency) ?? { currency: d.currency, held: ZERO, eligible: ZERO, refunded: ZERO, deducted: ZERO };
        t.held = t.held.add(money(d.remaining)); t.refunded = t.refunded.add(money(d.refunded)); t.deducted = t.deducted.add(money(d.deducted));
        if (d.eligible) t.eligible = t.eligible.add(money(d.remaining));
        return m.set(d.currency, t);
      }, new Map<string, { currency: string; held: Prisma.Decimal; eligible: Prisma.Decimal; refunded: Prisma.Decimal; deducted: Prisma.Decimal }>()).values()]
        .map((t) => ({ currency: t.currency, held: t.held.toFixed(2), eligible: t.eligible.toFixed(2), refunded: t.refunded.toFixed(2), deducted: t.deducted.toFixed(2) })),
      projects: deposits,
    },
  };
}

const obligationPick = {
  id: true, kind: true, dueDate: true, amount: true, settledAmount: true, currency: true, status: true, periodStart: true, periodEnd: true, description: true,
  siteProject: { select: { id: true, code: true, name: true, venue: { select: { name: true, city: true } } } },
} as const;
const obligationRow = (o: { id: string; kind: string; dueDate: Date; amount: Prisma.Decimal; settledAmount: Prisma.Decimal; currency: string; status: string; periodStart: Date | null; periodEnd: Date | null; description: string | null; siteProject: { id: string; code: string; name: string; venue: { name: string; city: string } } }) => ({
  ...o, amount: money(o.amount).toFixed(2), settledAmount: money(o.settledAmount).toFixed(2), outstanding: money(o.amount).sub(money(o.settledAmount)).toFixed(2),
});

/** Every project's deposit in one query: paid in, deducted, refunded, and what remains with the venue. */
async function depositRows(organizationId: string, f: ReportFilter, now = new Date()) {
  const rows = await prisma.$queryRaw<{ id: string; code: string; name: string; state: string; currency: string; contractEnd: Date | null; venue: string; held: Prisma.Decimal; deducted: Prisma.Decimal; refunded: Prisma.Decimal }[]>`
    WITH held AS (
      SELECT o."siteProjectId" AS id, sum(a.amount) AS v
      FROM site_allocations a JOIN site_obligations o ON o.id = a."obligationId"
      WHERE a."organizationId" = ${organizationId} AND a."reversedAt" IS NULL AND a."paymentId" IS NOT NULL AND o.kind = 'DEPOSIT'
      GROUP BY 1
    ), entries AS (
      SELECT "siteProjectId" AS id,
        sum(amount) FILTER (WHERE kind = 'DEDUCTION' AND status = 'APPROVED') AS deducted,
        sum(amount) FILTER (WHERE kind = 'REFUND' AND status = 'APPROVED') AS refunded
      FROM site_deposit_entries WHERE "organizationId" = ${organizationId} GROUP BY 1
    )
    SELECT p.id, p.code, p.name, p.state, p.currency, p."contractEnd", v.name AS venue,
      coalesce(h.v, 0) AS held, coalesce(e.deducted, 0) AS deducted, coalesce(e.refunded, 0) AS refunded
    FROM site_projects p
    JOIN venues v ON v.id = p."venueId"
    JOIN held h ON h.id = p.id
    LEFT JOIN entries e ON e.id = p.id
    WHERE p."organizationId" = ${organizationId}
      AND (${f.province ?? null}::text IS NULL OR v.province = ${f.province ?? null})
      AND (${f.city ?? null}::text IS NULL OR v.city = ${f.city ?? null})
      AND (${f.venueId ?? null}::text IS NULL OR p."venueId" = ${f.venueId ?? null})
      AND (${f.siteProjectId ?? null}::text IS NULL OR p.id = ${f.siteProjectId ?? null})
    ORDER BY p."contractEnd" NULLS LAST
    LIMIT 5000`;
  return rows.map((r) => {
    const remaining = money(r.held).sub(money(r.deducted)).sub(money(r.refunded));
    const eligible = remaining.gt(0) && (['SETTLING', 'CLOSURE_PENDING'].includes(r.state) || (!!r.contractEnd && r.contractEnd < now));
    return { ...r, held: money(r.held).toFixed(2), deducted: money(r.deducted).toFixed(2), refunded: money(r.refunded).toFixed(2), remaining: remaining.toFixed(2), eligible };
  });
}
