import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEPARTMENT_CODES, DEPARTMENT_LABELS, type DepartmentCode } from '@hiva/contracts';
import { apiGet, apiPost, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatCurrency, formatDate, localDigits } from '../lib/format';
import { forwardMove, type Transition } from '../lib/plain';
import { PageBody, PageHeader } from '../components/Shell';
import { JourneySteps, StepSection, type JourneyStep } from '../components/Journey';
import { StageProgress, placeOn } from '../components/StageProgress';
import { JalaliDateInput } from '../components/JalaliDateInput';
import { UnitOrderForm } from '../components/UnitOrderForm';
import { WorkflowActions } from '../components/common';
import { ReturnNote, StagePill } from '../components/WorkCard';
import { Button, EmptyState, ErrorBlock, Field, Input, LoadingBlock, Select, Textarea, useToast } from '../components/ui';
import { isEnglish, trx, tr } from '../i18n';

/**
 * Account's part of a sale, step by step (the owner's brief, 2026-11-02): review the brief, open the
 * project and the proposal, order each unit's part, check what each unit hands in and what it cost,
 * integrate, price and pass final QC, and hand the proposal to Sales. A desk lists every brief by the
 * step it is on; a brief's page walks its six steps. Every step writes through the routes and moves the
 * rest of the system uses — the engine still decides each one.
 */

interface Brief {
  id: string; code: string; title: string; state: string; createdAt: string;
  businessObjective: string | null; targetAudience: string | null; scope: string | null; expectedDeliverables: string | null;
  budgetRange: string | number | null; desiredDeadline: string | null; unitsNeeded: DepartmentCode[];
  completenessScore: number; missingItems: string[] | null;
  opportunity: { id: string; title: string; companyId?: string; company: { id?: string; legalName: string } | null } | null;
  proposals?: { id: string; code: string; title: string; state: string; version: number }[];
  availableTransitions: Transition[];
}
interface ProposalRow { id: string; briefId: string; state: string; version: number }
interface Proposal {
  id: string; code: string; title: string; state: string; totalCost: string | null; salePrice: string | null; pricingApprovedAt: string | null;
  costDeclarations: { id: string; workOrderId: string | null; departmentCode: string; internalCost: string; externalCost: string }[];
  qcReviews: { level: string; verdict: string }[];
  availableTransitions: Transition[];
}
interface ProjectRow { id: string; code: string; name: string; state: string; briefId: string | null; proposalId: string | null; plannedEnd: string | null }
interface Order {
  id: string; code: string; title: string; state: string; targetDepartmentCode: DepartmentCode; proposalId: string | null;
  deadline: string | null; owner: { fullName: string } | null; availableTransitions: Transition[];
}

const unitName = (code: string) => {
  const l = DEPARTMENT_LABELS[code as DepartmentCode];
  return l ? (isEnglish() ? l.en : l.fa) : code;
};
/** The units that make things — the ones a brief orders work from. */
const MAKERS = DEPARTMENT_CODES.filter((d) => !['M', 'OP', 'FI', 'LG', 'A', 'S'].includes(d));

/** How far a proposal has come, as an index on its road (−1 before one exists). */
const along = (state: string | undefined) => (state ? placeOn('proposal', state).at : -1);
const AT = { DRAFT: 0, AWAITING: 1, INTEGRATION: 2, APPROVED: 6, DELIVERED: 7 } as const;

