/**
 * Accounting vouchers from the records Hiva keeps (roadmap #33) — the general ledger stays in the
 * accounting package (a decision the product made on purpose); what stops is typing everything in
 * twice. Each invoice, cancellation, receipt and payment becomes a balanced double-entry voucher
 * in whole rials, posted to the account codes the organisation's own chart uses.
 *
 *   invoice      Dr receivable (client)  /  Cr revenue, Cr media clearing (pass-through, #31), Cr VAT
 *   cancellation the invoice's voucher, reversed — for an invoice already posted
 *   receipt      Dr bank or cash  /  Cr receivable at the invoice's booked rate (#28), the difference
 *                to exchange gain or loss; a receipt with no invoice is a client advance
 *   payment out  Dr project cost — or media clearing, for a media vendor (#31)  /  Cr bank or cash
 */
import { money as decimal, sumOf, toMoney } from '../lib/money.js';
import type { AccountKey } from '@hiva/contracts';

export interface VoucherLine { account: AccountKey; detail: string | null; description: string; debit: number; credit: number }
export interface Voucher { kind: 'INVOICE' | 'REVERSAL' | 'RECEIPT' | 'PAYMENT'; sourceId: string; reference: string; date: Date; description: string; lines: VoucherLine[] }

/** Whole rials, half away from zero, from an exact figure (audit CALC-2): Math.round took −2.5 to −2. */
const rial = (v: unknown) => toMoney(v, 0);
const dr = (account: AccountKey, amount: number, detail: string | null, description: string): VoucherLine => ({ account, detail, description, debit: amount, credit: 0 });
const cr = (account: AccountKey, amount: number, detail: string | null, description: string): VoucherLine => ({ account, detail, description, debit: 0, credit: amount });

/** The base value of an invoice's pass-through lines (#31). */
export function passThroughBase(lines: unknown, fxRate: unknown): number {
  if (!Array.isArray(lines)) return 0;
  return rial(sumOf(lines.filter((l: any) => l?.passThrough).map((l: any) => decimal(l.quantity ?? 1).mul(decimal(l.unitPrice)))).mul(decimal(fxRate ?? 1)));
}

export interface InvoiceRow { id: string; code: string; number: string; issueDate: Date; total: unknown; taxAmount: unknown; lines: unknown; fxRate: unknown; companyId: string; company: { legalName: string } }

export function invoiceVoucher(inv: InvoiceRow, clientCode: string | null): Voucher {
  const total = rial(inv.total), vat = rial(inv.taxAmount), pass = passThroughBase(inv.lines, inv.fxRate);
  // Revenue is what is left: it absorbs the rounding, so the voucher balances to the rial.
  const revenue = total - vat - pass;
  const what = `فاکتور ${inv.number} — ${inv.company.legalName}`;
  return {
    kind: 'INVOICE', sourceId: inv.id, reference: inv.code, date: inv.issueDate, description: what,
    lines: [
      dr('receivable', total, clientCode, what),
      ...(revenue ? [cr('revenue', revenue, null, what)] : []),
      ...(pass ? [cr('mediaClearing', pass, null, `${what} — هزینهٔ عبوری رسانه`)] : []),
      ...(vat ? [cr('vat', vat, null, `${what} — ارزش افزوده`)] : []),
    ],
  };
}

/** An invoice cancelled after it was posted: its voucher, the other way round, on the day it is exported. */
export function reversalVoucher(inv: InvoiceRow, clientCode: string | null, on: Date): Voucher {
  const v = invoiceVoucher(inv, clientCode);
  return {
    kind: 'REVERSAL', sourceId: inv.id, reference: inv.code, date: on, description: `برگشت ${v.description} (ابطال)`,
    lines: v.lines.map((l) => ({ ...l, description: `برگشت — ${l.description}`, debit: l.credit, credit: l.debit })),
  };
}

export interface PaymentRow {
  id: string; direction: string; amount: unknown; occurredAt: Date; method: string; reference: string | null; settledOriginal: unknown;
  mediaOrderId: string | null;
  invoice: { kind: string; number: string; companyId: string; currency: string; fxRate: unknown; company: { legalName: string } } | null;
  project: { code: string; name: string; companyId: string; company: { legalName: string } } | null;
  supplier: { name: string } | null;
}

export function paymentVoucher(p: PaymentRow, clientCodes: Record<string, string>, base: string): Voucher {
  const amount = rial(p.amount);
  const money: AccountKey = p.method === 'CASH' ? 'cash' : 'bank';
  const ref = p.reference ? ` (مرجع ${p.reference})` : '';
  if (p.direction === 'OUT') {
    const toMedia = !!p.mediaOrderId;
    const what = `پرداخت${p.supplier ? ` به ${p.supplier.name}` : ''}${p.project ? ` — پروژهٔ ${p.project.code}` : ''}${toMedia ? ' — رسانه (عبوری)' : ''}${ref}`;
    return {
      kind: 'PAYMENT', sourceId: p.id, reference: p.reference ?? p.id.slice(0, 8), date: p.occurredAt, description: what,
      lines: [dr(toMedia ? 'mediaClearing' : 'projectCost', amount, null, what), cr(money, amount, null, what)],
    };
  }
  // A proforma is never posted, so money received against one is an advance, not a settled receivable.
  if (p.invoice && p.invoice.kind !== 'PROFORMA') {
    const client = clientCodes[p.invoice.companyId] ?? null;
    const what = `دریافت بابت فاکتور ${p.invoice.number} — ${p.invoice.company.legalName}${ref}`;
    // A foreign invoice was booked at its own rate; the receivable is cleared at that rate, and the
    // difference from what actually arrived is an exchange gain or loss (#28).
    const booked = p.invoice.currency !== base && p.settledOriginal != null ? rial(decimal(p.settledOriginal).mul(decimal(p.invoice.fxRate))) : amount;
    const diff = amount - booked;
    return {
      kind: 'RECEIPT', sourceId: p.id, reference: p.reference ?? p.id.slice(0, 8), date: p.occurredAt, description: what,
      lines: [
        dr(money, amount, null, what),
        ...(diff < 0 ? [dr('fxLoss', -diff, null, `${what} — زیان تسعیر`)] : []),
        cr('receivable', booked, client, what),
        ...(diff > 0 ? [cr('fxGain', diff, null, `${what} — سود تسعیر`)] : []),
      ],
    };
  }
  const clientId = p.invoice?.companyId ?? p.project?.companyId ?? null;
  const clientName = p.invoice?.company.legalName ?? p.project?.company.legalName;
  const what = `پیش‌دریافت${clientName ? ` — ${clientName}` : ''}${p.invoice ? `، پیش‌فاکتور ${p.invoice.number}` : p.project ? `، پروژهٔ ${p.project.code}` : ''}${ref}`;
  return {
    kind: 'RECEIPT', sourceId: p.id, reference: p.reference ?? p.id.slice(0, 8), date: p.occurredAt, description: what,
    lines: [dr(money, amount, null, what), cr('clientAdvance', amount, clientId ? clientCodes[clientId] ?? null : null, what)],
  };
}

export const balanced = (v: Voucher) => v.lines.reduce((s, l) => s + l.debit - l.credit, 0) === 0;
