import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeliverableKind } from '@hiva/contracts';
import { apiGet, apiPatch, apiPost, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDraftState } from '../lib/drafts';
import { localDigits } from '../lib/format';
import { forwardMove, type Transition } from '../lib/plain';
import { PageBody, PageHeader } from '../components/Shell';
import { JourneySteps, StepSection, type JourneyStep } from '../components/Journey';
import { StartAuthorization } from '../components/StartAuthorization';
import { UnitOrderForm } from '../components/UnitOrderForm';
import { DeliverableFiles, useDeliverableFiles } from '../components/DeliverableFiles';
import { ClientApprovalsPanel } from '../components/ClientApprovals';
import { JalaliDateInput } from '../components/JalaliDateInput';
import { WorkflowActions } from '../components/common';
import { DueText, StagePill } from '../components/WorkCard';
import { Button, ErrorBlock, Field, Input, LoadingBlock, Textarea, useToast } from '../components/ui';
import { tr } from '../i18n';

/**
 * An out-of-home campaign carried out, step by step (the owner's «فرآیند محیطی», 2026-11-02): the
 * go-ahead, the execution order to the out-of-home unit (the media unit), the display's artwork — who
 * prepares or resizes it, the client's approval, its files handed to the unit — and the reports at the
 * display's start, during it and at its end, each sent to the client for approval. Every step is a record
 * the rest of the system already keeps: an order, a deliverable that says what it is, a task, a client
 * approval.
 */

interface Project360 {
  project: {
    id: string; code: string; name: string; state: string; inScope: string | null; objective: string | null;
    plannedStart: string | null; plannedEnd: string | null; proposalId: string | null;
    company: { id: string; legalName: string }; accountOwner: { fullName: string } | null;
    authorizations?: { basis: string; referenceDocument: string }[]; proposal?: { code: string; title: string } | null;
  };
  availableTransitions: Transition[];
}
interface Order { id: string; code: string; title: string; state: string; targetDepartmentCode: string; proposalId: string | null; owner: { id: string; fullName: string } | null; availableTransitions: Transition[] }
interface Deliverable { id: string; code: string; name: string; state: string; kind: DeliverableKind | null; departmentCode: string; workOrderId: string | null; dueDate: string | null; description: string | null; availableTransitions: Transition[] }
interface TaskRow { id: string; deliverableId: string | null; departmentCode: string; state: string }

/** Who prepares or resizes the display's artwork, as the unit that holds it. */
const PREPARERS: { code: 'CR' | 'ME' | 'A'; title: string; hint: string }[] = [
  { code: 'CR', title: tr('آتلیهٔ هیوا'), hint: tr('آتلیه طرح را آماده یا ری‌سایز می‌کند؛ سفارشش همین‌جا نوشته می‌شود.') },
  { code: 'ME', title: tr('صاحب رسانه'), hint: tr('صاحب رسانه ری‌سایز می‌کند؛ از راه واحد محیطی پیگیری می‌شود.') },
  { code: 'A', title: tr('خود مشتری'), hint: tr('ابعاد سازه‌ها برای مشتری فرستاده می‌شود و فایل‌ها از او گرفته و همین‌جا گذاشته می‌شوند.') },
];
const preparerOf = (code: string) => PREPARERS.find((p) => p.code === code)?.title ?? code;

const day = (iso: string, plus: number) => new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + plus * 86_400_000).toISOString().slice(0, 10);

/** The report deliverables a display needs: one at its start, one every so many days, one at its end. */
export function reportPlan(start: string, end: string, everyDays: number): { kind: DeliverableKind; due: string; n?: number }[] {
  const plan: { kind: DeliverableKind; due: string; n?: number }[] = [{ kind: 'OOH_START_REPORT', due: start.slice(0, 10) }];
  if (everyDays > 0) {
    for (let at = day(start, everyDays), n = 1; at < end.slice(0, 10); at = day(at, everyDays), n += 1) plan.push({ kind: 'OOH_PERIODIC_REPORT', due: at, n });
  }
  plan.push({ kind: 'OOH_END_REPORT', due: end.slice(0, 10) });
  return plan;
}

