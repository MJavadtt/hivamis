/**
 * Mizito and the owner's client sheet, read for a move into Hivamis (2026-10-28).
 *
 * The export is what Mizito's own screens read, saved from the owner's browser: its members (and those
 * it removed), client files, projects, every task open or done, and the comments posted on them. The
 * sheet ("Hiva-Project Mangement") is the owner's register: a code for each client (H1001) and for each
 * project (H1001-01), the industry, the account manager, the status. Both are joined here — a client by
 * its code, a project by its client and its name — into the shape migration.ts writes.
 *
 * A second file (2026-10-30, `mizito-extra/1`) brings what the first left out: Mizito's labels — on a
 * client its account manager, on a project its status («در حال مذاکره», «بلاتکلیف», «رد شده»), whether it
 * is the agency's own, and its account manager — each project's phases, and the sales deals.
 *
 * What it cannot know it does not guess silently: every choice it makes for a person (unit and roles
 * from the job title), a project (its client from "client | project"), or a row it could not place is
 * said in `notes`, for the administrator to read before committing.
 */
import type { DepartmentCode, RoleCode } from '@hiva/contracts';
import { dateOf } from './importers.js';
import { nameKey, suggestUnit } from './units.js';
import type { MigClient, MigComment, MigContact, MigOpportunity, MigPerson, MigProject, MigProjectState, MigTask, Migration } from './migration.js';
import type { OpportunityState } from '@hiva/contracts';

type Id = string;
interface MzUser { _id: Id; first_name?: string; last_name?: string; email?: string; phone_email?: string; role?: number; workspace_role_name?: string; deleted?: boolean }
interface MzPhone { label?: string; phone_number?: string }
interface MzRepresentative { name?: string; first_name?: string; last_name?: string; position?: string; title?: string; mobile?: unknown; phone?: unknown; phone_number?: string; email?: string }
interface MzCustomer {
  _id: Id; title?: string; name?: string; short_name?: string; national_code?: string; economic_code?: string; postal_code?: string;
  address?: string; email?: string; fax?: string; website?: string; notes?: string; archived?: boolean; deleted?: boolean;
  phone?: MzPhone[]; mobile?: MzPhone[]; representatives?: MzRepresentative[]; customer_admins?: Id[]; labels?: Id[]; created_at?: string;
}
interface MzProject { _id: Id; title?: string; owner?: Id; archived?: boolean; deleted?: boolean; labels?: Id[] }
interface MzChecklist { title?: string; checked?: boolean }
interface MzTask {
  _id: Id; title?: string; notes?: string; owner?: Id; assignee?: Id[]; responsible?: Id[]; progress?: number; created_at?: string | number;
  completed?: boolean; completed_at?: string | number | null; deadline?: string | number | null; has_deadline?: boolean; project?: Id;
  deleted?: boolean; checklist?: MzChecklist[]; kanban_board?: Id | null;
}
interface MzComment { id: Id; task?: Id | null; project: Id; from?: Id; date?: string | number; text?: string }
export interface MizitoExport {
  format: 'mizito-raw/1'; exportedAt?: string; users: MzUser[]; removedUsers?: MzUser[]; projects: MzProject[];
  tasks: MzTask[]; customers: MzCustomer[]; comments: MzComment[]; messages?: MzComment[];
}
export interface SheetExport { format: 'sheet-raw/1'; clients: string[][]; projects: string[][] }
interface MzLabel { _id: Id; title: string; deleted?: boolean }
interface MzDeal {
  _id: Id; title?: string; comments?: string; price?: number | null; probability?: number; customer?: Id; labels?: Id[];
  tracking_user?: Id | null; owner?: Id; invoice_date?: string | null; created_at?: string; attachments?: number;
}
/** What the first export left out: the labels, each project's labels and phases, and the sales deals. */
export interface MizitoExtra {
  format: 'mizito-extra/1'; exportedAt?: string;
  labels: { project?: MzLabel[]; crm?: MzLabel[]; deal?: MzLabel[]; task?: MzLabel[] };
  projects: { _id: Id; labels?: Id[]; members_admin?: Id[]; kanban_boards?: { _id: Id; title: string }[] }[];
  deals: MzDeal[];
}

