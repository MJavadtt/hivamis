/**
 * Bringing an organisation in (roadmap #48): its people, its clients and their contacts, the
 * projects already running, its holidays — from the spreadsheets it has.
 *
 * Every import is two calls with the same file: a preview that checks every row and writes
 * nothing, then a commit that re-checks and writes the valid rows, each on its own, so one bad row
 * never sinks the file. A row is CREATE, SKIP (it is already here — a migration file run twice
 * creates nothing twice) or INVALID, with its reasons in Persian. References are resolved the way
 * people write them: a user by email, a client by legal name or national id, a unit by the
 * organisation's own name for it (see units.ts). Digits may be Persian, Arabic or Latin; dates
 * Jalali or Gregorian.
 */
import { randomBytes } from 'node:crypto';
import {
  AUTHORIZATION_BASES, PROJECT_OPENING_STATES, ROLE_CODES, ROLE_LABELS, STATE_LABELS, type OnboardingImport, type RoleCode,
} from '@hiva/contracts';
import { prisma, type Tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { nextCode } from '../lib/codes.js';
import { jalaliToDate } from '../lib/jalali.js';
import { recordOpeningState } from '../workflow/engine.js';
import { nameKey, resolveUnit, unitMapOf } from './units.js';
import { PENDING_PREFIX, createActivation, sendActivation, type Activation } from './activation.js';

export interface ColumnSpec { key: string; labelFa: string; aliases: string[]; required?: boolean; hintFa: string }

const col = (key: string, labelFa: string, hintFa: string, aliases: string[] = [], required = false): ColumnSpec => ({ key, labelFa, hintFa, aliases, required });

export const COLUMNS: Record<OnboardingImport, ColumnSpec[]> = {
  users: [
    col('email', 'ایمیل', 'ایمیل سازمانی؛ نام کاربری او همین است', ['email', 'پست الکترونیک', 'رایانامه'], true),
    col('fullName', 'نام و نام خانوادگی', 'همان‌طور که در سامانه دیده شود', ['نام', 'name', 'full name', 'fullname'], true),
    col('unit', 'واحد', 'نام واحد در سازمان شما — در گام «واحدها» به یکی از ده واحد Doc_H وصل می‌شود', ['unit', 'department', 'دپارتمان', 'بخش'], true),
    col('roles', 'نقش‌ها', 'کد یا نام نقش؛ چند نقش با | جدا شود — مدیر سیستم با این فایل داده نمی‌شود', ['roles', 'role', 'نقش', 'سمت سازمانی'], true),
    col('jobTitle', 'عنوان شغلی', 'اختیاری', ['title', 'job title', 'سمت']),
    col('phone', 'تلفن', 'اختیاری', ['phone', 'موبایل', 'تلفن همراه']),
    col('weeklyCapacityHours', 'ظرفیت هفتگی (ساعت)', 'عدد؛ پیش‌فرض ۴۰', ['capacity', 'ظرفیت']),
    col('hourlyCost', 'هزینهٔ ساعتی (ریال)', 'اختیاری؛ برای بهای تمام‌شدهٔ کار', ['hourly cost', 'نرخ ساعتی']),
  ],
  companies: [
    col('legalName', 'نام حقوقی', 'نام ثبتی مشتری', ['legal name', 'نام شرکت', 'مشتری', 'company'], true),
    col('brandName', 'نام تجاری', 'اختیاری', ['brand', 'برند']),
    col('nationalId', 'شناسهٔ ملی', 'اختیاری؛ اگر باشد، تکراری‌بودن با آن سنجیده می‌شود', ['national id', 'شناسه ملی']),
    col('economicCode', 'کد اقتصادی', 'اختیاری', ['economic code']),
    col('industry', 'صنعت', 'اختیاری', ['industry']),
    col('phone', 'تلفن', 'اختیاری', ['phone']),
    col('website', 'وب‌سایت', 'اختیاری', ['website', 'سایت']),
    col('address', 'نشانی', 'اختیاری', ['address', 'آدرس']),
    col('postalCode', 'کد پستی', 'اختیاری', ['postal code']),
    col('accountOwner', 'مالک اکانت', 'ایمیل کاربر؛ خالی بماند، واردکننده مالک می‌شود', ['account owner', 'اکانت']),
    col('salesOwner', 'مالک فروش', 'ایمیل کاربر؛ اختیاری', ['sales owner', 'فروشنده']),
  ],
  contacts: [
    col('company', 'مشتری', 'نام حقوقی یا شناسهٔ ملی مشتری', ['company', 'نام شرکت', 'نام حقوقی'], true),
    col('fullName', 'نام و نام خانوادگی', 'نام مخاطب', ['name', 'نام', 'full name'], true),
    col('jobTitle', 'سمت', 'اختیاری', ['title', 'job title', 'عنوان شغلی']),
    col('email', 'ایمیل', 'اختیاری', ['email']),
    col('phone', 'تلفن', 'اختیاری', ['phone', 'موبایل']),
    col('isPrimary', 'مخاطب اصلی', 'بله یا خیر', ['primary', 'اصلی']),
  ],
  projects: [
    col('legacyRef', 'کد در سامانهٔ پیشین', 'شناسهٔ پروژه نزد شما؛ با آن، همین فایل دوباره چیزی نمی‌سازد', ['legacy ref', 'کد پروژه', 'کد قبلی', 'reference'], true),
    col('name', 'نام پروژه', '', ['name', 'عنوان', 'پروژه'], true),
    col('company', 'مشتری', 'نام حقوقی یا شناسهٔ ملی', ['company', 'نام شرکت', 'کارفرما'], true),
    col('accountOwner', 'مالک اکانت', 'ایمیل کاربر', ['account owner', 'اکانت'], true),
    col('state', 'وضعیت', 'پیش‌نویس، در انتظار مجوز، مجوزدار، در حال برنامه‌ریزی، در حال اجرا یا متوقف — پیش‌فرض پیش‌نویس', ['state', 'status']),
    col('plannedStart', 'شروع برنامه‌ریزی‌شده', 'تاریخ شمسی یا میلادی، مثلاً ۱۴۰۵/۰۷/۰۱', ['start', 'تاریخ شروع']),
    col('plannedEnd', 'پایان برنامه‌ریزی‌شده', 'تاریخ شمسی یا میلادی', ['end', 'تاریخ پایان']),
    col('contractValue', 'ارزش قرارداد (ریال)', 'عدد', ['contract value', 'مبلغ قرارداد']),
    col('plannedBudget', 'بودجهٔ برنامه‌ریزی‌شده (ریال)', 'عدد', ['budget', 'بودجه']),
    col('objective', 'هدف', 'اختیاری', ['objective']),
    col('authorizationBasis', 'مبنای مجوز شروع', 'قرارداد، سفارش رسمی یا … — برای پروژه‌ای که مجوز گرفته لازم است (قانون ۱۳)', ['authorization', 'مبنای مجوز']),
    col('authorizationRef', 'سند مجوز', 'شمارهٔ قرارداد یا نامهٔ سفارش', ['authorization ref', 'شماره قرارداد']),
  ],
  holidays: [
    col('date', 'تاریخ', 'شمسی یا میلادی، مثلاً ۱۴۰۵/۰۱/۰۱', ['date', 'روز'], true),
    col('title', 'عنوان', 'مثلاً نوروز', ['title', 'مناسبت', 'نام'], true),
  ],
};

/* ── cells ───────────────────────────────────────────────────────────────────────────────── */

const latin = (s: string) => s.replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660));
export function numberOf(s: string): number | null {
  const n = Number(latin(s).replace(/[,٬\s]/g, ''));
  return s.trim() !== '' && Number.isFinite(n) ? n : null;
}
/** 1405/07/01 (Jalali, by its year), 2026-09-23 or 2026/09/23 — as a date at midnight UTC. */
export function dateOf(s: string): Date | null {
  const m = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(latin(s).trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1700) {
    const g = jalaliToDate(y, mo, d);
    return g ? new Date(Date.UTC(g.getFullYear(), g.getMonth(), g.getDate())) : null;
  }
  const g = new Date(Date.UTC(y, mo - 1, d));
  return g.getUTCMonth() === mo - 1 && g.getUTCDate() === d ? g : null;
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const YES = new Set(['بله', 'آری', 'true', '1', 'yes', 'y', '✓', 'اصلی']);
const listOf = (s: string) => s.split(/[|،,]/).map((x) => x.trim()).filter(Boolean);
const byLabel = (value: string, codes: readonly string[], label: (c: string) => string | undefined) => {
  const key = nameKey(value);
  return codes.find((c) => c.toLowerCase() === value.trim().toLowerCase() || (label(c) && nameKey(label(c)!) === key)) ?? null;
};

/* ── the header ──────────────────────────────────────────────────────────────────────────── */

export interface HeaderMap { index: Record<string, number>; unknown: string[]; missing: string[] }

export function mapHeader(kind: OnboardingImport, header: string[]): HeaderMap {
  const index: Record<string, number> = {};
  const unknown: string[] = [];
  header.forEach((h, i) => {
    const k = nameKey(h);
    const spec = COLUMNS[kind].find((c) => [c.key, c.labelFa, ...c.aliases].some((a) => nameKey(a) === k));
    if (spec && index[spec.key] === undefined) index[spec.key] = i;
    else if (h.trim()) unknown.push(h.trim());
  });
  return { index, unknown, missing: COLUMNS[kind].filter((c) => c.required && index[c.key] === undefined).map((c) => c.labelFa) };
}

/* ── rows ────────────────────────────────────────────────────────────────────────────────── */

export type RowStatus = 'CREATE' | 'SKIP' | 'INVALID';
export interface RowPlan {
  line: number; label: string; status: RowStatus; issues: string[]; notes: string[];
  values: Record<string, string>;
  /** What the commit writes; absent unless CREATE. */
  write?: (tx: Tx) => Promise<{ id: string; activation?: Activation }>;
}
export interface Preview {
  kind: OnboardingImport; header: HeaderMap; rows: Omit<RowPlan, 'write'>[];
  summary: { create: number; skip: number; invalid: number };
}
export interface Actor { id: string; organizationId: string; ipAddress?: string | null; requestId?: string | null }

type Planner = (tx: Tx, actor: Actor, rows: { line: number; values: Record<string, string> }[]) => Promise<RowPlan[]>;

const need = (v: Record<string, string>, keys: string[], issues: string[]) => {
  for (const k of keys) if (!v[k]) issues.push(`«${[...Object.values(COLUMNS)].flat().find((c) => c.key === k)?.labelFa ?? k}» خالی است`);
};
/**
 * Rows the same file lists twice — the second and later are the problem. A row may be known by
 * more than one key (a client by national id and by name): sharing any of them is a repeat.
 */
const seenTwice = () => {
  const seen = new Set<string>();
  return (...keys: string[]) => {
    const own = keys.filter(Boolean);
    const repeat = own.some((k) => seen.has(k));
    own.forEach((k) => seen.add(k));
    return repeat;
  };
};

const usersPlanner: Planner = async (tx, actor, rows) => {
  const [departments, map, existing, roles] = await Promise.all([
    tx.department.findMany({ where: { organizationId: actor.organizationId }, select: { id: true, code: true, nameFa: true } }),
    unitMapOf(tx, actor.organizationId),
    // Taken within this organisation (audit LOG-4): another organisation's person may share the address.
    tx.user.findMany({ where: { organizationId: actor.organizationId, email: { in: rows.map((r) => r.values.email?.toLowerCase() ?? '') } }, select: { email: true } }),
    tx.role.findMany({ select: { id: true, code: true } }),
  ]);
  const taken = new Set(existing.map((u) => u.email));
  const twice = seenTwice();
  return rows.map(({ line, values: v }) => {
    const issues: string[] = [], notes: string[] = [];
    need(v, ['email', 'fullName', 'unit', 'roles'], issues);
    const email = (v.email ?? '').toLowerCase();
    if (email && !EMAIL.test(email)) issues.push(`ایمیل «${v.email}» درست نیست`);
    if (twice(email)) issues.push('این ایمیل در همین فایل تکرار شده است');
    const unit = v.unit ? resolveUnit(v.unit, map, departments) : null;
    if (v.unit && !unit) issues.push(`واحد «${v.unit}» نگاشته نشده — در گام «واحدها» آن را به یکی از ده واحد Doc_H وصل کنید`);
    const roleCodes = listOf(v.roles ?? '').map((r) => ({ r, code: byLabel(r, ROLE_CODES, (c) => ROLE_LABELS[c as RoleCode]?.fa) }));
    for (const x of roleCodes.filter((x) => !x.code)) issues.push(`نقش «${x.r}» شناخته نشد`);
    if (roleCodes.some((x) => x.code === 'SUPER_ADMIN')) issues.push('نقش مدیر سیستم با فایل داده نمی‌شود؛ آن را یک‌به‌یک در مدیریت کاربران بدهید');
    const capacity = v.weeklyCapacityHours ? numberOf(v.weeklyCapacityHours) : 40;
    if (capacity == null || capacity <= 0 || capacity > 80) issues.push('ظرفیت هفتگی باید عددی بین ۱ تا ۸۰ باشد');
    const cost = v.hourlyCost ? numberOf(v.hourlyCost) : null;
    if (v.hourlyCost && (cost == null || cost < 0)) issues.push('هزینهٔ ساعتی باید عدد باشد');
    const exists = taken.has(email);
    if (exists) notes.push('این ایمیل پیش‌تر در سامانه هست؛ دست نخورد');
    const status: RowStatus = issues.length ? 'INVALID' : exists ? 'SKIP' : 'CREATE';
    return {
      line, label: v.fullName || v.email || `ردیف ${line}`, status, issues, notes, values: v,
      ...(status === 'CREATE' ? {
        write: async (t: Tx) => {
          const dept = departments.find((d) => d.code === unit)!;
          const user = await t.user.create({
            data: {
              organizationId: actor.organizationId, departmentId: dept.id, email, fullName: v.fullName!,
              jobTitle: v.jobTitle || null, phone: v.phone || null, weeklyCapacityHours: capacity!, hourlyCost: cost,
              // No password is ever in a file: this one can never verify. The person sets their own
              // from a one-time link.
              passwordHash: `${PENDING_PREFIX}${randomBytes(12).toString('hex')}`, mustChangePassword: false,
              roles: { create: roleCodes.map((x) => ({ roleId: roles.find((r) => r.code === x.code)!.id })) },
            },
            select: { id: true, email: true, fullName: true },
          });
          await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'user', entityId: user.id, after: { ...user, unit, roles: roleCodes.map((x) => x.code), source: 'onboarding' }, ipAddress: actor.ipAddress, requestId: actor.requestId }, t);
          return { id: user.id, activation: await createActivation(t, user.id, actor.id) };
        },
      } : {}),
    };
  });
};

