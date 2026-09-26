/**
 * «گواهی تأیید مشتری» — the evidence of one decision on paper (roadmap #35): what was shown, with
 * each file's SHA-256; who decided, how they were verified, when and from where; what they did
 * before deciding; and the hashes that tie it to the organisation's chain. Everything on it can be
 * recomputed from the record by anyone holding the files.
 */
import { CLIENT_APPROVAL_EVENT_LABELS, CLIENT_APPROVAL_STATUS_LABELS, type ClientApprovalStatus } from '@hiva/contracts';
import { dateTime, esc, fa, field, money, num, table, text } from '../pdf/fmt.js';
import { docHeader, routingBand, ruleNote, section } from '../pdf/sections.js';
import type { Evidence, Manifest } from './evidence.js';

const CONTENT_FA: Record<string, string> = {
  description: 'شرح', format: 'قالب', executiveSummary: 'خلاصهٔ مدیریتی', approach: 'رویکرد', deliverablesSummary: 'خروجی‌ها',
  timelineSummary: 'زمان‌بندی', salePrice: 'مبلغ پیشنهادی', paymentTerms: 'شرایط پرداخت',
};
const mono = (s: string | null | undefined) => (s ? `<span dir="ltr" style="font-family:monospace;font-size:8pt;word-break:break-all">${esc(s)}</span>` : '—');

export function certificateHtml(a: {
  code: string; status: string; manifest: unknown; manifestHash: string; evidence: unknown; evidenceHash: string | null; channel: string;
  transitionError: string | null; events: { kind: string; documentId: string | null; ip: string | null; userAgent: string | null; at: Date }[];
}, verified: { ok: boolean; problems: { message: string }[]; checkedAt: Date }): string {
  const m = a.manifest as Manifest;
  const e = a.evidence as Evidence | null;
  const fileName = (id: string | null) => m.files.find((f) => f.documentId === id)?.fileName ?? '';
  return [
    docHeader({ title: 'گواهی تأیید مشتری', code: a.code, subtitle: `${m.organization} — ${m.subject.title}` }),
    routingBand([
      ['موضوع', `${esc(m.subject.type === 'DELIVERABLE' ? 'خروجی' : 'پروپوزال')} ${esc(m.subject.code)} — نسخهٔ ${esc(m.subject.version)}`],
      ['وضعیت', esc(CLIENT_APPROVAL_STATUS_LABELS[a.status as ClientApprovalStatus] ?? a.status)],
      ['مخاطب', `${esc(m.contact.name)} — ${mono(m.contact.email)}`],
      ['درخواست', dateTime(m.requestedAt)],
    ]),
    section('آنچه به مشتری نشان داده شد', [
      ...Object.entries(m.content).filter(([, v]) => v).map(([k, v]) => field(CONTENT_FA[k] ?? k, k === 'salePrice' ? money(v) : text(v))),
      table(['فایل', 'حجم (بایت)', 'SHA-256'], m.files.map((f) => [esc(f.fileName), num(f.sizeBytes), mono(f.sha256)])),
      field('اثر انگشت فهرست (manifest)', mono(a.manifestHash)),
    ].join('')),
    e ? section('تصمیم', [
      field('تصمیم', e.decision === 'APPROVE' ? '✓ تأیید' : '✗ درخواست اصلاح'),
      e.comment ? field('توضیح مشتری', text(e.comment)) : '',
      field('نام واردشده به‌عنوان امضا', esc(e.signerName)),
      field('احراز هویت', e.verification === 'PORTAL'
        ? 'ورود خود مخاطب به حساب شخصی‌اش در پورتال مشتری، با رمز عبوری که خود او تعیین کرده است'
        : e.verification === 'EMAIL_CODE'
        ? 'پیوند اختصاصی به ایمیل مخاطب، و کد یک‌بارمصرفی که هنگام تصمیم به همان ایمیل فرستاده شد'
        : a.channel === 'EMAIL' ? 'پیوند اختصاصی که به ایمیل مخاطب فرستاده شد (بدون کد)' : 'پیوند اختصاصی که کارکنان سازمان به مشتری رساندند (بدون کد)'),
      field('زمان', dateTime(e.decidedAt)),
      field('نشانی IP و مرورگر', `${mono(e.ip)} ${esc(e.userAgent ?? '')}`),
      e.staffAddress ? ruleNote('این تصمیم از نشانی‌ای ثبت شد که کارکنان همین سازمان در سی روز گذشته از آن کار کرده‌اند.') : '',
      field('شمارهٔ حلقه در زنجیرهٔ سازمان', fa(e.sequence)),
      field('اثر انگشت حلقهٔ پیشین', mono(e.prevEvidenceHash)),
      field('اثر انگشت این تصمیم', mono(a.evidenceHash)),
      a.transitionError ? ruleNote(`تصمیم ثبت شد اما بر پرونده اعمال نشد: ${a.transitionError}`) : '',
    ].join('')) : '',
    section('رویدادها', table(['زمان', 'رویداد', 'فایل', 'IP'], a.events.map((x) => [
      dateTime(x.at), esc(CLIENT_APPROVAL_EVENT_LABELS[x.kind] ?? x.kind), esc(fileName(x.documentId)), mono(x.ip),
    ]))),
    section('بررسی دوباره', verified.ok
      ? `<p>در ${dateTime(verified.checkedAt)} همهٔ اثر انگشت‌ها دوباره محاسبه شد و با آنچه ثبت شده بود یکی بود: فایل‌ها، فهرست، سند تصمیم و حلقهٔ زنجیره.</p>`
      : `<p>در ${dateTime(verified.checkedAt)} این موارد نخواند:</p><ul>${verified.problems.map((p) => `<li>${esc(p.message)}</li>`).join('')}</ul>`),
  ].join('');
}
