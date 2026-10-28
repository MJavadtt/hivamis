import type { Tx } from '../db.js';
import type { GuardContext, GuardResult } from '../workflow/guards.js';
import type { EffectContext } from '../workflow/effects.js';
import { money } from '../lib/money.js';
import { balancesOf, OPEN } from './ledger.js';
import { settingsOf } from './options.js';

/**
 * The deployment project's rules and effects (ADR-103), run by the workflow engine on every way in —
 * the project page, the API, the assistant — answering 422 with the rule that said no. A governed
 * waiver (governance.waive) is the one way past a rule, and it is recorded with its reason: the
 * documented exception the closure of a project with something still open needs.
 */

const pass: GuardResult = { ok: true };
const RULE = 'پروژهٔ استقرار';
const refuse = (messageFa: string, details?: unknown): GuardResult => ({ ok: false, rule: RULE, messageFa, ...(details ? { details } : {}) });

/** The contract version that speaks for the project now: the newest not superseded. */
export const currentContract = (tx: Tx, siteProjectId: string) =>
  tx.siteContract.findFirst({ where: { siteProjectId, status: { not: 'SUPERSEDED' } }, orderBy: { version: 'desc' } });

async function requiresContract(tx: Tx, organizationId: string, cooperationCode: string | null) {
  if (!cooperationCode) return true;
  const o = await tx.siteOption.findUnique({ where: { organizationId_list_code: { organizationId, list: 'COOPERATION', code: cooperationCode } }, select: { meta: true } });
  return (o?.meta as { requiresContract?: boolean } | null)?.requiresContract !== false;
}

const evidence = (tx: Tx, siteProjectId: string, siteRecordType: string, extra: object = {}) =>
  tx.document.count({ where: { siteProjectId, siteRecordType, deletedAt: null, supersededAt: null, ...extra } });

/** What is still open on the project's books, in words — for a closure, or a cancellation. */
async function openMoney(tx: Tx, siteProjectId: string, opts: { unpaidCountsAsOpen: boolean }) {
  const b = await balancesOf(tx, siteProjectId);
  const open: string[] = [];
  const partial = await tx.siteObligation.count({ where: { siteProjectId, status: 'PARTIAL' } });
  const unpaid = await tx.siteObligation.count({ where: { siteProjectId, status: 'OPEN' } });
  if (opts.unpaidCountsAsOpen && (partial || unpaid)) open.push(`${partial + unpaid} قلم پرداخت‌نشده (ماندهٔ ${money(b.outstanding).toFixed(0)})`);
  else if (partial) open.push(`${partial} قلم نیمه‌پرداخت`);
  if (money(b.deposit.remaining).gt(0)) open.push(`ودیعهٔ نزد مکان ${money(b.deposit.remaining).toFixed(0)} که نه عودت شده نه کسر`);
  if (money(b.deposit.deductionsPending).gt(0)) open.push(`کسر از ودیعهٔ در انتظار تصمیم (${money(b.deposit.deductionsPending).toFixed(0)})`);
  if (money(b.credit).gt(0)) open.push(`اضافه‌پرداخت ${money(b.credit).toFixed(0)} که برنگشته یا به قلمی نسبت داده نشده`);
  return { open, balances: b };
}