async function companiesOf(tx: Tx, organizationId: string) {
  const rows = await tx.company.findMany({ where: { organizationId, deletedAt: null }, select: { id: true, legalName: true, nationalId: true } });
  return {
    rows,
    find: (ref: string) => {
      const id = latin(ref).trim();
      return rows.find((c) => (c.nationalId && c.nationalId === id) || nameKey(c.legalName) === nameKey(ref)) ?? null;
    },
  };
}
async function usersByEmail(tx: Tx, organizationId: string) {
  const users = await tx.user.findMany({ where: { organizationId, isActive: true, deletedAt: null }, select: { id: true, email: true } });
  return (email: string) => users.find((u) => u.email === email.trim().toLowerCase())?.id ?? null;
}

const companiesPlanner: Planner = async (tx, actor, rows) => {
  const companies = await companiesOf(tx, actor.organizationId);
  const userOf = await usersByEmail(tx, actor.organizationId);
  const twice = seenTwice();
  return rows.map(({ line, values: v }) => {
    const issues: string[] = [], notes: string[] = [];
    need(v, ['legalName'], issues);
    const nationalId = v.nationalId ? latin(v.nationalId).replace(/\D/g, '') : '';
    if (twice(nationalId, nameKey(v.legalName ?? ''))) issues.push('این مشتری در همین فایل تکرار شده است');
    const accountOwnerId = v.accountOwner ? userOf(v.accountOwner) : actor.id;
    if (v.accountOwner && !accountOwnerId) issues.push(`کاربری با ایمیل «${v.accountOwner}» نیست`);
    const salesOwnerId = v.salesOwner ? userOf(v.salesOwner) : null;
    if (v.salesOwner && !salesOwnerId) issues.push(`کاربری با ایمیل «${v.salesOwner}» نیست`);
    const exists = v.legalName ? companies.find(nationalId || v.legalName) ?? (nationalId ? companies.find(v.legalName) : null) : null;
    if (exists) notes.push(`«${exists.legalName}» پیش‌تر ثبت شده است؛ دست نخورد`);
    const status: RowStatus = issues.length ? 'INVALID' : exists ? 'SKIP' : 'CREATE';
    // Said only of a row that will be written: of one that is skipped it would be untrue.
    if (status === 'CREATE' && !v.accountOwner) notes.push('مالک اکانت خالی بود؛ واردکننده مالک می‌شود');
    return {
      line, label: v.legalName || `ردیف ${line}`, status, issues, notes, values: v,
      ...(status === 'CREATE' ? {
        write: async (t: Tx) => {
          const c = await t.company.create({
            data: {
              organizationId: actor.organizationId, legalName: v.legalName!, brandName: v.brandName || null, nationalId: nationalId || null,
              economicCode: v.economicCode ? latin(v.economicCode) : null, industry: v.industry || null, phone: v.phone ? latin(v.phone) : null,
              website: v.website || null, address: v.address || null, postalCode: v.postalCode ? latin(v.postalCode) : null,
              accountOwnerId, salesOwnerId,
            },
          });
          await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'company', entityId: c.id, after: { legalName: c.legalName, source: 'onboarding' }, ipAddress: actor.ipAddress, requestId: actor.requestId }, t);
          return { id: c.id };
        },
      } : {}),
    };
  });
};

