import { prisma } from '../db.js';
import { hivaSvg } from '@hiva/contracts';
import { chip, date, dateTime, esc, metaGrid, table, text } from './fmt.js';

/** The owner's logo on every printed page's masthead (2026-10-16): vector, so it prints sharp. */
const LOGO = hivaSvg('logo', { color: '#0f172a', title: 'Hiva' });

/** Masthead shared by every printed document. */
export function docHeader(opts: {
  title: string;
  code?: string | null;
  subtitle?: string | null;
  state?: string | null;
}): string {
  return `<div class="doc-head">
  <div>
    <div class="brand"><span class="logo">${LOGO}</span><span>هیوامیس — سامانه عملیات سازمانی</span></div>
    <h1>${esc(opts.title)}</h1>
    ${opts.subtitle ? `<div class="muted">${esc(opts.subtitle)}</div>` : ''}
  </div>
  <div style="text-align:left;">
    ${opts.code ? `<div class="code">${esc(opts.code)}</div>` : ''}
    ${opts.state ? `<div style="margin-top:2mm;">${chip(opts.state)}</div>` : ''}
  </div>
</div>`;
}

/**
 * Doc_H requires each form to carry its route:
 * Form → Sender → Receiver → Trigger → Input → Process → Output → Approver → SLA → Next Process.
 * Printed documents reproduce that band so a paper copy remains self-describing.
 */
export const routingBand = (pairs: [string, string][]): string => metaGrid(pairs);

/** Immutable state history — who moved the record, when, and why. */
export async function stateTrail(entityType: string, entityId: string): Promise<string> {
  const rows = await prisma.stateTransition.findMany({
    where: { entityType, entityId },
    include: { actor: { select: { fullName: true } } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  if (rows.length === 0) return '';
  return `<h2>سابقه گردش کار</h2>${table(
    ['تاریخ', 'از وضعیت', 'به وضعیت', 'اقدام', 'کاربر', 'دلیل'],
    rows.map((r) => [
      dateTime(r.createdAt), chip(r.fromState), chip(r.toState),
      esc(r.action), esc(r.actor?.fullName ?? '—'), text(r.reason),
    ]),
  )}`;
}

/** Signature block for documents that are physically signed or countersigned. */
export const signatures = (roles: string[]): string =>
  `<div class="sig">${roles.map((r) => `<div>${esc(r)}</div>`).join('')}</div>`;

/** Quotes the Doc_H clause a document depends on, so the printed page carries its own justification. */
export const ruleNote = (body: string): string => `<div class="rule">${esc(body)}</div>`;

export const section = (title: string, body: string): string =>
  `<h2>${esc(title)}</h2>${body}`;

export const dateOrDash = (v: unknown): string => date(v);