export const SITE_GUARDS: Record<string, (c: GuardContext) => Promise<GuardResult>> = {
  'siteProject.venueActive': async ({ tx, record }) => {
    const v = await tx.venue.findUnique({ where: { id: record.venueId }, select: { isActive: true, archivedAt: true, mergedIntoId: true, name: true } });
    return v?.isActive && !v.archivedAt && !v.mergedIntoId ? pass : refuse(`مکان «${v?.name ?? '—'}» فعال نیست؛ مکان را فعال کنید یا پروژه را به مکان دیگری ببرید.`);
  },

  'siteProject.termsComplete': async ({ record }) => {
    const missing: string[] = [];
    if (!record.cooperationCode) missing.push('مدل همکاری');
    if (!record.contractStart) missing.push('آغاز قرارداد');
    if (!record.contractEnd) missing.push('پایان قرارداد');
    if (record.rentAmount == null && record.chargeAmount == null && record.depositAmount == null) missing.push('دست‌کم یکی از اجاره، شارژ یا ودیعه');
    if (money(record.rentAmount).gt(0) && !record.rentMethodCode) missing.push('نحوهٔ پرداخت اجاره');
    if (money(record.chargeAmount).gt(0) && !record.chargeMethodCode) missing.push('نحوهٔ پرداخت شارژ');
    return missing.length ? refuse(`شرایط تجاری کامل نیست: ${missing.join('، ')}.`, { missing }) : pass;
  },

  'siteProject.agreedNegotiation': async ({ tx, id }) =>
    (await tx.siteNegotiation.count({ where: { siteProjectId: id, outcome: 'AGREED' } }))
      ? pass
      : refuse('هنوز مذاکره‌ای با نتیجهٔ «توافق شد» ثبت نشده است.'),

  'siteProject.contractSubmitted': async ({ tx, id, record }) => {
    const c = await currentContract(tx, id);
    if (!c || c.status !== 'PENDING_APPROVAL') return refuse('نسخه‌ای از قرارداد که برای تأیید فرستاده شده باشد نیست؛ قرارداد را ثبت و برای تأیید بفرستید.');
    if (await requiresContract(tx, record.organizationId, record.cooperationCode) && !(await evidence(tx, id, 'contract', { siteRecordId: c.id }))) {
      return refuse('در همکاری قراردادی، فایل قرارداد باید پیوست نسخهٔ فرستاده‌شده باشد.');
    }
    return pass;
  },

  'siteProject.contractApproved': async ({ tx, id }) => {
    const c = await currentContract(tx, id);
    if (c?.status === 'APPROVED') return pass;
    // An amendment waiting for approval leaves the approved version in force until it is decided.
    const approved = await tx.siteContract.count({ where: { siteProjectId: id, status: 'APPROVED' } });
    return approved ? pass : refuse('قرارداد این پروژه تأیید نشده است.');
  },

  'siteProject.contractRejected': async ({ tx, id }) =>
    (await currentContract(tx, id))?.status === 'REJECTED' ? pass : refuse('قرارداد از مسیر تصمیم دربارهٔ نسخهٔ آن رد می‌شود.'),

  'siteProject.installationPlanned': async ({ tx, id, record }) => {
    const missing: string[] = [];
    if (!record.installPlannedAt) missing.push('تاریخ برنامه‌ریزی‌شدهٔ نصب');
    if (!(await tx.siteCounter.count({ where: { siteProjectId: id } }))) missing.push('دست‌کم یک کانتر');
    return missing.length ? refuse(`برای برنامه‌ریزی نصب لازم است: ${missing.join('، ')}.`) : pass;
  },

  'siteProject.installed': async ({ record }) =>
    record.installedAt && new Date(record.installedAt) <= new Date() ? pass : refuse('تاریخ واقعی نصب ثبت نشده است (یا در آینده است).'),

  'siteProject.activationEvidence': async ({ tx, id, record }) => {
    const s = await settingsOf(record.organizationId, tx);
    const missing: string[] = [];
    if (s.activation.requireInstallationPhoto && !(await evidence(tx, id, 'installation', { mimeType: { startsWith: 'image/' } }))) missing.push('عکس نصب');
    if (s.activation.requireEmployerApproval && !(await tx.siteApproval.count({ where: { siteProjectId: id, kind: 'EMPLOYER', decision: 'APPROVED' } }))) missing.push('تأییدیهٔ کارفرما');
    return missing.length ? refuse(`برای آغاز بهره‌برداری لازم است: ${missing.join('، ')}.`, { missing }) : pass;
  },

  'siteProject.scheduleReady': async ({ record }) => {
    const owes = money(record.rentAmount).gt(0) || money(record.chargeAmount).gt(0) || money(record.depositAmount).gt(0);
    return !owes || record.scheduleGeneratedAt ? pass : refuse('جدول اجاره ساخته نشده است؛ پیش از بهره‌برداری، جدول اجاره و شارژ را بسازید تا یادآوری‌ها کار کنند.');
  },

  /** Nothing open on the books: every item settled, waived or void, the deposit back or kept with approval, no credit left. */
  'siteProject.settled': async ({ tx, id }) => {
    const { open } = await openMoney(tx, id, { unpaidCountsAsOpen: true });
    return open.length ? refuse(`حساب پروژه هنوز باز است: ${open.join('؛ ')}.`, { open }) : pass;
  },

  /** A cancellation may leave unpaid items behind — they are voided — but not money with the venue. */
  'siteProject.noMoneyOpen': async ({ tx, id }) => {
    const { open } = await openMoney(tx, id, { unpaidCountsAsOpen: false });
    return open.length ? refuse(`پیش از لغو، پول باز را تعیین تکلیف کنید: ${open.join('؛ ')}.`, { open }) : pass;
  },
};