export function OohJourney() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const c360 = useQuery<Project360>({ queryKey: [`/projects/${id}/360`], queryFn: () => apiGet(`/projects/${id}/360`), enabled: !!id });
  const orders = useQuery<Page<Order>>({ queryKey: ['/work-orders', 'ooh', id], queryFn: () => apiGet('/work-orders', { projectId: id!, pageSize: '200' }), enabled: !!id });
  const deliverables = useQuery<Page<Deliverable>>({ queryKey: ['/deliverables', 'ooh', id], queryFn: () => apiGet('/deliverables', { projectId: id!, pageSize: '200' }), enabled: !!id });
  const tasks = useQuery<Page<TaskRow>>({ queryKey: ['/tasks', 'ooh', id], queryFn: () => apiGet('/tasks', { projectId: id!, pageSize: '200' }), enabled: !!id });
  const refresh = () => void qc.invalidateQueries();

  if (c360.isLoading) return <PageBody><LoadingBlock /></PageBody>;
  if (c360.error || !c360.data) return <PageBody><ErrorBlock error={c360.error} onRetry={() => void c360.refetch()} /></PageBody>;
  const { project: p } = c360.data;
  // The execution order is the media unit's order made for the project, not for its proposal.
  const exec = (orders.data?.items ?? []).filter((o) => o.targetDepartmentCode === 'ME' && !o.proposalId && o.state !== 'CANCELLED')[0];
  const all = deliverables.data?.items ?? [];
  const art = all.find((d) => d.kind === 'OOH_ARTWORK');
  const start = all.find((d) => d.kind === 'OOH_START_REPORT');
  const periodic = all.filter((d) => d.kind === 'OOH_PERIODIC_REPORT').sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
  const end = all.find((d) => d.kind === 'OOH_END_REPORT');
  const planned = !!start || !!end;
  const handedOff = !!art && (tasks.data?.items ?? []).some((t) => t.deliverableId === art.id && t.departmentCode === 'ME');
  const accepted = (d?: Deliverable) => d?.state === 'ACCEPTED';
  const steps: JourneyStep[] = [
    { key: 'go', label: tr('مجوز شروع'), done: !!p.authorizations?.length },
    { key: 'order', label: tr('سفارش اجرا'), done: !!exec && exec.state !== 'DRAFT' },
    { key: 'art', label: tr('طرح اکران'), done: handedOff },
    { key: 'start', label: tr('شروع اکران'), done: accepted(start) },
    { key: 'periodic', label: tr('گزارش‌های دوره‌ای'), done: planned && periodic.every(accepted) },
    { key: 'end', label: tr('پایان اکران'), done: accepted(end) },
  ];

  return (
    <>
      <PageHeader title={tr('مسیر اجرای محیطی — {0}', p.name)} subtitle={tr('{0} — از مجوز شروع تا گزارش پایان اکران و تأیید مشتری.', p.company.legalName)}
        actions={<Link to={`/projects/${p.id}`}><Button variant="ghost">{tr('پروژه ۳۶۰')}</Button></Link>} />
      <PageBody className="space-y-4">
        <JourneySteps steps={steps} />

        <StepSection n={1} tour="ooh-go" title={tr('قرارداد و مجوز شروع')} done={steps[0]!.done}
          hint={tr('قرارداد از فروش رسیده و اکانت به مشتری معرفی شده است. کار با مجوز شروع راه می‌افتد — با قرارداد، سفارش رسمی مشتری یا دستور اجرا با فاکتور.')}>
          <p className="text-sm text-ink-700">{tr('مدیر اکانت این پروژه: {0}', p.accountOwner?.fullName ?? '—')}</p>
          {steps[0]!.done
            ? <p className="mt-1 text-sm text-emerald-700">{tr('مجوز شروع ثبت شده است.')}</p>
            : <div className="-mx-3 sm:-mx-5"><StartAuthorization projectId={p.id} companyId={p.company.id} transitions={c360.data.availableTransitions ?? []} onDone={refresh} /></div>}
        </StepSection>

        <StepSection n={2} tour="ooh-order" title={tr('سفارش اجرا به واحد محیطی')} done={steps[1]!.done}
          hint={tr('فرم سفارش اجرا با پروپوزالِ قراردادشده به واحد محیطی می‌رود؛ زمان اکران و گزارش‌هایش همین‌جا تعیین می‌شود.')}>
          <ExecOrder project={p} exec={exec} onDone={refresh} />
          {exec && !planned && <ReportPlan project={p} exec={exec} onDone={refresh} />}
          {planned && <p className="mt-2 text-sm text-ink-600">{tr('گزارش‌ها: یکی در شروع، {0} گزارش دوره‌ای، یکی در پایان.', localDigits(periodic.length))}</p>}
        </StepSection>

        <StepSection n={3} tour="ooh-art" title={tr('طرح اکران')} done={handedOff}
          hint={tr('طرح از مشتری گرفته می‌شود؛ معلوم می‌شود چه کسی ری‌سایز می‌کند؛ مشتری نسخهٔ نهایی را تأیید می‌کند و فایل‌ها به واحد محیطی می‌رسند. اگر مشتری تأیید نکند، دوباره تصمیم گرفته می‌شود چه کسی اصلاح کند.')}>
          {!exec ? <p className="text-sm text-ink-500">{tr('اول سفارش اجرا را بنویسید.')}</p>
            : <Artwork project={p} exec={exec} art={art} studio={(orders.data?.items ?? []).find((o) => art?.departmentCode === 'CR' && o.id === art.workOrderId)} handedOff={handedOff} onDone={refresh} />}
        </StepSection>

        <StepSection n={4} tour="ooh-start" title={tr('گزارش شروع اکران')} done={steps[3]!.done}
          hint={tr('واحد محیطی گزارش شروع اکران را می‌فرستد؛ اکانت بررسی می‌کند و برای تأیید مشتری می‌فرستد.')}>
          {start ? <ReportRow d={start} onDone={refresh} /> : <p className="text-sm text-ink-500">{tr('پس از تعیین زمان اکران.')}</p>}
        </StepSection>

        <StepSection n={5} tour="ooh-periodic" title={tr('گزارش‌های دوره‌ای اکران')} done={steps[4]!.done}
          hint={tr('در طول اکران، طبق زمان‌بندی قرارداد، گزارش می‌آید و هر کدام برای تأیید مشتری فرستاده می‌شود.')}>
          {!planned ? <p className="text-sm text-ink-500">{tr('پس از تعیین زمان اکران.')}</p> : (
            <div className="space-y-2">
              {!periodic.length && <p className="text-sm text-ink-500">{tr('گزارش دوره‌ای برنامه‌ریزی نشده است.')}</p>}
              {periodic.map((d) => <ReportRow key={d.id} d={d} onDone={refresh} />)}
              {exec && <AnotherReport project={p} exec={exec} count={periodic.length} onDone={refresh} />}
            </div>
          )}
        </StepSection>

        <StepSection n={6} tour="ooh-end" title={tr('گزارش پایان اکران')} done={steps[5]!.done}
          hint={tr('در پایان، گزارش اتمام اکران می‌آید و برای تأیید مشتری فرستاده می‌شود.')}>
          {end ? <ReportRow d={end} onDone={refresh} /> : <p className="text-sm text-ink-500">{tr('پس از تعیین زمان اکران.')}</p>}
        </StepSection>
      </PageBody>
    </>
  );
}

