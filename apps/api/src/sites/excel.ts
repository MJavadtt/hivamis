import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  IMPORT_KIND_LABELS, OBLIGATION_KINDS, OBLIGATION_KIND_LABELS, RENT_PERIODS, SITE_OPTION_LIST_LABELS,
  moneySchema, nameKey, phoneKey, obligationSchema, siteProjectCreateSchema, venueContactSchema, venueSchema,
  type ImportKind, type SiteOptionList, type SiteSettings,
} from '@hiva/contracts';
import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../db.js';
import { badRequest, conflict } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { nextCode } from '../lib/codes.js';
import { jalaliToDate } from '../lib/jalali.js';
import { optionsOf, type SiteOptionRow } from './options.js';
import { addContact, assertRequired, createVenue, findDuplicates, type SiteActor } from './venues.js';

/**
 * Excel in and out (ADR-103) — «امکان اینپورت و اکسپورت با فایل اکسل».
 *
 * In: a template per kind (venues, their contacts, deployment projects, obligations), each column
 * documented on a second sheet with the values its lists allow. A file is read, its columns matched to
 * the template's by header — Persian or the column's key — or by a mapping the person gives, and every
 * row checked: required fields, types, dates (Persian or Gregorian), the organisation's lists, venues
 * that look like one already here. The preview says row by row what would happen and why not; the
 * commit writes the good rows in one transaction, and only skips bad ones when the person said to.
 * Nothing is overwritten unless the import is an update (UPSERT) and the row names the record's code.
 *
 * Out: any list as the screen filtered it, with documented headers, money as numbers, dates in the
 * Persian calendar, and every text cell that could be read as a formula written as plain text.
 */

export const MAX_IMPORT_ROWS = 5000;

interface ColumnDef { key: string; fa: string; required?: boolean; hint?: string; list?: SiteOptionList }

