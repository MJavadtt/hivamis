/**
 * Proposed actions (audit F-4): the assistant may propose changes — submit a task, log time, create
 * a task, schedule a meeting, send a form — as a plan. Each step is the exact request it would make,
 * shown to the person in words; nothing runs until they approve steps, and then each runs through
 * the ordinary API with their own token, so every permission, guard, SLA and audit applies. The plan
 * and its outcome are kept and audited.
 *
 * Steps are resolved here, with the person's own reads: a code or a task's title becomes the record's
 * id only if they may see it. The model never supplies an id that is used as it is.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { asAgentFor } from '../lib/request-context.js';
import { formatJalali } from '../lib/jalali.js';
import { TASK_WORKFLOW } from '@hiva/contracts';
import { dateFor } from './shape.js';

export const STEP_KINDS = ['task_submit', 'task_move', 'log_time', 'create_task', 'schedule_meeting', 'submit_form'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export interface PlanStep {
  kind: StepKind;
  summaryFa: string;
  summaryEn: string;
  request: { method: 'POST'; path: string; body: Record<string, unknown> };
  /** Why this step cannot be approved as it stands — said, rather than run to fail. In English for
   *  the model and the audit; `issueFa` is what a Persian reader sees. */
  issue?: string;
  issueFa?: string;
}

/** A reason, in both languages. */
interface Why { en: string; fa: string }
const why = (en: string, faText: string): Why => ({ en, fa: faText });
const flaw = (w: Why | null | undefined) => (w ? { issue: w.en, issueFa: w.fa } : {});
const isWhy = (t: unknown): t is Why => typeof (t as Why).en === 'string';
/** A task's moves the assistant may propose: all but assigning, which wants a person chosen on the page. */
const MOVES = TASK_WORKFLOW.transitions.filter((t) => t.action !== 'assign');

export interface PlanContext {
  app: FastifyInstance;
  userId: string;
  organizationId: string;
  authorization: string;
  locale: 'fa' | 'en';
  unit: string | null;
  conversationId?: string | null;
  /** The person's own words this turn. */
  said?: string;
}

type Raw = Record<string, unknown>;
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
const UUID = /^[0-9a-f-]{36}$/i;
const fa = (n: number | string) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]!);
/** A day as each reader writes it: the Persian calendar, or the Gregorian. */
const dayFa = (day: string) => formatJalali(new Date(`${day}T12:00:00Z`));
const dayEn = (day: string) => dateFor(`${day}T12:00:00Z`, 'en');

async function get(ctx: PlanContext, url: string): Promise<unknown | null> {
  const res = await asAgentFor(ctx.userId, () => ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: ctx.authorization } }));
  if (res.statusCode >= 400) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

/** A record by its code, among what the person may see. */
async function byCode(ctx: PlanContext, type: string, code: string): Promise<{ id: string; code: string; title?: string; name?: string } | null> {
  const found = await get(ctx, `/search?q=${encodeURIComponent(code)}`) as { groups?: { type: string; items: { id: string; code?: string; title?: string; name?: string }[] }[] } | null;
  const items = found?.groups?.find((g) => g.type === type)?.items ?? [];
  return (items.find((i) => i.code?.toUpperCase() === code.toUpperCase()) as { id: string; code: string; title?: string; name?: string } | undefined) ?? null;
}

/** A task: by its code, or by words of its title in a project given by code. */
const projectMissing = (code: string) => why(`project ${code || '—'} not found among what the user may see`, `پروژهٔ ${code || '—'} در میان آنچه می‌بینید یافت نشد.`);

/**
 * Persian as it is spoken and as it is typed rarely match letter for letter: «برنامهٔ» and «برنامه»,
 * a zero-width joiner or a space, Arabic ي and ك. Compared in one form, word by word.
 */
export function words(text: string): string[] {
  return text.toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[\u200c\u200f\u200e]/g, ' ')
    .replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/ة/g, 'ه')
    .split(/[^\p{L}\p{N}-]+/u)
    .filter((w) => w.length > 1);
}

/**
 * How well a task's title answers what was said: the share of the title said, or of what was said in
 * the title, whichever is more — and how many words met, so a one-word title loses to a fuller one.
 */
export function likeness(title: string, said: string): { score: number; hits: number } {
  const t = words(title), s = words(said);
  if (!t.length || !s.length) return { score: 0, hits: 0 };
  const hits = t.filter((w) => s.includes(w)).length;
  return { score: Math.max(hits / t.length, s.filter((w) => t.includes(w)).length / s.length), hits };
}

const CLOSED = new Set(['CLOSED', 'CANCELLED', 'APPROVED']);
type Listed = { id: string; code: string; title: string; assigneeId: string | null; state: string };

