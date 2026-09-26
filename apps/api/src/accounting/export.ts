/**
 * The export batch (roadmap #33): everything not yet posted up to a date, as vouchers in the
 * organisation's own file layout. A batch marks what it posted, so nothing is posted twice; an
 * invoice cancelled after it was posted is reversed in a later batch, dated the day it was cancelled.
 */
import { ACCOUNT_LABELS, ACCOUNTING_FIELD_LABELS, type AccountKey, type AccountingField } from '@hiva/contracts';
import type { Tx } from '../db.js';
import { AppError, conflict } from '../lib/errors.js';
import { nextNumber, nextNumbers } from '../lib/codes.js';
import { jalaliOf } from '../lib/jalali.js';
import { toCsv } from '../forms/bulk.js';
import { baseCurrency, dayKey } from '../finance/fx.js';
import { balanced, invoiceVoucher, paymentVoucher, reversalVoucher, type InvoiceRow, type Voucher } from './vouchers.js';

const DAY = 86_400_000;

export interface Layout { columns: { field: AccountingField; header: string }[]; dateFormat: 'JALALI' | 'GREGORIAN' }
export interface Settings { accounts: Partial<Record<AccountKey, string>>; clientCodes: Record<string, string>; layout: Layout }
export interface Problem { code: string; message: string }

export const DEFAULT_LAYOUT: Layout = {
  columns: (['voucherNo', 'date', 'voucherDescription', 'row', 'accountCode', 'detailCode', 'lineDescription', 'debit', 'credit', 'reference'] as const)
    .map((field) => ({ field, header: ACCOUNTING_FIELD_LABELS[field] })),
  dateFormat: 'JALALI',
};

export async function settingsFor(tx: Tx, organizationId: string): Promise<Settings & { saved: boolean }> {
  const row = await tx.accountingSettings.findUnique({ where: { organizationId } });
  if (!row) return { accounts: {}, clientCodes: {}, layout: DEFAULT_LAYOUT, saved: false };
  return { accounts: row.accounts as Settings['accounts'], clientCodes: row.clientCodes as Settings['clientCodes'], layout: row.layout as unknown as Layout, saved: true };
}

/** A layout the package can import: an account code, and the amount as debit/credit or signed. */
export function layoutProblems(layout: Layout): Problem[] {
  const fields = layout.columns.map((c) => c.field);
  const problems: Problem[] = [];
  const dup = fields.find((f, i) => fields.indexOf(f) !== i);
  if (dup) problems.push({ code: 'LAYOUT_DUPLICATE', message: `ستون «${ACCOUNTING_FIELD_LABELS[dup]}» دو بار آمده است.` });
  if (!fields.includes('accountCode')) problems.push({ code: 'LAYOUT_NO_ACCOUNT', message: 'فایل بدون ستون «کد حساب» در نرم‌افزار حسابداری خوانده نمی‌شود.' });
  if (!fields.includes('amount') && !(fields.includes('debit') && fields.includes('credit'))) {
    problems.push({ code: 'LAYOUT_NO_AMOUNT', message: 'مبلغ باید یا در دو ستون «بدهکار» و «بستانکار» بیاید یا در ستون «مبلغ» علامت‌دار.' });
  }
  if (!fields.includes('voucherNo')) problems.push({ code: 'LAYOUT_NO_VOUCHER', message: 'بدون ستون «شماره سند» ردیف‌های یک سند از هم جدا نمی‌شوند.' });
  return problems;
}

const invoiceSelect = {
  id: true, code: true, number: true, issueDate: true, total: true, taxAmount: true, lines: true, fxRate: true, companyId: true, updatedAt: true,
  company: { select: { legalName: true } },
} as const;
const paymentSelect = {
  id: true, direction: true, amount: true, occurredAt: true, method: true, reference: true, settledOriginal: true, mediaOrderId: true,
  invoice: { select: { kind: true, number: true, companyId: true, currency: true, fxRate: true, company: { select: { legalName: true } } } },
  project: { select: { code: true, name: true, companyId: true, company: { select: { legalName: true } } } },
  supplier: { select: { name: true } },
} as const;