export const IMPORT_COLUMNS: Record<ImportKind, ColumnDef[]> = {
  VENUES: [
    { key: 'code', fa: 'کد مکان', hint: 'فقط برای به‌روزرسانی؛ خالی یعنی مکان تازه' },
    { key: 'name', fa: 'نام مکان', required: true },
    { key: 'province', fa: 'استان', required: true },
    { key: 'city', fa: 'شهر', required: true },
    { key: 'address', fa: 'آدرس' },
    { key: 'type', fa: 'نوع مکان', required: true, list: 'VENUE_TYPE' },
    { key: 'grade', fa: 'گرید', list: 'VENUE_GRADE' },
    { key: 'audiences', fa: 'مخاطبان', list: 'AUDIENCE', hint: 'چند مورد را با ویرگول جدا کنید' },
    { key: 'phone', fa: 'تلفن' },
    { key: 'email', fa: 'ایمیل' },
    { key: 'website', fa: 'وب‌سایت' },
    { key: 'notes', fa: 'یادداشت' },
    { key: 'active', fa: 'فعال', hint: 'بله یا خیر؛ خالی یعنی بله' },
    { key: 'contact_name', fa: 'نام مخاطب' },
    { key: 'contact_role', fa: 'سمت مخاطب', list: 'CONTACT_ROLE' },
    { key: 'contact_phone', fa: 'تلفن مخاطب' },
    { key: 'contact_email', fa: 'ایمیل مخاطب' },
    { key: 'not_duplicate', fa: 'تکراری نیست', hint: 'بله، اگر مکان شبیه مکانی ثبت‌شده است ولی جای دیگری است' },
  ],
  CONTACTS: [
    { key: 'venue_code', fa: 'کد مکان', required: true },
    { key: 'full_name', fa: 'نام و نام خانوادگی', required: true },
    { key: 'role', fa: 'سمت', required: true, list: 'CONTACT_ROLE' },
    { key: 'job_title', fa: 'عنوان شغلی' },
    { key: 'phone', fa: 'تلفن' },
    { key: 'email', fa: 'ایمیل' },
    { key: 'notes', fa: 'یادداشت' },
    { key: 'primary', fa: 'مخاطب اصلی', hint: 'بله یا خیر' },
  ],
  SITE_PROJECTS: [
    { key: 'code', fa: 'کد پروژه', hint: 'فقط برای به‌روزرسانی؛ خالی یعنی پروژهٔ تازه' },
    { key: 'name', fa: 'نام پروژه', required: true },
    { key: 'venue_code', fa: 'کد مکان', required: true },
    { key: 'placement', fa: 'محل استقرار' },
    { key: 'cooperation', fa: 'مدل همکاری', list: 'COOPERATION' },
    { key: 'contract_start', fa: 'آغاز قرارداد', hint: 'تاریخ شمسی (۱۴۰۵/۰۸/۰۱) یا میلادی' },
    { key: 'contract_end', fa: 'پایان قرارداد' },
    { key: 'deposit', fa: 'مبلغ ودیعه' },
    { key: 'rent', fa: 'مبلغ اجاره' },
    { key: 'rent_period', fa: 'دورهٔ اجاره', hint: 'MONTHLY (ماهیانه)، DAILY (روزانه) یا ONCE (یکجا)' },
    { key: 'rent_due_day', fa: 'روز سررسید اجاره', hint: 'چند روز پس از آغاز هر دوره؛ ۰ یعنی روز اول' },
    { key: 'rent_method', fa: 'نحوهٔ پرداخت اجاره', list: 'PAYMENT_METHOD' },
    { key: 'charge', fa: 'شارژ ماهیانه' },
    { key: 'charge_due_day', fa: 'روز سررسید شارژ' },
    { key: 'charge_method', fa: 'نحوهٔ پرداخت شارژ', list: 'PAYMENT_METHOD' },
    { key: 'install_planned', fa: 'تاریخ برنامهٔ نصب' },
    { key: 'install_cost', fa: 'هزینهٔ نصب' },
    { key: 'transport_cost', fa: 'هزینهٔ حمل' },
    { key: 'notes', fa: 'یادداشت' },
  ],
  OBLIGATIONS: [
    { key: 'project_code', fa: 'کد پروژه', required: true },
    { key: 'kind', fa: 'نوع', required: true, hint: OBLIGATION_KINDS.map((k) => `${k} (${OBLIGATION_KIND_LABELS[k].fa})`).join('، ') },
    { key: 'category', fa: 'دستهٔ هزینه', list: 'CHARGE_CATEGORY' },
    { key: 'description', fa: 'شرح' },
    { key: 'due_date', fa: 'تاریخ سررسید', required: true },
    { key: 'amount', fa: 'مبلغ', required: true },
    { key: 'period_start', fa: 'آغاز دوره' },
    { key: 'period_end', fa: 'پایان دوره' },
  ],
};

/* ── cells ───────────────────────────────────────────────────────────────── */

/** Text that a spreadsheet would run as a formula is written as text: a leading quote, kept visible. */
export const safeText = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

const latin = (s: string) => s.replace(/[۰-۹]/g, (c) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/[٠-٩]/g, (c) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String((v as { text: unknown }).text ?? '');
    if ('result' in v) return String((v as { result: unknown }).result ?? '');
    return '';
  }
  return String(v).trim();
}

/** A date from a cell: a real date, or text in the Persian calendar (year below 1700) or the Gregorian. */
export function parseDateCell(v: ExcelJS.CellValue): Date | null | 'invalid' {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'invalid' : v;
  const s = latin(cellText(v)).replace(/[.\-]/g, '/');
  if (!s) return null;
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (!m) return 'invalid';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1700) {
    const g = jalaliToDate(y, mo, d);
    // The day as the app's own date fields send it: that calendar day at UTC midnight.
    return g ? new Date(Date.UTC(g.getFullYear(), g.getMonth(), g.getDate())) : 'invalid';
  }
  const g = new Date(Date.UTC(y, mo - 1, d));
  return g.getUTCMonth() === mo - 1 ? g : 'invalid';
}