const contactsPlanner: Planner = async (tx, actor, rows) => {
  const companies = await companiesOf(tx, actor.organizationId);
  const existing = await tx.contact.findMany({ where: { companyId: { in: companies.rows.map((c) => c.id) }, deletedAt: null }, select: { companyId: true, fullName: true, email: true } });
  const twice = seenTwice();
  return rows.map(({ line, values: v }) => {
    const issues: string[] = [], notes: string[] = [];
    need(v, ['company', 'fullName'], issues);
    const company = v.company ? companies.find(v.company) : null;
    if (v.company && !company) issues.push(`مشتری «${v.company}» پیدا نشد — نخست مشتریان را وارد کنید`);
    const email = (v.email ?? '').toLowerCase();
    if (email && !EMAIL.test(email)) issues.push(`ایمیل «${v.email}» درست نیست`);
    if (twice(`${company?.id}:${email || nameKey(v.fullName ?? '')}`)) issues.push('این مخاطب در همین فایل تکرار شده است');
    const exists = company && existing.some((c) => c.companyId === company.id && ((email && c.email?.toLowerCase() === email) || nameKey(c.fullName) === nameKey(v.fullName ?? '')));
    if (exists) notes.push('این مخاطب پیش‌تر برای همین مشتری ثبت شده است');
    const status: RowStatus = issues.length ? 'INVALID' : exists ? 'SKIP' : 'CREATE';
    return {
      line, label: v.fullName || `ردیف ${line}`, status, issues, notes, values: v,
      ...(status === 'CREATE' ? {
        write: async (t: Tx) => {
          const c = await t.contact.create({ data: { organizationId: actor.organizationId, companyId: company!.id, fullName: v.fullName!, jobTitle: v.jobTitle || null, email: email || null, phone: v.phone ? latin(v.phone) : null, isPrimary: YES.has((v.isPrimary ?? '').toLowerCase()) } });
          await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'contact', entityId: c.id, after: { companyId: company!.id, fullName: c.fullName, source: 'onboarding' }, ipAddress: actor.ipAddress, requestId: actor.requestId }, t);
          return { id: c.id };
        },
      } : {}),
    };
  });
};

