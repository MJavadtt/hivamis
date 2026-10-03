import { esc } from '../pdf/fmt.js';

/**
 * RTL Persian email bodies.
 *
 * Deliberately NOT using the embedded Vazirmatn the PDF layer relies on — mail clients strip
 * @font-face and many block remote fonts outright, so this uses a system stack and accepts
 * whatever the client has. Every message ships a plain-text alternative, because a Persian
 * HTML mail that renders as a wall of unstyled markup is worse than plain text.
 */
export interface MailBody {
  subject: string;
  html: string;
  text: string;
}

const SYSTEM_FONTS =
  "'Vazirmatn','IRANSans','Segoe UI',Tahoma,Arial,sans-serif";

function shell(title: string, lines: string[], action?: { label: string; url: string }): string {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:${SYSTEM_FONTS};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;">
    <tr><td style="background:#ffffff;border-radius:12px;padding:24px;border:1px solid #e2e8f0;">
      <p style="margin:0 0 4px;font-size:12px;color:#64748b;">هیوامیس — سامانه عملیات سازمانی</p>
      <h1 style="margin:0 0 16px;font-size:17px;color:#0f172a;">${esc(title)}</h1>
      ${lines.map((l) => `<p style="margin:0 0 10px;font-size:14px;line-height:1.9;color:#334155;">${l}</p>`).join('')}
      ${action ? `<p style="margin:20px 0 0;"><a href="${esc(action.url)}"
          style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;
                 padding:10px 18px;border-radius:8px;font-size:14px;">${esc(action.label)}</a></p>` : ''}
      <p style="margin:20px 0 0;padding-top:14px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;">
        این پیام به‌صورت خودکار ارسال شده است. برای پیگیری وارد سامانه شوید.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

const plain = (title: string, lines: string[], url?: string): string =>
  [title, '', ...lines.map((l) => l.replace(/<[^>]+>/g, '')), url ? `\n${url}` : '']
    .join('\n').trim();

export function slaBreachMail(p: {
  policyFa: string; entityFa: string; code: string; url: string;
}): MailBody {
  const lines = [
    `مهلت «<strong>${esc(p.policyFa)}</strong>» برای ${esc(p.entityFa)} <strong>${esc(p.code)}</strong> گذشته است.`,
    'این مورد در گزارش نقض SLA ثبت شده و در داشبورد مدیریتی دیده می‌شود.',
  ];
  return {
    subject: `نقض SLA — ${p.policyFa} (${p.code})`,
    html: shell('نقض مهلت', lines, { label: 'مشاهده در سامانه', url: p.url }),
    text: plain('نقض مهلت', lines, p.url),
  };
}

export function slaWarningMail(p: {
  policyFa: string; entityFa: string; code: string; remainingFa: string; url: string;
}): MailBody {
  const lines = [
    `مهلت «<strong>${esc(p.policyFa)}</strong>» برای ${esc(p.entityFa)} <strong>${esc(p.code)}</strong> رو به اتمام است.`,
    `زمان باقی‌مانده: <strong>${esc(p.remainingFa)}</strong>`,
  ];
  return {
    subject: `هشدار SLA — ${p.policyFa} (${p.code})`,
    html: shell('هشدار نزدیک شدن مهلت', lines, { label: 'مشاهده در سامانه', url: p.url }),
    text: plain('هشدار نزدیک شدن مهلت', lines, p.url),
  };
}

export function formApprovalMail(p: {
  formFa: string; code: string; senderFa: string; url: string;
}): MailBody {
  const lines = [
    `فرم «<strong>${esc(p.formFa)}</strong>» (${esc(p.code)}) در انتظار تأیید شماست.`,
    `ارسال‌کننده: ${esc(p.senderFa)}`,
  ];
  return {
    subject: `در انتظار تأیید شما — ${p.formFa}`,
    html: shell('درخواست تأیید', lines, { label: 'بررسی و تأیید', url: p.url }),
    text: plain('درخواست تأیید', lines, p.url),
  };
}

export function overdueDigestMail(p: {
  items: { titleFa: string; code: string; daysFa: string }[]; url: string;
}): MailBody {
  const rows = p.items.map((i) =>
    `• ${esc(i.titleFa)} (${esc(i.code)}) — ${esc(i.daysFa)} روز گذشته`);
  const lines = [
    `<strong>${p.items.length}</strong> مورد سررسید گذشته دارید:`,
    ...rows,
  ];
  return {
    subject: `کارهای سررسید گذشته — ${p.items.length} مورد`,
    html: shell('خلاصه کارهای عقب‌افتاده', lines, { label: 'مشاهده فهرست', url: p.url }),
    text: plain('خلاصه کارهای عقب‌افتاده', lines, p.url),
  };
}