const YES = new Set(['بله', 'آری', 'yes', 'y', 'true', '1', 'فعال']);
const NO = new Set(['خیر', 'نه', 'no', 'n', 'false', '0', 'غیرفعال']);
function parseBool(v: string): boolean | null | 'invalid' {
  const s = latin(v).trim().toLowerCase();
  if (!s) return null;
  return YES.has(s) ? true : NO.has(s) ? false : 'invalid';
}

/* ── reading a file ──────────────────────────────────────────────────────── */

export interface RowResult {
  row: number;
  action: 'CREATE' | 'UPDATE' | 'ERROR';
  /** The record's code once written, or the code an update names. */
  code?: string | null;
  label: string;
  errors: string[];
  warnings: string[];
}

export interface ImportOutcome {
  kind: ImportKind; mode: 'CREATE' | 'UPSERT'; dryRun: boolean;
  fileName: string; totalRows: number;
  mapping: Record<string, string>;
  /** Headers in the file no column was matched to: they are not read. */
  unmatched: string[];
  created: number; updated: number; failed: number;
  rows: RowResult[];
  importId?: string;
}

interface ParsedRow { row: number; values: Record<string, ExcelJS.CellValue> }

/** The file's first sheet as rows of values by column key. */
export async function readRows(buffer: Buffer, kind: ImportKind, mapping: Record<string, string> = {}) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw badRequest('BAD_FILE', 'فایل اکسل خوانده نشد؛ فایل xlsx بفرستید.');
  }
  const sheet = wb.worksheets[0];
  if (!sheet) throw badRequest('BAD_FILE', 'فایل اکسل برگه‌ای ندارد.');
  const columns = IMPORT_COLUMNS[kind];
  const byHeader = new Map<string, string>();
  for (const c of columns) { byHeader.set(nameKey(c.fa), c.key); byHeader.set(nameKey(c.key), c.key); }
  const header = sheet.getRow(1);
  const colKey = new Map<number, string>();
  const used: Record<string, string> = {};
  const unmatched: string[] = [];
  header.eachCell({ includeEmpty: false }, (cell, col) => {
    const h = cellText(cell.value);
    const key = mapping[h] ?? byHeader.get(nameKey(h));
    if (key && columns.some((c) => c.key === key) && !Object.values(used).includes(key)) { colKey.set(col, key); used[h] = key; }
    else if (h) unmatched.push(h);
  });
  const missing = columns.filter((c) => c.required && !Object.values(used).includes(c.key));
  if (missing.length) {
    throw badRequest('MISSING_COLUMNS', `این ستون‌های لازم در فایل نیست: ${missing.map((c) => c.fa).join('، ')}. الگوی همین نوع را دریافت و پر کنید، یا ستون‌ها را نگاشت کنید.`, { missing: missing.map((c) => c.key), headers: [...colKey.values()] });
  }
  const rows: ParsedRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (r, n) => {
    if (n === 1) return;
    const values: Record<string, ExcelJS.CellValue> = {};
    let any = false;
    for (const [col, key] of colKey) {
      const v = r.getCell(col).value;
      values[key] = v;
      if (cellText(v)) any = true;
    }
    if (any) rows.push({ row: n, values });
  });
  if (rows.length > MAX_IMPORT_ROWS) throw badRequest('TOO_MANY_ROWS', `هر فایل حداکثر ${MAX_IMPORT_ROWS} ردیف؛ فایل را چند بخش کنید.`);
  return { rows, mapping: used, unmatched };
}

/** An option by its code or either of its labels, as people type them. */
function optionResolver(options: SiteOptionRow[]) {
  return (list: SiteOptionList, raw: string): string | null | 'invalid' => {
    const s = raw.trim();
    if (!s) return null;
    const k = nameKey(s);
    const o = options.find((x) => x.list === list && x.isActive && (x.code === s.toUpperCase() || nameKey(x.labelFa) === k || (x.labelEn && nameKey(x.labelEn) === k)));
    return o?.code ?? 'invalid';
  };
}