/** In one sentence, what the brief is waiting for. */
export function nextFor(brief: { state: string }, proposal?: { state: string }): string {
  if (brief.state === 'SUBMITTED') return tr('بریف تازه رسیده است؛ بررسی آن را شروع کنید.');
  if (brief.state === 'UNDER_REVIEW') return tr('در حال بررسی؛ تأیید کنید یا با توضیح به فروش برگردانید.');
  if (brief.state === 'RETURNED_INCOMPLETE') return tr('برای تکمیل به فروش برگشته است.');
  if (brief.state !== 'APPROVED') return tr('هنوز به اکانت فرستاده نشده است.');
  switch (proposal?.state) {
    case undefined: return tr('تأیید شده؛ پروژه و پروپوزال را باز کنید.');
    case 'DRAFT': return tr('سفارش هر واحد را صادر کنید.');
    case 'AWAITING_UNIT_OUTPUTS': return tr('منتظر خروجی و هزینهٔ واحدها.');
    case 'INTEGRATION': return tr('خروجی‌ها رسیده است؛ یکپارچه کنید و به قیمت‌گذاری بفرستید.');
    case 'PRICING': return tr('قیمت فروش را تعیین کنید و به QC نهایی بفرستید.');
    case 'UNIT_APPROVAL': return tr('منتظر تأیید مدیر واحد رسانه است.');
    case 'FINAL_QC': return tr('در QC نهایی است.');
    case 'APPROVED': return tr('تأیید نهایی شده؛ آن را به فروش تحویل دهید.');
    case 'DELIVERED_TO_SALES': return tr('به فروش تحویل شد؛ فروش آن را به مشتری ارائه می‌کند.');
    case 'PRESENTED_TO_CLIENT': return tr('به مشتری ارائه شده و منتظر پاسخ اوست.');
    case 'CLIENT_APPROVED': return tr('مشتری تأیید کرد؛ نوبت قرارداد و مجوز شروع پروژه است.');
    case 'CLIENT_REVISION_REQUESTED': return tr('مشتری اصلاح خواسته است؛ اصلاح پروپوزال را شروع کنید.');
    case 'CLIENT_REJECTED': return tr('مشتری آن را نپذیرفت.');
    default: return tr('آن را باز کنید و گام بعد را بردارید.');
  }
}

/* ── the desk ─────────────────────────────────────────────────────────────── */

const DESK = [
  { key: 'review', label: tr('بریف‌های تازه برای بررسی') },
  { key: 'working', label: tr('در دست اکانت') },
  { key: 'sales', label: tr('نزد فروش و مشتری') },
  { key: 'returned', label: tr('برگشته به فروش') },
] as const;
type DeskGroup = (typeof DESK)[number]['key'];

export function deskGroupOf(brief: { state: string }, proposal?: { state: string }): DeskGroup | null {
  if (['SUBMITTED', 'UNDER_REVIEW'].includes(brief.state)) return 'review';
  if (brief.state === 'RETURNED_INCOMPLETE') return 'returned';
  if (brief.state !== 'APPROVED') return null;
  if (proposal && proposal.state !== 'CLIENT_REVISION_REQUESTED' && along(proposal.state) >= AT.DELIVERED) return 'sales';
  return 'working';
}