/** The words a spreadsheet uses for a state or a basis, besides the app's own labels. */
const ALIASES: Record<string, string[]> = {
  DRAFT: ['پیش‌نویس', 'پیشنویس', 'draft'],
  PENDING_AUTHORIZATION: ['در انتظار مجوز', 'منتظر مجوز'],
  AUTHORIZED: ['مجوزدار', 'مجوز گرفته', 'مجوز صادر شد'],
  PLANNING: ['در حال برنامه‌ریزی', 'برنامه‌ریزی', 'planning'],
  ACTIVE: ['در حال اجرا', 'فعال', 'جاری', 'active'],
  ON_HOLD: ['متوقف', 'معلق', 'on hold'],
  CONTRACT: ['قرارداد', 'قرارداد معتبر', 'contract'],
  OFFICIAL_ORDER: ['سفارش رسمی', 'نامهٔ سفارش', 'نامه سفارش', 'order'],
  INVOICED_EXECUTION_ORDER: ['دستور اجرای فاکتوری', 'فاکتور', 'پیش‌فاکتور', 'invoice'],
};
const labelOrAlias = (value: string, codes: readonly string[]) => {
  const key = nameKey(value);
  return byLabel(value, codes, (c) => STATE_LABELS[c]?.fa) ?? codes.find((c) => (ALIASES[c] ?? []).some((a) => nameKey(a) === key)) ?? null;
};