/* ── importing ───────────────────────────────────────────────────────────── */

export async function runImport(actor: SiteActor, input: {
  kind: ImportKind; mode: 'CREATE' | 'UPSERT'; dryRun: boolean; skipInvalid: boolean;
  fileName: string; buffer: Buffer; mapping?: Record<string, string>; settings: SiteSettings;
}): Promise<ImportOutcome> {
  const { rows, mapping, unmatched } = await readRows(input.buffer, input.kind, input.mapping);
  const options = await optionsOf(actor.organizationId);
  const opt = optionResolver(options);
  const outcome: ImportOutcome = {
    kind: input.kind, mode: input.mode, dryRun: input.dryRun, fileName: input.fileName, totalRows: rows.length,
    mapping, unmatched, created: 0, updated: 0, failed: 0, rows: [],
  };

  const work = async (tx: Tx | typeof prisma, write: boolean, importId: string | null) => {
    outcome.rows = [];
    // Venues the file itself repeats, by name in a city and by phone.
    const seenInFile = new Map<string, number>();
    for (const r of rows) {
      const res: RowResult = { row: r.row, action: 'ERROR', label: '', errors: [], warnings: [] };
      const text = (k: string) => cellText(r.values[k] ?? null);
      const date = (k: string, label: string) => {
        const d = parseDateCell(r.values[k] ?? null);
        if (d === 'invalid') { res.errors.push(`«${label}» تاریخ معتبری نیست.`); return null; }
        return d;
      };
      const amount = (k: string, label: string) => {
        const raw = r.values[k];
        if (raw == null || cellText(raw) === '') return null;
        const p = moneySchema.safeParse(typeof raw === 'number' ? raw : cellText(raw));
        if (!p.success) { res.errors.push(`«${label}» مبلغ معتبری نیست.`); return null; }
        return p.data;
      };
      const pick = (list: SiteOptionList, k: string, label: string) => {
        const v = opt(list, text(k));
        if (v === 'invalid') { res.errors.push(`«${text(k)}» در فهرست «${label}» نیست.`); return null; }
        return v;
      };
      const zodErrors = (issues: { path: (string | number)[]; message: string }[]) => {
        for (const i of issues) res.errors.push(`${IMPORT_COLUMNS[input.kind].find((c) => c.key === String(i.path[0]))?.fa ?? String(i.path[0] ?? '')}: ${i.message}`);
      };

      if (input.kind === 'VENUES') {
        const active = parseBool(text('active'));
        const notDuplicate = parseBool(text('not_duplicate'));
        if (active === 'invalid') res.errors.push('«فعال» باید بله یا خیر باشد.');
        const audiences = text('audiences').split(/[,،؛;]/).map((x) => x.trim()).filter(Boolean).map((a) => {
          const c = opt('AUDIENCE', a);
          if (c === 'invalid') res.errors.push(`«${a}» در فهرست «${SITE_OPTION_LIST_LABELS.AUDIENCE.fa}» نیست.`);
          return c;
        }).filter((c): c is string => !!c && c !== 'invalid');
        const contactName = text('contact_name');
        const candidate = {
          name: text('name'), province: text('province'), city: text('city'), address: text('address') || null,
          typeCode: pick('VENUE_TYPE', 'type', 'نوع مکان') ?? '', gradeCode: pick('VENUE_GRADE', 'grade', 'گرید'), audienceCodes: audiences,
          phone: text('phone') || null, email: text('email') || null, website: text('website') || null, notes: text('notes') || null,
          isActive: active === 'invalid' || active === null ? true : active,
          contacts: contactName ? [{ fullName: contactName, roleCode: pick('CONTACT_ROLE', 'contact_role', 'سمت مخاطب') ?? 'OTHER', phone: text('contact_phone') || null, email: text('contact_email') || null, isPrimary: true, channels: [] }] : [],
          confirmNotDuplicate: notDuplicate === true,
        };
        const parsed = venueSchema.safeParse(candidate);
        res.label = candidate.name;
        if (!parsed.success) zodErrors(parsed.error.issues);
        const code = text('code');
        const existing = code ? await tx.venue.findFirst({ where: { organizationId: actor.organizationId, code } }) : null;
        if (code && !existing) res.errors.push(`مکانی با کد «${code}» نیست.`);
        if (existing && input.mode === 'CREATE') res.errors.push(`کد «${code}» از آنِ مکانی ثبت‌شده است؛ برای به‌روزرسانی، ورود را «به‌روزرسانی» بگذارید.`);
        if (parsed.success && !res.errors.length) {
          const fileKey = `${nameKey(parsed.data.name)}|${parsed.data.city}`;
          if (seenInFile.has(fileKey)) res.errors.push(`همین مکان در ردیف ${seenInFile.get(fileKey)} هم آمده است.`);
          seenInFile.set(fileKey, r.row);
          const dups = await findDuplicates(actor.organizationId, { ...parsed.data, contactPhones: parsed.data.contacts?.map((c) => c.phone) }, input.settings, existing?.id, tx);
          if (dups.length && !parsed.data.confirmNotDuplicate) res.errors.push(`شبیه مکان ثبت‌شدهٔ ${dups.map((d) => `${d.code} ${d.name}`).join('، ')} است؛ اگر جای دیگری است، «تکراری نیست» را بله بگذارید.`);
          const missingRequired = input.settings.venues.required.filter((f) => f !== 'contacts' && f !== 'photos' && !(f === 'audienceCodes' ? parsed.data.audienceCodes.length : parsed.data[f as 'address']));
          if (missingRequired.length) res.warnings.push('ناقص: برخی موارد لازم مکان خالی است و مکان «ناقص» نشان داده می‌شود.');
        }
        if (!res.errors.length && parsed.success) {
          res.action = existing ? 'UPDATE' : 'CREATE';
          res.code = existing?.code ?? null;
          if (write) {
            const original = Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, cellText(v)]));
            if (existing) {
              const { contacts, confirmNotDuplicate: _c, channels: _ch, ...fields } = parsed.data;
              const after = await tx.venue.update({
                where: { id: existing.id },
                data: { ...fields, nameKey: nameKey(fields.name), phoneKey: phoneKey(fields.phone), updatedById: actor.id, version: { increment: 1 }, importId, importedValues: original as Prisma.InputJsonValue },
              });
              if (contacts?.[0] && !(await tx.venueContact.count({ where: { venueId: existing.id, fullName: contacts[0].fullName, archivedAt: null } }))) {
                await addContact(tx as Tx, actor.organizationId, existing.id, { ...contacts[0], isPrimary: !(await tx.venueContact.count({ where: { venueId: existing.id, isPrimary: true, archivedAt: null } })) });
              }
              await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'IMPORT', entityType: 'venue', entityId: existing.id, before: existing, after, reason: `ورود از اکسل: ${input.fileName}، ردیف ${r.row}` }, tx as Tx);
            } else {
              const v = await createVenue(tx as Tx, actor, parsed.data, { source: 'IMPORT', importId, importedValues: original });
              res.code = v.code;
            }
          }
        }
      }

      if (input.kind === 'CONTACTS') {
        const venue = await tx.venue.findFirst({ where: { organizationId: actor.organizationId, code: text('venue_code'), mergedIntoId: null }, select: { id: true, name: true } });
        if (!venue) res.errors.push(`مکانی با کد «${text('venue_code')}» نیست.`);
        const primary = parseBool(text('primary'));
        if (primary === 'invalid') res.errors.push('«مخاطب اصلی» باید بله یا خیر باشد.');
        const parsed = venueContactSchema.safeParse({
          fullName: text('full_name'), roleCode: pick('CONTACT_ROLE', 'role', 'سمت') ?? '', jobTitle: text('job_title') || null,
          phone: text('phone') || null, email: text('email') || null, notes: text('notes') || null, isPrimary: primary === true,
        });
        res.label = `${text('full_name')} — ${venue?.name ?? text('venue_code')}`;
        if (!parsed.success) zodErrors(parsed.error.issues);
        if (venue && parsed.success && await tx.venueContact.count({ where: { venueId: venue.id, fullName: parsed.data.fullName, archivedAt: null } })) {
          res.errors.push('این مخاطب با همین نام برای این مکان ثبت شده است.');
        }
        if (!res.errors.length && venue && parsed.success) {
          res.action = 'CREATE';
          if (write) {
            const c = await addContact(tx as Tx, actor.organizationId, venue.id, parsed.data);
            await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'IMPORT', entityType: 'venueContact', entityId: c.id, after: c, reason: `ورود از اکسل: ${input.fileName}، ردیف ${r.row}` }, tx as Tx);
          }
        }
      }

      if (input.kind === 'SITE_PROJECTS') {
        const venue = await tx.venue.findFirst({ where: { organizationId: actor.organizationId, code: text('venue_code'), mergedIntoId: null }, select: { id: true } });
        if (!venue) res.errors.push(`مکانی با کد «${text('venue_code')}» نیست.`);
        const period = text('rent_period').toUpperCase();
        if (period && !RENT_PERIODS.includes(period as never)) res.errors.push(`دورهٔ اجارهٔ «${text('rent_period')}» نامعتبر است.`);
        const int = (k: string, label: string) => {
          const s = latin(text(k));
          if (!s) return null;
          if (!/^\d{1,2}$/.test(s) || Number(s) > 27) { res.errors.push(`«${label}» عددی میان ۰ و ۲۷ باشد.`); return null; }
          return Number(s);
        };
        const candidate = {
          name: text('name'), venueId: venue?.id ?? '00000000-0000-0000-0000-000000000000', placement: text('placement') || null,
          cooperationCode: pick('COOPERATION', 'cooperation', 'مدل همکاری'),
          contractStart: date('contract_start', 'آغاز قرارداد'), contractEnd: date('contract_end', 'پایان قرارداد'),
          depositAmount: amount('deposit', 'مبلغ ودیعه'), rentAmount: amount('rent', 'مبلغ اجاره'), rentPeriod: (period || 'MONTHLY') as 'MONTHLY',
          rentDueDay: int('rent_due_day', 'روز سررسید اجاره'), rentMethodCode: pick('PAYMENT_METHOD', 'rent_method', 'نحوهٔ پرداخت اجاره'),
          chargeAmount: amount('charge', 'شارژ ماهیانه'), chargeDueDay: int('charge_due_day', 'روز سررسید شارژ'), chargeMethodCode: pick('PAYMENT_METHOD', 'charge_method', 'نحوهٔ پرداخت شارژ'),
          installPlannedAt: date('install_planned', 'تاریخ برنامهٔ نصب'), installCost: amount('install_cost', 'هزینهٔ نصب'), transportCost: amount('transport_cost', 'هزینهٔ حمل'),
          notes: text('notes') || null,
        };
        res.label = candidate.name;
        const parsed = siteProjectCreateSchema.safeParse(candidate);
        if (!parsed.success) zodErrors(parsed.error.issues);
        const code = text('code');
        const existing = code ? await tx.siteProject.findFirst({ where: { organizationId: actor.organizationId, code } }) : null;
        if (code && !existing) res.errors.push(`پروژه‌ای با کد «${code}» نیست.`);
        if (existing && input.mode === 'CREATE') res.errors.push(`کد «${code}» از آنِ پروژه‌ای ثبت‌شده است.`);
        if (existing && !['DRAFT', 'EVALUATION', 'NEGOTIATION', 'TERMS_AGREED'].includes(existing.state)) res.errors.push('شرایط پروژه‌ای که قراردادش فرستاده یا تأیید شده، از اکسل تغییر نمی‌کند.');
        if (!res.errors.length && parsed.success) {
          res.action = existing ? 'UPDATE' : 'CREATE';
          res.code = existing?.code ?? null;
          if (write) {
            const { rentPeriod, ...rest } = parsed.data;
            const data = { ...rest, rentPeriod, currency: existing?.currency };
            if (existing) {
              const after = await tx.siteProject.update({ where: { id: existing.id }, data: { ...data, currency: existing.currency, updatedById: actor.id, version: { increment: 1 } } });
              await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'IMPORT', entityType: 'siteProject', entityId: existing.id, before: existing, after, reason: `ورود از اکسل: ${input.fileName}، ردیف ${r.row}` }, tx as Tx);
            } else {
              const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { currency: true } });
              const made = await tx.siteProject.create({ data: { ...data, organizationId: actor.organizationId, code: await nextCode(tx as Tx, 'siteProject'), currency: org.currency, createdById: actor.id } });
              res.code = made.code;
              await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'IMPORT', entityType: 'siteProject', entityId: made.id, after: made, reason: `ورود از اکسل: ${input.fileName}، ردیف ${r.row}` }, tx as Tx);
            }
          }
        }
      }

      if (input.kind === 'OBLIGATIONS') {
        const project = await tx.siteProject.findFirst({ where: { organizationId: actor.organizationId, code: text('project_code') }, select: { id: true, name: true, state: true, currency: true } });
        if (!project) res.errors.push(`پروژه‌ای با کد «${text('project_code')}» نیست.`);
        else if (['CLOSED', 'CANCELLED'].includes(project.state)) res.errors.push('پروژه بسته یا لغو شده است.');
        const kind = text('kind').toUpperCase();
        const kindByLabel = OBLIGATION_KINDS.find((k) => k === kind || nameKey(OBLIGATION_KIND_LABELS[k].fa) === nameKey(text('kind')));
        const parsed = obligationSchema.safeParse({
          kind: kindByLabel ?? kind, categoryCode: pick('CHARGE_CATEGORY', 'category', 'دستهٔ هزینه'), description: text('description') || null,
          dueDate: date('due_date', 'تاریخ سررسید'), amount: amount('amount', 'مبلغ') ?? '', periodStart: date('period_start', 'آغاز دوره'), periodEnd: date('period_end', 'پایان دوره'),
        });
        res.label = `${project?.name ?? text('project_code')} — ${text('kind')}`;
        if (!parsed.success) zodErrors(parsed.error.issues);
        if (!res.errors.length && parsed.success && project) {
          res.action = 'CREATE';
          if (write) {
            const o = await tx.siteObligation.create({ data: { ...parsed.data, organizationId: actor.organizationId, siteProjectId: project.id, currency: project.currency, source: 'IMPORT', createdById: actor.id } });
            await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'IMPORT', entityType: 'siteObligation', entityId: o.id, after: o, reason: `ورود از اکسل: ${input.fileName}، ردیف ${r.row}` }, tx as Tx);
          }
        }
      }

      outcome.rows.push(res);
    }
    outcome.created = outcome.rows.filter((x) => x.action === 'CREATE').length;
    outcome.updated = outcome.rows.filter((x) => x.action === 'UPDATE').length;
    outcome.failed = outcome.rows.filter((x) => x.action === 'ERROR').length;
  };

  if (input.dryRun) {
    await work(prisma, false, null);
    return outcome;
  }
  // First the check, outside any transaction; then, if the person accepts what will be skipped, the write.
  await work(prisma, false, null);
  if (outcome.failed && !input.skipInvalid) {
    throw conflict('IMPORT_HAS_ERRORS', `${outcome.failed} ردیف خطا دارد. آن‌ها را درست کنید، یا با تأیید «ردیف‌های خطادار کنار گذاشته شوند» ثبت کنید.`, { failed: outcome.failed });
  }
  if (!outcome.created && !outcome.updated) throw conflict('IMPORT_EMPTY', 'ردیف درستی برای ثبت نیست.');
  const sha = createHash('sha256').update(input.buffer).digest('hex');
  await prisma.$transaction(async (tx) => {
    const batch = await tx.siteImport.create({
      data: {
        organizationId: actor.organizationId, kind: input.kind, mode: input.mode, fileName: input.fileName.slice(0, 200), fileSha256: sha,
        totalRows: rows.length, created: 0, updated: 0, failed: 0, report: [], createdById: actor.id,
      },
    });
    await work(tx, true, batch.id);
    await tx.siteImport.update({
      where: { id: batch.id },
      data: { created: outcome.created, updated: outcome.updated, failed: outcome.failed, report: outcome.rows.slice(0, 2000) as unknown as Prisma.InputJsonValue },
    });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, ipAddress: actor.ipAddress ?? null, requestId: actor.requestId ?? null,
      action: 'IMPORT_COMMITTED', entityType: 'siteImport', entityId: batch.id,
      after: { kind: input.kind, mode: input.mode, fileName: input.fileName, sha256: sha, rows: rows.length, created: outcome.created, updated: outcome.updated, skipped: outcome.failed },
    }, tx);
    outcome.importId = batch.id;
  }, { timeout: 5 * 60_000, maxWait: 30_000 });
  return outcome;
}