/**
 * A task: by its code, or by its title — in the project named, or else among the person's own. When
 * the model's reference does not resolve (a model can make a code up), the person's own words this
 * turn are tried; the step then shows the task found, by code and title, before anyone approves it.
 */
async function findTask(ctx: PlanContext, raw: Raw): Promise<{ id: string; code: string; title: string } | Why> {
  const ref = str(raw.task);
  const code = /\bTSK-\d+\b/i.exec(ref)?.[0];
  if (code) {
    const t = await byCode(ctx, 'task', code);
    if (t) return { id: t.id, code: t.code, title: t.title ?? code };
  }
  const title = ref.replace(/\bTSK-\d+\b/gi, ' ').trim();
  const found = title ? await byTitle(ctx, title, str(raw.project)) : null;
  if (found && !isWhy(found)) return found;
  const heard = ctx.said ? await byTitle(ctx, ctx.said, str(raw.project)) : null;
  if (heard && !isWhy(heard)) return heard;
  if (code) return why(`task ${code} not found among what the user may see`, `وظیفهٔ ${code} در میان آنچه می‌بینید یافت نشد.`);
  return found ?? why('give the task by its code (TSK-…) or its title', 'وظیفه را با کدش (TSK-…) یا عنوانش بگویید.');
}

async function byTitle(ctx: PlanContext, text: string, projectRef: string): Promise<{ id: string; code: string; title: string } | Why> {
  // A project said in the same breath counts: «… PRJ-000016 را تمام کردم».
  const projectCode = /\bPRJ-\d+\b/i.exec(`${projectRef} ${text}`)?.[0];
  const project = projectCode ? await byCode(ctx, 'project', projectCode) : null;
  if (projectCode && !project) return projectMissing(projectCode);
  const page = await get(ctx, project ? `/tasks?projectId=${project.id}&pageSize=200` : '/tasks?mine=true&pageSize=200') as { items?: Listed[] } | null;
  const said = text.replace(/\b(PRJ|TSK)-\d+\b/gi, ' ');
  const best = (page?.items ?? [])
    .map((x) => ({ x, ...likeness(x.title, said) }))
    .filter((c) => c.score >= 0.5)
    // Theirs first, then open ones: "I finished the logo" is about their own task in hand.
    .sort((a, b) => b.score - a.score || b.hits - a.hits
      || Number(b.x.assigneeId === ctx.userId) - Number(a.x.assigneeId === ctx.userId)
      || Number(!CLOSED.has(b.x.state)) - Number(!CLOSED.has(a.x.state)))[0]?.x;
  if (best) return { id: best.id, code: best.code, title: best.title };
  return project
    ? why(`no task titled like “${said.trim()}” in ${projectCode}`, `وظیفه‌ای با عنوانی مانند «${said.trim()}» در ${projectCode} نیست.`)
    : why(`none of the user's own tasks is titled like “${said.trim()}”; give its code (TSK-…) or its project (PRJ-…)`,
      `در وظیفه‌های خودتان عنوانی مانند «${said.trim()}» نیست؛ کد وظیفه (TSK-…) یا پروژه‌اش (PRJ-…) را بگویید.`);
}

/** A day the model named: "today", "yesterday", or a date. */
function dayOf(v: unknown): string | null {
  const s = str(v, 40).toLowerCase();
  const d = new Date();
  if (!s || s === 'today' || s === 'امروز') return d.toISOString().slice(0, 10);
  if (s === 'yesterday' || s === 'دیروز') { d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); }
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

const NONE = { method: 'POST' as const, path: '', body: {} };