/** A name as it is compared: Arabic presentation forms unfolded, diacritics and spacing gone. */
export const key = (s: string) => nameKey(s.normalize('NFKC').replace(/[ً-ٰٟ‏‎]/g, '').replace(/\s*\((آرشیو شده|آرشیو)\)\s*/g, ' '));
const clean = (s: string | null | undefined) => {
  const v = (s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return v && v !== 'undefined' && v !== '`' ? v : null;
};
const ARCHIVED = /\((آرشیو شده|آرشیو)\)/g;
/** A title with no "client |" that is the agency's own: its units, meetings, office, channels and proposals. */
const INTERNAL = /هیوا|^(واحد|پارتنر ?شیپ|گروه داخلی|جلسات|مدیریت|مدیران|امور|خرید|پروژه عمومی|پارتنرشیپ|سایر وظایف|ارتباط با مشتریان|پیام ?رسان|شرکت های در حال مذاکره|کد ?گذاری|درخواست نمونه کار|طراحی پروپوزال|آماده سازی پروپوزال|اعلام لیست خدمات|تحلیل بازار)/;
/** The work a title names before its client: «سئو سایت هامرز» is Hammers' site, «تبلیغات باشگاه استقلال» the club's. */
const WORK = /^(اجرای تبلیغات|تبلیغات|تصویر ?برداری|عکاسی|سئو سایت|گوگل ادز|لوگو|برندینگ|برند|پروژه|پروره|بیلبورد(های|ها)?|ایونت|برگزاری|شرکت) +/;
/** A typo, not another name: one letter apart, two for a long name. */
const typo = (a: string, b: string) => near(a, b) <= (Math.max(a.length, b.length) >= 8 ? 2 : 1);
/** How many letters apart two names are (Levenshtein). */
export function near(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}
const when = (v: string | number | null | undefined): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/* ── people: a unit and roles from the job title, said in the notes ── */

/** Before the onboarding's own suggestions: the titles Mizito's members carry. */
const UNIT_WORDS: [DepartmentCode, string[]][] = [
  ['FI', ['مالی', 'حسابداری']],
  ['CR', ['عکس', 'تصویربرداری', 'تدوین', 'ایدهواجرا', 'رابط', 'تجربهکاربری', 'معماری', 'گرافیک', 'خلاقیت']],
  ['ME', ['ooh', 'btl', 'رسانه', 'محیطی']],
  ['OP', ['ترافیک', 'عملیات']],
  ['M', ['قائممقام', 'مدیرعامل', 'منابعانسانی', 'دفترمدیریت', 'مشاور', 'اداری']],
];
export function unitFor(title: string | null): DepartmentCode {
  if (!title) return 'OP';
  const k = key(title);
  return UNIT_WORDS.find(([, words]) => words.some((w) => k.includes(w)))?.[0] ?? suggestUnit(title) ?? 'OP';
}
/** Never the system administrator's: that is given one person at a time, in the app. */
export function rolesFor(title: string | null): RoleCode[] {
  const k = title ? key(title) : '';
  const head = k.startsWith('مدیر') || k.startsWith('معاون') || k.startsWith('سرپرست');
  if (k.includes('قائممقام')) return ['DEPUTY'];
  if (k.includes('مدیرعامل')) return ['CEO'];
  if (k.includes('مالی') || k.includes('حسابداری')) return [head ? 'FINANCE_MANAGER' : 'FINANCE_SPECIALIST'];
  if (k.includes('امورمشتریان') || k.includes('اکانت')) return [head ? 'ACCOUNT_MANAGER' : 'ACCOUNT_EXEC'];
  if (k.includes('فروش')) return [head ? 'SALES_MANAGER' : 'SALES_REP'];
  if (head) return ['UNIT_MANAGER'];
  if (k.includes('مشاور')) return ['VIEWER'];
  return ['UNIT_MEMBER'];
}
/* ── what Mizito's labels mean, as the owner's workspace uses them (read 2026-10-30) ── */

/** A project's status label. All of them sit on archived projects: the state the work was in when filed away. */
const PROJECT_STATUS: Record<string, 'NEGOTIATION' | 'ON_HOLD' | 'REJECTED' | 'ACTIVE' | 'DONE'> = {
  [key('پروژه های در حال مذاکره')]: 'NEGOTIATION', [key('غیر فعال( بلاتکلیف)')]: 'ON_HOLD', [key('پروژه رد شده')]: 'REJECTED',
  [key('پروژه های فعال')]: 'ACTIVE', [key('پروژه های انجام شده')]: 'DONE',
};
/** Labels that file a project as the agency's own — believed only when its title names no client («نفت سپاهان» carries one). */
const INTERNAL_LABELS = new Set(['واحدهای داخلی هیوا', 'تیم های داخلی هیوا', 'امور داخلی هیوا'].map(key));
/** A deal's stage is its probability: 10 to 90 per cent, 100 «موفقیت کامل», 0 «عدم موفقیت». */
const DEAL_STAGE: [number, OpportunityState][] = [[100, 'WON'], [75, 'NEGOTIATION'], [60, 'PROPOSAL'], [40, 'BRIEF_REQUESTED'], [20, 'QUALIFIED'], [1, 'NEW'], [0, 'LOST']];
const stageOf = (p: number | undefined) => DEAL_STAGE.find(([at]) => (p ?? 10) >= at)![1];
/** The deal labels that say why a sale was lost; the others say where it came from. */
const LOSS = new Set(['قیمت', 'انتخاب رقیب', 'لغو پروژه', 'عدم اولویت', 'عدم تطابق نیاز', 'رد شدن پیشنهاد ارائه شده', 'عدم پیگیری تیم فروش'].map(key));
/** A project's phase names the unit of its tasks; one named for a person or a step («Doing», «نشده‌ها») does not. */
const PHASE_WORDS: [DepartmentCode, string[]][] = [
  ['A', ['اکانت', 'امورمشتریان']], ['ST', ['استراتژی']], ['DM', ['دیجیتال']], ['ME', ['رسانه']],
  ['CR', ['آتلیه', 'خلاقیت', 'خلاقه', 'ویدیو', 'ویدئو']], ['FI', ['مالی']], ['S', ['فروش']],
];
const phaseUnit = (title: string | undefined) => {
  const k = title ? key(title) : '';
  return k ? PHASE_WORDS.find(([, words]) => words.some((w) => k.includes(w)))?.[0] ?? null : null;
};
/** The same work under two names: equal, a typo apart, one inside the other, or mostly the same words («بیلبوردهای قشم», «بیلبورد قشم»). */
export function similar(a: string, b: string): boolean {
  const [x, y] = [key(a), key(b)];
  if (x.length < 2 || y.length < 2) return false;
  if (x === y || typo(x, y) || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)))) return true;
  const words = (s: string) => s.normalize('NFKC').split(/[\s\-–—_/|،,()]+/).map(key).filter((w) => w.length >= 3);
  const [wa, wb] = [words(a), words(b)];
  const same = (u: string, v: string) => u === v || typo(u, v) || (Math.min(u.length, v.length) >= 4 && (u.startsWith(v) || v.startsWith(u)));
  const hits = wa.filter((u) => wb.some((v) => same(u, v))).length;
  return hits >= 2 && hits / Math.max(wa.length, wb.length) >= 0.6;
}
/** The sheet's dates: «1403/12/05», or a month alone — «403/12», «1403/12» — taken as its first day. */
const sheetDate = (s: string | undefined) => {
  const v = clean(s)?.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  if (!v) return null;
  const month = /^(\d{3,4})\/(\d{1,2})$/.exec(v);
  return month ? dateOf(`${month[1]!.length === 3 ? `1${month[1]}` : month[1]}/${month[2]}/01`) : dateOf(v);
};

