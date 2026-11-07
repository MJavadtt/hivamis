import type { Prisma, PrismaClient } from '@prisma/client';
import { INVOICE_FORMS, type InvoiceBuyer, type InvoiceForm } from '@hiva/contracts';
import { audit } from '../lib/audit.js';
import { money } from '../lib/money.js';
import { SELLER_DEFAULTS, type SellerDetails } from './forms.js';
import type { PrintableInvoice } from './workbook.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The companies invoices are issued in (ADR-125): one for each form, made for every organisation as
 * the owner's files had them, and never touched again by the sync — what they print is the system
 * administrator's to correct.
 */
export async function syncInvoiceSellers(db: Db, organizationId: string): Promise<number> {
  let added = 0;
  for (const form of INVOICE_FORMS) {
    const made = await db.invoiceSeller.createMany({ data: [{ organizationId, form, ...SELLER_DEFAULTS[form] }], skipDuplicates: true });
    added += made.count;
  }
  return added;
}

const SELLER_FIELDS = ['shortName', 'legalName', 'economicCode', 'nationalId', 'province', 'county', 'city', 'address', 'postalCode', 'phone', 'bankName', 'accountNumber', 'iban'] as const;
/** What an invoice keeps of its seller: as printed the day it was issued. */
export const sellerDetailsOf = (s: Record<(typeof SELLER_FIELDS)[number], string | null>): SellerDetails =>
  Object.fromEntries(SELLER_FIELDS.map((k) => [k, s[k] ?? null])) as unknown as SellerDetails;

const BUYER_FIELDS = ['legalName', 'economicCode', 'nationalId', 'postalCode', 'province', 'county', 'city', 'address', 'phone'] as const;
type CompanyLike = Partial<Record<(typeof BUYER_FIELDS)[number], string | null>>;

/** «مشخصات خریدار» as the client's record has it. */
export const buyerOf = (c: CompanyLike): InvoiceBuyer => Object.fromEntries(BUYER_FIELDS.map((k) => [k, c[k] || null])) as InvoiceBuyer;

/** The buyer as typed, without its blanks; null when nothing was. */
export function cleanBuyer(b: InvoiceBuyer | null | undefined): InvoiceBuyer | null {
  if (!b) return null;
  const kept = Object.fromEntries(BUYER_FIELDS.filter((k) => b[k]?.trim()).map((k) => [k, b[k]!.trim()]));
  return Object.keys(kept).length ? (kept as InvoiceBuyer) : null;
}

/** Two buyers say the same thing — whatever order their fields came in. */
export const sameBuyer = (a: unknown, b: unknown) =>
  BUYER_FIELDS.every((k) => ((a as CompanyLike | null)?.[k] || null) === ((b as CompanyLike | null)?.[k] || null));

/** What the invoice printed, and the client's record where it printed nothing. */
export function printedBuyer(buyer: unknown, company: CompanyLike): InvoiceBuyer {
  const b = (buyer ?? {}) as CompanyLike;
  return Object.fromEntries(BUYER_FIELDS.map((k) => [k, b[k] || company[k] || null])) as InvoiceBuyer;
}

/**
 * Writes what the invoice's buyer adds to the client's record — only into fields still blank there, so
 * nothing the client's account holder wrote is overwritten. Audited as the client's change.
 */
export async function fillCompanyBlanks(tx: Prisma.TransactionClient, actor: { id: string; organizationId: string; ipAddress?: string; requestId?: string }, companyId: string, buyer: InvoiceBuyer | null, invoiceNumber: string) {
  if (!buyer) return;
  const before = await tx.company.findFirst({ where: { id: companyId, organizationId: actor.organizationId }, select: { id: true, nationalId: true, economicCode: true, postalCode: true, province: true, county: true, city: true, address: true, phone: true } });
  if (!before) return;
  const data: Record<string, string> = {};
  for (const k of ['nationalId', 'economicCode', 'postalCode', 'province', 'county', 'city', 'address', 'phone'] as const) {
    if (!before[k] && buyer[k]) data[k] = buyer[k]!;
  }
  if (!Object.keys(data).length) return;
  const after = await tx.company.update({ where: { id: companyId }, data, select: { id: true, ...Object.fromEntries(Object.keys(data).map((k) => [k, true])) } });
  await audit({
    organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'company', entityId: companyId,
    before: Object.fromEntries(Object.keys(data).map((k) => [k, null])), after, reason: `blank fields filled from invoice ${invoiceNumber}`,
    ipAddress: actor.ipAddress, requestId: actor.requestId,
  }, tx);
}

interface StoredLine { code?: string; description: string; quantity: number; unit?: string; unitPrice: number; discount?: number }
/** The invoice as its form prints it: amounts in rials, at the rate it was booked at. */
export function printable(inv: {
  kind: string; state: string; number: string; issueDate: Date; lines: unknown; taxPercent: unknown; fxRate: unknown;
  saleTerms: string | null; notes: string | null; sellerDetails: unknown; buyer: unknown;
  seller: { form: string }; company: CompanyLike;
}): PrintableInvoice {
  const rate = money(inv.fxRate ?? 1);
  return {
    form: inv.seller.form as InvoiceForm, kind: inv.kind, state: inv.state, number: inv.number, issueDate: inv.issueDate,
    seller: inv.sellerDetails as SellerDetails, buyer: printedBuyer(inv.buyer, inv.company),
    lines: (Array.isArray(inv.lines) ? (inv.lines as StoredLine[]) : []).map((l) => ({
      code: l.code ?? null, description: l.description, quantity: Number(l.quantity), unit: l.unit ?? null,
      unitPrice: money(l.unitPrice).mul(rate), discount: money(l.discount ?? 0).mul(rate),
    })),
    taxPercent: Number(inv.taxPercent), saleTerms: inv.saleTerms, notes: inv.notes,
  };
}