export const SITE_GUARD_LABELS: Record<string, string> = {
  'siteProject.venueActive': 'مکان پروژه فعال باشد',
  'siteProject.termsComplete': 'شرایط تجاری کامل باشد: مدل همکاری، دورهٔ قرارداد، مبالغ و نحوهٔ پرداخت',
  'siteProject.agreedNegotiation': 'مذاکره‌ای با نتیجهٔ «توافق شد» ثبت شده باشد',
  'siteProject.contractSubmitted': 'نسخهٔ قرارداد (با فایل، در همکاری قراردادی) برای تأیید فرستاده شده باشد',
  'siteProject.contractApproved': 'قرارداد تأیید شده باشد',
  'siteProject.contractRejected': 'نسخهٔ قرارداد رد شده باشد',
  'siteProject.installationPlanned': 'تاریخ نصب و کانترها ثبت شده باشد',
  'siteProject.installed': 'تاریخ واقعی نصب ثبت شده باشد',
  'siteProject.activationEvidence': 'عکس نصب و تأییدیهٔ کارفرما، اگر سازمان خواسته، ثبت شده باشد',
  'siteProject.scheduleReady': 'جدول اجاره و شارژ ساخته شده باشد',
  'siteProject.settled': 'همهٔ اقلام تسویه، ودیعه تعیین تکلیف و اضافه‌پرداختی باقی نمانده باشد',
  'siteProject.noMoneyOpen': 'پولی نزد مکان یا نیمه‌پرداخت باقی نمانده باشد',
};

export const SITE_EFFECTS: Record<string, (c: EffectContext) => Promise<Record<string, unknown>>> = {
  'siteProject.plan_installation': async () => ({ installStatus: 'PLANNED' }),
  'siteProject.start_installation': async () => ({ installStatus: 'IN_PROGRESS' }),
  'siteProject.activate': async () => ({ installStatus: 'DONE' }),

  /** The books as they stood the day it closed, kept on the project. */
  'siteProject.close': async ({ tx, id }) => ({ closedAt: new Date(), closureStatement: JSON.parse(JSON.stringify(await balancesOf(tx, id))) }),

  /** What was never paid is void, with the reason; nothing paid is touched, and the history stays. */
  'siteProject.cancel': async ({ tx, id, reason }) => {
    await tx.siteObligation.updateMany({
      where: { siteProjectId: id, status: { in: [...OPEN] }, settledAmount: 0 },
      data: { status: 'VOID', closeReason: `پروژه لغو شد${reason ? `: ${reason}` : ''}`.slice(0, 500), closedAt: new Date() },
    });
    await tx.siteContract.updateMany({ where: { siteProjectId: id, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } }, data: { status: 'SUPERSEDED' } });
    return { cancelReason: reason ?? null };
  },
};