/** What a batch up to `to` would post, and what stands in its way. Reads only. */
export async function plan(tx: Tx, organizationId: string, to: Date) {
  const settings = await settingsFor(tx, organizationId);
  const base = await baseCurrency(tx, organizationId);
  const until = new Date(dayKey(to).getTime() + DAY);

  // Only a final invoice is posted — a proforma is an offer — and one cancelled before it was posted never is.
  const invoices = await tx.invoice.findMany({
    where: { organizationId, kind: 'INVOICE', state: { notIn: ['DRAFT', 'CANCELLED'] }, accountingExportId: null, issueDate: { lt: until } },
    select: invoiceSelect, orderBy: [{ issueDate: 'asc' }, { code: 'asc' }],
  });
  const cancelled = await tx.invoice.findMany({
    where: { organizationId, state: 'CANCELLED', accountingExportId: { not: null }, accountingReversalExportId: null },
    select: invoiceSelect, orderBy: { code: 'asc' },
  });
  const cancels = cancelled.length
    ? await tx.stateTransition.findMany({ where: { organizationId, entityType: 'invoice', entityId: { in: cancelled.map((c) => c.id) }, toState: 'CANCELLED' }, select: { entityId: true, createdAt: true } })
    : [];
  const cancelledOn = new Map(cancels.map((c) => [c.entityId, c.createdAt]));
  const reversals = cancelled.map((inv) => ({ inv, on: dayKey(cancelledOn.get(inv.id) ?? inv.updatedAt) })).filter((r) => r.on < until);
  const payments = await tx.payment.findMany({
    where: { organizationId, accountingExportId: null, occurredAt: { lt: until } },
    select: paymentSelect, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
  });

  const code = (companyId: string) => settings.clientCodes[companyId] ?? null;
  const vouchers: Voucher[] = [
    ...invoices.map((inv) => invoiceVoucher(inv as InvoiceRow, code(inv.companyId))),
    ...reversals.map((r) => reversalVoucher(r.inv as InvoiceRow, code(r.inv.companyId), r.on)),
    ...payments.map((p) => paymentVoucher(p, settings.clientCodes, base)),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());

  const problems: Problem[] = layoutProblems(settings.layout);
  const used = new Set(vouchers.flatMap((v) => v.lines.map((l) => l.account)));
  const missing = [...used].filter((k) => !settings.accounts[k]);
  if (missing.length) {
    problems.push({ code: 'ACCOUNT_CODE_MISSING', message: `کد حساب این سرفصل‌ها تعیین نشده است: ${missing.map((k) => ACCOUNT_LABELS[k]).join('، ')}` });
  }
  const unbalanced = vouchers.filter((v) => !balanced(v));
  if (unbalanced.length) problems.push({ code: 'VOUCHER_UNBALANCED', message: `سند تراز نیست: ${unbalanced.map((v) => v.reference).join('، ')}` });

  const noCode = new Map<string, string>();
  for (const inv of [...invoices, ...reversals.map((r) => r.inv)]) if (!code(inv.companyId)) noCode.set(inv.companyId, inv.company.legalName);
  for (const p of payments) {
    const c = p.direction === 'IN' ? p.invoice ?? p.project : null;
    if (c && !code(c.companyId)) noCode.set(c.companyId, c.company.legalName);
  }
  const warnings: Problem[] = noCode.size
    ? [{ code: 'CLIENT_CODE_MISSING', message: `کد تفصیلی این مشتریان تعیین نشده است و ردیف‌هایشان بدون تفصیلی می‌آید: ${[...noCode.values()].join('، ')}` }]
    : [];

  const lines = vouchers.flatMap((v) => v.lines);
  return {
    settings, vouchers, problems, warnings,
    counts: { invoices: invoices.length, reversals: reversals.length, receipts: payments.filter((p) => p.direction === 'IN').length, payments: payments.filter((p) => p.direction === 'OUT').length },
    lines: lines.length,
    debitTotal: lines.reduce((s, l) => s + l.debit, 0),
    creditTotal: lines.reduce((s, l) => s + l.credit, 0),
    ids: { invoices: invoices.map((i) => i.id), reversals: reversals.map((r) => r.inv.id), payments: payments.map((p) => p.id) },
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
export function formatDate(d: Date, format: Layout['dateFormat']): string {
  const day = dayKey(d);
  if (format === 'GREGORIAN') return day.toISOString().slice(0, 10);
  const j = jalaliOf(day);
  return `${j.y}/${pad(j.m)}/${pad(j.d)}`;
}

/** Text a spreadsheet would read as a formula is written as text. Amounts stay numbers. */
const text = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

export function renderCsv(vouchers: Voucher[], firstVoucherNo: number, settings: Settings): string {
  const cols = settings.layout.columns;
  const rows: unknown[][] = [cols.map((c) => c.header)];
  vouchers.forEach((v, i) => v.lines.forEach((l, r) => {
    const value: Record<AccountingField, unknown> = {
      voucherNo: firstVoucherNo + i, date: formatDate(v.date, settings.layout.dateFormat), voucherDescription: text(v.description),
      row: r + 1, accountCode: text(settings.accounts[l.account] ?? ''), detailCode: text(l.detail ?? ''), lineDescription: text(l.description),
      debit: l.debit, credit: l.credit, amount: l.debit - l.credit, reference: text(v.reference),
    };
    rows.push(cols.map((c) => value[c.field]));
  }));
  return toCsv(rows);
}

/** Post a batch: number it, keep the file as written, and mark every record it carries. */
export async function createExport(tx: Tx, organizationId: string, to: Date, actorId: string) {
  const p = await plan(tx, organizationId, to);
  if (p.problems.length) throw new AppError(422, 'ACCOUNTING_EXPORT_BLOCKED', 'خروجی حسابداری هنوز آماده نیست', { problems: p.problems });
  if (!p.vouchers.length) throw new AppError(422, 'ACCOUNTING_NOTHING_TO_EXPORT', 'تا این تاریخ سند ثبت‌نشده‌ای نمانده است.');

  const number = await nextNumber(tx, `accounting:${organizationId}`);
  // Voucher numbers run on across batches, so two files never reuse one.
  const first = await nextNumbers(tx, `accounting-voucher:${organizationId}`, p.vouchers.length);
  const exp = await tx.accountingExport.create({
    data: {
      organizationId, number, periodTo: dayKey(to), vouchers: p.vouchers.length, lines: p.lines,
      debitTotal: p.debitTotal, creditTotal: p.creditTotal,
      fileName: `hiva-accounting-${number}-${dayKey(to).toISOString().slice(0, 10)}.csv`,
      content: renderCsv(p.vouchers, first, p.settings), createdById: actorId,
    },
  });
  // A batch running at the same moment waits on these rows, then finds them taken and rolls back.
  const marked = [
    [await tx.invoice.updateMany({ where: { id: { in: p.ids.invoices }, accountingExportId: null }, data: { accountingExportId: exp.id } }), p.ids.invoices],
    [await tx.invoice.updateMany({ where: { id: { in: p.ids.reversals }, accountingReversalExportId: null }, data: { accountingReversalExportId: exp.id } }), p.ids.reversals],
    [await tx.payment.updateMany({ where: { id: { in: p.ids.payments }, accountingExportId: null }, data: { accountingExportId: exp.id } }), p.ids.payments],
  ] as const;
  if (marked.some(([r, ids]) => r.count !== ids.length)) {
    throw conflict('ACCOUNTING_EXPORT_RACE', 'خروجی دیگری هم‌زمان بخشی از همین اسناد را ثبت کرد؛ دوباره تلاش کنید.');
  }
  return { export: exp, counts: p.counts, warnings: p.warnings };
}