/** States past which Doc_H rule 13 needs an authorization on record. */
const AUTHORIZED_STATES = new Set(['AUTHORIZED', 'PLANNING', 'ACTIVE', 'ON_HOLD']);

const projectsPlanner: Planner = async (tx, actor, rows) => {
  const companies = await companiesOf(tx, actor.organizationId);
  const userOf = await usersByEmail(tx, actor.organizationId);
  const known = new Set((await tx.project.findMany({ where: { organizationId: actor.organizationId, legacyRef: { in: rows.map((r) => r.values.legacyRef ?? '') } }, select: { legacyRef: true } })).map((p) => p.legacyRef));
  const twice = seenTwice();
  const label = (c: string) => STATE_LABELS[c]?.fa;
  return rows.map(({ line, values: v }) => {
    const issues: string[] = [], notes: string[] = [];
    need(v, ['legacyRef', 'name', 'company', 'accountOwner'], issues);
    if (twice(v.legacyRef ?? '')) issues.push('این کد در همین فایل تکرار شده است');
    const company = v.company ? companies.find(v.company) : null;
    if (v.company && !company) issues.push(`مشتری «${v.company}» پیدا نشد — نخست مشتریان را وارد کنید`);
    const ownerId = v.accountOwner ? userOf(v.accountOwner) : null;
    if (v.accountOwner && !ownerId) issues.push(`کاربری با ایمیل «${v.accountOwner}» نیست`);
    const state = v.state ? labelOrAlias(v.state, PROJECT_OPENING_STATES) : 'DRAFT';
    if (!state) issues.push(`وضعیت «${v.state}» برای پروژهٔ در جریان پذیرفته نیست — ${PROJECT_OPENING_STATES.map((s) => label(s) ?? s).join('، ')}`);
    const start = v.plannedStart ? dateOf(v.plannedStart) : null, end = v.plannedEnd ? dateOf(v.plannedEnd) : null;
    if (v.plannedStart && !start) issues.push(`تاریخ شروع «${v.plannedStart}» خوانا نیست`);
    if (v.plannedEnd && !end) issues.push(`تاریخ پایان «${v.plannedEnd}» خوانا نیست`);
    if (start && end && end < start) issues.push('پایان پیش از شروع است');
    const value = v.contractValue ? numberOf(v.contractValue) : null, budget = v.plannedBudget ? numberOf(v.plannedBudget) : null;
    if (v.contractValue && (value == null || value < 0)) issues.push('ارزش قرارداد باید عدد باشد');
    if (v.plannedBudget && (budget == null || budget < 0)) issues.push('بودجه باید عدد باشد');
    const basis = v.authorizationBasis ? labelOrAlias(v.authorizationBasis, AUTHORIZATION_BASES) : null;
    if (v.authorizationBasis && !basis) issues.push(`مبنای مجوز «${v.authorizationBasis}» شناخته نشد`);
    const authorized = !!state && AUTHORIZED_STATES.has(state);
    if (authorized && (!basis || !v.authorizationRef)) issues.push(`پروژه‌ای «${label(state!) ?? state}» مبنای مجوز و سند آن را لازم دارد (قانون ۱۳ — بدون مجوز شروع، اجرا نیست)`);
    const exists = !!v.legacyRef && known.has(v.legacyRef);
    if (exists) notes.push(`پروژه‌ای با کد «${v.legacyRef}» پیش‌تر وارد شده است؛ دست نخورد`);
    const status: RowStatus = issues.length ? 'INVALID' : exists ? 'SKIP' : 'CREATE';
    return {
      line, label: v.name || v.legacyRef || `ردیف ${line}`, status, issues, notes, values: v,
      ...(status === 'CREATE' ? {
        write: async (t: Tx) => {
          const p = await t.project.create({
            data: {
              organizationId: actor.organizationId, code: await nextCode(t, 'project'), name: v.name!, legacyRef: v.legacyRef!,
              companyId: company!.id, accountOwnerId: ownerId!, objective: v.objective || null, plannedStart: start, plannedEnd: end,
              contractValue: value, plannedBudget: budget,
            },
          });
          await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'project', entityId: p.id, after: { code: p.code, name: p.name, legacyRef: p.legacyRef, source: 'onboarding' }, ipAddress: actor.ipAddress, requestId: actor.requestId }, t);
          if (authorized) {
            await t.executionAuthorization.create({
              data: { projectId: p.id, basis: basis!, referenceDocument: v.authorizationRef!, notes: 'ثبت‌شده هنگام ورود از سامانهٔ پیشین', authorizedById: actor.id },
            });
          }
          await recordOpeningState(t, { entity: 'project', id: p.id, toState: state!, reason: `ورود از سامانهٔ پیشین (کد ${v.legacyRef})`, actor });
          return { id: p.id };
        },
      } : {}),
    };
  });
};