async function resolve(ctx: PlanContext, raw: Raw): Promise<PlanStep | null> {
  const kind = str(raw.kind) as StepKind;
  switch (kind) {
    case 'task_submit':
    case 'task_move': {
      const action = kind === 'task_submit' ? 'submit' : str(raw.action, 40);
      const move = MOVES.find((m) => m.action === action);
      const t = await findTask(ctx, raw);
      const reason = str(raw.reason, 2000);
      const bad = !move ? why(`not a task action: ${action || '—'}; one of ${MOVES.map((m) => m.action).join(', ')}`, `«${action || '—'}» کاری نیست که روی وظیفه بشود.`)
        : isWhy(t) ? t
        : move.requiresReason && reason.length < 3 ? why(`“${move.labelEn}” needs a reason`, `«${move.labelFa}» دلیل می‌خواهد.`) : null;
      if (bad || isWhy(t) || !move) return { kind, summaryFa: move?.labelFa ?? 'جابه‌جایی وظیفه', summaryEn: move?.labelEn ?? 'Move a task', request: NONE, ...flaw(bad) };
      return {
        kind, request: { method: 'POST', path: `/workflow/task/${t.id}/transitions`, body: { action, ...(reason ? { reason } : {}) } },
        summaryFa: `${move.labelFa}: وظیفهٔ «${t.title}» (${t.code})${reason ? ` — ${reason}` : ''}`,
        summaryEn: `${move.labelEn}: the task “${t.title}” (${t.code})${reason ? ` — ${reason}` : ''}`,
      };
    }
    case 'log_time': {
      const t = await findTask(ctx, raw);
      const hours = Number(raw.hours);
      const day = dayOf(raw.date);
      const bad = isWhy(t) ? t : !(hours > 0 && hours <= 24) ? why('hours must be between 0 and 24', 'ساعت‌ها باید بیش از صفر و تا ۲۴ باشد.')
        : !day ? why('not a date', 'روز کار روشن نیست.') : null;
      if (bad || isWhy(t) || !day) return { kind, summaryFa: 'ثبت زمان', summaryEn: 'Log time', request: NONE, ...flaw(bad) };
      const note = str(raw.note, 500);
      return {
        kind, request: { method: 'POST', path: `/tasks/${t.id}/time`, body: { hours, workedOn: day, ...(note ? { note } : {}) } },
        summaryFa: `ثبت ${fa(hours)} ساعت کار روی «${t.title}» (${t.code}) برای ${dayFa(day)}`, summaryEn: `Log ${hours} h on “${t.title}” (${t.code}) for ${dayEn(day)}`,
      };
    }
    case 'create_task': {
      const projectCode = str(raw.project);
      const project = /^PRJ-\d+$/i.test(projectCode) ? await byCode(ctx, 'project', projectCode) : null;
      const title = str(raw.title);
      const sourceType = str(raw.sourceType, 40);
      const sourceRef = str(raw.sourceRef, 120);
      const issue = !project ? projectMissing(projectCode)
        : title.length < 2 ? why('a task needs a title', 'وظیفه عنوان می‌خواهد.')
        // Doc_H §6: a task traces to its source document, or it is not a task.
        : !sourceType || !sourceRef ? why('Doc_H §6: a task needs its source document (brief, order form, minutes, change request…)',
          'Doc_H §6: هر وظیفه از سند مبدأش می‌آید (بریف، فرم سفارش، صورتجلسه، درخواست تغییر…)؛ آن را نام ببرید.') : null;
      const due = raw.dueDate ? dayOf(raw.dueDate) : null;
      return {
        kind, ...flaw(issue),
        request: { method: 'POST', path: '/tasks', body: { projectId: project?.id, title, departmentCode: ctx.unit, sourceType, sourceRef, ...(due ? { dueDate: due } : {}) } },
        summaryFa: `ساخت وظیفهٔ «${title}» در ${projectCode}${due ? ` با مهلت ${dayFa(due)}` : ''}`, summaryEn: `Create the task “${title}” in ${projectCode}${due ? ` due ${dayEn(due)}` : ''}`,
      };
    }
    case 'schedule_meeting': {
      const projectCode = str(raw.project);
      const project = /^PRJ-\d+$/i.test(projectCode) ? await byCode(ctx, 'project', projectCode) : null;
      const subject = str(raw.subject);
      const at = new Date(str(raw.at, 40));
      const attendees = str(raw.attendees, 2000);
      const issue = projectCode && !project ? projectMissing(projectCode)
        : subject.length < 2 ? why('a meeting needs a subject', 'جلسه موضوع می‌خواهد.')
        : Number.isNaN(at.getTime()) ? why('a meeting needs a date and time', 'زمان جلسه روشن نیست.')
        : attendees.length < 2 ? why('say who attends', 'بگویید چه کسانی در جلسه‌اند.') : null;
      return {
        kind, ...flaw(issue),
        request: { method: 'POST', path: '/meetings', body: { ...(project ? { projectId: project.id } : {}), kind: 'INTERNAL', subject, heldAt: Number.isNaN(at.getTime()) ? null : at.toISOString(), attendees } },
        summaryFa: `ثبت جلسهٔ «${subject}»${project ? ` برای ${projectCode}` : ''}`, summaryEn: `Schedule the meeting “${subject}”${project ? ` for ${projectCode}` : ''}`,
      };
    }
    case 'submit_form': {
      const code = str(raw.form, 60);
      const def = await get(ctx, `/forms/definitions/${encodeURIComponent(code)}`) as { nameFa: string; nameEn: string; canSubmit: boolean; schema: { key: string }[] } | null;
      if (!def) return { kind, summaryFa: `ارسال فرم ${code}`, summaryEn: `Send the form ${code}`, request: NONE, ...flaw(why(`no such form: ${code}`, `فرمی با کد ${code} نیست.`)) };
      const keys = new Set(def.schema.map((f) => f.key));
      // Only the form's own fields, only plain values: the person reads every one before approving.
      const data = Object.fromEntries(Object.entries((raw.fields ?? {}) as Raw)
        .filter(([k, v]) => keys.has(k) && (typeof v === 'string' || typeof v === 'number'))
        .map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 2000) : v]));
      return {
        kind, ...flaw(def.canSubmit ? null : why("the user's unit may not send this form", 'واحد شما این فرم را نمی‌فرستد.')),
        request: { method: 'POST', path: '/forms/submissions', body: { formCode: code, data, asDraft: false } },
        summaryFa: `ارسال «${def.nameFa}» با ${fa(Object.keys(data).length)} فیلد پرشده`, summaryEn: `Send “${def.nameEn}” with ${Object.keys(data).length} field(s) filled`,
      };
    }
    default:
      return null;
  }
}