const fullName = (u: { first_name?: string; last_name?: string; name?: string }) => clean(u.name) ?? clean(`${u.first_name ?? ''} ${u.last_name ?? ''}`) ?? '';
const phoneOf = (v: unknown): string | null => {
  if (!v) return null;
  if (typeof v === 'string') return clean(v);
  if (Array.isArray(v)) return phoneOf(v[0]);
  return clean((v as MzPhone).phone_number);
};

export function fromMizito(mz: MizitoExport, sheet: SheetExport | null, extra: MizitoExtra | null = null): Migration {
  const notes: string[] = [];
  const note = (s: string) => notes.push(s);
  const labelTitle = new Map(Object.values(extra?.labels ?? {}).flat().map((l) => [l._id, clean(l.title) ?? '']));
  const labelsOf = (ids: Id[] | undefined) => (ids ?? []).map((id) => labelTitle.get(id)).filter((t): t is string => !!t);
  const projectExtra = new Map((extra?.projects ?? []).map((p) => [p._id, p]));

  /* people */
  const people: MigPerson[] = [];
  const seenPeople = new Set<Id>();
  /** A removed account of someone still here under the same name («نگین هاتفی» twice): their history is theirs. */
  const alias = new Map<Id, string>();
  const named = new Map<string, string>();
  for (const [list, removed] of [[mz.users, false], [mz.removedUsers ?? [], true]] as const) {
    for (const u of list) {
      if (seenPeople.has(u._id)) continue;
      seenPeople.add(u._id);
      const name = fullName(u);
      if (!name) continue;
      if (removed && named.has(key(name))) { alias.set(u._id, named.get(key(name))!); continue; }
      named.set(key(name), `user:${u._id}`);
      const title = clean(u.workspace_role_name);
      const email = clean(u.email) ?? (u.phone_email?.includes('@') ? clean(u.phone_email) : null);
      const phone = u.phone_email && !u.phone_email.includes('@') ? clean(u.phone_email) : null;
      people.push({ ref: `user:${u._id}`, fullName: name, email: email?.toLowerCase() ?? null, phone, jobTitle: title, unit: unitFor(title), roles: removed ? ['VIEWER'] : rolesFor(title), removed: removed || !!u.deleted });
    }
  }
  const personByName = new Map(people.map((p) => [key(p.fullName), p.ref]));
  const userRef = (id: Id | null | undefined) => (id ? alias.get(id) ?? (seenPeople.has(id) ? `user:${id}` : null) : null);
  if (alias.size) note(`${alias.size} حساب حذف‌شده در میزیتو از آنِ همکاری بود که هنوز هست؛ سابقه‌اش به نام همان همکار آمد`);
  const nameOfRef = new Map(people.map((p) => [p.ref, p.fullName]));
  /** The person a label or a cell names: the same name, else the only one whose name holds it («مهندس قاسم زاده»). */
  const personFor = (name: string | null | undefined): string | null => {
    const raw = clean(name);
    if (!raw) return null;
    const exact = personByName.get(key(raw));
    if (exact) return exact;
    const bare = key(raw.replace(/^(مهندس|دکتر|خانم|آقای|آقا)\s+/, ''));
    if (bare.length < 4) return null;
    const hits = people.filter((p) => key(p.fullName).includes(bare) || typo(key(p.fullName), bare));
    const present = hits.filter((p) => !p.removed);
    return (hits.length === 1 ? hits[0] : present.length === 1 ? present[0] : null)?.ref ?? null;
  };
  const NO_ACCOUNT = key('بدون اکانت');

  /* clients: Mizito's files, joined to the sheet's rows by code */
  const clients = new Map<string, MigClient>();
  const codeOf = (s: string | null | undefined) => (s ?? '').match(/H\d{4}/)?.[0] ?? null;
  // The sheet says whose a code is: where Mizito files two clients under one code, the one the sheet names keeps it.
  const sheetName = new Map((sheet?.clients ?? []).map((r) => [codeOf(r[0]), key(r[1] ?? '')] as const).filter(([c]) => c));
  const strays: { client: MigClient; id: Id }[] = [];
  /** Which client each Mizito file became — its deals follow it there. */
  const clientOfFile = new Map<Id, string>();
  let unknownAccounts = 0;
  for (const c of mz.customers) {
    if (c.deleted) continue;
    let code = codeOf(c.title) ?? codeOf(c.name);
    // Mizito files a client under its code (name and title "H1016") and keeps the name people use in short_name.
    const own = (s: string | undefined) => clean(s)?.replace(/\s*-?\s*H\d{4}\s*$/, '').trim() || null;
    const legalName = own(c.name) ?? own(c.short_name) ?? own(c.title) ?? '';
    if (!legalName) { note(`پرونده‌ای در میزیتو بی‌نام ماند (${c.title ?? c._id})`); continue; }
    if (code && sheetName.has(code) && !typo(sheetName.get(code)!, key(legalName)) && sheetName.get(code) !== key(legalName)) {
      note(`در میزیتو «${legalName}» با کد ${code} ثبت شده، ولی آن کد در فایل مشتریان از آنِ دیگری است؛ بی‌کد وارد می‌شود`);
      code = null;
    }
    let ref = code ? `client:${code}` : `client:mz:${c._id}`;
    if (clients.has(ref)) {
      note(`کد ${code} در میزیتو دو پرونده دارد؛ «${clients.get(ref)!.legalName}» کد را نگه داشت و «${legalName}» بی‌کد وارد می‌شود`);
      code = null; ref = `client:mz:${c._id}`;
    }
    const phones = [...(c.phone ?? []), ...(c.mobile ?? [])].map((p) => clean(p.phone_number)).filter((p): p is string => !!p);
    const more = [
      clean(c.notes),
      phones.length > 1 ? `تلفن‌های دیگر: ${phones.slice(1).join('، ')}` : null,
      clean(c.fax) ? `فکس: ${clean(c.fax)}` : null,
      c.archived ? 'در میزیتو بایگانی شده بود' : null,
    ].filter(Boolean);
    // The account manager is the file's label in Mizito («ملیکا لطفی», or «بدون اکانت»); who may edit the file is not.
    const accounts = labelsOf(c.labels).filter((l) => key(l) !== NO_ACCOUNT);
    const accountOwnerRef = accounts.map(personFor).find(Boolean) ?? null;
    if (accounts.length && !accountOwnerRef) unknownAccounts++;
    const contacts: MigContact[] = (c.representatives ?? []).map((r) => ({
      fullName: fullName(r), jobTitle: clean(r.position) ?? clean(r.title), phone: phoneOf(r.mobile) ?? phoneOf(r.phone) ?? clean(r.phone_number), email: clean(r.email),
    })).filter((r) => r.fullName);
    const client: MigClient = {
      ref, code, legalName, brandName: own(c.short_name) && own(c.short_name) !== legalName ? own(c.short_name) : null, industry: null,
      nationalId: clean(c.national_code), economicCode: clean(c.economic_code), postalCode: clean(c.postal_code), phone: phones[0] ?? null,
      email: clean(c.email), website: clean(c.website), address: clean(c.address), notes: more.length ? more.join('\n') : null,
      accountOwnerRef, contacts, createdAt: when(c.created_at),
    };
    if (code) { clients.set(ref, client); clientOfFile.set(c._id, ref); } else strays.push({ client, id: c._id });
  }
  if (unknownAccounts) note(`${unknownAccounts} پرونده اکانتی داشت که در اعضای میزیتو پیدا نشد؛ اکانتشان خالی ماند`);
  const sheetClients = sheet?.clients ?? [];
  for (const row of sheetClients) {
    const [rawCode, rawName, industry, coop, status, since, until, website] = row;
    const code = codeOf(rawCode);
    const name = clean(rawName);
    if (!name) continue;
    const ref = code ? `client:${code}` : `client:sheet:${key(name)}`;
    const facts = [clean(coop) && `وضعیت همکاری: ${clean(coop)}`, clean(status) && `وضعیت: ${clean(status)}`, clean(since) && `شروع همکاری: ${clean(since)}`, clean(until) && `پایان همکاری: ${clean(until)}`].filter(Boolean).join(' · ');
    const usable = (s: string | null) => (s && s.length > 2 ? s : null);
    const known = clients.get(ref);
    if (known) {
      known.industry = usable(clean(industry)) ?? known.industry;
      known.website = known.website ?? clean(website);
      if (facts) known.notes = [known.notes, facts].filter(Boolean).join('\n');
      if (key(known.legalName) !== key(name) && !known.brandName) known.brandName = name;
      continue;
    }
    clients.set(ref, {
      ref, code, legalName: name, brandName: null, industry: usable(clean(industry)), nationalId: null, economicCode: null, postalCode: null,
      phone: null, email: null, website: clean(website), address: null, notes: facts || null, accountOwnerRef: null, contacts: [], createdAt: null,
    });
  }
  // A file without its code: a second file of a client already here is folded into it; anyone else comes in uncoded.
  for (const { client: s, id } of strays) {
    const all = [...clients.values()];
    const same = all.find((c) => key(c.legalName) === key(s.legalName)) ?? all.find((c) => typo(key(c.legalName), key(s.legalName)));
    clientOfFile.set(id, same?.ref ?? s.ref);
    if (!same) { clients.set(s.ref, s); continue; }
    same.accountOwnerRef = same.accountOwnerRef ?? s.accountOwnerRef;
    same.notes = [same.notes, s.notes, `پروندهٔ دیگری در میزیتو با همین نام به این مشتری پیوست`].filter(Boolean).join('\n');
    same.contacts.push(...s.contacts.filter((ct) => !same.contacts.some((x) => key(x.fullName) === key(ct.fullName))));
    for (const f of ['phone', 'email', 'website', 'address', 'nationalId', 'economicCode', 'postalCode'] as const) same[f] = same[f] ?? s[f];
    note(`پروندهٔ دوم «${s.legalName}» در میزیتو با «${same.legalName}»${same.code ? ` (${same.code})` : ''} یکی شد`);
  }

  // The agency itself: the client of its own projects (Mizito's units, office, hiring).
  const agency = [...clients.values()].find((c) => c.code === 'H1001') ?? [...clients.values()].find((c) => key(c.legalName).includes('هیوا'));
  const index = [...clients.values()].flatMap((c) => [c.legalName, c.brandName].filter((n): n is string => !!n).map((n) => ({ k: key(n), ref: c.ref })));
  /** The client a project's "client | …" names: the same name, else the closest one that contains it or is contained. */
  const findClient = (text: string): string | null => {
    const k = key(text);
    if (k.length < 2) return null;
    const exact = index.find((x) => x.k === k);
    if (exact) return exact.ref;
    const containing = index.filter((x) => x.k.length >= 3 && k.length >= 3 && (x.k.includes(k) || k.includes(x.k)))
      .sort((a, b) => Math.abs(a.k.length - k.length) - Math.abs(b.k.length - k.length));
    if (containing[0]) return containing[0].ref;
    // A letter or two apart — «وزرات ارشاد» for «وزارت ارشاد», «خوردو» for «خودرو».
    return index.filter((x) => typo(x.k, k)).sort((a, b) => near(a.k, k) - near(b.k, k))[0]?.ref ?? null;
  };

  /* sales deals: each an opportunity of its client, in the stage Mizito left it */
  const opportunities: MigOpportunity[] = [];
  /** A deal is titled like a project, «بیمه البرز | رسانه | cip فرودگاه»: the work is what follows its client. */
  const work = (o: MigOpportunity) => (o.title.includes('|') ? [o.title.split('|').slice(1).join(' '), o.title.split('|').at(-1)!] : [o.title]).map((t) => t.trim()).filter(Boolean);
  for (const d of extra?.deals ?? []) {
    const title = clean(d.title) ?? 'فرصت بی‌نام';
    const clientRef = d.customer ? clientOfFile.get(d.customer) : undefined;
    if (!clientRef || !clients.has(clientRef)) { note(`فرصت «${title}» پروندهٔ مشتری‌اش را نداشت و وارد نمی‌شود`); continue; }
    const state = stageOf(d.probability);
    const labels = labelsOf(d.labels);
    const loss = labels.filter((l) => LOSS.has(key(l)));
    const from = labels.filter((l) => !LOSS.has(key(l)));
    // Mizito counts a deal's value in toman; this organisation counts in rials.
    const toman = d.price ?? 0;
    const stage = d.probability === 100 ? 'موفقیت کامل' : d.probability === 0 ? 'عدم موفقیت' : `${d.probability ?? 10}٪`;
    opportunities.push({
      ref: `deal:${d._id}`, title, clientRef, value: toman * 10, state, ownerRef: userRef(d.tracking_user) ?? userRef(d.owner),
      description: [
        clean(d.comments), `مرحله در میزیتو: ${stage}`, toman ? `ارزش در میزیتو: ${toman.toLocaleString('fa-IR')} تومان` : null,
        from.length ? `منبع: ${from.join('، ')}` : null, d.attachments ? `${d.attachments} پیوست در میزیتو ماند` : null,
      ].filter(Boolean).join('\n'),
      lostReason: state === 'LOST' ? loss.join('، ') || 'در میزیتو دلیلی ثبت نشده بود' : null,
      wonAt: state === 'WON' ? when(d.invoice_date) ?? when(d.created_at) : null,
      expectedCloseDate: state === 'WON' || state === 'LOST' ? null : when(d.invoice_date), createdAt: when(d.created_at),
    });
  }

  /* projects: Mizito's, then the sheet's rows joined to them or added */
  const projects = new Map<string, MigProject & { clientName: string }>();
  const madeClients = new Map<string, string>();
  const creatorOf = new Map<string, string | null>();
  const worked = new Set([...mz.tasks.filter((t) => !t.deleted).map((t) => t.project), ...mz.comments.map((c) => c.project), ...(mz.messages ?? []).map((c) => c.project)]);
  let emptyWorkspaces = 0;
  for (const p of mz.projects) {
    if (p.deleted || !p.title) continue;
    const archived = !!p.archived || p.title.search(ARCHIVED) >= 0;
    const title = clean(p.title.replace(ARCHIVED, ''))!;
    const [head, ...rest] = title.split('|');
    const named = rest.length ? clean(head) : null;
    const name = (rest.length ? clean(rest.join('|')) : title) ?? title;
    const labels = labelsOf(projectExtra.get(p._id)?.labels ?? p.labels);
    const status = labels.map((l) => PROJECT_STATUS[key(l)]).find(Boolean) ?? null;
    const internalLabel = labels.some((l) => INTERNAL_LABELS.has(key(l)));
    // Without "client |", the title is the client's work («دیجی کالا», «سئو سایت هامرز») unless it is the agency's own:
    // by its words, or by its label when it names no client.
    const own = INTERNAL.test((named ?? title).replace(/\u200c/g, ' ')) || (!named && (internalLabel || personByName.has(key(title))));
    const clientName = own ? null : named ?? clean(title.replace(WORK, ''));
    let clientRef = named ? findClient(named) : findClient(name) ?? (clientName ? findClient(clientName) : null);
    if (!clientRef && clientName) {
      // A client the lists do not have, named by its projects: made once, from that name.
      const k = key(clientName);
      const madeAlready = [...madeClients.keys()].find((x) => x === k || typo(x, k) || (Math.min(x.length, k.length) >= 3 && (x.includes(k) || k.includes(x))));
      clientRef = madeAlready ? madeClients.get(madeAlready)! : `client:name:${k}`;
      if (!clients.has(clientRef)) {
        clients.set(clientRef, { ref: clientRef, code: null, legalName: clientName, brandName: null, industry: null, nationalId: null, economicCode: null, postalCode: null, phone: null, email: null, website: null, address: null, notes: 'از عنوان پروژه‌های میزیتو ساخته شد', accountOwnerRef: null, contacts: [], createdAt: null });
        madeClients.set(k, clientRef);
        note(`مشتری «${clientName}» در فهرست‌ها نبود؛ از عنوان پروژهٔ «${title}» ساخته شد`);
      }
    }
    if (!clientRef) { clientRef = agency?.ref ?? null; if (clientRef) note(`پروژهٔ «${title}» کار خود آژانس است و پروژهٔ داخلی آن شد`); }
    if (!clientRef) { note(`پروژهٔ «${title}» مشتری پیدا نکرد و وارد نمی‌شود`); continue; }
    const client = clients.get(clientRef)!;
    const internal = clientRef === agency?.ref;
    // A client's own workspace, filed away, named only for the client («شرکت شیرآلات کیان»), never used and with nothing
    // said of it: nothing to bring — the client itself comes all the same.
    const bare = clean(name.replace(/^(شرکت|پروژه|پروره) +/, '')) ?? name;
    if (!named && !internal && archived && !worked.has(p._id) && (!status || status === 'ACTIVE' || status === 'DONE')
      && [client.legalName, client.brandName].some((n) => n && [name, bare].some((x) => key(x) === key(n) || typo(key(x), key(n))))) {
      emptyWorkspaces++;
      continue;
    }
    const accountRef = labels.filter((l) => !PROJECT_STATUS[key(l)] && !INTERNAL_LABELS.has(key(l))).map(personFor).find(Boolean) ?? null;
    // The state the work was in: its label's when it has one; else closed if Mizito archived it, running if not.
    let state: MigProjectState = archived ? 'CLOSED' : 'ACTIVE';
    let stateReason: string | null = null;
    let opportunityRef: string | null = null;
    if (status === 'ON_HOLD') { state = 'ON_HOLD'; stateReason = 'در میزیتو «غیر فعال (بلاتکلیف)» بود'; }
    else if (status === 'DONE') state = 'CLOSED';
    else if ((status === 'NEGOTIATION' || status === 'REJECTED') && !internal) {
      // Not yet a project but a sale (the owner's answer, 2026-10-30): its opportunity — the deal of that name, when Mizito
      // has one — and a draft project that keeps its work.
      const rejected = status === 'REJECTED';
      const deals = opportunities.filter((o) => o.ref.startsWith('deal:') && o.clientRef === clientRef);
      const workspace = [client.legalName, client.brandName].some((n) => n && (key(n) === key(bare) || typo(key(n), key(bare))));
      const open = deals.filter((o) => o.state !== 'WON' && o.state !== 'LOST').sort((x, y) => (y.createdAt?.getTime() ?? 0) - (x.createdAt?.getTime() ?? 0));
      const lost = deals.filter((o) => o.state === 'LOST').sort((x, y) => (y.createdAt?.getTime() ?? 0) - (x.createdAt?.getTime() ?? 0));
      const deal = deals.find((o) => work(o).some((w) => similar(w, name))) ?? (workspace ? (rejected ? lost : open)[0] : undefined);
      opportunityRef = deal?.ref ?? `opportunity:project:${p._id}`;
      if (!deal) {
        opportunities.push({
          ref: opportunityRef, title: name, clientRef, value: 0, state: rejected ? 'LOST' : 'NEGOTIATION', ownerRef: accountRef ?? userRef(p.owner),
          description: `از پروژهٔ «${title}» در میزیتو، با برچسب «${rejected ? 'پروژه رد شده' : 'پروژه های در حال مذاکره'}»`,
          lostReason: rejected ? 'پروژه رد شد' : null, wonAt: null, expectedCloseDate: null, createdAt: null,
        });
      }
      if (rejected) { state = 'CANCELLED'; stateReason = 'در میزیتو «پروژه رد شده» بود'; } else state = 'DRAFT';
    }
    creatorOf.set(`project:${p._id}`, userRef(p.owner));
    projects.set(`project:${p._id}`, {
      ref: `project:${p._id}`, legacyRef: null, name, clientRef, clientName: client.legalName, accountOwnerRef: accountRef, state, stateReason,
      opportunityRef, plannedStart: null, plannedEnd: null, createdAt: null, closedAt: null,
    });
  }
  if (emptyWorkspaces) note(`${emptyWorkspaces} فضای میزیتو که فقط نام مشتری را داشت و نه کاری در آن بود و نه گفتگویی، وارد نشد`);
  const STATUS: Record<string, MigProjectState> = {
    [key('در حال انجام')]: 'ACTIVE', [key('شروع نشده')]: 'DRAFT', [key('تمام شده')]: 'CLOSED', [key('پایان یافته')]: 'CLOSED', [key('متوقف شده')]: 'ON_HOLD',
  };
  const joined = new Set<string>();
  const sheetAccounts = new Map<string, string[]>();
  for (const [line, row] of (sheet?.projects ?? []).entries()) {
    const [, rawClientCode, rawClientName, rawCode, rawName, , , account, status, start, end] = row;
    const name = clean(rawName);
    if (!name || key(name).length < 2) continue;
    const clientCode = codeOf(rawClientCode);
    const clientRef = (clientCode && clients.has(`client:${clientCode}`) ? `client:${clientCode}` : null) ?? (clean(rawClientName) ? findClient(rawClientName!) : null);
    if (!clientRef) { note(`ردیف پروژهٔ «${name}» در فایل مشتری‌اش (${rawClientName || rawClientCode || '—'}) را پیدا نکرد`); continue; }
    const code = clean(rawCode);
    const state = clean(status) ? STATUS[key(status!)] : undefined;
    if (clean(status) && !state) note(`وضعیت «${status}» برای «${name}» شناخته نشد؛ متوقف وارد می‌شود`);
    const owner = clean(account) ? personFor(account) : null;
    if (clean(account) && !owner) note(`اکانت «${account}» برای «${name}» در اعضای میزیتو نبود`);
    if (owner) sheetAccounts.set(clientRef, [...(sheetAccounts.get(clientRef) ?? []), owner]);
    const match = [...projects.values()].find((p) => !joined.has(p.ref) && !p.ref.startsWith('project:sheet:') && p.clientRef === clientRef && similar(p.name, name));
    const dates = { plannedStart: sheetDate(start), plannedEnd: sheetDate(end) };
    if (match) {
      joined.add(match.ref);
      Object.assign(match, { legacyRef: code ?? match.legacyRef, ...(state ? { state, stateReason: null } : {}), ...(owner ? { accountOwnerRef: owner } : {}), ...dates });
      continue;
    }
    // A row without its code is known by its place in the file — the same file run again finds it again.
    const ref = `project:sheet:${code ?? `row:${line + 2}`}`;
    if (projects.has(ref)) { note(`کد پروژهٔ ${code} در فایل دو بار آمده است؛ ردیف «${name}» وارد نمی‌شود`); continue; }
    // A row the sheet gives no status is on hold until someone says what it is (the owner's answer, 2026-10-30).
    projects.set(ref, {
      ref, legacyRef: code, name, clientRef, clientName: clients.get(clientRef)!.legalName, accountOwnerRef: owner, state: state ?? 'ON_HOLD',
      stateReason: state ? null : clean(status) ? `وضعیت «${clean(status)}» در فایل پروژه‌ها شناخته نشد` : 'وضعیتش در فایل پروژه‌ها خالی بود',
      opportunityRef: null, createdAt: null, closedAt: null, ...dates,
    });
  }
  if (joined.size) note(`${joined.size} ردیف فایل پروژه‌ها به پروژهٔ همان‌نامِ میزیتو پیوست`);
  // A client with no account label: the one its projects in the sheet name most.
  for (const [ref, owners] of sheetAccounts) {
    const c = clients.get(ref)!;
    c.accountOwnerRef ??= [...new Set(owners)].sort((a, b) => owners.filter((o) => o === b).length - owners.filter((o) => o === a).length)[0] ?? null;
  }
  for (const p of projects.values()) {
    // A project's account manager: its own label or sheet row, else its client's, else whoever made it in Mizito.
    p.accountOwnerRef ??= clients.get(p.clientRef)?.accountOwnerRef ?? creatorOf.get(p.ref) ?? null;
  }
  // A won deal is the sale its project came from, when exactly one project of its client carries its name.
  for (const o of opportunities) {
    if (o.state !== 'WON' || !o.ref.startsWith('deal:')) continue;
    const hits = [...projects.values()].filter((p) => p.clientRef === o.clientRef && !p.opportunityRef && work(o).some((w) => similar(p.name, w)));
    if (hits.length === 1) hits[0]!.opportunityRef = o.ref;
  }

  /* tasks and their history */
  const tasks: MigTask[] = [];
  const taskIds = new Set<string>();
  let orphans = 0;
  for (const t of mz.tasks) {
    if (t.deleted || !clean(t.title)) continue;
    const projectRef = `project:${t.project}`;
    if (!projects.has(projectRef)) { orphans++; continue; }
    const list = (t.checklist ?? []).filter((c) => clean(c.title)).map((c) => `${c.checked ? '☑' : '☐'} ${clean(c.title)}`);
    // Hivamis gives a task one doer; the others Mizito named are kept on it by name.
    const others = (t.assignee ?? []).slice(1).map((id) => nameOfRef.get(userRef(id) ?? '')).filter(Boolean);
    const description = [clean(t.notes), list.length ? list.join('\n') : null, others.length ? `همکاران دیگر در میزیتو: ${others.join('، ')}` : null]
      .filter(Boolean).join('\n\n') || null;
    tasks.push({
      ref: `task:${t._id}`, projectRef, title: clean(t.title)!, description, assigneeRef: userRef(t.assignee?.[0]) ?? userRef(t.responsible?.[0]),
      createdByRef: userRef(t.owner), createdAt: when(t.created_at), dueDate: t.has_deadline === false ? null : when(t.deadline),
      done: !!t.completed, doneAt: t.completed ? when(t.completed_at) : null, progress: t.progress ?? 0,
      unit: phaseUnit(projectExtra.get(t.project ?? '')?.kanban_boards?.find((b) => b._id === t.kanban_board)?.title),
    });
    taskIds.add(t._id);
  }
  if (orphans) note(`${orphans} وظیفه پروژه‌ای داشت که وارد نمی‌شود؛ آن‌ها هم وارد نمی‌شوند`);
  const comments: MigComment[] = [];
  for (const [list, kind] of [[mz.comments, 'comment'], [mz.messages ?? [], 'message']] as const) {
    for (const c of list) {
      const body = clean(c.text);
      if (!body || !projects.has(`project:${c.project}`)) continue;
      comments.push({ ref: `${kind}:${c.id}`, projectRef: `project:${c.project}`, taskRef: c.task && taskIds.has(c.task) ? `task:${c.task}` : null, authorRef: userRef(c.from), body, createdAt: when(c.date) });
    }
  }

  // A closed project's date: the last of its work, when it has any.
  for (const p of projects.values()) if (p.state === 'CLOSED') p.closedAt = tasks.filter((t) => t.projectRef === p.ref && t.doneAt).map((t) => t.doneAt!).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  return {
    source: 'mizito',
    people,
    clients: [...clients.values()],
    opportunities,
    projects: [...projects.values()].map(({ clientName: _c, ...p }) => p),
    tasks, comments, notes,
  };
}
