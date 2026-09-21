import type { Permission } from '@hiva/contracts';
import type { AccessTokenClaims } from '../auth/tokens.js';

/**
 * Export access order.
 *
 * Exporting is a read, so it is gated by the same permission that gates reading the record —
 * a PDF must never become a side door around the permission model. On top of that, two Doc_H
 * rules survive into the rendered document as FIELD-level redaction:
 *
 *  • §12 «مدیریت مالی پروژه» — an execution unit declares its own cost but is never party to the
 *    customer-facing sale price or margin. Sales, conversely, presents the price but must not see
 *    the internal cost it was built from.
 *  • §2 «تفکیک Sales و Account» — the two loops stay separated in what each side can read.
 *
 * A redacted field is printed as «محرمانه — خارج از سطح دسترسی» rather than omitted, so the
 * reader can tell a blank from a withheld value, and the audit record lists what was withheld.
 */
export type DocumentKind =
  | 'form-submission' | 'brief' | 'proposal' | 'contract' | 'invoice'
  | 'project' | 'company' | 'work-order' | 'deliverable' | 'qc-review'
  | 'revision' | 'change-request' | 'status-report' | 'meeting'
  | 'closure-report' | 'executive-report';

export interface KindPolicy {
  /** Every listed permission is required — same gate as the corresponding read endpoint. */
  readonly permissions: readonly Permission[];
  readonly titleFa: string;
  readonly landscape?: boolean;
}

export const DOCUMENT_POLICIES: Record<DocumentKind, KindPolicy> = {
  'form-submission': { permissions: ['form.read'], titleFa: 'فرم' },
  brief: { permissions: ['brief.read'], titleFa: 'بریف' },
  proposal: { permissions: ['proposal.read'], titleFa: 'پروپوزال' },
  contract: { permissions: ['contract.read'], titleFa: 'قرارداد' },
  invoice: { permissions: ['finance.read'], titleFa: 'سند مالی' },
  project: { permissions: ['project.read'], titleFa: 'پرونده پروژه' },
  company: { permissions: ['crm.company.read'], titleFa: 'پرونده مشتری' },
  'work-order': { permissions: ['workorder.read'], titleFa: 'سفارش کار' },
  deliverable: { permissions: ['deliverable.read'], titleFa: 'خروجی' },
  'qc-review': { permissions: ['qc.read'], titleFa: 'کنترل کیفیت' },
  revision: { permissions: ['revision.read'], titleFa: 'اصلاحیه' },
  'change-request': { permissions: ['change.read'], titleFa: 'درخواست تغییر' },
  'status-report': { permissions: ['report.read'], titleFa: 'گزارش وضعیت' },
  meeting: { permissions: ['meeting.read'], titleFa: 'صورتجلسه' },
  'closure-report': { permissions: ['project.read'], titleFa: 'گزارش پایان پروژه' },
  'executive-report': { permissions: ['report.executive'], titleFa: 'گزارش مدیریتی', landscape: true },
};

const REDACTED_LABEL = 'محرمانه — خارج از سطح دسترسی';

/** Proposal states from which Sales may see the price: Final QC has passed (Doc_H stage F). */
export const PROPOSAL_SANCTIONED_STATES = new Set(['APPROVED', 'DELIVERED_TO_SALES', 'PRESENTED_TO_CLIENT',
  'CLIENT_REVISION_REQUESTED', 'CLIENT_APPROVED', 'CLIENT_REJECTED']);

export interface RedactionContext {
  /** Internal cost figures: declared by the unit that spends it, reviewed by Account and Finance. */
  readonly cost: boolean;
  /** Customer-facing price and margin — see §12 above. */
  readonly price: boolean;
  /** Invoices, payments, settlement. */
  readonly finance: boolean;
  /** Everything withheld from this render, for the audit trail. */
  readonly withheld: string[];
}

const can = (u: AccessTokenClaims, p: Permission) => u.permissions.includes(p);

/**
 * @param proposalSanctioned true once a proposal has passed Final QC — from that point Sales
 *   legitimately needs the price in order to present it (Doc_H stage F).
 */
export function redactionFor(
  user: AccessTokenClaims,
  opts: { proposalSanctioned?: boolean } = {},
): RedactionContext {
  const cost = can(user, 'pricing.read') || can(user, 'pricing.declare_cost');

  const priceOwner =
    can(user, 'pricing.set_price') || can(user, 'pricing.approve') || can(user, 'finance.read');
  // Sales carries `proposal.present` and nothing financial; it sees the number only once approved.
  const salesPresenting = can(user, 'proposal.present') && opts.proposalSanctioned === true;
  const price = priceOwner || salesPresenting;

  const finance = can(user, 'finance.read');

  const withheld: string[] = [];
  if (!cost) withheld.push('cost');
  if (!price) withheld.push('price');
  if (!finance) withheld.push('finance');

  return { cost, price, finance, withheld };
}

/**
 * Which redaction class a field name belongs to. One rule for the PDF templates and the audit
 * timeline, so a figure withheld on paper is withheld in the history too.
 */
export function classifyField(key: string): 'price' | 'cost' | null {
  if (/(salePrice|price|margin|contractValue)/i.test(key)) return 'price';
  if (/cost|budget|هزینه/i.test(key)) return 'cost';
  return null;
}

/** Render a value, or the redaction notice when the caller may not see it. */
export function guard<T>(allowed: boolean, value: T, render: (v: T) => string): string {
  if (!allowed) return `<span class="redacted">${REDACTED_LABEL}</span>`;
  if (value === null || value === undefined || value === '') return '<span class="empty">—</span>';
  return render(value);
}
