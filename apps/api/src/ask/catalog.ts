/**
 * The semantic layer under natural-language reporting (roadmap #27).
 *
 * A question is never translated into SQL. It is translated into a choice from this catalogue:
 * a metric with a written definition, the date that places a record in a window, the ways it may
 * be split, and the permissions its *fields* need — so "profit margin" means one thing whether it
 * is asked for in a sentence or read off the dashboard, and a person who may not see contract
 * values does not get them by asking nicely. Where a dashboard already shows the same number, the
 * definition here is that dashboard's, and a test holds the two together.
 *
 * Each metric returns facts — one row per record, with its dimensions and additive measures — and
 * the answer layer groups and totals them. Facts carry a reference to their record, so every
 * number can be opened and checked.
 */
import { DEPARTMENT_LABELS, REVISION_REASON_LABELS, stateLabelFa, WORKFLOWS } from '@hiva/contracts';
import type { Prisma } from '@prisma/client';
import type { Tx } from '../db.js';
import { loadCalendar } from '../sla/engine.js';
import { mine } from '../reports/mining.js';

export type Dim = 'unit' | 'client' | 'project' | 'person' | 'month' | 'reason' | 'policy' | 'state';
export const DIMS: Dim[] = ['unit', 'client', 'project', 'person', 'month', 'reason', 'policy', 'state'];

export interface Filters {
  units?: string[];
  companyId?: string;
  projectId?: string;
  personId?: string;
  /** cycle_time only: which state machine. */
  entity?: string;
}
export type FilterKey = keyof Filters;

export interface Ref { entity: string; id: string; label: string; href: string }
export interface DimValue { key: string; labelFa: string }
export interface Fact {
  dims: Partial<Record<Dim, DimValue>>;
  m: Record<string, number>;
  /** The date that placed the record in the window; the month dimension is read from it. */
  at: Date | null;
  ref?: Ref;
}

export interface FactCtx {
  tx: Tx;
  org: string;
  from: Date | null;
  to: Date | null;
  filters: Filters;
  now: Date;
  people: Map<string, { fullName: string; departmentCode: string | null }>;
}

export type ValueUnit = 'RIAL' | 'PERCENT' | 'COUNT' | 'HOURS' | 'SCORE';

export interface MetricSpec {
  key: string;
  labelFa: string;
  definitionFa: string;
  unit: ValueUnit;
  /** Normalised by the parser; longer phrases win over the words inside them. */
  synonyms: string[];
  /** Words too common to decide the metric on their own when a stronger one is present. */
  weak?: string[];
  /** Every one is needed — the metric's fields, not just the report it lives in. */
  requires: string[];
  dims: Dim[];
  filters: FilterKey[];
  /** What the person dimension is on this metric, for the label. */
  personLabelFa?: string;
  /** Splitting or filtering by a colleague shows individual performance: management only, or yourself. */
  personSensitive?: boolean;
  /** A state of today rather than a flow over a window. */
  asOfNow?: boolean;
  /** What a unit filter means here. */
  unitMeaning?: 'OWN' | 'PROJECT';
  /** Cost history is per unit: those who set or approve prices see all units, others their own. */
  ownUnitUnless?: string[];
  example: string;
  facts?(ctx: FactCtx): Promise<Fact[]>;
  /** For metrics that are not a sum of records (cycle time from the event log). */
  direct?(ctx: FactCtx): Promise<{ value: number | null; countFa: string; noteFa: string[] }>;
  value(m: Record<string, number>): number | null;
  countFa(m: Record<string, number>): string;
  secondaryFa?(m: Record<string, number>): string | null;
  caveats?(ctx: FactCtx, m: Record<string, number>): Promise<string[]>;
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const FA = '۰۱۲۳۴۵۶۷۸۹';
export const fa = (v: string | number) => String(v).replace(/\d/g, (c) => FA[Number(c)]!);
const nf = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 });
export const money = (v: number) => `${nf.format(Math.round(v))} ریال`;
const num = (v: unknown) => (v == null ? 0 : Number(v));
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);
const round1 = (v: number) => Math.round(v * 10) / 10;

const range = (from: Date | null, to: Date | null): Prisma.DateTimeFilter | undefined =>
  from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } : undefined;
const inWindow = (d: Date | null, from: Date | null, to: Date | null) =>
  !!d && (!from || d >= from) && (!to || d < to);

const unitDim = (code: string | null | undefined): DimValue | undefined =>
  code ? { key: code, labelFa: DEPARTMENT_LABELS[code as keyof typeof DEPARTMENT_LABELS]?.fa ?? code } : undefined;
const clientDim = (c: { id: string; legalName: string } | null | undefined): DimValue =>
  c ? { key: c.id, labelFa: c.legalName } : { key: '-', labelFa: 'بدون مشتری' };
const projectDim = (p: { id: string; code: string; name: string } | null | undefined): DimValue =>
  p ? { key: p.id, labelFa: `${p.name} (${p.code})` } : { key: '-', labelFa: 'بدون پروژه' };
const personDim = (id: string | null | undefined, people: FactCtx['people']): DimValue =>
  id ? { key: id, labelFa: people.get(id)?.fullName ?? 'کاربر حذف‌شده' } : { key: '-', labelFa: 'بدون مسئول' };

/** "Projects of the media unit" — those in which the unit received a work order. */
const projectScope = (org: string, f: Filters): Prisma.ProjectWhereInput => ({
  organizationId: org, deletedAt: null,
  ...(f.companyId ? { companyId: f.companyId } : {}),
  ...(f.projectId ? { id: f.projectId } : {}),
  ...(f.units?.length ? { workOrders: { some: { targetDepartmentCode: { in: f.units } } } } : {}),
});
const hasProjectScope = (f: Filters) => !!(f.companyId || f.projectId || f.units?.length);