const holidaysPlanner: Planner = async (tx, actor, rows) => {
  const existing = new Set((await tx.holiday.findMany({ where: { organizationId: actor.organizationId }, select: { date: true } })).map((h) => h.date.toISOString().slice(0, 10)));
  const twice = seenTwice();
  return rows.map(({ line, values: v }) => {
    const issues: string[] = [], notes: string[] = [];
    need(v, ['date', 'title'], issues);
    const date = v.date ? dateOf(v.date) : null;
    if (v.date && !date) issues.push(`تاریخ «${v.date}» خوانا نیست`);
    const day = date?.toISOString().slice(0, 10) ?? '';
    if (twice(day)) issues.push('این روز در همین فایل تکرار شده است');
    const exists = existing.has(day);
    if (exists) notes.push('این روز پیش‌تر تعطیل ثبت شده است');
    const status: RowStatus = issues.length ? 'INVALID' : exists ? 'SKIP' : 'CREATE';
    return {
      line, label: v.title || v.date || `ردیف ${line}`, status, issues, notes, values: v,
      ...(status === 'CREATE' ? {
        write: async (t: Tx) => {
          const h = await t.holiday.create({ data: { organizationId: actor.organizationId, date: date!, title: v.title! } });
          return { id: h.id };
        },
      } : {}),
    };
  });
};

