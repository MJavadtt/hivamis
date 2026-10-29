/**
 * Mizito and the owner's client sheet, read for a move into Hivamis (2026-10-28).
 *
 * The export is what Mizito's own screens read, saved from the owner's browser: its members (and those
 * it removed), client files, projects, every task open or done, and the comments posted on them. The
 * sheet ("Hiva-Project Mangement") is the owner's register: a code for each client (H1001) and for each
 * project (H1001-01), the industry, the account manager, the status. Both are joined here — a client by
 * its code, a project by its client and its name — into the shape migration.ts writes.
 *
 * What it cannot know it does not guess silently: every choice it makes for a person (unit and roles
 * from the job title), a project (its client from "client | project"), or a row it could not place is
 * said in `notes`, for the administrator to read before committing.
 */
import type { DepartmentCode, RoleCode } from '@hiva/contracts';
import { dateOf } from './importers.js';
import { nameKey, suggestUnit } from './units.js';
import type { MigClient, MigComment, MigContact, MigPerson, MigProject, MigProjectState, MigTask, Migration } from './migration.js';

type Id = string;
interface MzUser { _id: Id; first_name?: string; last_name?: string; email?: string; phone_email?: string; role?: number; workspace_role_name?: string; deleted?: boolean }
interface MzPhone { label?: string; phone_number?: string }
interface MzRepresentative { name?: string; first_name?: string; last_name?: string; position?: string; title?: string; mobile?: unknown; phone?: unknown; phone_number?: string; email?: string }
interface MzCustomer {
  _id: Id; title?: string; name?: string; short_name?: string; national_code?: string; economic_code?: string; postal_code?: string;
  address?: string; email?: string; fax?: string; website?: string; notes?: string; archived?: boolean; deleted?: boolean;
  phone?: MzPhone[]; mobile?: MzPhone[]; representatives?: MzRepresentative[]; customer_admins?: Id[];
}
interface MzProject { _id: Id; title?: string; owner?: Id; archived?: boolean; deleted?: boolean }
interface MzChecklist { title?: string; checked?: boolean }
interface MzTask {
  _id: Id; title?: string; notes?: string; owner?: Id; assignee?: Id[]; responsible?: Id[]; progress?: number; created_at?: string | number;
  completed?: boolean; completed_at?: string | number | null; deadline?: string | number | null; has_deadline?: boolean; project?: Id;
  deleted?: boolean; checklist?: MzChecklist[];
}
interface MzComment { id: Id; task?: Id | null; project: Id; from?: Id; date?: string | number; text?: string }
export interface MizitoExport {
  format: 'mizito-raw/1'; exportedAt?: string; users: MzUser[]; removedUsers?: MzUser[]; projects: MzProject[];
  tasks: MzTask[]; customers: MzCustomer[]; comments: MzComment[]; messages?: MzComment[];
}
export interface SheetExport { format: 'sheet-raw/1'; clients: string[][]; projects: string[][] }

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
const fullName = (u: { first_name?: string; last_name?: string; name?: string }) => clean(u.name) ?? clean(`${u.first_name ?? ''} ${u.last_name ?? ''}`) ?? '';
const phoneOf = (v: unknown): string | null => {
  if (!v) return null;
  if (typeof v === 'string') return clean(v);
  if (Array.isArray(v)) return phoneOf(v[0]);
  return clean((v as MzPhone).phone_number);
};