const DONE_TASK = ['APPROVED', 'CLOSED'];
const CLOSED_TASK = ['APPROVED', 'CLOSED', 'CANCELLED'];
const projectRef = (p: { id: string; code: string; name: string }): Ref => ({ entity: 'project', id: p.id, label: `${p.code} — ${p.name}`, href: `/projects/${p.id}` });
const taskRef = (t: { id: string; code: string; title: string }): Ref => ({ entity: 'task', id: t.id, label: `${t.code} — ${t.title}`, href: `/tasks/${t.id}` });

const ENTITY_HREF: Record<string, (id: string) => string> = {
  task: (id) => `/tasks/${id}`, project: (id) => `/projects/${id}`, workOrder: (id) => `/work-orders/${id}`,
  brief: (id) => `/briefs/${id}`, proposal: (id) => `/proposals/${id}`, opportunity: (id) => `/opportunities/${id}`,
  changeRequest: (id) => `/changes/${id}`, contract: (id) => `/contracts/${id}`,
};

/* ── the catalogue ───────────────────────────────────────────────────────── */

export const METRICS: MetricSpec[] = [
  {
    key: 'margin', labelFa: 'حاشیهٔ سود',
    definitionFa: 'برای پروژه‌هایی که در این بازه بسته شده‌اند: (ارزش قرارداد − هزینهٔ اعلام‌شدهٔ سفارش‌های کار) ÷ ارزش قرارداد. پروژهٔ در جریان حساب نمی‌شود، چون هزینه‌اش هنوز کامل نیست؛ پروژهٔ بدون ارزش قرارداد کنار گذاشته می‌شود.',
    unit: 'PERCENT', synonyms: ['حاشیه سود', 'سودآوری', 'سود اوری', 'مارجین', 'margin', 'سود', 'حاشیه'], weak: ['حاشیه', 'سود'],
    requires: ['report.read', 'finance.read', 'pricing.read'],
    dims: ['client', 'project', 'person', 'month'], filters: ['units', 'companyId', 'projectId', 'personId'],
    personLabelFa: 'مدیر حساب', unitMeaning: 'PROJECT',
    example: 'حاشیه سود پروژه‌های واحد رسانه در سه ماه گذشته چقدر بوده؟',
    async facts({ tx, org, from, to, filters, people }) {
      const projects = await tx.project.findMany({
        where: { ...projectScope(org, filters), state: 'CLOSED', ...(from || to ? { closedAt: range(from, to) } : {}), ...(filters.personId ? { accountOwnerId: filters.personId } : {}) },
        select: { id: true, code: true, name: true, contractValue: true, closedAt: true, accountOwnerId: true, company: { select: { id: true, legalName: true } } },
      });
      const costs = await tx.costDeclaration.findMany({
        where: { organizationId: org, workOrder: { projectId: { in: projects.map((p) => p.id) } } },
        select: { internalCost: true, externalCost: true, workOrder: { select: { projectId: true } } },
      });
      const costOf = new Map<string, number>();
      for (const c of costs) costOf.set(c.workOrder!.projectId, (costOf.get(c.workOrder!.projectId) ?? 0) + num(c.internalCost) + num(c.externalCost));
      return projects.map((p) => {
        const revenue = num(p.contractValue);
        return {
          dims: { client: clientDim(p.company), project: projectDim(p), person: personDim(p.accountOwnerId, people) },
          m: revenue > 0 ? { revenue, cost: costOf.get(p.id) ?? 0, projects: 1, noContract: 0 } : { revenue: 0, cost: 0, projects: 0, noContract: 1 },
          at: p.closedAt, ref: projectRef(p),
        };
      });
    },
    value: (m) => (m.revenue! > 0 ? round1(((m.revenue! - m.cost!) / m.revenue!) * 100) : null),
    countFa: (m) => `${fa(m.projects ?? 0)} پروژهٔ بسته‌شده`,
    secondaryFa: (m) => (m.revenue! > 0 ? `حاشیهٔ ریالی ${money(m.revenue! - m.cost!)} از ${money(m.revenue!)} قرارداد` : null),
    async caveats({ tx, org, filters }, m) {
      const out: string[] = [];
      if (m.noContract) out.push(`${fa(m.noContract)} پروژهٔ بسته بدون ارزش قرارداد کنار گذاشته شد.`);
      const live = await tx.project.count({ where: { ...projectScope(org, filters), state: { notIn: ['CLOSED', 'CANCELLED'] } } });
      if (live) out.push(`${fa(live)} پروژهٔ در جریان در این عدد نیست؛ حاشیهٔ آن‌ها تا بسته شدن قطعی نیست.`);
      return out;
    },
  },
  {
    key: 'contract_value', labelFa: 'ارزش قراردادها',
    definitionFa: 'جمع ارزش قرارداد پروژه‌هایی که در این بازه ایجاد شده‌اند، به‌جز پروژه‌های لغوشده.',
    unit: 'RIAL', synonyms: ['ارزش قرارداد', 'ارزش قراردادها', 'مبلغ قرارداد', 'درامد قراردادی', 'درامد', 'فروش قراردادی'],
    requires: ['report.read', 'finance.read'],
    dims: ['client', 'project', 'person', 'month', 'state'], filters: ['units', 'companyId', 'projectId', 'personId'],
    personLabelFa: 'مدیر حساب', unitMeaning: 'PROJECT',
    example: 'ارزش قراردادهای امسال به تفکیک مشتری',
    async facts({ tx, org, from, to, filters, people }) {
      const projects = await tx.project.findMany({
        where: { ...projectScope(org, filters), state: { not: 'CANCELLED' }, ...(from || to ? { createdAt: range(from, to) } : {}), ...(filters.personId ? { accountOwnerId: filters.personId } : {}) },
        select: { id: true, code: true, name: true, state: true, contractValue: true, createdAt: true, accountOwnerId: true, company: { select: { id: true, legalName: true } } },
      });
      return projects.map((p) => ({
        dims: { client: clientDim(p.company), project: projectDim(p), person: personDim(p.accountOwnerId, people), state: { key: p.state, labelFa: stateLabelFa(p.state) } },
        m: { value: num(p.contractValue), projects: 1 }, at: p.createdAt, ref: projectRef(p),
      }));
    },
    value: (m) => m.value ?? 0,
    countFa: (m) => `${fa(m.projects ?? 0)} پروژه`,
  },
  {
    key: 'invoiced', labelFa: 'مبلغ فاکتورشده',
    definitionFa: 'جمع مبلغ کل فاکتورهایی که تاریخ صدورشان در این بازه است، به‌جز فاکتورهای ابطال‌شده.',
    unit: 'RIAL', synonyms: ['فاکتور شده', 'فاکتورشده', 'فاکتور', 'صورتحساب', 'صورت حساب'],
    requires: ['report.read', 'finance.read'],
    dims: ['client', 'project', 'month'], filters: ['units', 'companyId', 'projectId'], unitMeaning: 'PROJECT',
    example: 'مبلغ فاکتورشده در فصل گذشته به تفکیک مشتری',
    async facts({ tx, org, from, to, filters }) {
      const invoices = await tx.invoice.findMany({
        where: {
          organizationId: org, state: { not: 'CANCELLED' }, ...(from || to ? { issueDate: range(from, to) } : {}),
          ...(filters.companyId ? { companyId: filters.companyId } : {}),
          ...(filters.projectId ? { projectId: filters.projectId } : {}),
          ...(filters.units?.length ? { project: { workOrders: { some: { targetDepartmentCode: { in: filters.units } } } } } : {}),
        },
        select: { id: true, number: true, code: true, total: true, issueDate: true, company: { select: { id: true, legalName: true } }, project: { select: { id: true, code: true, name: true } } },
      });
      return invoices.map((i) => ({
        dims: { client: clientDim(i.company), project: projectDim(i.project) },
        m: { value: num(i.total), invoices: 1 }, at: i.issueDate,
        ref: { entity: 'invoice', id: i.id, label: `${i.code} — ${i.number}`, href: '/finance' },
      }));
    },
    value: (m) => m.value ?? 0,
    countFa: (m) => `${fa(m.invoices ?? 0)} فاکتور`,
  },
  {
    key: 'received', labelFa: 'دریافتی از مشتری',
    definitionFa: 'جمع پرداخت‌های دریافتی (ورودی) که تاریخ وقوعشان در این بازه است.',
    unit: 'RIAL', synonyms: ['دریافتی', 'دریافت شده', 'وصولی', 'وصول شده', 'نقد شده', 'دریافت'], weak: ['دریافت'],
    requires: ['report.read', 'finance.read'],
    dims: ['client', 'project', 'month'], filters: ['units', 'companyId', 'projectId'], unitMeaning: 'PROJECT',
    example: 'دریافتی از مشتری در ماه گذشته',
    async facts({ tx, org, from, to, filters }) {
      const payments = await tx.payment.findMany({
        where: {
          organizationId: org, direction: 'IN', ...(from || to ? { occurredAt: range(from, to) } : {}),
          ...(filters.projectId ? { projectId: filters.projectId } : {}),
          ...(filters.companyId ? { OR: [{ project: { companyId: filters.companyId } }, { invoice: { companyId: filters.companyId } }] } : {}),
          ...(filters.units?.length ? { project: { workOrders: { some: { targetDepartmentCode: { in: filters.units } } } } } : {}),
        },
        select: {
          id: true, amount: true, occurredAt: true, reference: true,
          project: { select: { id: true, code: true, name: true, company: { select: { id: true, legalName: true } } } },
          invoice: { select: { code: true, company: { select: { id: true, legalName: true } } } },
        },
      });
      return payments.map((p) => ({
        dims: { client: clientDim(p.invoice?.company ?? p.project?.company), project: projectDim(p.project) },
        m: { value: num(p.amount), payments: 1 }, at: p.occurredAt,
        ref: { entity: 'payment', id: p.id, label: p.invoice?.code ? `پرداخت فاکتور ${p.invoice.code}` : (p.reference ?? 'پرداخت'), href: '/finance' },
      }));
    },
    value: (m) => m.value ?? 0,
    countFa: (m) => `${fa(m.payments ?? 0)} پرداخت`,
  },
  {
    key: 'outstanding', labelFa: 'مطالبات',
    definitionFa: 'مانده‌ی پرداخت‌نشدهٔ فاکتورهای ابطال‌نشده (مبلغ کل − مبلغ پرداخت‌شده)، در وضعیت امروز.',
    unit: 'RIAL', synonyms: ['مطالبات', 'مطالبات معوق', 'معوقات', 'وصول نشده', 'پرداخت نشده', 'بدهی مشتری', 'بدهی مشتریان', 'طلب'], weak: ['طلب'],
    requires: ['report.read', 'finance.read'],
    dims: ['client', 'project'], filters: ['units', 'companyId', 'projectId'], unitMeaning: 'PROJECT', asOfNow: true,
    example: 'مطالبات به تفکیک مشتری',
    async facts({ tx, org, filters, now }) {
      const invoices = await tx.invoice.findMany({
        where: {
          organizationId: org, state: { not: 'CANCELLED' },
          ...(filters.companyId ? { companyId: filters.companyId } : {}),
          ...(filters.projectId ? { projectId: filters.projectId } : {}),
          ...(filters.units?.length ? { project: { workOrders: { some: { targetDepartmentCode: { in: filters.units } } } } } : {}),
        },
        select: { id: true, code: true, number: true, total: true, paidAmount: true, dueDate: true, issueDate: true, company: { select: { id: true, legalName: true } }, project: { select: { id: true, code: true, name: true } } },
      });
      return invoices.filter((i) => num(i.total) - num(i.paidAmount) > 0).map((i) => {
        const rest = num(i.total) - num(i.paidAmount);
        return {
          dims: { client: clientDim(i.company), project: projectDim(i.project) },
          m: { value: rest, overdue: i.dueDate && i.dueDate < now ? rest : 0, invoices: 1 }, at: i.issueDate,
          ref: { entity: 'invoice', id: i.id, label: `${i.code} — ${i.number}`, href: '/finance' },
        };
      });
    },
    value: (m) => m.value ?? 0,
    countFa: (m) => `${fa(m.invoices ?? 0)} فاکتور باز`,
    secondaryFa: (m) => (m.overdue ? `${money(m.overdue)} از آن سررسید گذشته است` : 'هیچ‌کدام سررسید نگذشته‌اند'),
  },
  {
    key: 'declared_cost', labelFa: 'هزینهٔ اعلام‌شده',
    definitionFa: 'جمع هزینهٔ داخلی و بیرونی که واحدها در این بازه اعلام کرده‌اند (قیمت تمام‌شده؛ هم برای سفارش کار و هم برای پروپوزال) — همان عدد گزارش عملکرد واحدها.',
    unit: 'RIAL', synonyms: ['هزینه اعلام شده', 'قیمت تمام شده', 'بهای تمام شده', 'هزینه ها', 'هزینه'], weak: ['هزینه'],
    requires: ['report.read', 'pricing.read'], ownUnitUnless: ['pricing.set_price', 'pricing.approve'],
    dims: ['unit', 'client', 'project', 'month'], filters: ['units', 'companyId', 'projectId'], unitMeaning: 'OWN',
    example: 'هزینهٔ اعلام‌شدهٔ هر واحد در سه ماه گذشته',
    async facts({ tx, org, from, to, filters }) {
      const rows = await tx.costDeclaration.findMany({
        where: {
          organizationId: org, ...(from || to ? { createdAt: range(from, to) } : {}),
          ...(filters.units?.length ? { departmentCode: { in: filters.units } } : {}),
          ...(filters.projectId || filters.companyId ? {
            workOrder: { ...(filters.projectId ? { projectId: filters.projectId } : {}), ...(filters.companyId ? { project: { companyId: filters.companyId } } : {}) },
          } : {}),
        },
        select: {
          id: true, departmentCode: true, internalCost: true, externalCost: true, createdAt: true,
          workOrder: { select: { id: true, code: true, title: true, project: { select: { id: true, code: true, name: true, company: { select: { id: true, legalName: true } } } } } },
          proposal: { select: { id: true, code: true } },
        },
      });
      return rows.map((c) => ({
        dims: { unit: unitDim(c.departmentCode), client: clientDim(c.workOrder?.project.company), project: c.workOrder ? projectDim(c.workOrder.project) : { key: '-', labelFa: 'پروپوزال (پیش از پروژه)' } },
        m: { value: num(c.internalCost) + num(c.externalCost), declarations: 1 }, at: c.createdAt,
        ref: c.workOrder
          ? { entity: 'workOrder', id: c.workOrder.id, label: `${c.workOrder.code} — ${c.workOrder.title}`, href: `/work-orders/${c.workOrder.id}` }
          : { entity: 'proposal', id: c.proposal?.id ?? c.id, label: c.proposal?.code ?? 'پروپوزال', href: c.proposal ? `/proposals/${c.proposal.id}` : '/proposals' },
      }));
    },
    value: (m) => m.value ?? 0,
    countFa: (m) => `${fa(m.declarations ?? 0)} اعلام هزینه`,
  },
  {
    key: 'on_time_rate', labelFa: 'نرخ تحویل به‌موقع',
    definitionFa: 'از وظایف انجام‌شده‌ای که مهلت داشتند، سهمی که پیش از مهلت تحویل شد. بازه بر اساس تاریخ تحویل وظیفه است. همان تعریف برج کنترل و گزارش واحدها.',
    unit: 'PERCENT', synonyms: ['تحویل به موقع', 'نرخ به موقع', 'به موقع', 'بموقع', 'on time'],
    requires: ['report.read'],
    dims: ['unit', 'project', 'client', 'person', 'month'], filters: ['units', 'companyId', 'projectId', 'personId'],
    personLabelFa: 'مسئول وظیفه', personSensitive: true, unitMeaning: 'OWN',
    example: 'نرخ تحویل به‌موقع واحد خلاقیت در این فصل',
    async facts({ tx, org, from, to, filters, people }) {
      const tasks = await tx.task.findMany({
        where: {
          organizationId: org, state: { in: DONE_TASK }, dueDate: { not: null },
          ...(from || to ? { submittedAt: range(from, to) } : {}),
          ...(filters.units?.length ? { departmentCode: { in: filters.units } } : {}),
          ...(filters.projectId ? { projectId: filters.projectId } : {}),
          ...(filters.companyId ? { project: { companyId: filters.companyId } } : {}),
          ...(filters.personId ? { assigneeId: filters.personId } : {}),
        },
        select: { id: true, code: true, title: true, dueDate: true, submittedAt: true, departmentCode: true, assigneeId: true, project: { select: { id: true, code: true, name: true, company: { select: { id: true, legalName: true } } } } },
      });
      return tasks.map((t) => ({
        dims: { unit: unitDim(t.departmentCode), project: projectDim(t.project), client: clientDim(t.project.company), person: personDim(t.assigneeId, people) },
        m: { onTime: t.submittedAt && t.submittedAt <= t.dueDate! ? 1 : 0, done: 1 }, at: t.submittedAt, ref: taskRef(t),
      }));
    },
    value: (m) => pct(m.onTime ?? 0, m.done ?? 0),
    countFa: (m) => `${fa(m.onTime ?? 0)} از ${fa(m.done ?? 0)} وظیفه`,
  },
  {
    key: 'first_pass_yield', labelFa: 'قبولی در QC واحد',
    definitionFa: 'سهم بازبینی‌های QC سطح واحد روی خروجی‌ها که با «تأیید» بسته شدند، در این بازه — همان عدد «First Pass Yield» گزارش واحدها.',
    unit: 'PERCENT', synonyms: ['عبور در نوبت اول', 'قبولی در qc', 'قبولی qc', 'تایید qc', 'first pass', 'fpy', 'qc'], weak: ['qc'],
    requires: ['report.read'],
    dims: ['unit', 'project', 'client', 'month'], filters: ['units', 'companyId', 'projectId'], unitMeaning: 'OWN',
    example: 'قبولی در QC به تفکیک واحد در امسال',
    async facts({ tx, org, from, to, filters }) {
      const reviews = await tx.qcReview.findMany({
        where: {
          organizationId: org, level: 'UNIT', deliverableId: { not: null }, ...(from || to ? { reviewedAt: range(from, to) } : {}),
          ...(filters.units?.length || filters.projectId || filters.companyId ? {
            deliverable: {
              ...(filters.units?.length ? { departmentCode: { in: filters.units } } : {}),
              ...(filters.projectId ? { projectId: filters.projectId } : {}),
              ...(filters.companyId ? { project: { companyId: filters.companyId } } : {}),
            },
          } : {}),
        },
        select: { id: true, verdict: true, reviewedAt: true, deliverable: { select: { id: true, code: true, name: true, departmentCode: true, project: { select: { id: true, code: true, name: true, company: { select: { id: true, legalName: true } } } } } } },
      });
      return reviews.map((r) => ({
        dims: { unit: unitDim(r.deliverable!.departmentCode), project: projectDim(r.deliverable!.project), client: clientDim(r.deliverable!.project.company) },
        m: { passed: r.verdict === 'PASSED' ? 1 : 0, total: 1 }, at: r.reviewedAt,
        ref: { entity: 'deliverable', id: r.deliverable!.id, label: `${r.deliverable!.code} — ${r.deliverable!.name}`, href: `/projects/${r.deliverable!.project.id}` },
      }));
    },
    value: (m) => pct(m.passed ?? 0, m.total ?? 0),
    countFa: (m) => `${fa(m.passed ?? 0)} از ${fa(m.total ?? 0)} بازبینی`,
  },
  {
    key: 'revisions', labelFa: 'اصلاحیه‌ها',
    definitionFa: 'تعداد اصلاحیه‌هایی که در این بازه ثبت شده‌اند، به نام واحد مسئول اصلاح.',
    unit: 'COUNT', synonyms: ['اصلاحیه', 'اصلاحیه ها', 'ریوایز', 'revision', 'revisions', 'دوباره کاری', 'بازکاری'],
    requires: ['report.read'],
    dims: ['unit', 'reason', 'project', 'client', 'person', 'month'], filters: ['units', 'companyId', 'projectId', 'personId'],
    personLabelFa: 'مسئول اصلاح', personSensitive: true, unitMeaning: 'OWN',
    example: 'کدام واحد بیشترین اصلاحیه را در سه ماه گذشته داشته؟',
    async facts({ tx, org, from, to, filters, people }) {
      const projectFilter: Prisma.RevisionWhereInput | undefined = filters.projectId || filters.companyId ? {
        OR: [
          { deliverable: { ...(filters.projectId ? { projectId: filters.projectId } : {}), ...(filters.companyId ? { project: { companyId: filters.companyId } } : {}) } },
          { task: { ...(filters.projectId ? { projectId: filters.projectId } : {}), ...(filters.companyId ? { project: { companyId: filters.companyId } } : {}) } },
        ],
      } : undefined;
      const rows = await tx.revision.findMany({
        where: {
          organizationId: org, ...(from || to ? { createdAt: range(from, to) } : {}),
          ...(filters.units?.length ? { responsibleDepartmentCode: { in: filters.units } } : {}),
          ...(filters.personId ? { assigneeId: filters.personId } : {}),
          ...(projectFilter ?? {}),
        },
        select: {
          id: true, code: true, reason: true, responsibleDepartmentCode: true, assigneeId: true, createdAt: true, taskId: true,
          deliverable: { select: { project: { select: { id: true, code: true, name: true, company: { select: { id: true, legalName: true } } } } } },
          task: { select: { project: { select: { id: true, code: true, name: true, company: { select: { id: true, legalName: true } } } } } },
        },
      });
      return rows.map((r) => {
        const project = r.deliverable?.project ?? r.task?.project ?? null;
        return {
          dims: { unit: unitDim(r.responsibleDepartmentCode), reason: { key: r.reason, labelFa: REVISION_REASON_LABELS[r.reason] ?? r.reason }, project: projectDim(project), client: clientDim(project?.company), person: personDim(r.assigneeId, people) },
          m: { count: 1 }, at: r.createdAt,
          ref: { entity: 'revision', id: r.id, label: r.code, href: project ? `/projects/${project.id}` : r.taskId ? `/tasks/${r.taskId}` : '/qc' },
        };
      });
    },
    value: (m) => m.count ?? 0,
    countFa: (m) => `${fa(m.count ?? 0)} اصلاحیه`,
  },
  {
    key: 'sla_compliance', labelFa: 'رعایت SLA',
    definitionFa: 'از مهلت‌های SLA که به نتیجه رسیدند، سهمی که به‌موقع بسته شد (بسته‌شده ÷ بسته‌شده + نقض‌شده). بازه بر اساس تاریخ بسته شدن یا نقض است — همان عدد گزارش پایبندی به SLA.',
    unit: 'PERCENT', synonyms: ['رعایت sla', 'پایبندی به sla', 'انطباق sla', 'پایبندی', 'sla'],
    requires: ['report.read'],
    dims: ['policy', 'unit', 'person', 'month'], filters: ['units', 'personId'],
    personLabelFa: 'صاحب مهلت', personSensitive: true, unitMeaning: 'OWN',
    example: 'رعایت SLA به تفکیک سیاست در ماه گذشته',
    async facts({ tx, org, from, to, filters, people }) {
      const clocks = await tx.slaClock.findMany({
        where: { organizationId: org, state: { in: ['MET', 'BREACHED'] }, ...(filters.personId ? { ownerId: filters.personId } : {}) },
        select: { id: true, state: true, stoppedAt: true, breachedAt: true, ownerId: true, entityType: true, entityId: true, policy: { select: { code: true, labelFa: true } } },
      });
      const out: Fact[] = [];
      for (const c of clocks) {
        const at = c.state === 'MET' ? c.stoppedAt : (c.breachedAt ?? c.stoppedAt);
        if ((from || to) && !inWindow(at, from, to)) continue;
        const dept = c.ownerId ? people.get(c.ownerId)?.departmentCode ?? null : null;
        if (filters.units?.length && (!dept || !filters.units.includes(dept))) continue;
        out.push({
          dims: { policy: { key: c.policy.code, labelFa: c.policy.labelFa }, unit: unitDim(dept) ?? { key: '-', labelFa: 'بدون صاحب' }, person: personDim(c.ownerId, people) },
          m: { met: c.state === 'MET' ? 1 : 0, closed: 1 }, at,
          ref: { entity: c.entityType, id: c.entityId, label: `${c.policy.labelFa} — ${c.state === 'MET' ? 'به‌موقع' : 'نقض‌شده'}`, href: (ENTITY_HREF[c.entityType] ?? (() => '/reports'))(c.entityId) },
        });
      }
      return out;
    },
    value: (m) => pct(m.met ?? 0, m.closed ?? 0),
    countFa: (m) => `${fa(m.met ?? 0)} از ${fa(m.closed ?? 0)} مهلت`,
  },
  {
    key: 'overdue_tasks', labelFa: 'وظایف عقب‌افتاده',
    definitionFa: 'وظایف بازی که مهلتشان گذشته است، در وضعیت امروز — همان عدد گزارش واحدها.',
    unit: 'COUNT', synonyms: ['وظایف عقب افتاده', 'کارهای عقب افتاده', 'تسک های عقب افتاده', 'وظایف معوق', 'کارهای معوق', 'عقب افتاده', 'دیرکرد'],
    requires: ['report.read'],
    dims: ['unit', 'project', 'client', 'person'], filters: ['units', 'companyId', 'projectId', 'personId'],
    personLabelFa: 'مسئول وظیفه', personSensitive: true, unitMeaning: 'OWN', asOfNow: true,
    example: 'وظایف عقب‌افتاده به تفکیک واحد',
    async facts({ tx, org, filters, now, people }) {
      const tasks = await tx.task.findMany({
        where: {
          organizationId: org, state: { notIn: CLOSED_TASK }, dueDate: { lt: now, not: null },
          ...(filters.units?.length ? { departmentCode: { in: filters.units } } : {}),
          ...(filters.projectId ? { projectId: filters.projectId } : {}),
          ...(filters.companyId ? { project: { companyId: filters.companyId } } : {}),
          ...(filters.personId ? { assigneeId: filters.personId } : {}),
        },
        select: { id: true, code: true, title: true, dueDate: true, departmentCode: true, assigneeId: true, project: { select: { id: true, code: true, name: true, company: { select: { id: true, legalName: true } } } } },
      });
      return tasks.map((t) => ({
        dims: { unit: unitDim(t.departmentCode), project: projectDim(t.project), client: clientDim(t.project.company), person: personDim(t.assigneeId, people) },
        m: { count: 1 }, at: t.dueDate, ref: taskRef(t),
      }));
    },
    value: (m) => m.count ?? 0,
    countFa: (m) => `${fa(m.count ?? 0)} وظیفه`,
  },
  {
    key: 'hours_logged', labelFa: 'ساعات کار ثبت‌شده',
    definitionFa: 'جمع ساعت‌هایی که روی وظایف ثبت شده و تاریخ کارشان در این بازه است.',
    unit: 'HOURS', synonyms: ['ساعات کار', 'ساعت کار', 'ساعات ثبت شده', 'ساعت ثبت شده', 'زمان ثبت شده', 'کارکرد', 'ساعات', 'ساعت'], weak: ['ساعت', 'ساعات'],
    requires: ['report.read'],
    dims: ['unit', 'project', 'client', 'person', 'month'], filters: ['units', 'companyId', 'projectId', 'personId'],
    personLabelFa: 'ثبت‌کننده', personSensitive: true, unitMeaning: 'OWN',
    example: 'ساعات ثبت‌شدهٔ من در این ماه',
    async facts({ tx, org, from, to, filters, people }) {
      const entries = await tx.timeEntry.findMany({
        where: {
          organizationId: org, ...(from || to ? { workedOn: range(from, to) } : {}),
          ...(filters.personId ? { userId: filters.personId } : {}),
          ...(filters.units?.length || filters.projectId || filters.companyId ? {
            task: {
              ...(filters.units?.length ? { departmentCode: { in: filters.units } } : {}),
              ...(filters.projectId ? { projectId: filters.projectId } : {}),
              ...(filters.companyId ? { project: { companyId: filters.companyId } } : {}),
            },
          } : {}),
        },
        select: { hours: true, workedOn: true, userId: true, task: { select: { id: true, code: true, title: true, departmentCode: true, project: { select: { id: true, code: true, name: true, company: { select: { id: true, legalName: true } } } } } } },
      });
      return entries.map((e) => ({
        dims: { unit: unitDim(e.task.departmentCode), project: projectDim(e.task.project), client: clientDim(e.task.project.company), person: personDim(e.userId, people) },
        m: { hours: num(e.hours), entries: 1 }, at: e.workedOn, ref: taskRef(e.task),
      }));
    },
    value: (m) => round1(m.hours ?? 0),
    countFa: (m) => `${fa(m.entries ?? 0)} ثبت زمان`,
  },
  {
    key: 'win_rate', labelFa: 'نرخ برد',
    definitionFa: 'از فرصت‌هایی که در این بازه به نتیجه رسیدند، سهم بردشده (برد ÷ برد + باخت). تاریخ نتیجه از رویدادنگار فرایند خوانده می‌شود — همان نرخ گزارش قیف فروش.',
    unit: 'PERCENT', synonyms: ['نرخ برد', 'نرخ موفقیت فروش', 'نرخ تبدیل فرصت', 'win rate', 'برد'], weak: ['برد'],
    requires: ['report.read', 'crm.opportunity.read'],
    dims: ['person', 'client', 'month'], filters: ['companyId', 'personId'], personLabelFa: 'مسئول فروش',
    example: 'نرخ برد امسال به تفکیک مسئول',
    async facts({ tx, org, from, to, filters, people }) {
      const opps = await tx.opportunity.findMany({
        where: { organizationId: org, deletedAt: null, state: { in: ['WON', 'LOST'] }, ...(filters.companyId ? { companyId: filters.companyId } : {}), ...(filters.personId ? { ownerId: filters.personId } : {}) },
        select: { id: true, code: true, title: true, state: true, wonAt: true, updatedAt: true, ownerId: true, company: { select: { id: true, legalName: true } } },
      });
      // When it was decided is an event, and the event log (#1) has it.
      const decided = await tx.stateTransition.findMany({
        where: { organizationId: org, entityType: 'opportunity', entityId: { in: opps.map((o) => o.id) }, toState: { in: ['WON', 'LOST'] } },
        select: { entityId: true, createdAt: true }, orderBy: { createdAt: 'asc' },
      });
      const decidedAt = new Map(decided.map((d) => [d.entityId, d.createdAt]));
      const out: Fact[] = [];
      for (const o of opps) {
        const at = decidedAt.get(o.id) ?? (o.state === 'WON' ? o.wonAt : null) ?? o.updatedAt;
        if ((from || to) && !inWindow(at, from, to)) continue;
        out.push({
          dims: { person: personDim(o.ownerId, people), client: clientDim(o.company) },
          m: { won: o.state === 'WON' ? 1 : 0, closed: 1 }, at,
          ref: { entity: 'opportunity', id: o.id, label: `${o.code} — ${o.title}`, href: `/opportunities/${o.id}` },
        });
      }
      return out;
    },
    value: (m) => pct(m.won ?? 0, m.closed ?? 0),
    countFa: (m) => `${fa(m.won ?? 0)} برد از ${fa(m.closed ?? 0)} فرصت`,
  },
  {
    key: 'pipeline_value', labelFa: 'ارزش قیف فروش',
    definitionFa: 'جمع ارزش برآوردی فرصت‌های باز (نه برده و نه باخته)، در وضعیت امروز — همان عدد گزارش قیف فروش.',
    unit: 'RIAL', synonyms: ['قیف فروش', 'پایپ لاین', 'pipeline', 'فرصت های باز', 'ارزش فرصت ها', 'قیف'], weak: ['قیف'],
    requires: ['report.read', 'crm.opportunity.read'],
    dims: ['person', 'client', 'state'], filters: ['companyId', 'personId'], personLabelFa: 'مسئول فروش', asOfNow: true,
    example: 'ارزش قیف فروش به تفکیک مرحله',
    async facts({ tx, org, filters, people }) {
      const opps = await tx.opportunity.findMany({
        where: { organizationId: org, deletedAt: null, state: { notIn: ['WON', 'LOST'] }, ...(filters.companyId ? { companyId: filters.companyId } : {}), ...(filters.personId ? { ownerId: filters.personId } : {}) },
        select: { id: true, code: true, title: true, state: true, estimatedValue: true, createdAt: true, ownerId: true, company: { select: { id: true, legalName: true } } },
      });
      return opps.map((o) => ({
        dims: { person: personDim(o.ownerId, people), client: clientDim(o.company), state: { key: o.state, labelFa: stateLabelFa(o.state) } },
        m: { value: num(o.estimatedValue), count: 1 }, at: o.createdAt,
        ref: { entity: 'opportunity', id: o.id, label: `${o.code} — ${o.title}`, href: `/opportunities/${o.id}` },
      }));
    },
    value: (m) => m.value ?? 0,
    countFa: (m) => `${fa(m.count ?? 0)} فرصت باز`,
  },
  {
    key: 'csat', labelFa: 'رضایت مشتری (CSAT)',
    definitionFa: 'میانگین امتیاز رضایت (از ۵) در بازخوردهای ثبت‌شده در این بازه — همان عدد برج کنترل.',
    unit: 'SCORE', synonyms: ['رضایت مشتری', 'رضایت مشتریان', 'csat', 'رضایت'], weak: ['رضایت'],
    requires: ['report.read'],
    dims: ['client', 'project', 'month'], filters: ['units', 'companyId', 'projectId'], unitMeaning: 'PROJECT',
    example: 'رضایت مشتری به تفکیک مشتری در امسال',
    async facts({ tx, org, from, to, filters }) {
      const rows = await tx.feedback.findMany({
        where: { organizationId: org, ...(from || to ? { createdAt: range(from, to) } : {}), ...(hasProjectScope(filters) ? { project: projectScope(org, filters) } : {}) },
        select: { id: true, csat: true, createdAt: true, project: { select: { id: true, code: true, name: true, company: { select: { id: true, legalName: true } } } } },
      });
      return rows.map((f) => ({
        dims: { client: clientDim(f.project.company), project: projectDim(f.project) },
        m: { sum: f.csat, n: 1 }, at: f.createdAt, ref: projectRef(f.project),
      }));
    },
    value: (m) => (m.n ? Number(((m.sum ?? 0) / m.n).toFixed(2)) : null),
    countFa: (m) => `${fa(m.n ?? 0)} بازخورد`,
  },
  {
    key: 'cycle_time', labelFa: 'زمان چرخهٔ فرایند',
    definitionFa: 'میانگین ساعت کاری از ایجاد یک پرونده تا رسیدنش به وضعیت پایانی، از روی رویدادنگار واقعی فرایند (کشف فرآیند) — پرونده‌هایی که در این بازه رویداد داشته‌اند.',
    unit: 'HOURS', synonyms: ['زمان چرخه', 'چرخه', 'طول فرایند', 'مدت فرایند', 'cycle time', 'طول میکشد', 'طول می کشد', 'طول کشیده', 'گلوگاه'], weak: ['چرخه'],
    requires: ['report.executive'],
    dims: [], filters: ['entity'],
    example: 'زمان چرخهٔ پروپوزال در شش ماه گذشته',
    async direct({ tx, org, from, to, filters }) {
      const entity = filters.entity!;
      const cal = await loadCalendar(org);
      const r = await mine(tx, org, entity, cal, { ...(from ? { from } : {}), ...(to ? { to } : {}) });
      const top = r.bottlenecks[0];
      return {
        value: r.cycleTime.meanHours,
        countFa: `${fa(r.cycleTime.completed)} پروندهٔ کامل‌شده`,
        noteFa: [
          ...(r.cycleTime.medianHours != null ? [`میانه: ${nf.format(r.cycleTime.medianHours)} ساعت کاری`] : []),
          ...(top ? [`کندترین مرحله: «${stateLabelFa(top.state)}» با میانگین ${nf.format(top.meanDwellHours)} ساعت کاری`] : []),
        ],
      };
    },
    value: () => null,
    countFa: () => '',
  },
];