const PLANNERS: Record<OnboardingImport, Planner> = { users: usersPlanner, companies: companiesPlanner, contacts: contactsPlanner, projects: projectsPlanner, holidays: holidaysPlanner };

/** The table as rows keyed by column — the first row is the header. */
function rowsOf(kind: OnboardingImport, table: string[][]) {
  const header = mapHeader(kind, table[0] ?? []);
  const rows = table.slice(1).map((cells, i) => ({
    line: i + 2,
    values: Object.fromEntries(Object.entries(header.index).map(([k, idx]) => [k, (cells[idx] ?? '').trim()]).filter(([, v]) => v !== '')) as Record<string, string>,
  })).filter((r) => Object.keys(r.values).length > 0);
  return { header, rows };
}

export async function plan(tx: Tx, actor: Actor, kind: OnboardingImport, table: string[][]): Promise<{ preview: Preview; plans: RowPlan[] }> {
  const { header, rows } = rowsOf(kind, table);
  const plans = header.missing.length ? [] : await PLANNERS[kind](tx, actor, rows);
  const count = (s: RowStatus) => plans.filter((p) => p.status === s).length;
  return {
    plans,
    preview: {
      kind, header, rows: plans.map(({ write: _w, ...p }) => p),
      summary: { create: count('CREATE'), skip: count('SKIP'), invalid: count('INVALID') },
    },
  };
}