function ExecOrder({ project: p, exec, onDone }: { project: Project360['project']; exec?: Order; onDone: () => void }) {
  const { can } = useAuth();
  const [writing, setWriting] = useState(false);
  if (exec) {
    const move = exec.state === 'DRAFT' ? forwardMove(exec.availableTransitions) : null;
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="ooh-exec-order">
        <span><Link to={`/work-orders/${exec.id}`} className="text-brand-700 hover:underline">{exec.title}</Link>{' '}<StagePill state={exec.state} entity="workOrder" />
          {exec.owner && <span className="ms-2 text-xs text-ink-500">{exec.owner.fullName}</span>}</span>
        {move && <WorkflowActions minimal entity="workOrder" id={exec.id} transitions={[move]} onDone={onDone} />}
      </div>
    );
  }
  if (!can('workorder.issue')) return <p className="text-sm text-ink-500">{tr('نوشتن سفارش اجرا با اکانت است.')}</p>;
  if (!writing) return <Button variant="primary" onClick={() => setWriting(true)}>{tr('نوشتن سفارش اجرا')}</Button>;
  return (
    <UnitOrderForm unit="ME" projectId={p.id} onClose={() => setWriting(false)} onDone={onDone} defaults={{
      title: tr('اجرای محیطی — {0}', p.name),
      scopeOfWork: p.inScope || tr('اجرای اکران طبق پروپوزالِ قراردادشده'),
      brief: [p.objective, p.proposal && tr('پروپوزال قراردادشده: {0} — {1}', p.proposal.code, p.proposal.title)].filter(Boolean).join('\n'),
      expectedOutput: tr('اکران طبق قرارداد، و گزارش‌های شروع، دوره‌ای و پایان اکران'),
      outputFormat: tr('گزارش تصویری (عکس و PDF)'),
      deadline: (p.plannedEnd ?? '').slice(0, 10),
    }} />
  );
}