export const METRIC_BY_KEY = new Map(METRICS.map((m) => [m.key, m]));

/** State machines the cycle-time metric can be asked about, and the words for them. */
export const ENTITY_WORDS: [string, string[]][] = [
  ['mediaOrder', ['سفارش رسانه', 'خرید رسانه']],
  ['proposal', ['پروپوزال', 'پیشنهاد']],
  ['deliverable', ['خروجی', 'دلیوربل', 'تحویلی']],
  ['workOrder', ['سفارش کار', 'دستور کار']],
  ['changeRequest', ['درخواست تغییر']],
  ['brief', ['بریف']],
  ['task', ['وظیفه', 'وظایف', 'تسک']],
  ['opportunity', ['فرصت', 'فرصت فروش']],
  ['lead', ['سرنخ', 'لید']],
  ['contract', ['قرارداد']],
  ['invoice', ['فاکتور']],
  ['revision', ['اصلاحیه']],
  ['project', ['پروژه']],
];
export const entityLabelFa = (entity: string) => WORKFLOWS[entity]?.labelFa ?? entity;

export const DIM_LABEL_FA: Record<Dim, string> = {
  unit: 'واحد', client: 'مشتری', project: 'پروژه', person: 'فرد', month: 'ماه', reason: 'دلیل', policy: 'سیاست SLA', state: 'مرحله',
};

export const UNIT_VALUE_FA = (unit: ValueUnit, v: number | null): string => {
  if (v == null) return '—';
  if (unit === 'RIAL') return money(v);
  if (unit === 'PERCENT') return `${nf.format(v)}٪`;
  if (unit === 'HOURS') return `${nf.format(v)} ساعت`;
  if (unit === 'SCORE') return `${nf.format(v)} از ۵`;
  return nf.format(v);
};