export interface CommitResult {
  preview: Preview;
  created: { line: number; label: string; id: string }[];
  failed: { line: number; label: string; messageFa: string }[];
  activations: (Activation & { line: number; label: string; email: string })[];
}

/** Write the valid rows, each in its own transaction; a row the database refuses is reported and the rest go on. */
export async function commit(actor: Actor, kind: OnboardingImport, table: string[][]): Promise<CommitResult> {
  const { preview, plans } = await plan(prisma, actor, kind, table);
  const out: CommitResult = { preview, created: [], failed: [], activations: [] };
  for (const p of plans.filter((x) => x.write)) {
    try {
      const done = await prisma.$transaction((tx) => p.write!(tx), { timeout: 20_000 });
      out.created.push({ line: p.line, label: p.label, id: done.id });
      if (done.activation) {
        await sendActivation(done.activation);
        // A link is shown only when it was not emailed: shown once, to pass on by hand.
        const { mail: _m, ...a } = done.activation;
        out.activations.push({ ...a, url: a.emailed ? '' : a.url, mail: null, line: p.line, label: p.label, email: (p.values.email ?? '').toLowerCase() });
      }
    } catch (e) {
      out.failed.push({ line: p.line, label: p.label, messageFa: (e as { message?: string }).message ?? 'نوشته نشد' });
    }
  }
  await audit({
    organizationId: actor.organizationId, actorId: actor.id, action: 'BULK_IMPORT', entityType: 'onboarding', entityId: kind,
    after: { kind, created: out.created.length, skipped: preview.summary.skip, invalid: preview.summary.invalid, failed: out.failed.length },
    ipAddress: actor.ipAddress, requestId: actor.requestId,
  });
  return out;
}