/** Resolves and keeps a plan; runs nothing. Returns the plan as the person will see it. */
export async function proposePlan(ctx: PlanContext, raw: unknown): Promise<{ id: string; steps: PlanStep[] } | null> {
  const list = (Array.isArray(raw) ? raw : []).slice(0, 8) as Raw[];
  const steps = (await Promise.all(list.map((r) => resolve(ctx, r)))).filter((s): s is PlanStep => s !== null);
  if (!steps.length) return null;
  const plan = await prisma.$transaction(async (tx) => {
    const p = await tx.aiPlan.create({ data: { organizationId: ctx.organizationId, userId: ctx.userId, conversationId: ctx.conversationId ?? null, steps: steps as unknown as object } });
    await audit({
      organizationId: ctx.organizationId, actorId: ctx.userId, action: 'AI_PLAN_PROPOSED', entityType: 'aiPlan', entityId: p.id,
      after: { steps: steps.map((s) => ({ kind: s.kind, summary: s.summaryEn, issue: s.issue ?? null })) },
    }, tx);
    return p;
  });
  return { id: plan.id, steps };
}

export interface StepOutcome { index: number; status: 'DONE' | 'FAILED' | 'DECLINED'; code?: string; message?: string }

/**
 * Runs the approved steps, in order, as the person: their token on each request, nothing else. The
 * rest are declined. Each step's answer is kept; a refusal is the API's own words.
 */
export async function executePlan(app: FastifyInstance, plan: { id: string; organizationId: string; userId: string; steps: unknown },
  approved: number[], authorization: string, locale: string): Promise<{ status: string; outcome: StepOutcome[] }> {
  const steps = plan.steps as PlanStep[];
  const outcome: StepOutcome[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (!approved.includes(i)) { outcome.push({ index: i, status: 'DECLINED' }); continue; }
    if (step.issue || !step.request.path) {
      outcome.push({ index: i, status: 'FAILED', code: 'NOT_APPROVABLE', message: (locale.startsWith('en') ? step.issue : step.issueFa ?? step.issue) ?? 'incomplete' });
      continue;
    }
    const res = await asAgentFor(plan.userId, () => app.inject({
      method: step.request.method, url: `/api/v1${step.request.path}`, payload: step.request.body as object,
      headers: { authorization, 'accept-language': locale },
    }));
    if (res.statusCode < 400) { outcome.push({ index: i, status: 'DONE' }); continue; }
    let error: { code?: string; message?: string } = {};
    try { error = (JSON.parse(res.body) as { error?: typeof error }).error ?? {}; } catch { /* not JSON */ }
    outcome.push({ index: i, status: 'FAILED', code: error.code ?? String(res.statusCode), message: error.message ?? `HTTP ${res.statusCode}` });
  }
  const done = outcome.filter((o) => o.status === 'DONE').length;
  const tried = outcome.filter((o) => o.status !== 'DECLINED').length;
  const status = tried === 0 ? 'DECLINED' : done === tried ? 'EXECUTED' : done === 0 ? 'FAILED' : 'PARTIAL';
  await prisma.$transaction(async (tx) => {
    await tx.aiPlan.update({ where: { id: plan.id, organizationId: plan.organizationId }, data: { status, outcome: outcome as unknown as object, decidedAt: new Date() } });
    await audit({
      organizationId: plan.organizationId, actorId: plan.userId, action: tried === 0 ? 'AI_PLAN_DECLINED' : 'AI_PLAN_EXECUTED',
      entityType: 'aiPlan', entityId: plan.id, before: { status: 'PROPOSED' }, after: { status, outcome },
    }, tx);
  });
  return { status, outcome };
}