/* ── templates and exports ───────────────────────────────────────────────── */

const RTL = { views: [{ rightToLeft: true, state: 'frozen' as const, ySplit: 1 }] };

/** An empty sheet of the kind's columns, and a second sheet saying what each takes. */
export async function templateFor(organizationId: string, kind: ImportKind): Promise<Buffer> {
  const options = await optionsOf(organizationId);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Hivamis';
  const sheet = wb.addWorksheet(IMPORT_KIND_LABELS[kind].fa.slice(0, 31), RTL);
  sheet.columns = IMPORT_COLUMNS[kind].map((c) => ({ header: c.fa, key: c.key, width: Math.max(14, c.fa.length + 6) }));
  sheet.getRow(1).font = { bold: true };
  const guide = wb.addWorksheet('راهنما', { views: [{ rightToLeft: true }] });
  guide.columns = [{ header: 'ستون', width: 24 }, { header: 'کلید', width: 18 }, { header: 'الزامی', width: 10 }, { header: 'مقدارهای مجاز / توضیح', width: 90 }];
  guide.getRow(1).font = { bold: true };
  for (const c of IMPORT_COLUMNS[kind]) {
    const allowed = c.list ? options.filter((o) => o.list === c.list && o.isActive).map((o) => `${o.labelFa} (${o.code})`).join('، ') : '';
    guide.addRow([c.fa, c.key, c.required ? 'بله' : '', [allowed, c.hint].filter(Boolean).join(' — ')]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface ExportColumn<T> { header: string; key: string; width?: number; value: (row: T) => string | number | Date | null | undefined; money?: boolean }

/**
 * A sheet streamed as it is written: rows are fetched page by page and committed one at a time, so a
 * long register leaves the server as it is read, not after it is all in memory.
 */
export function streamWorkbook<T>(title: string, columns: ExportColumn<T>[], pages: AsyncIterable<T[]>): PassThrough {
  const out = new PassThrough();
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: false });
  const sheet = wb.addWorksheet(title.slice(0, 31), RTL);
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 18, style: c.money ? { numFmt: '#,##0.##' } : {} }));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).commit();
  (async () => {
    for await (const page of pages) {
      for (const row of page) {
        const values: Record<string, unknown> = {};
        for (const c of columns) {
          const v = c.value(row);
          values[c.key] = typeof v === 'string' ? safeText(v) : v ?? null;
        }
        sheet.addRow(values).commit();
      }
    }
    sheet.commit();
    await wb.commit();
  })().catch((e) => out.destroy(e as Error));
  return out;
}