/** When the display runs and how often it is reported on — the contract's schedule, as report deliverables. */
function ReportPlan({ project: p, exec, onDone }: { project: Project360['project']; exec: Order; onDone: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [v, setV] = useState({ start: (p.plannedStart ?? '').slice(0, 10), end: (p.plannedEnd ?? '').slice(0, 10), every: '7' });
  const [busy, setBusy] = useState(false);
  if (!can('deliverable.write')) return null;
  const every = Math.max(0, Math.floor(Number(v.every) || 0));
  const plan = v.start && v.end && v.start <= v.end ? reportPlan(v.start, v.end, every) : [];
  const save = async () => {
    setBusy(true);
    try {
      for (const r of plan) {
        await apiPost('/deliverables', {
          projectId: p.id, workOrderId: exec.id, kind: r.kind, departmentCode: 'ME', dueDate: r.due, format: tr('گزارش تصویری'),
          name: r.kind === 'OOH_START_REPORT' ? tr('گزارش شروع اکران') : r.kind === 'OOH_END_REPORT' ? tr('گزارش پایان اکران') : tr('گزارش دوره‌ای اکران {0}', localDigits(r.n!)),
        });
      }
      toast(tr('زمان اکران و گزارش‌هایش ثبت شد.'));
      onDone();
    } catch (e: any) { toast(e?.message ?? tr('ثبت ناموفق بود.'), 'danger'); onDone(); } finally { setBusy(false); }
  };
  return (
    <div className="mt-3 grid gap-3 rounded-lg bg-ink-50/60 p-3 sm:grid-cols-3" data-testid="ooh-report-plan">
      <Field label={tr('شروع اکران')} required><JalaliDateInput mode="date" value={v.start || null} onChange={(d) => setV({ ...v, start: d })} label={tr('شروع اکران')} /></Field>
      <Field label={tr('پایان اکران')} required><JalaliDateInput mode="date" value={v.end || null} onChange={(d) => setV({ ...v, end: d })} label={tr('پایان اکران')} /></Field>
      <Field label={tr('هر چند روز یک گزارش دوره‌ای؟')} hint={tr('صفر یعنی بی گزارش دوره‌ای')}>
        <Input type="number" min={0} value={v.every} onChange={(e) => setV({ ...v, every: e.target.value })} className="ltr" aria-label={tr('فاصلهٔ گزارش‌های دوره‌ای')} />
      </Field>
      <div className="sm:col-span-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-600">{plan.length ? tr('{0} گزارش ساخته می‌شود: شروع، {1} دوره‌ای، پایان.', localDigits(plan.length), localDigits(plan.length - 2)) : tr('شروع و پایان اکران را بنویسید.')}</p>
        <Button variant="primary" loading={busy} disabled={!plan.length} onClick={() => void save()}>{tr('ثبت زمان اکران و گزارش‌ها')}</Button>
      </div>
    </div>
  );
}

function AnotherReport({ project: p, exec, count, onDone }: { project: Project360['project']; exec: Order; count: number; onDone: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [due, setDue] = useState('');
  if (!can('deliverable.write')) return null;
  const add = async () => {
    try {
      await apiPost('/deliverables', { projectId: p.id, workOrderId: exec.id, kind: 'OOH_PERIODIC_REPORT', departmentCode: 'ME', dueDate: due, format: tr('گزارش تصویری'), name: tr('گزارش دوره‌ای اکران {0}', localDigits(count + 1)) });
      setDue(''); onDone();
    } catch (e: any) { toast(e?.message ?? tr('ثبت ناموفق بود.'), 'danger'); }
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label={tr('گزارش دوره‌ای دیگر، تا')}><JalaliDateInput mode="date" value={due || null} onChange={setDue} label={tr('مهلت گزارش دوره‌ای تازه')} /></Field>
      <Button size="sm" variant="secondary" disabled={!due} onClick={() => void add()}>{tr('+ گزارش دوره‌ای')}</Button>
    </div>
  );
}

/** The display's artwork: who prepares it, the client's approval, and its files handed to the unit. */
function Artwork({ project: p, exec, art, studio, handedOff, onDone }: { project: Project360['project']; exec: Order; art?: Deliverable; studio?: Order; handedOff: boolean; onDone: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const files = useDeliverableFiles(art?.id);
  const [choosing, setChoosing] = useState(false);
  if (!art || choosing) return <ChoosePreparer project={p} exec={exec} art={art} onDone={() => { setChoosing(false); onDone(); }} />;
  // The studio's and the media owner's work is checked and approved by the client; the client's own files are theirs already.
  const ready = art.state === 'ACCEPTED' || (art.departmentCode === 'A' && !!files.data?.length);
  const rejected = art.state === 'REVISION_REQUIRED';
  const moves = ['IN_QC', 'DELIVERED'].includes(art.state) ? art.availableTransitions : [forwardMove(art.availableTransitions)].filter((m): m is Transition => !!m);
  const handOff = async () => {
    try {
      await apiPost('/tasks', {
        projectId: p.id, workOrderId: exec.id, deliverableId: art.id, departmentCode: 'ME', assigneeId: exec.owner?.id,
        title: tr('اکران طرح تأییدشده — {0}', p.name), sourceType: 'ORDER_FORM', sourceRef: exec.code,
        description: tr('فایل‌های تأییدشدهٔ طرح اکران پیوست این وظیفه است.'),
      });
      toast(tr('فایل‌ها برای واحد محیطی فرستاده شد.'));
      onDone();
    } catch (e: any) { toast(e?.message ?? tr('ارسال ناموفق بود.'), 'danger'); }
  };
  return (
    <div className="space-y-3" data-testid="ooh-artwork">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>{tr('آماده‌سازی یا ری‌سایز: {0}', preparerOf(art.departmentCode))}{' '}<StagePill state={art.state} entity="deliverable" /></span>
        {art.dueDate && <DueText at={art.dueDate} />}
      </div>
      {art.description && <p className="whitespace-pre-line rounded-lg bg-ink-50/60 px-3 py-2 text-sm text-ink-700">{art.description}</p>}
      {studio && <ExecOrder project={p} exec={studio} onDone={onDone} />}
      <DeliverableFiles deliverableId={art.id} label={art.departmentCode === 'A' ? tr('گذاشتن فایل‌های مشتری') : tr('گذاشتن فایل طرح')} />
      {rejected && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {tr('مشتری طرح را تأیید نکرد. دوباره تصمیم بگیرید چه کسی اصلاح کند.')}
          {can('deliverable.write') && <Button size="sm" variant="secondary" className="ms-2" onClick={() => setChoosing(true)}>{tr('انتخاب دوباره')}</Button>}
        </div>
      )}
      {art.departmentCode !== 'A' && !!moves.length && <WorkflowActions minimal entity="deliverable" id={art.id} transitions={moves} onDone={onDone} />}
      {art.state === 'DELIVERED' && <ClientApprovalsPanel subjectType="DELIVERABLE" subjectId={art.id} />}
      {handedOff ? <p className="text-sm text-emerald-700">{tr('فایل‌های تأییدشده به واحد محیطی رسیده است.')}</p>
        : ready && can('task.write') && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 pt-3">
            <p className="text-sm text-ink-700">{tr('طرح آماده است. فایل‌ها را برای اجرا به واحد محیطی بفرستید.')}</p>
            <Button variant="primary" onClick={() => void handOff()}>{tr('ارسال فایل‌ها برای واحد محیطی')}</Button>
          </div>
        )}
    </div>
  );
}

function ChoosePreparer({ project: p, exec, art, onDone }: { project: Project360['project']; exec: Order; art?: Deliverable; onDone: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [who, setWho] = useDraftState<'CR' | 'ME' | 'A' | null>(tr('چه کسی طرح را آماده یا ری‌سایز می‌کند؟'), null);
  const [notes, setNotes] = useState(art?.description ?? '');
  const [due, setDue] = useState((art?.dueDate ?? p.plannedStart ?? '').slice(0, 10));
  const [studio, setStudio] = useState(false);
  if (!can('deliverable.write')) return <p className="text-sm text-ink-500">{tr('تصمیم دربارهٔ طرح اکران با اکانت است.')}</p>;
  // The artwork is one deliverable: made the first time, its preparer changed when the client sends it back.
  const record = async (departmentCode: 'CR' | 'ME' | 'A', workOrderId?: string) => {
    const body = { departmentCode, workOrderId, description: notes.trim() || undefined, dueDate: due || undefined };
    try {
      if (art) await apiPatch(`/deliverables/${art.id}`, body);
      else await apiPost('/deliverables', { ...body, projectId: p.id, kind: 'OOH_ARTWORK', name: tr('طرح اکران'), format: tr('فایل چاپی در ابعاد هر سازه') });
      toast(tr('طرح اکران ثبت شد: {0}.', preparerOf(departmentCode)));
      onDone();
    } catch (e: any) { toast(e?.message ?? tr('ثبت ناموفق بود.'), 'danger'); }
  };
  return (
    <div className="space-y-3" data-testid="ooh-preparer">
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={tr('چه کسی طرح را آماده یا ری‌سایز می‌کند؟')}>
        {PREPARERS.map((o) => (
          <button key={o.code} type="button" role="radio" aria-checked={who === o.code} onClick={() => { setWho(o.code); setStudio(false); }}
            className={`rounded-lg px-3 py-2.5 text-start text-sm ring-1 ${who === o.code ? 'bg-brand-50 text-brand-900 ring-brand-400' : 'bg-surface text-ink-800 ring-ink-200 hover:bg-ink-50'}`}>
            <span className="block font-bold">{o.title}</span>
            <span className="block text-[12.5px] text-ink-500">{o.hint}</span>
          </button>
        ))}
      </div>
      {who && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><Field label={tr('ابعاد سازه‌ها و توضیح')} hint={tr('برای ری‌سایز: ابعاد هر سازه و هر نکته‌ای که باید رعایت شود')}>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} aria-label={tr('ابعاد سازه‌ها و توضیح')} />
          </Field></div>
          <Field label={tr('تا کی آماده باشد؟')}><JalaliDateInput mode="date" value={due || null} onChange={setDue} label={tr('مهلت طرح اکران')} /></Field>
          <div className="flex items-end justify-end">
            {who === 'CR'
              ? !studio && <Button variant="primary" onClick={() => setStudio(true)}>{tr('نوشتن سفارش آتلیه')}</Button>
              : <Button variant="primary" onClick={() => void record(who, who === 'ME' ? exec.id : undefined)}>{tr('ثبت')}</Button>}
          </div>
        </div>
      )}
      {who === 'CR' && studio && (
        <UnitOrderForm unit="CR" projectId={p.id} onClose={() => setStudio(false)} onDone={(order) => void record('CR', order.id)} defaults={{
          title: tr('ری‌سایز طرح اکران — {0}', p.name),
          scopeOfWork: tr('آماده‌سازی و ری‌سایز طرح اکران در ابعاد هر سازه'),
          brief: notes.trim() || tr('طرح از مشتری گرفته شده است؛ ابعاد سازه‌ها در توضیح آمده.'),
          expectedOutput: tr('فایل‌های چاپی طرح در ابعاد هر سازه'),
          outputFormat: tr('فایل چاپی (PDF یا TIFF) و فایل لایه‌باز'),
          deadline: due,
        }} />
      )}
    </div>
  );
}

/** One report: its deadline, files, the next move, and — once with the client — the client's approval. */
function ReportRow({ d, onDone }: { d: Deliverable; onDone: () => void }) {
  const moves = ['IN_QC', 'DELIVERED'].includes(d.state) ? d.availableTransitions : [forwardMove(d.availableTransitions)].filter((m): m is Transition => !!m);
  return (
    <div className="space-y-2 rounded-lg bg-ink-50/60 p-3" data-testid="ooh-report">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium text-ink-800">{d.name}{' '}<StagePill state={d.state} entity="deliverable" /></span>
        {d.dueDate && d.state !== 'ACCEPTED' && <DueText at={d.dueDate} />}
      </div>
      <DeliverableFiles deliverableId={d.id} label={tr('گذاشتن عکس‌ها و فایل گزارش')} />
      {!!moves.length && <WorkflowActions minimal entity="deliverable" id={d.id} transitions={moves} onDone={onDone} />}
      {d.state === 'DELIVERED' && <ClientApprovalsPanel subjectType="DELIVERABLE" subjectId={d.id} />}
    </div>
  );
}