export function AccountDesk() {
  const briefs = useQuery<Page<Brief>>({ queryKey: ['/briefs', 'desk'], queryFn: () => apiGet('/briefs', { pageSize: '200' }) });
  const proposals = useQuery<Page<ProposalRow>>({ queryKey: ['/proposals', 'desk'], queryFn: () => apiGet('/proposals', { pageSize: '200' }) });
  if (briefs.isLoading || proposals.isLoading) return <PageBody><LoadingBlock /></PageBody>;
  if (briefs.error) return <PageBody><ErrorBlock error={briefs.error} onRetry={() => void briefs.refetch()} /></PageBody>;
  // A brief's proposal is its latest version.
  const latest = new Map<string, ProposalRow>();
  for (const p of proposals.data?.items ?? []) if (!latest.has(p.briefId) || latest.get(p.briefId)!.version < p.version) latest.set(p.briefId, p);
  const rows = (briefs.data?.items ?? []).map((b) => ({ b, p: latest.get(b.id), group: deskGroupOf(b, latest.get(b.id)) })).filter((r) => r.group);

  return (
    <>
      <PageHeader title={tr('میز اکانت')} subtitle={tr('هر بریف و اینکه اکنون منتظر چیست: از بررسی بریف تا تحویل پروپوزال به فروش.')} />
      <PageBody className="space-y-4">
        <p className="text-sm text-ink-700" data-tour="account-summary">
          {tr('{0} بریف برای بررسی، {1} بریف در دست اکانت، {2} نزد فروش و مشتری.',
            localDigits(rows.filter((r) => r.group === 'review').length), localDigits(rows.filter((r) => r.group === 'working').length), localDigits(rows.filter((r) => r.group === 'sales').length))}
        </p>
        {!rows.length && <EmptyState title={tr('بریفی به اکانت نرسیده است')} />}
        <div className="space-y-4" data-tour="account-groups" data-testid="account-desk">
          {DESK.map(({ key, label }) => {
            const mine = rows.filter((r) => r.group === key);
            if (!mine.length) return null;
            return (
              <section key={key} aria-label={label} className="rounded-xl bg-surface p-4 ring-1 ring-edge">
                <h2 className="text-[15px] font-bold text-ink-900">{label} <span className="text-sm font-normal text-ink-500">({localDigits(mine.length)})</span></h2>
                <ul className="mt-2 divide-y divide-ink-100">
                  {mine.map(({ b, p }) => (
                    <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5" data-testid="desk-row">
                      <div className="min-w-0">
                        <Link to={`/account/journey/${b.id}`} className="font-medium text-brand-700 hover:underline">{b.title}</Link>
                        <span className="ms-2 text-xs text-ink-500">{b.opportunity?.company?.legalName}</span>
                        <p className="text-sm text-ink-700">{nextFor(b, p)}</p>
                      </div>
                      <StagePill state={p?.state ?? b.state} entity={p ? 'proposal' : 'brief'} />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </PageBody>
    </>
  );
}

/* ── one brief's journey ──────────────────────────────────────────────────── */

export function AccountJourney() {
  const { briefId } = useParams<{ briefId: string }>();
  const qc = useQueryClient();
  const brief = useQuery<Brief>({ queryKey: [`/briefs/${briefId}`], queryFn: () => apiGet(`/briefs/${briefId}`), enabled: !!briefId });
  const latest = [...(brief.data?.proposals ?? [])].sort((a, b) => b.version - a.version)[0];
  const proposal = useQuery<Proposal>({ queryKey: [`/proposals/${latest?.id}`], queryFn: () => apiGet(`/proposals/${latest!.id}`), enabled: !!latest });
  const companyId = brief.data?.opportunity?.companyId ?? brief.data?.opportunity?.company?.id;
  const projects = useQuery<Page<ProjectRow>>({
    queryKey: ['/projects', 'of-brief', companyId], queryFn: () => apiGet('/projects', { companyId: companyId!, pageSize: '200' }), enabled: !!companyId,
  });
  const project = projects.data?.items.find((p) => p.briefId === briefId || (!!latest && p.proposalId === latest.id));
  const orders = useQuery<Page<Order>>({
    queryKey: ['/work-orders', 'of-project', project?.id], queryFn: () => apiGet('/work-orders', { projectId: project!.id, pageSize: '200' }), enabled: !!project,
  });
  const refresh = () => void qc.invalidateQueries();

  if (brief.isLoading) return <PageBody><LoadingBlock /></PageBody>;
  if (brief.error || !brief.data) return <PageBody><ErrorBlock error={brief.error} onRetry={() => void brief.refetch()} /></PageBody>;
  const b = brief.data;
  const p = latest ? proposal.data : undefined;
  const at = along(p?.state);
  // The proposal's own orders; an execution order made later for the project is the execution path's (ADR-120).
  const mine = (orders.data?.items ?? []).filter((o) => !!p && o.proposalId === p.id).filter((o) => o.state !== 'CANCELLED');
  const approved = b.state === 'APPROVED';
  const steps: JourneyStep[] = [
    { key: 'review', label: tr('بررسی بریف'), done: approved },
    { key: 'setup', label: tr('پروژه و پروپوزال'), done: approved && !!project && !!p },
    { key: 'orders', label: tr('سفارش به واحدها'), done: at > AT.DRAFT },
    { key: 'outputs', label: tr('خروجی و هزینهٔ واحدها'), done: at > AT.AWAITING },
    { key: 'finish', label: tr('یکپارچه‌سازی، قیمت و QC نهایی'), done: at >= AT.APPROVED },
    { key: 'deliver', label: tr('تحویل به فروش'), done: at >= AT.DELIVERED },
  ];

  return (
    <>
      <PageHeader title={tr('مسیر اکانت — {0}', b.title)}
        subtitle={tr('{0} — {1}', b.opportunity?.company?.legalName ?? '', nextFor(b, p))}
        actions={<><Link to="/account"><Button variant="ghost">{tr('میز اکانت')}</Button></Link><Link to={`/briefs/${b.id}`}><Button variant="ghost">{tr('صفحهٔ کامل بریف')}</Button></Link></>} />
      <PageBody className="space-y-4">
        <JourneySteps steps={steps} />

        <StepSection n={1} tour="brief-review" title={tr('بررسی بریف')} done={approved}
          hint={tr('آیا فروش همه‌چیز را گفته است؟ اگر کامل است تأیید کنید؛ اگر چیزی کم است، با توضیح دقیق به فروش برگردانید.')}>
          <BriefFacts brief={b} />
          <div className="mt-3">
            {b.state === 'RETURNED_INCOMPLETE' ? (
              <><ReturnNote entity="brief" id={b.id} state={b.state} /><p className="mt-2 text-sm text-ink-700">{tr('بریف نزد فروش است تا کامل شود؛ پس از ارسال دوباره همین‌جا می‌بینید.')}</p></>
            ) : approved ? <p className="text-sm text-emerald-700">{tr('بریف تأیید شده است.')}</p>
              : b.availableTransitions.length ? <WorkflowActions minimal entity="brief" id={b.id} transitions={b.availableTransitions} onDone={refresh} />
                : <p className="text-sm text-ink-500">{tr('تصمیم دربارهٔ این بریف با کسی است که بررسی بریف به او سپرده شده.')}</p>}
          </div>
        </StepSection>

        <StepSection n={2} tour="project-setup" title={tr('پروژه و پروپوزال')} done={steps[1]!.done}
          hint={tr('پروژه جایی است که کار و سفارش‌ها در آن می‌مانند؛ پروپوزال همان چیزی است که در پایان به مشتری ارائه می‌شود.')}>
          {!approved ? <p className="text-sm text-ink-500">{tr('پس از تأیید بریف.')}</p>
            : project && p ? (
              <ul className="space-y-1 text-sm text-ink-700">
                <li>{tr('پروژه: ')}<Link to={`/projects/${project.id}`} className="font-medium text-brand-700 hover:underline">{project.name}</Link>{' '}<StagePill state={project.state} entity="project" /></li>
                <li>{tr('پروپوزال: ')}<Link to={`/proposals/${p.id}`} className="font-medium text-brand-700 hover:underline">{p.title}</Link>{' '}<StagePill state={p.state} entity="proposal" /></li>
              </ul>
            ) : <StartWork brief={b} companyId={companyId} project={project} hasProposal={!!latest} onDone={refresh} />}
        </StepSection>

        <StepSection n={3} tour="unit-orders" title={tr('سفارش به واحدها')} done={steps[2]!.done}
          hint={tr('برای هر واحد یک سفارش: چه کاری، برای چه، چه خروجی‌ای، در چه قالبی، تا کی و با مسئولیت چه کسی. سفارش کامل صادر می‌شود و واحد آن را در «کارهای من» می‌بیند.')}>
          {!project || !p ? <p className="text-sm text-ink-500">{tr('اول پروژه و پروپوزال را باز کنید.')}</p>
            : <UnitOrders brief={b} project={project} proposal={p} orders={mine} onDone={refresh} />}
        </StepSection>

        <StepSection n={4} tour="unit-outputs" title={tr('خروجی و هزینهٔ واحدها')} done={steps[3]!.done}
          hint={tr('هر واحد خروجی و قیمت تمام‌شده‌اش را تحویل می‌دهد. خروجی را ببینید و تأیید کنید یا با توضیح برای اصلاح برگردانید.')}>
          {!p || at < AT.AWAITING ? <p className="text-sm text-ink-500">{tr('پس از صدور سفارش‌ها.')}</p>
            : <UnitOutputs proposal={p} orders={mine} onDone={refresh} />}
        </StepSection>

        <StepSection n={5} tour="proposal-finish" title={tr('یکپارچه‌سازی، قیمت و QC نهایی')} done={steps[4]!.done}
          hint={tr('خروجی‌ها در یک پروپوزال جمع می‌شوند، قیمت فروش با دلیلش تعیین و به تأیید مقام مجاز می‌رسد، و QC نهایی آن را می‌پذیرد.')}>
          {!p || at < AT.INTEGRATION ? <p className="text-sm text-ink-500">{tr('پس از رسیدن و پذیرش خروجی همهٔ واحدها.')}</p>
            : <FinishProposal proposal={p} media={mine.some((o) => o.proposalId === p.id && o.targetDepartmentCode === 'ME')} onDone={refresh} />}
        </StepSection>

        <StepSection n={6} tour="deliver" title={tr('تحویل به فروش')} done={steps[5]!.done}
          hint={tr('پروپوزال تأییدشده به فروش تحویل می‌شود تا به مشتری ارائه کند. پاسخ مشتری همین‌جا دیده می‌شود.')}>
          {!p || at < AT.APPROVED ? <p className="text-sm text-ink-500">{tr('پس از تأیید نهایی پروپوزال.')}</p>
            : <Deliver proposal={p} project={project} media={mine.some((o) => o.targetDepartmentCode === 'ME')} onDone={refresh} />}
        </StepSection>
      </PageBody>
    </>
  );
}

function BriefFacts({ brief: b }: { brief: Brief }) {
  const rows: [string, string | null][] = [
    [tr('هدف'), b.businessObjective], [tr('مخاطب هدف'), b.targetAudience], [tr('کار'), b.scope], [tr('خروجی‌ها'), b.expectedDeliverables],
    [tr('بودجه'), b.budgetRange != null && b.budgetRange !== '' ? formatCurrency(b.budgetRange) : null],
    [tr('مهلت'), b.desiredDeadline ? formatDate(b.desiredDeadline) : null],
    [tr('واحدها'), b.unitsNeeded?.length ? b.unitsNeeded.map(unitName).join(tr('، ')) : null],
  ];
  return (
    <div>
      <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2" data-testid="brief-facts">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-2 text-sm">
            <dt className="shrink-0 text-ink-500">{k}:</dt>
            <dd className={v ? 'line-clamp-2 text-ink-800' : 'text-rose-700'}>{v || tr('— گفته نشده —')}</dd>
          </div>
        ))}
      </dl>
      {!!b.missingItems?.length && b.state !== 'APPROVED' && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{tr('کم است: {0}', b.missingItems.map((m) => trx(m)).join(tr('، ')))}</p>
      )}
    </div>
  );
}

/** The project and the proposal, opened together from the brief. */
function StartWork({ brief: b, companyId, project, hasProposal, onDone }: { brief: Brief; companyId?: string; project?: ProjectRow; hasProposal: boolean; onDone: () => void }) {
  const { user, can } = useAuth();
  const toast = useToast();
  const name = b.title.replace(/^بریف\s*[—-]\s*/, '');
  const today = new Date().toISOString().slice(0, 10);
  const [v, setV] = useState({
    name, plannedStart: today, plannedEnd: b.desiredDeadline?.slice(0, 10) ?? '', objective: b.businessObjective ?? '',
    plannedBudget: b.budgetRange != null ? String(b.budgetRange) : '', proposalTitle: tr('پروپوزال — {0}', name),
  });
  const [busy, setBusy] = useState(false);
  if (!can('project.write') || !can('proposal.write')) return <p className="text-sm text-ink-500">{tr('باز کردن پروژه و پروپوزال با مدیر اکانت است.')}</p>;
  const save = async () => {
    setBusy(true);
    try {
      if (!project) {
        await apiPost('/projects', {
          name: v.name.trim(), companyId, briefId: b.id, accountOwnerId: user!.id, objective: v.objective.trim() || undefined,
          plannedStart: v.plannedStart || undefined, plannedEnd: v.plannedEnd || undefined,
          plannedBudget: v.plannedBudget ? Number(v.plannedBudget) : undefined, inScope: b.scope ?? undefined,
        });
      }
      if (!hasProposal) await apiPost('/proposals', { briefId: b.id, title: v.proposalTitle.trim() });
      toast(tr('پروژه و پروپوزال باز شد. اکنون سفارش هر واحد را بنویسید.'));
      onDone();
    } catch (e: any) { toast(e?.message ?? tr('عملیات ناموفق بود.'), 'danger'); onDone(); } finally { setBusy(false); }
  };
  const set = (k: keyof typeof v, value: string) => setV((x) => ({ ...x, [k]: value }));
  return (
    <div className="grid gap-3 rounded-lg bg-ink-50/60 p-3 sm:grid-cols-2" data-testid="start-work">
      {!project && <>
        <Field label={tr('نام پروژه')} required><Input value={v.name} onChange={(e) => set('name', e.target.value)} aria-label={tr('نام پروژه')} /></Field>
        <Field label={tr('بودجه (ریال)')}><Input type="number" value={v.plannedBudget} onChange={(e) => set('plannedBudget', e.target.value)} className="ltr" aria-label={tr('بودجهٔ پروژه')} /></Field>
        <Field label={tr('شروع')}><JalaliDateInput mode="date" value={v.plannedStart} onChange={(d) => set('plannedStart', d)} label={tr('شروع پروژه')} /></Field>
        <Field label={tr('پایان')}><JalaliDateInput mode="date" value={v.plannedEnd || null} onChange={(d) => set('plannedEnd', d)} label={tr('پایان پروژه')} /></Field>
        <div className="sm:col-span-2"><Field label={tr('هدف پروژه')}><Textarea value={v.objective} onChange={(e) => set('objective', e.target.value)} rows={2} aria-label={tr('هدف پروژه')} /></Field></div>
      </>}
      {!hasProposal && <div className="sm:col-span-2"><Field label={tr('عنوان پروپوزال')} required><Input value={v.proposalTitle} onChange={(e) => set('proposalTitle', e.target.value)} aria-label={tr('عنوان پروپوزال')} /></Field></div>}
      <div className="sm:col-span-2 flex justify-end">
        <Button variant="primary" loading={busy} disabled={v.name.trim().length < 2 || v.proposalTitle.trim().length < 2 || !companyId} onClick={() => void save()}>{tr('باز کردن پروژه و پروپوزال')}</Button>
      </div>
    </div>
  );
}

/** One order per unit the brief needs, each issued when it is complete. */
function UnitOrders({ brief: b, project, proposal: p, orders, onDone }: { brief: Brief; project: ProjectRow; proposal: Proposal; orders: Order[]; onDone: () => void }) {
  const { can } = useAuth();
  const [writing, setWriting] = useState<DepartmentCode | null>(null);
  const [other, setOther] = useState('');
  const units = [...new Set<DepartmentCode>([...(b.unitsNeeded ?? []), ...orders.map((o) => o.targetDepartmentCode)])];
  const dispatch = p.state === 'DRAFT' ? forwardMove(p.availableTransitions) : null;
  const ordered = units.length > 0 && units.every((u) => orders.some((o) => o.targetDepartmentCode === u && o.state !== 'DRAFT'));
  return (
    <div className="space-y-3">
      {!units.length && <p className="text-sm text-ink-500">{tr('بریف واحدی را نام نبرده است؛ واحد را از پایین برگزینید.')}</p>}
      <ul className="space-y-2">
        {units.map((u) => {
          const theirs = orders.filter((o) => o.targetDepartmentCode === u);
          return (
            <li key={u} className="rounded-lg bg-ink-50/60 p-3" data-testid="unit-order">
              <p className="text-sm font-bold text-ink-800">{unitName(u)}</p>
              {theirs.map((o) => {
                const move = o.state === 'DRAFT' ? forwardMove(o.availableTransitions) : null;
                return (
                  <div key={o.id} className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span>
                      <Link to={`/work-orders/${o.id}`} className="text-brand-700 hover:underline">{o.title}</Link>{' '}<StagePill state={o.state} entity="workOrder" />
                      <span className="ms-2 text-xs text-ink-500">{[o.owner?.fullName, o.deadline && tr('تا {0}', formatDate(o.deadline))].filter(Boolean).join(' · ')}</span>
                    </span>
                    {move && <WorkflowActions minimal entity="workOrder" id={o.id} transitions={[move]} onDone={onDone} />}
                  </div>
                );
              })}
              {!theirs.length && can('workorder.issue') && writing !== u && (
                <Button size="sm" variant="secondary" className="mt-2" onClick={() => setWriting(u)}>{tr('نوشتن سفارش {0}', unitName(u))}</Button>
              )}
              {writing === u && <OrderForm unit={u} brief={b} project={project} proposal={p} onClose={() => setWriting(null)} onDone={onDone} />}
            </li>
          );
        })}
      </ul>
      {can('workorder.issue') && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={other} onChange={(e) => setOther(e.target.value)} aria-label={tr('واحد دیگر')} className="w-auto">
            <option value="">{tr('— سفارش به واحد دیگر —')}</option>
            {MAKERS.filter((d) => !units.includes(d)).map((d) => <option key={d} value={d}>{unitName(d)}</option>)}
          </Select>
          {other && <Button size="sm" variant="secondary" onClick={() => { setWriting(other as DepartmentCode); setOther(''); }}>{tr('نوشتن سفارش')}</Button>}
        </div>
      )}
      {writing && !units.includes(writing) && <OrderForm unit={writing} brief={b} project={project} proposal={p} onClose={() => setWriting(null)} onDone={onDone} />}
      {dispatch && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 pt-3">
          <p className="text-sm text-ink-700">{ordered
            ? tr('سفارش همهٔ واحدها صادر شده است. پروپوزال را به مرحلهٔ «منتظر واحدها» ببرید.')
            : tr('وقتی سفارش همهٔ واحدها صادر شد، پروپوزال را به مرحلهٔ «منتظر واحدها» ببرید.')}</p>
          <WorkflowActions minimal entity="proposal" id={p.id} transitions={[dispatch]} onDone={onDone} />
        </div>
      )}
    </div>
  );
}

/** The order's nine parts, filled from the brief where it already says them. */
function OrderForm({ unit, brief: b, project, proposal: p, onClose, onDone }: { unit: DepartmentCode; brief: Brief; project: ProjectRow; proposal: Proposal; onClose: () => void; onDone: () => void }) {
  return (
    <UnitOrderForm unit={unit} projectId={project.id} proposalId={p.id} onClose={onClose} onDone={onDone} defaults={{
      title: tr('{0} — {1}', unitName(unit), project.name),
      scopeOfWork: b.scope ?? '',
      brief: [b.businessObjective, b.targetAudience && tr('مخاطب: {0}', b.targetAudience)].filter(Boolean).join('\n'),
      expectedOutput: b.expectedDeliverables ?? '',
      deadline: (project.plannedEnd ?? b.desiredDeadline ?? '').slice(0, 10),
    }} />
  );
}

/** What each unit handed in and what it cost; Account takes it or sends it back. */
function UnitOutputs({ proposal: p, orders, onDone }: { proposal: Proposal; orders: Order[]; onDone: () => void }) {
  const costOf = (o: Order) => p.costDeclarations.find((c) => c.workOrderId === o.id);
  const integrate = p.state === 'AWAITING_UNIT_OUTPUTS' ? forwardMove(p.availableTransitions) : null;
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {orders.map((o) => {
          const cost = costOf(o);
          const handedIn = o.state === 'SUBMITTED';
          return (
            <li key={o.id} className="rounded-lg bg-ink-50/60 p-3 text-sm" data-testid="unit-output">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span><span className="font-bold text-ink-800">{unitName(o.targetDepartmentCode)}</span>{' — '}<Link to={`/work-orders/${o.id}`} className="text-brand-700 hover:underline">{o.title}</Link>{' '}<StagePill state={o.state} entity="workOrder" /></span>
                <span className={cost ? 'text-ink-700' : 'text-amber-700'}>{cost ? tr('هزینه: {0}', formatCurrency(Number(cost.internalCost) + Number(cost.externalCost))) : tr('هزینه هنوز اعلام نشده')}</span>
              </div>
              {handedIn && (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-ink-700">{tr('واحد خروجی را تحویل داده است. آن را ببینید و بپذیرید، یا با توضیح برای اصلاح برگردانید.')}</p>
                  <WorkflowActions minimal entity="workOrder" id={o.id} transitions={o.availableTransitions} onDone={onDone} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {integrate && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 pt-3">
          <p className="text-sm text-ink-700">{tr('وقتی خروجی همهٔ واحدها پذیرفته شد، آن‌ها را در پروپوزال یکپارچه کنید.')}</p>
          <WorkflowActions minimal entity="proposal" id={p.id} transitions={[integrate]} onDone={onDone} />
        </div>
      )}
    </div>
  );
}

function FinishProposal({ proposal: p, media, onDone }: { proposal: Proposal; media: boolean; onDone: () => void }) {
  const { can } = useAuth();
  const finalQc = p.qcReviews.find((q) => q.level === 'FINAL');
  // After pricing, a proposal the media unit worked on goes to that unit's manager; any other, to final QC.
  const options = p.state === 'PRICING' ? p.availableTransitions.filter((t) => t.action === (media ? 'send_to_unit_approval' : 'send_to_final_qc')) : p.availableTransitions;
  const moves = p.state === 'UNIT_APPROVAL' ? p.availableTransitions
    : [along(p.state) < AT.APPROVED || p.state === 'CLIENT_REVISION_REQUESTED' ? forwardMove(options) : null].filter((m): m is Transition => !!m);
  return (
    <div className="space-y-3">
      <StageProgress inline entity="proposal" state={p.state} transitions={p.availableTransitions} />
      <dl className="grid gap-2 text-sm sm:grid-cols-4" data-testid="proposal-figures">
        <div><dt className="text-ink-500">{tr('قیمت تمام‌شده')}</dt><dd className="font-medium">{formatCurrency(p.totalCost)}</dd></div>
        <div><dt className="text-ink-500">{tr('قیمت فروش')}</dt><dd className="font-medium">{p.salePrice ? formatCurrency(p.salePrice) : tr('تعیین نشده')}</dd></div>
        <div><dt className="text-ink-500">{tr('تأیید قیمت')}</dt><dd className={p.pricingApprovedAt ? 'text-emerald-700' : 'text-amber-700'}>{p.pricingApprovedAt ? tr('تأیید شده') : tr('هنوز نه')}</dd></div>
        <div><dt className="text-ink-500">{tr('QC نهایی')}</dt><dd>{finalQc ? <StagePill state={finalQc.verdict} /> : tr('ثبت نشده')}</dd></div>
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        {p.state === 'PRICING' && can('pricing.set_price') && <Link to={`/proposals/${p.id}`}><Button variant="secondary">{tr('تعیین قیمت در صفحهٔ پروپوزال')}</Button></Link>}
        {!!moves.length && <WorkflowActions minimal entity="proposal" id={p.id} transitions={moves} onDone={onDone} />}
      </div>
      {p.state === 'UNIT_APPROVAL' && <p className="text-sm text-ink-600">{tr('واحد رسانه روی این پروپوزال کار کرده است؛ مدیر آن واحد قیمت و محتوا را تأیید می‌کند یا با دلیل برای بازبینی قیمت برمی‌گرداند.')}</p>}
    </div>
  );
}

function Deliver({ proposal: p, project, media, onDone }: { proposal: Proposal; project?: ProjectRow; media: boolean; onDone: () => void }) {
  const move = p.state === 'APPROVED' ? forwardMove(p.availableTransitions) : null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-ink-700">{nextFor({ state: 'APPROVED' }, p)}</p>
      <div className="flex gap-2">
        {move && <WorkflowActions minimal entity="proposal" id={p.id} transitions={[move]} onDone={onDone} />}
        {p.state === 'CLIENT_APPROVED' && project && <Link to={`/projects/${project.id}`}><Button variant="secondary">{tr('رفتن به پروژه')}</Button></Link>}
        {p.state === 'CLIENT_APPROVED' && project && media && <Link to={`/projects/${project.id}/ooh`}><Button variant="primary">{tr('مسیر اجرای محیطی')}</Button></Link>}
      </div>
    </div>
  );
}