export function fromMizito(mz: MizitoExport, sheet: SheetExport | null): Migration {
  const notes: string[] = [];
  const note = (s: string) => notes.push(s);

  /* people */
  const people: MigPerson[] = [];
  const seenPeople = new Set<Id>();
  for (const [list, removed] of [[mz.users, false], [mz.removedUsers ?? [], true]] as const) {
    for (const u of list) {
      if (seenPeople.has(u._id)) continue;
      seenPeople.add(u._id);
      const name = fullName(u);
      if (!name) continue;
      const title = clean(u.workspace_role_name);
      const email = clean(u.email) ?? (u.phone_email?.includes('@') ? clean(u.phone_email) : null);
      const phone = u.phone_email && !u.phone_email.includes('@') ? clean(u.phone_email) : null;
      people.push({ ref: `user:${u._id}`, fullName: name, email: email?.toLowerCase() ?? null, phone, jobTitle: title, unit: unitFor(title), roles: removed ? ['VIEWER'] : rolesFor(title), removed: removed || !!u.deleted });
    }
  }
  const personByName = new Map(people.map((p) => [key(p.fullName), p.ref]));
  const userRef = (id: Id | null | undefined) => (id && seenPeople.has(id) ? `user:${id}` : null);

  /* clients: Mizito's files, joined to the sheet's rows by code */
  const clients = new Map<string, MigClient>();
  const codeOf = (s: string | null | undefined) => (s ?? '').match(/H\d{4}/)?.[0] ?? null;
  // The sheet says whose a code is: where Mizito files two clients under one code, the one the sheet names keeps it.
  const sheetName = new Map((sheet?.clients ?? []).map((r) => [codeOf(r[0]), key(r[1] ?? '')] as const).filter(([c]) => c));
  const strays: MigClient[] = [];
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
    const extra = [
      clean(c.notes),
      phones.length > 1 ? `تلفن‌های دیگر: ${phones.slice(1).join('، ')}` : null,
      clean(c.fax) ? `فکس: ${clean(c.fax)}` : null,
      c.archived ? 'در میزیتو بایگانی شده بود' : null,
    ].filter(Boolean);
    const contacts: MigContact[] = (c.representatives ?? []).map((r) => ({
      fullName: fullName(r), jobTitle: clean(r.position) ?? clean(r.title), phone: phoneOf(r.mobile) ?? phoneOf(r.phone) ?? clean(r.phone_number), email: clean(r.email),
    })).filter((r) => r.fullName);
    const client: MigClient = {
      ref, code, legalName, brandName: own(c.short_name) && own(c.short_name) !== legalName ? own(c.short_name) : null, industry: null,
      nationalId: clean(c.national_code), economicCode: clean(c.economic_code), postalCode: clean(c.postal_code), phone: phones[0] ?? null,
      email: clean(c.email), website: clean(c.website), address: clean(c.address), notes: extra.length ? extra.join('\n') : null,
      accountOwnerRef: userRef(c.customer_admins?.[0]), contacts,
    };
    if (code) clients.set(ref, client); else strays.push(client);
  }
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
      phone: null, email: null, website: clean(website), address: null, notes: facts || null, accountOwnerRef: null, contacts: [],
    });
  }
  // A file without its code: a second file of a client already here is folded into it; anyone else comes in uncoded.
  for (const s of strays) {
    const all = [...clients.values()];
    const same = all.find((c) => key(c.legalName) === key(s.legalName)) ?? all.find((c) => typo(key(c.legalName), key(s.legalName)));
    if (!same) { clients.set(s.ref, s); continue; }
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

  /* projects: Mizito's, then the sheet's rows joined to them or added */
  const projects = new Map<string, MigProject & { clientName: string }>();
  const madeClients = new Map<string, string>();
  for (const p of mz.projects) {
    if (p.deleted || !p.title) continue;
    const archived = !!p.archived || p.title.search(ARCHIVED) >= 0;
    const title = clean(p.title.replace(ARCHIVED, ''))!;
    const [head, ...rest] = title.split('|');
    const named = rest.length ? clean(head) : null;
    const name = (rest.length ? clean(rest.join('|')) : title) ?? title;
    // Without "client |", the title is the client's work («دیجی کالا», «سئو سایت هامرز») unless it is the agency's own.
    const own = INTERNAL.test((named ?? title).replace(/\u200c/g, ' '));
    const clientName = own ? null : named ?? clean(title.replace(WORK, ''));
    let clientRef = named ? findClient(named) : findClient(name) ?? (clientName ? findClient(clientName) : null);
    if (!clientRef && clientName) {
      // A client the lists do not have, named by its projects: made once, from that name.
      const k = key(clientName);
      const madeAlready = [...madeClients.keys()].find((x) => x === k || typo(x, k) || (Math.min(x.length, k.length) >= 3 && (x.includes(k) || k.includes(x))));
      clientRef = madeAlready ? madeClients.get(madeAlready)! : `client:name:${k}`;
      if (!clients.has(clientRef)) {
        clients.set(clientRef, { ref: clientRef, code: null, legalName: clientName, brandName: null, industry: null, nationalId: null, economicCode: null, postalCode: null, phone: null, email: null, website: null, address: null, notes: 'از عنوان پروژه‌های میزیتو ساخته شد', accountOwnerRef: null, contacts: [] });
        madeClients.set(k, clientRef);
        note(`مشتری «${clientName}» در فهرست‌ها نبود؛ از عنوان پروژهٔ «${title}» ساخته شد`);
      }
    }
    if (!clientRef) { clientRef = agency?.ref ?? null; if (clientRef) note(`پروژهٔ «${title}» کار خود آژانس است و پروژهٔ داخلی آن شد`); }
    if (!clientRef) { note(`پروژهٔ «${title}» مشتری پیدا نکرد و وارد نمی‌شود`); continue; }
    projects.set(`project:${p._id}`, {
      ref: `project:${p._id}`, legacyRef: null, name, clientRef, clientName: clients.get(clientRef)!.legalName,
      accountOwnerRef: userRef(p.owner), state: archived ? 'CLOSED' : 'ACTIVE', plannedStart: null, plannedEnd: null, createdAt: null, closedAt: null,
    });
  }
  const STATUS: Record<string, MigProjectState> = {
    [key('در حال انجام')]: 'ACTIVE', [key('شروع نشده')]: 'DRAFT', [key('تمام شده')]: 'CLOSED', [key('پایان یافته')]: 'CLOSED', [key('متوقف شده')]: 'ON_HOLD',
  };
  const joined = new Set<string>();
  for (const [line, row] of (sheet?.projects ?? []).entries()) {
    const [, rawClientCode, rawClientName, rawCode, rawName, , , account, status, start, end] = row;
    const name = clean(rawName);
    if (!name || key(name).length < 2) continue;
    const clientCode = codeOf(rawClientCode);
    const clientRef = (clientCode && clients.has(`client:${clientCode}`) ? `client:${clientCode}` : null) ?? (clean(rawClientName) ? findClient(rawClientName!) : null);
    if (!clientRef) { note(`ردیف پروژهٔ «${name}» در فایل مشتری‌اش (${rawClientName || rawClientCode || '—'}) را پیدا نکرد`); continue; }
    const code = clean(rawCode);
    const state = clean(status) ? STATUS[key(status!)] : undefined;
    if (clean(status) && !state) note(`وضعیت «${status}» برای «${name}» شناخته نشد؛ از میزیتو یا پیش‌نویس`);
    const owner = clean(account) ? personByName.get(key(account!)) ?? null : null;
    if (clean(account) && !owner) note(`اکانت «${account}» برای «${name}» در اعضای میزیتو نبود`);
    const k = key(name);
    const match = [...projects.values()].find((p) => !joined.has(p.ref) && p.ref.startsWith('project:') && !p.ref.startsWith('project:sheet:') && p.clientRef === clientRef
      && (key(p.name) === k || typo(key(p.name), k) || (k.length >= 4 && key(p.name).length >= 4 && (key(p.name).includes(k) || k.includes(key(p.name))))));
    const dates = { plannedStart: clean(start) ? dateOf(start!) : null, plannedEnd: clean(end) ? dateOf(end!) : null };
    if (match) {
      joined.add(match.ref);
      Object.assign(match, { legacyRef: code ?? match.legacyRef, ...(state ? { state } : {}), ...(owner ? { accountOwnerRef: owner } : {}), ...dates });
      continue;
    }
    // A row without its code is known by its place in the file — the same file run again finds it again.
    const ref = `project:sheet:${code ?? `row:${line + 2}`}`;
    if (projects.has(ref)) { note(`کد پروژهٔ ${code} در فایل دو بار آمده است؛ ردیف «${name}» وارد نمی‌شود`); continue; }
    projects.set(ref, { ref, legacyRef: code, name, clientRef, clientName: clients.get(clientRef)!.legalName, accountOwnerRef: owner, state: state ?? 'DRAFT', createdAt: null, closedAt: null, ...dates });
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
    const description = [clean(t.notes), list.length ? list.join('\n') : null].filter(Boolean).join('\n\n') || null;
    tasks.push({
      ref: `task:${t._id}`, projectRef, title: clean(t.title)!, description, assigneeRef: userRef(t.assignee?.[0]) ?? userRef(t.responsible?.[0]),
      createdByRef: userRef(t.owner), createdAt: when(t.created_at), dueDate: t.has_deadline === false ? null : when(t.deadline),
      done: !!t.completed, doneAt: t.completed ? when(t.completed_at) : null, progress: t.progress ?? 0,
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
    projects: [...projects.values()].map(({ clientName: _c, ...p }) => p),
    tasks, comments, notes,
  };
}
