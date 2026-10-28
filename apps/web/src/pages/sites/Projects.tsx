import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ASSIGNMENT_ROLE_LABELS, ASSIGNMENT_ROLES, CURRENCIES, NEGOTIATION_CHANNELS, NEGOTIATION_LABELS, NEGOTIATION_OUTCOMES, RENT_PERIOD_LABELS, RENT_PERIODS,
  SITE_PROJECT_WORKFLOW, stateLabelFa,
} from '@hiva/contracts';
import { apiDelete, apiGet, apiPatch, apiPost, downloadFile, type Page } from '../../lib/api';
import { useAuth, useSystemAdmin } from '../../lib/auth';
import { formatDate, formatDateTime, localDigits } from '../../lib/format';
import { PageBody, PageHeader } from '../../components/Shell';
import { Code, StateHistory, WorkflowActions } from '../../components/common';
import { FilePreview } from '../../components/Assets';
import { JalaliDateInput } from '../../components/JalaliDateInput';
import {
  Badge, Button, Card, Checkbox, DescRow, EmptyState, ErrorBlock, Field, IconPlus, IconSearch, Input, LoadingBlock, Modal, Pagination, Select,
  StateBadge, Table, Tabs, Td, Textarea, Th, Tr, cx, useToast,
} from '../../components/ui';
import { tr, trx } from '../../i18n';
import { AmountInput, Money, SitesNav, blank, money, pairLabel, useSiteOptions } from './shared';
import { FilterSelect, SavedViews } from './Venues';
import { PeopleSelect, RecordSelect, SiteUpload, VenueSelect } from './pickers';
import { ClosurePanel, ProjectLedger } from './Ledger';

/**
 * Deployment projects (ADR-103, module B): one placement in one venue, from the first look at the
 * place through the negotiation, the contract and its approvals, the installation and the people on
 * site, to the money and the closure. Each step's button is the workflow's own — it says what is still
 * missing before it is pressed.
 */

export interface Project {
  id: string; code: string; name: string; state: string; placement: string | null; currency: string; version: number; termsLocked: boolean;
  venueId: string; venue: { id: string; code: string; name: string; city: string; province: string; address: string | null; phone: string | null; contacts: { id: string; fullName: string; roleCode: string; phone: string | null; isPrimary: boolean }[] };
  responsible: { id: string; fullName: string } | null; responsibleId: string | null; createdBy: { fullName: string }; createdAt: string;
  project: { id: string; code: string; name: string } | null; projectId: string | null; company: { id: string; legalName: string; brandName: string | null } | null; companyId: string | null;
  cooperationCode: string | null; contractStart: string | null; contractEnd: string | null;
  depositAmount: string | null; rentAmount: string | null; rentPeriod: string; rentDueDay: number | null; rentMethodCode: string | null;
  chargeAmount: string | null; chargeDueDay: number | null; chargeMethodCode: string | null;
  installPlannedAt: string | null; installedAt: string | null; installDays: number | null; installStatus: string; installCost: string | null; transportCost: string | null; installNotes: string | null;
  notes: string | null; scheduleGeneratedAt: string | null; fabricationCost: string; closedAt: string | null; cancelReason: string | null;
  negotiations: Negotiation[]; contracts: Contract[]; approvals: Approval[]; counters: Counter[]; assignments: Assignment[]; documents: Doc[];
  availableTransitions: { action: string; labelFa: string; labelEn: string; requiresReason: boolean; to: string }[];
  balances: { currency: string; outstanding: string; overdue: string; deposit: { remaining: string; status: string } } | null;
}
interface Negotiation {
  id: string; heldAt: string; channel: string; summary: string; proposedRent: string | null; proposedRentPeriod: string | null; proposedDeposit: string | null; proposedCharge: string | null;
  otherTerms: string | null; outcome: string; nextAction: string | null; followUpAt: string | null; followUpDoneAt: string | null;
  assignee: { fullName: string } | null; createdBy: { fullName: string }; participants: { contact: { fullName: string } | null; user: { fullName: string } | null; name: string | null }[];
}
interface Contract { id: string; version: number; reference: string | null; status: string; terms: Record<string, string | null>; notes: string | null; submittedAt: string | null; decidedAt: string | null; decisionComment: string | null; createdBy: { id: string; fullName: string }; decidedBy: { fullName: string } | null; createdAt: string }
interface Approval { id: string; kind: string; subject: string | null; subjectId: string | null; decision: string; comment: string | null; approverName: string | null; approverTitle: string | null; decidedAt: string; decidedBy: { fullName: string } | null; recordedBy: { fullName: string } }
interface Counter { id: string; label: string; quantity: number; widthCm: number | null; depthCm: number | null; heightCm: number | null; specs: string | null; unitCost: string | null; totalCost?: string | null; supplier: { id: string; name: string } | null }
interface Assignment { id: string; role: string; user: { id: string; fullName: string } | null; personName: string | null; phone: string | null; startsOn: string | null; endsOn: string | null; shift: string | null; notes: string | null }
interface Doc { id: string; fileName: string; mimeType: string; siteRecordType: string | null; siteRecordId: string | null; caption: string | null; createdAt: string; uploadedBy: { fullName: string } }

const STATES = SITE_PROJECT_WORKFLOW.states.filter((s) => s !== 'CANCELLED');
const ask = (e: any) => e?.message ?? tr('عملیات ناموفق بود.');

export default function ProjectsPage() {
  const { id } = useParams();
  return id ? <ProjectDetail id={id} /> : <ProjectList />;
}

/* ── the list ────────────────────────────────────────────────────────────── */

function ProjectList() {
  const { can, canAny } = useAuth();
  const opts = useSiteOptions();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const keys = ['q', 'state', 'province', 'city', 'cooperationCode', 'open', 'page'] as const;
  const f = Object.fromEntries(keys.map((k) => [k, params.get(k) ?? ''])) as Record<(typeof keys)[number], string>;
  const set = (patch: Partial<typeof f>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    if (!('page' in patch)) next.delete('page');
    next.delete('new'); next.delete('venueId');
    setParams(next, { replace: true });
  };
  const [q, setQ] = useState(f.q);
  const [creating, setCreating] = useState(params.get('new') === '1');
  const query = { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), pageSize: '25' };
  const { data, isLoading, error, refetch } = useQuery<Page<Project & { overdueItems: number }>>({ queryKey: ['/site-projects', query], queryFn: () => apiGet('/site-projects', query) });
  return (
    <>
      <PageHeader title={tr('پروژه‌های استقرار')} subtitle={tr('هر پروژه: یک استقرار در یک مکان — از بررسی و مذاکره تا قرارداد، نصب، بهره‌برداری و تسویه')}
        actions={<div className="flex gap-2">
          <Button size="sm" onClick={() => void downloadFile(`/site-data/export/projects?${new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([k, v]) => v && ['state', 'province', 'city'].includes(k))))}`, 'projects.xlsx')}>{tr('خروجی اکسل')}</Button>
          {can('site.write') && <Button size="sm" variant="primary" onClick={() => setCreating(true)}><IconPlus className="size-4" />{tr('پروژهٔ تازه')}</Button>}
        </div>} />
      <PageBody>
        <SitesNav />
        <SavedViews page="projects" current={f} onApply={(filters) => setParams(new URLSearchParams(filters), { replace: true })} />
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 p-3">
            <form onSubmit={(e) => { e.preventDefault(); set({ q }); }} className="relative flex-1 basis-56 max-w-sm">
              <IconSearch className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-ink-400" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} className="ps-9" placeholder={tr('نام، کد، مکان یا محل استقرار…')} aria-label={tr('جستجو در پروژه‌ها')} />
            </form>
            <FilterSelect label={tr('وضعیت')} value={f.state} onChange={(v) => set({ state: v })} options={SITE_PROJECT_WORKFLOW.states.map((s) => ({ value: s, label: trx(stateLabelFa(s)) }))} />
            <FilterSelect label={tr('مدل همکاری')} value={f.cooperationCode} onChange={(v) => set({ cooperationCode: v })} options={opts.choices('COOPERATION')} />
            <Input value={f.city} onChange={(e) => set({ city: e.target.value })} placeholder={tr('شهر')} aria-label={tr('شهر')} className="w-32" />
            <Checkbox label={tr('فقط جاری‌ها')} checked={f.open === 'true'} onChange={(e) => set({ open: e.target.checked ? 'true' : '' })} />
          </div>
          {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={() => void refetch()} /> : !data?.items.length ? <EmptyState title={tr('پروژه‌ای نیست')} /> : (
            <>
              <Table>
                <thead className="bg-ink-50/60"><tr><Th>{tr('پروژه')}</Th><Th>{tr('مکان')}</Th><Th>{tr('وضعیت')}</Th><Th>{tr('مدل همکاری')}</Th><Th>{tr('دورهٔ قرارداد')}</Th><Th>{tr('مسئول')}</Th></tr></thead>
                <tbody>
                  {data.items.map((p) => (
                    <Tr key={p.id} onClick={() => navigate(`/sites/projects/${p.id}`)}>
                      <Td><p className="font-medium text-ink-800">{p.name}</p><span className="text-xs text-ink-500"><Code>{p.code}</Code>{p.project && <> · {p.project.name}</>}</span></Td>
                      <Td><span className="text-sm">{p.venue.name}</span><span className="block text-xs text-ink-500">{p.venue.city}{p.placement && ` · ${p.placement}`}</span></Td>
                      <Td><StateBadge state={p.state} />{canAny('rental.read') && p.overdueItems > 0 && <Badge tone="danger" className="ms-1">{tr('{0} معوق', localDigits(p.overdueItems))}</Badge>}</Td>
                      <Td><span className="text-xs">{opts.label('COOPERATION', p.cooperationCode)}</span></Td>
                      <Td><span className="text-xs">{p.contractStart ? `${formatDate(p.contractStart)} — ${formatDate(p.contractEnd)}` : '—'}</span></Td>
                      <Td><span className="text-xs">{p.responsible?.fullName ?? '—'}</span></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={data.page} pageCount={data.pageCount} total={data.total} onChange={(pg) => set({ page: String(pg) })} />
            </>
          )}
        </Card>
      </PageBody>
      {creating && <ProjectForm venueId={params.get('venueId')} onClose={() => setCreating(false)} onSaved={(pid) => navigate(`/sites/projects/${pid}`)} />}
    </>
  );
}

/* ── the form ────────────────────────────────────────────────────────────── */

const num = (v: string | null | undefined) => v ?? '';

export function ProjectForm({ project, venueId, onClose, onSaved }: { project?: Project; venueId?: string | null; onClose: () => void; onSaved?: (id: string) => void }) {
  const opts = useSiteOptions();
  const toast = useToast();
  const qc = useQueryClient();
  const locked = !!project?.termsLocked;
  const [p, setP] = useState({
    name: project?.name ?? '', venueId: project?.venueId ?? venueId ?? null, placement: project?.placement ?? '', projectId: project?.projectId ?? null, companyId: project?.companyId ?? null,
    responsibleId: project?.responsibleId ?? null, cooperationCode: project?.cooperationCode ?? '', currency: project?.currency ?? 'IRR',
    contractStart: project?.contractStart ?? '', contractEnd: project?.contractEnd ?? '',
    depositAmount: num(project?.depositAmount), rentAmount: num(project?.rentAmount), rentPeriod: project?.rentPeriod ?? 'MONTHLY', rentDueDay: project?.rentDueDay ?? 0, rentMethodCode: project?.rentMethodCode ?? '',
    chargeAmount: num(project?.chargeAmount), chargeDueDay: project?.chargeDueDay ?? 0, chargeMethodCode: project?.chargeMethodCode ?? '',
    installPlannedAt: project?.installPlannedAt ?? '', installCost: num(project?.installCost), transportCost: num(project?.transportCost), notes: project?.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const up = (patch: Partial<typeof p>) => setP((x) => ({ ...x, ...patch }));
  const cheque = (code: string) => opts.all.find((o) => o.list === 'PAYMENT_METHOD' && o.code === code)?.meta.isCheque;
  const save = async () => {
    setBusy(true);
    const body: Record<string, unknown> = {
      name: p.name, venueId: p.venueId, placement: p.placement || null, projectId: p.projectId, companyId: p.companyId, responsibleId: p.responsibleId,
      installPlannedAt: p.installPlannedAt || null, installCost: p.installCost || null, transportCost: p.transportCost || null, notes: p.notes || null,
      ...(locked ? {} : {
        cooperationCode: blank(p.cooperationCode), currency: p.currency, contractStart: p.contractStart || null, contractEnd: p.contractEnd || null,
        depositAmount: p.depositAmount || null, rentAmount: p.rentAmount || null, rentPeriod: p.rentPeriod, rentDueDay: Number(p.rentDueDay) || 0, rentMethodCode: blank(p.rentMethodCode),
        chargeAmount: p.chargeAmount || null, chargeDueDay: Number(p.chargeDueDay) || 0, chargeMethodCode: blank(p.chargeMethodCode),
      }),
    };
    if (locked) delete body.venueId;
    try {
      if (project) {
        await apiPatch(`/site-projects/${project.id}`, { ...body, version: project.version });
        toast(tr('پروژه به‌روز شد.'));
      } else {
        const made = await apiPost<{ id: string }>('/site-projects', body);
        toast(tr('پروژه ثبت شد.'));
        onSaved?.(made.id);
      }
      await qc.invalidateQueries();
      onClose();
    } catch (e) { toast(ask(e), 'danger'); } finally { setBusy(false); }
  };
  const methods = opts.choices('PAYMENT_METHOD');
  return (
    <Modal open onClose={onClose} wide title={project ? tr('ویرایش {0}', project.name) : tr('پروژهٔ استقرار تازه')}
      footer={<><Button onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" loading={busy} disabled={!p.name || !p.venueId} onClick={() => void save()}>{tr('ثبت')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('نام پروژه')} required><Input value={p.name} onChange={(e) => up({ name: e.target.value })} /></Field>
        <Field label={tr('مکان')} required hint={locked ? tr('مکان پس از فرستادن قرارداد تغییر نمی‌کند.') : undefined}>
          {locked ? <Input disabled value={project!.venue.name} /> : <VenueSelect value={p.venueId} onChange={(v) => up({ venueId: v })} initialLabel={project?.venue.name} />}
        </Field>
        <Field label={tr('محل استقرار در مکان')}><Input value={p.placement} onChange={(e) => up({ placement: e.target.value })} placeholder={tr('مثلاً طبقهٔ همکف، کنار ورودی شمالی')} /></Field>
        <Field label={tr('مسئول پروژه')}><PeopleSelect label={tr('مسئول پروژه')} value={p.responsibleId} onChange={(v) => up({ responsibleId: v })} /></Field>
        <Field label={tr('پروژهٔ مشتری')}><RecordSelect path="/projects" label={tr('پروژهٔ مشتری')} value={p.projectId} onChange={(v) => up({ projectId: v })} render={(r) => `${r.code} — ${r.name}`} /></Field>
        <Field label={tr('کارفرما (مشتری)')}><RecordSelect path="/companies" label={tr('کارفرما')} value={p.companyId} onChange={(v) => up({ companyId: v })} render={(r) => r.brandName || r.legalName} /></Field>
      </div>
      <fieldset disabled={locked} className="mt-4 rounded-lg p-3 ring-1 ring-ink-100">
        <legend className="px-1 text-sm font-bold text-ink-800">{tr('شرایط تجاری')}{locked && <span className="ms-2 text-xs font-normal text-amber-700">{tr('قرارداد این شرایط را تعیین کرده؛ برای تغییر، الحاقیه ثبت کنید.')}</span>}</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={tr('مدل همکاری')}><Select value={p.cooperationCode} onChange={(e) => up({ cooperationCode: e.target.value })}><option value="">{tr('— برگزینید —')}</option>{opts.choices('COOPERATION').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
          <Field label={tr('آغاز قرارداد')}><JalaliDateInput value={p.contractStart} onChange={(v) => up({ contractStart: v })} label={tr('آغاز قرارداد')} /></Field>
          <Field label={tr('پایان قرارداد')}><JalaliDateInput value={p.contractEnd} onChange={(v) => up({ contractEnd: v })} label={tr('پایان قرارداد')} /></Field>
          <Field label={tr('مبلغ ودیعه')}><AmountInput value={p.depositAmount} onChange={(v) => up({ depositAmount: v })} aria-label={tr('مبلغ ودیعه')} /></Field>
          <Field label={tr('مبلغ اجاره')}><AmountInput value={p.rentAmount} onChange={(v) => up({ rentAmount: v })} aria-label={tr('مبلغ اجاره')} /></Field>
          <Field label={tr('دورهٔ اجاره')}><Select value={p.rentPeriod} onChange={(e) => up({ rentPeriod: e.target.value })}>{RENT_PERIODS.map((r) => <option key={r} value={r}>{pairLabel(RENT_PERIOD_LABELS, r)}</option>)}</Select></Field>
          <Field label={tr('سررسید اجاره (روز پس از آغاز دوره)')}><Input type="number" min={0} max={27} value={p.rentDueDay} onChange={(e) => up({ rentDueDay: Number(e.target.value) })} /></Field>
          <Field label={tr('نحوهٔ پرداخت اجاره')} hint={cheque(p.rentMethodCode) ? tr('شمارهٔ و تاریخ هر چک هنگام ثبت پرداخت پرسیده می‌شود.') : undefined}><Select value={p.rentMethodCode} onChange={(e) => up({ rentMethodCode: e.target.value })}><option value="">—</option>{methods.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
          <Field label={tr('ارز')}><Select value={p.currency} onChange={(e) => up({ currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>
          <Field label={tr('شارژ ماهیانه')}><AmountInput value={p.chargeAmount} onChange={(v) => up({ chargeAmount: v })} aria-label={tr('شارژ ماهیانه')} /></Field>
          <Field label={tr('سررسید شارژ (روز پس از آغاز دوره)')}><Input type="number" min={0} max={27} value={p.chargeDueDay} onChange={(e) => up({ chargeDueDay: Number(e.target.value) })} /></Field>
          <Field label={tr('نحوهٔ پرداخت شارژ')}><Select value={p.chargeMethodCode} onChange={(e) => up({ chargeMethodCode: e.target.value })}><option value="">—</option>{methods.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
        </div>
      </fieldset>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Field label={tr('تاریخ برنامهٔ نصب')}><JalaliDateInput value={p.installPlannedAt} onChange={(v) => up({ installPlannedAt: v })} label={tr('تاریخ برنامهٔ نصب')} /></Field>
        <Field label={tr('هزینهٔ نصب')}><AmountInput value={p.installCost} onChange={(v) => up({ installCost: v })} aria-label={tr('هزینهٔ نصب')} /></Field>
        <Field label={tr('هزینهٔ حمل و نقل')}><AmountInput value={p.transportCost} onChange={(v) => up({ transportCost: v })} aria-label={tr('هزینهٔ حمل و نقل')} /></Field>
        <div className="sm:col-span-3"><Field label={tr('یادداشت')}><Textarea value={p.notes} onChange={(e) => up({ notes: e.target.value })} /></Field></div>
      </div>
    </Modal>
  );
}

/* ── the project ─────────────────────────────────────────────────────────── */

function ProjectDetail({ id }: { id: string }) {
  const { can } = useAuth();
  const opts = useSiteOptions();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'summary';
  const setTab = (t: string) => { const n = new URLSearchParams(params); n.set('tab', t); setParams(n, { replace: true }); };
  const { data: p, isLoading, error, refetch } = useQuery<Project>({ queryKey: ['/site-projects', id], queryFn: () => apiGet(`/site-projects/${id}`) });
  const [editing, setEditing] = useState(false);
  if (isLoading) return <LoadingBlock />;
  if (error || !p) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  const open = !['CLOSED', 'CANCELLED'].includes(p.state);
  // A contract is decided on its version, in the contract tab: the decision and the move are one.
  const moves = p.availableTransitions.filter((t) => !['approve_contract', 'reject_contract'].includes(t.action));
  const pendingContract = p.contracts.find((c) => c.status === 'PENDING_APPROVAL');
  const tabs = [
    { key: 'summary', label: tr('خلاصه و روند') },
    { key: 'negotiations', label: tr('مذاکره‌ها'), count: p.negotiations.length },
    { key: 'contract', label: tr('قرارداد و تأییدها'), count: pendingContract ? 1 : undefined },
    { key: 'installation', label: tr('نصب و نیروها') },
    ...(can('rental.read') ? [{ key: 'finance', label: tr('اجاره و پرداخت‌ها') }, { key: 'closure', label: tr('تسویه و بستن') }] : []),
    { key: 'files', label: tr('پیوست‌ها'), count: p.documents.length },
  ];
  return (
    <>
      <PageHeader title={p.name} subtitle={<><Link to={`/sites/venues/${p.venue.id}`} className="text-brand-700 hover:underline">{p.venue.name}</Link> · {p.venue.city}{p.placement && ` · ${p.placement}`} · <Code>{p.code}</Code></>}
        badge={<StateBadge state={p.state} />}
        actions={<div className="flex flex-wrap gap-2">
          {open && can('site.write') && <Button size="sm" onClick={() => setEditing(true)}>{tr('ویرایش')}</Button>}
          <Link to="/sites/projects"><Button size="sm" variant="ghost">{tr('همهٔ پروژه‌ها')}</Button></Link>
        </div>} />
      <PageBody>
        <SitesNav />
        <Lifecycle state={p.state} />
        {moves.length > 0 && <div className="mb-4"><WorkflowActions entity="siteProject" id={p.id} transitions={moves} onDone={() => void refetch()} /></div>}
        {pendingContract && can('site.contract.approve') && tab !== 'contract' && (
          <div className="mb-4 rounded-lg bg-amber-50 p-3 text-sm ring-1 ring-amber-200">{tr('نسخهٔ {0} قرارداد منتظر تصمیم شماست.', localDigits(pendingContract.version))} <button type="button" className="font-semibold text-brand-700 underline" onClick={() => setTab('contract')}>{tr('بررسی قرارداد')}</button></div>
        )}
        <Card>
          <Tabs tabs={tabs} active={tab} onChange={setTab} />
          <div className="p-4">
            {tab === 'summary' && <Summary p={p} opts={opts} />}
            {tab === 'negotiations' && <Negotiations p={p} open={open} />}
            {tab === 'contract' && <ContractTab p={p} open={open} />}
            {tab === 'installation' && <Installation p={p} open={open} />}
            {tab === 'finance' && <ProjectLedger project={p} />}
            {tab === 'closure' && <ClosurePanel project={p} />}
            {tab === 'files' && <Files p={p} open={open} />}
          </div>
        </Card>
        <div className="mt-5"><StateHistory entity="siteProject" id={p.id} /></div>
      </PageBody>
      {editing && <ProjectForm project={p} onClose={() => setEditing(false)} />}
    </>
  );
}

function Lifecycle({ state }: { state: string }) {
  const at = STATES.indexOf(state);
  return (
    <ol aria-label={tr('مراحل پروژه')} className="mb-4 flex gap-1 overflow-x-auto rounded-xl bg-surface p-2 ring-1 ring-edge">
      {state === 'CANCELLED' ? <li className="px-2 text-sm font-semibold text-rose-700">{tr('این پروژه لغو شده است؛ سوابقش می‌ماند.')}</li> : STATES.map((s, i) => (
        <li key={s} aria-current={i === at ? 'step' : undefined}
          className={cx('whitespace-nowrap rounded-lg px-2 py-1 text-xs font-semibold', i < at ? 'bg-emerald-50 text-emerald-800' : i === at ? 'bg-brand-600 text-white' : 'text-ink-400')}>
          {localDigits(i + 1)}. {trx(stateLabelFa(s))}
        </li>
      ))}
    </ol>
  );
}

function Summary({ p, opts }: { p: Project; opts: ReturnType<typeof useSiteOptions> }) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <dl className="divide-y divide-ink-100">
        <DescRow label={tr('مدل همکاری')}>{opts.label('COOPERATION', p.cooperationCode)}</DescRow>
        <DescRow label={tr('دورهٔ قرارداد')}>{p.contractStart ? `${formatDate(p.contractStart)} — ${formatDate(p.contractEnd)}` : '—'}</DescRow>
        <DescRow label={tr('ودیعه')}><Money value={p.depositAmount} currency={p.currency} exact /></DescRow>
        <DescRow label={tr('اجاره')}><Money value={p.rentAmount} currency={p.currency} exact /> {p.rentAmount && <span className="text-xs text-ink-500">{pairLabel(RENT_PERIOD_LABELS, p.rentPeriod)} · {opts.label('PAYMENT_METHOD', p.rentMethodCode)}</span>}</DescRow>
        <DescRow label={tr('شارژ ماهیانه')}><Money value={p.chargeAmount} currency={p.currency} exact /> {p.chargeAmount && <span className="text-xs text-ink-500">{opts.label('PAYMENT_METHOD', p.chargeMethodCode)}</span>}</DescRow>
        <DescRow label={tr('مسئول')}>{p.responsible?.fullName ?? '—'}</DescRow>
        <DescRow label={tr('پروژهٔ مشتری')}>{p.project ? <Link to={`/projects/${p.project.id}`} className="text-brand-700 hover:underline">{p.project.name}</Link> : '—'}</DescRow>
        <DescRow label={tr('کارفرما')}>{p.company ? p.company.brandName || p.company.legalName : '—'}</DescRow>
      </dl>
      <dl className="divide-y divide-ink-100">
        <DescRow label={tr('نصب')}><StateBadge state={p.installStatus} /> {p.installPlannedAt && <span className="text-xs">{tr('برنامه: {0}', formatDate(p.installPlannedAt))}</span>} {p.installedAt && <span className="text-xs">{tr('انجام: {0}', formatDate(p.installedAt))}</span>}</DescRow>
        <DescRow label={tr('هزینهٔ نصب')}><Money value={p.installCost} currency={p.currency} /></DescRow>
        <DescRow label={tr('هزینهٔ حمل و نقل')}><Money value={p.transportCost} currency={p.currency} /></DescRow>
        <DescRow label={tr('ساخت کانترها')}><Money value={p.fabricationCost} currency={p.currency} /> <span className="text-xs text-ink-500">{tr('{0} کانتر', localDigits(p.counters.reduce((s, c) => s + c.quantity, 0)))}</span></DescRow>
        <DescRow label={tr('نیروهای مستقر')}>{localDigits(p.assignments.length)}</DescRow>
        {p.balances && <DescRow label={tr('مانده')}><Money value={p.balances.outstanding} currency={p.currency} tone={Number(p.balances.overdue) > 0 ? 'danger' : undefined} />{Number(p.balances.overdue) > 0 && <span className="ms-2 text-xs text-rose-700">{tr('سررسیدگذشته:')} <Money value={p.balances.overdue} currency={p.currency} /></span>}</DescRow>}
        {p.balances && <DescRow label={tr('ودیعهٔ نزد مکان')}><Money value={p.balances.deposit.remaining} currency={p.currency} /> <StateBadge state={p.balances.deposit.status === 'NONE' ? 'NOT_STARTED' : p.balances.deposit.status === 'PARTIAL' ? 'HELD' : p.balances.deposit.status} /></DescRow>}
        <DescRow label={tr('ثبت')}>{p.createdBy.fullName} · {formatDate(p.createdAt)}</DescRow>
        {p.cancelReason && <DescRow label={tr('دلیل لغو')}>{p.cancelReason}</DescRow>}
      </dl>
      {p.notes && <p className="whitespace-pre-line text-sm text-ink-700 lg:col-span-2">{p.notes}</p>}
    </div>
  );
}

/* negotiations */

function Negotiations({ p, open }: { p: Project; open: boolean }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const proposals = [...p.negotiations].reverse().filter((n) => n.proposedRent || n.proposedDeposit || n.proposedCharge);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-600">{tr('هر گفت‌وگو با مکان — پیش از قرارداد و پس از آن — با پیشنهادها و پیگیری بعدی.')}</p>
        {open && can('site.write') && <Button size="sm" variant="primary" onClick={() => setAdding(true)}><IconPlus className="size-4" />{tr('ثبت مذاکره')}</Button>}
      </div>
      {proposals.length > 1 && (
        <div className="overflow-x-auto">
          <h3 className="mb-1 text-sm font-bold">{tr('مقایسهٔ پیشنهادها')}</h3>
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>{tr('تاریخ')}</Th><Th>{tr('اجاره')}</Th><Th>{tr('ودیعه')}</Th><Th>{tr('شارژ')}</Th><Th>{tr('نتیجه')}</Th></tr></thead>
            <tbody>{proposals.map((n, i) => {
              const prev = proposals[i - 1];
              const delta = (a: string | null, b: string | null | undefined) => (a && b && a !== b ? (Number(a) < Number(b) ? ' ↓' : ' ↑') : '');
              return (
                <Tr key={n.id}>
                  <Td>{formatDate(n.heldAt)}</Td>
                  <Td><Money value={n.proposedRent} currency={p.currency} />{delta(n.proposedRent, prev?.proposedRent)}</Td>
                  <Td><Money value={n.proposedDeposit} currency={p.currency} />{delta(n.proposedDeposit, prev?.proposedDeposit)}</Td>
                  <Td><Money value={n.proposedCharge} currency={p.currency} />{delta(n.proposedCharge, prev?.proposedCharge)}</Td>
                  <Td><Badge tone={n.outcome === 'AGREED' ? 'success' : n.outcome === 'REJECTED' ? 'danger' : 'neutral'}>{pairLabel(NEGOTIATION_LABELS, n.outcome)}</Badge></Td>
                </Tr>
              );
            })}</tbody>
          </Table>
        </div>
      )}
      {!p.negotiations.length ? <EmptyState title={tr('مذاکره‌ای ثبت نشده')} /> : (
        <ol className="space-y-3">
          {p.negotiations.map((n) => (
            <li key={n.id} className="rounded-lg p-3 ring-1 ring-ink-100">
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
                <span className="font-semibold text-ink-700">{formatDateTime(n.heldAt)}</span><Badge>{pairLabel(NEGOTIATION_LABELS, n.channel)}</Badge>
                <Badge tone={n.outcome === 'AGREED' ? 'success' : n.outcome === 'REJECTED' ? 'danger' : 'info'}>{pairLabel(NEGOTIATION_LABELS, n.outcome)}</Badge>
                <span>{tr('ثبت: {0}', n.createdBy.fullName)}</span>
              </div>
              <p className="mt-1 whitespace-pre-line text-sm text-ink-800">{n.summary}</p>
              {n.otherTerms && <p className="mt-1 text-xs text-ink-600">{tr('سایر شرایط: {0}', n.otherTerms)}</p>}
              {n.participants.length > 0 && <p className="mt-1 text-xs text-ink-600">{tr('حاضران: {0}', n.participants.map((x) => x.contact?.fullName ?? x.user?.fullName ?? x.name).filter(Boolean).join('، '))}</p>}
              {(n.nextAction || n.followUpAt) && (
                <div className={cx('mt-2 flex flex-wrap items-center gap-2 rounded-md px-2 py-1 text-xs', n.followUpDoneAt ? 'bg-emerald-50 text-emerald-800' : n.followUpAt && new Date(n.followUpAt) < new Date() ? 'bg-rose-50 text-rose-800' : 'bg-amber-50 text-amber-900')}>
                  <span>{tr('اقدام بعدی: {0}', n.nextAction ?? '—')}</span>
                  {n.followUpAt && <span>{tr('پیگیری: {0}', formatDate(n.followUpAt))}</span>}
                  {n.assignee && <span>{tr('با {0}', n.assignee.fullName)}</span>}
                  {n.followUpDoneAt ? <span>{tr('انجام شد')}</span> : open && can('site.write') && (
                    <Button size="sm" variant="ghost" onClick={async () => { try { await apiPatch(`/site-negotiations/${n.id}`, { followUpDone: true }); toast(tr('پیگیری انجام شد.')); await qc.invalidateQueries(); } catch (e) { toast(ask(e), 'danger'); } }}>{tr('پیگیری انجام شد')}</Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {adding && <NegotiationForm p={p} onClose={() => setAdding(false)} />}
    </div>
  );
}

function NegotiationForm({ p, onClose }: { p: Project; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [n, setN] = useState({
    heldAt: new Date().toISOString(), channel: 'MEETING', summary: '', proposedRent: '', proposedRentPeriod: p.rentPeriod, proposedDeposit: '', proposedCharge: '', otherTerms: '',
    outcome: 'OPEN', nextAction: '', followUpAt: '', assigneeId: p.responsibleId, contactIds: [] as string[], others: '',
  });
  const up = (patch: Partial<typeof n>) => setN((x) => ({ ...x, ...patch }));
  const save = async () => {
    try {
      await apiPost(`/site-projects/${p.id}/negotiations`, {
        heldAt: n.heldAt, channel: n.channel, summary: n.summary, proposedRent: n.proposedRent || null, proposedRentPeriod: n.proposedRent ? n.proposedRentPeriod : null,
        proposedDeposit: n.proposedDeposit || null, proposedCharge: n.proposedCharge || null, otherTerms: n.otherTerms || null, outcome: n.outcome,
        nextAction: n.nextAction || null, followUpAt: n.followUpAt || null, assigneeId: n.assigneeId, contactIds: n.contactIds,
        otherParticipants: n.others.split(/[,،]/).map((x) => x.trim()).filter((x) => x.length >= 2),
      });
      toast(tr('مذاکره ثبت شد.')); await qc.invalidateQueries(); onClose();
    } catch (e) { toast(ask(e), 'danger'); }
  };
  return (
    <Modal open onClose={onClose} wide title={tr('ثبت مذاکره')} footer={<><Button onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" disabled={n.summary.trim().length < 3} onClick={() => void save()}>{tr('ثبت')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={tr('زمان')} required><JalaliDateInput mode="datetime" value={n.heldAt} onChange={(v) => up({ heldAt: v })} label={tr('زمان')} /></Field>
        <Field label={tr('نوع')}><Select value={n.channel} onChange={(e) => up({ channel: e.target.value })}>{NEGOTIATION_CHANNELS.map((c) => <option key={c} value={c}>{pairLabel(NEGOTIATION_LABELS, c)}</option>)}</Select></Field>
        <Field label={tr('نتیجه')}><Select value={n.outcome} onChange={(e) => up({ outcome: e.target.value })}>{NEGOTIATION_OUTCOMES.map((c) => <option key={c} value={c}>{pairLabel(NEGOTIATION_LABELS, c)}</option>)}</Select></Field>
        <div className="sm:col-span-3"><Field label={tr('خلاصهٔ گفت‌وگو')} required><Textarea value={n.summary} onChange={(e) => up({ summary: e.target.value })} /></Field></div>
        <Field label={tr('اجارهٔ پیشنهادی')}><AmountInput value={n.proposedRent} onChange={(v) => up({ proposedRent: v })} aria-label={tr('اجارهٔ پیشنهادی')} /></Field>
        <Field label={tr('ودیعهٔ پیشنهادی')}><AmountInput value={n.proposedDeposit} onChange={(v) => up({ proposedDeposit: v })} aria-label={tr('ودیعهٔ پیشنهادی')} /></Field>
        <Field label={tr('شارژ پیشنهادی')}><AmountInput value={n.proposedCharge} onChange={(v) => up({ proposedCharge: v })} aria-label={tr('شارژ پیشنهادی')} /></Field>
        <div className="sm:col-span-3"><Field label={tr('سایر هزینه‌ها یا امتیازها')}><Input value={n.otherTerms} onChange={(e) => up({ otherTerms: e.target.value })} /></Field></div>
        <div className="sm:col-span-3">
          <span className="mb-1 block text-xs font-bold text-ink-700">{tr('حاضران از مکان')}</span>
          <div className="flex flex-wrap gap-3">{p.venue.contacts.map((c) => (
            <Checkbox key={c.id} label={c.fullName} checked={n.contactIds.includes(c.id)} onChange={(e) => up({ contactIds: e.target.checked ? [...n.contactIds, c.id] : n.contactIds.filter((x) => x !== c.id) })} />
          ))}</div>
        </div>
        <div className="sm:col-span-3"><Field label={tr('دیگر حاضران')} hint={tr('با ویرگول جدا کنید')}><Input value={n.others} onChange={(e) => up({ others: e.target.value })} /></Field></div>
        <Field label={tr('اقدام بعدی')}><Input value={n.nextAction} onChange={(e) => up({ nextAction: e.target.value })} /></Field>
        <Field label={tr('تاریخ پیگیری')}><JalaliDateInput value={n.followUpAt} onChange={(v) => up({ followUpAt: v })} label={tr('تاریخ پیگیری')} /></Field>
        <Field label={tr('پیگیری با')}><PeopleSelect label={tr('پیگیری با')} value={n.assigneeId} onChange={(v) => up({ assigneeId: v })} /></Field>
      </div>
    </Modal>
  );
}

/* the contract and its approvals */

function ContractTab({ p, open }: { p: Project; open: boolean }) {
  const { can, user } = useAuth();
  const systemAdmin = useSystemAdmin();
  const toast = useToast();
  const qc = useQueryClient();
  const opts = useSiteOptions();
  const [deciding, setDeciding] = useState<{ c: Contract; decision: 'APPROVE' | 'REJECT' } | null>(null);
  const [comment, setComment] = useState('');
  const [newVersion, setNewVersion] = useState(false);
  const [employer, setEmployer] = useState(false);
  const approvedBefore = p.approvals.some((a) => a.kind === 'CONTRACT' && a.decision === 'APPROVED');
  const filesOf = (kind: string, rid: string) => p.documents.filter((d) => d.siteRecordType === kind && d.siteRecordId === rid);
  const run = async (fn: () => Promise<unknown>, done: string) => { try { await fn(); toast(done); await qc.invalidateQueries(); } catch (e) { toast(ask(e), 'danger'); } };
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold">{tr('نسخه‌های قرارداد')}</h3>
          {open && can('site.write') && !['DRAFT', 'EVALUATION'].includes(p.state) && <Button size="sm" variant="primary" onClick={() => setNewVersion(true)}>{approvedBefore ? tr('الحاقیهٔ تازه') : tr('ثبت قرارداد')}</Button>}
        </div>
        {!p.contracts.length ? <EmptyState title={tr('قراردادی ثبت نشده')} description={tr('پس از توافق بر شرایط، قرارداد را با فایلش ثبت و برای تأیید بفرستید.')} /> : p.contracts.map((c) => (
          <div key={c.id} className={cx('rounded-lg p-3 ring-1', c.status === 'SUPERSEDED' ? 'opacity-70 ring-ink-100' : 'ring-ink-200')}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold">{tr('نسخهٔ {0}', localDigits(c.version))}</span><StateBadge state={c.status} />
              {c.reference && <span className="text-xs text-ink-500">{tr('شماره: {0}', c.reference)}</span>}
              <span className="text-xs text-ink-500">{c.createdBy.fullName} · {formatDate(c.createdAt)}</span>
            </div>
            <p className="mt-1 text-xs text-ink-600">
              {tr('اجاره {0} · شارژ {1} · ودیعه {2} · {3} تا {4}', money(c.terms.rentAmount, p.currency), money(c.terms.chargeAmount, p.currency), money(c.terms.depositAmount, p.currency), formatDate(c.terms.contractStart), formatDate(c.terms.contractEnd))}
              {' · '}{opts.label('COOPERATION', c.terms.cooperationCode)}
            </p>
            {c.decidedAt && <p className="mt-1 text-xs">{c.status === 'REJECTED' ? tr('رد شد') : tr('تأیید شد')} — {c.decidedBy?.fullName} · {formatDateTime(c.decidedAt)}{c.decisionComment && `: ${c.decisionComment}`}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {filesOf('contract', c.id).map((d) => <span key={d.id} className="text-xs"><FileLink doc={d} /></span>)}
              {['DRAFT', 'PENDING_APPROVAL'].includes(c.status) && open && can('site.write') && <SiteUpload label={tr('پیوست فایل قرارداد')} fields={{ siteProjectId: p.id, siteRecordType: 'contract', siteRecordId: c.id }} accept="application/pdf,image/*" />}
              {c.status === 'DRAFT' && open && can('site.write') && <Button size="sm" variant="primary" onClick={() => void run(() => apiPost(`/site-contracts/${c.id}/submit`), tr('قرارداد برای تأیید فرستاده شد.'))}>{tr('فرستادن برای تأیید')}</Button>}
              {c.status === 'PENDING_APPROVAL' && can('site.contract.approve') && (
                c.createdBy.id === user?.id && !systemAdmin
                  ? <span className="text-xs text-ink-500">{tr('نسخه‌ای را که خودتان نوشته‌اید همکار دیگری تأیید می‌کند.')}</span>
                  : <>
                    <Button size="sm" variant="primary" onClick={() => { setComment(''); setDeciding({ c, decision: 'APPROVE' }); }}>{tr('تأیید قرارداد')}</Button>
                    <Button size="sm" variant="danger" onClick={() => { setComment(''); setDeciding({ c, decision: 'REJECT' }); }}>{tr('رد قرارداد')}</Button>
                  </>
              )}
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold">{tr('تأییدها')}</h3>
          {open && can('site.write') && <Button size="sm" onClick={() => setEmployer(true)}>{tr('ثبت تأییدیهٔ کارفرما')}</Button>}
        </div>
        {!p.approvals.length ? <EmptyState title={tr('تأییدی ثبت نشده')} /> : (
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>{tr('نوع')}</Th><Th>{tr('تصمیم')}</Th><Th>{tr('تصمیم‌گیرنده')}</Th><Th>{tr('زمان')}</Th><Th>{tr('شاهد')}</Th></tr></thead>
            <tbody>{p.approvals.map((a) => (
              <Tr key={a.id}>
                <Td>{a.kind === 'CONTRACT' ? tr('قرارداد') : a.kind === 'EMPLOYER' ? tr('کارفرما') : tr('کسر از ودیعه')}{a.subject && a.kind === 'EMPLOYER' && <span className="block text-xs text-ink-500">{a.subject === 'INSTALLATION' ? tr('نصب') : a.subject === 'CONTRACT' ? tr('قرارداد') : tr('کلی')}</span>}</Td>
                <Td><StateBadge state={a.decision} />{a.comment && <span className="block text-xs text-ink-600">{a.comment}</span>}</Td>
                <Td>{a.decidedBy?.fullName ?? `${a.approverName ?? ''}${a.approverTitle ? ` (${a.approverTitle})` : ''}`}<span className="block text-xs text-ink-500">{tr('ثبت: {0}', a.recordedBy.fullName)}</span></Td>
                <Td><span className="text-xs">{formatDate(a.decidedAt)}</span></Td>
                <Td>
                  <div className="flex flex-wrap gap-1">{filesOf('approval', a.id).map((d) => <FileLink key={d.id} doc={d} />)}</div>
                  {a.kind === 'EMPLOYER' && open && can('site.write') && <SiteUpload label={tr('عکس تأییدیه')} fields={{ siteProjectId: p.id, siteRecordType: 'approval', siteRecordId: a.id }} accept="image/*,application/pdf" />}
                </Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </section>

      {deciding && (
        <Modal open onClose={() => setDeciding(null)} title={deciding.decision === 'APPROVE' ? tr('تأیید نسخهٔ {0}', localDigits(deciding.c.version)) : tr('رد نسخهٔ {0}', localDigits(deciding.c.version))}
          footer={<><Button onClick={() => setDeciding(null)}>{tr('انصراف')}</Button><Button variant={deciding.decision === 'APPROVE' ? 'primary' : 'danger'} disabled={deciding.decision === 'REJECT' && comment.trim().length < 3}
            onClick={() => void run(() => apiPost(`/site-contracts/${deciding.c.id}/decision`, { decision: deciding.decision, comment: comment || null }), deciding.decision === 'APPROVE' ? tr('قرارداد تأیید شد.') : tr('قرارداد رد شد.')).then(() => setDeciding(null))}>{tr('ثبت تصمیم')}</Button></>}>
          {!filesOf('contract', deciding.c.id).length && <p className="mb-2 text-sm text-amber-700">{tr('این نسخه فایلی ندارد.')}</p>}
          <Field label={deciding.decision === 'REJECT' ? tr('دلیل رد') : tr('توضیح')} required={deciding.decision === 'REJECT'}><Textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        </Modal>
      )}
      {newVersion && <ContractVersionForm p={p} amendment={approvedBefore} onClose={() => setNewVersion(false)} />}
      {employer && <EmployerApprovalForm p={p} onClose={() => setEmployer(false)} />}
    </div>
  );
}

function FileLink({ doc }: { doc: Doc }) {
  return <button type="button" className="text-xs text-brand-700 underline" onClick={() => void downloadFile(`/documents/${doc.id}/download`, doc.fileName)}>{doc.fileName}</button>;
}

function ContractVersionForm({ p, amendment, onClose }: { p: Project; amendment: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [c, setC] = useState({ reference: '', notes: '', rentAmount: num(p.rentAmount), chargeAmount: num(p.chargeAmount), depositAmount: num(p.depositAmount), contractEnd: p.contractEnd ?? '' });
  const save = async () => {
    try {
      const terms = amendment ? {
        ...(c.rentAmount !== num(p.rentAmount) ? { rentAmount: c.rentAmount || null } : {}),
        ...(c.chargeAmount !== num(p.chargeAmount) ? { chargeAmount: c.chargeAmount || null } : {}),
        ...(c.depositAmount !== num(p.depositAmount) ? { depositAmount: c.depositAmount || null } : {}),
        ...(c.contractEnd !== (p.contractEnd ?? '') ? { contractEnd: c.contractEnd || null } : {}),
      } : undefined;
      await apiPost(`/site-projects/${p.id}/contracts`, { reference: c.reference || null, notes: c.notes || null, ...(terms ? { amendment: terms } : {}) });
      toast(tr('نسخهٔ قرارداد ثبت شد؛ فایلش را پیوست و برای تأیید بفرستید.')); await qc.invalidateQueries(); onClose();
    } catch (e) { toast(ask(e), 'danger'); }
  };
  return (
    <Modal open onClose={onClose} title={amendment ? tr('الحاقیهٔ قرارداد') : tr('ثبت قرارداد')} footer={<><Button onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" onClick={() => void save()}>{tr('ثبت')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('شمارهٔ قرارداد')}><Input value={c.reference} onChange={(e) => setC({ ...c, reference: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label={tr('یادداشت')}><Textarea value={c.notes} onChange={(e) => setC({ ...c, notes: e.target.value })} /></Field></div>
        {amendment ? <>
          <p className="text-xs text-ink-600 sm:col-span-2">{tr('آنچه الحاقیه تغییر می‌دهد؛ با تأیید، شرایط پروژه می‌شود و جدول اجاره باید دوباره ساخته شود.')}</p>
          <Field label={tr('اجاره')}><AmountInput value={c.rentAmount} onChange={(v) => setC({ ...c, rentAmount: v })} aria-label={tr('اجاره')} /></Field>
          <Field label={tr('شارژ ماهیانه')}><AmountInput value={c.chargeAmount} onChange={(v) => setC({ ...c, chargeAmount: v })} aria-label={tr('شارژ ماهیانه')} /></Field>
          <Field label={tr('ودیعه')}><AmountInput value={c.depositAmount} onChange={(v) => setC({ ...c, depositAmount: v })} aria-label={tr('ودیعه')} /></Field>
          <Field label={tr('پایان قرارداد')}><JalaliDateInput value={c.contractEnd} onChange={(v) => setC({ ...c, contractEnd: v })} label={tr('پایان قرارداد')} /></Field>
        </> : <p className="text-xs text-ink-600 sm:col-span-2">{tr('شرایط فعلی پروژه در این نسخه ثبت می‌شود.')}</p>}
      </div>
    </Modal>
  );
}

function EmployerApprovalForm({ p, onClose }: { p: Project; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [a, setA] = useState({ decision: 'APPROVED', approverName: '', approverTitle: '', decidedAt: new Date().toISOString().slice(0, 10), comment: '', subject: 'INSTALLATION' });
  const save = async () => {
    try {
      await apiPost(`/site-projects/${p.id}/approvals`, { ...a, approverTitle: a.approverTitle || null, comment: a.comment || null });
      toast(tr('تأییدیهٔ کارفرما ثبت شد؛ عکس آن را پیوست کنید.')); await qc.invalidateQueries(); onClose();
    } catch (e) { toast(ask(e), 'danger'); }
  };
  return (
    <Modal open onClose={onClose} title={tr('تأییدیهٔ کارفرما')} footer={<><Button onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" disabled={a.approverName.trim().length < 2} onClick={() => void save()}>{tr('ثبت')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('موضوع')}><Select value={a.subject} onChange={(e) => setA({ ...a, subject: e.target.value })}><option value="INSTALLATION">{tr('نصب')}</option><option value="CONTRACT">{tr('قرارداد')}</option><option value="GENERAL">{tr('کلی')}</option></Select></Field>
        <Field label={tr('تصمیم')}><Select value={a.decision} onChange={(e) => setA({ ...a, decision: e.target.value })}><option value="APPROVED">{tr('تأیید')}</option><option value="REJECTED">{tr('رد')}</option></Select></Field>
        <Field label={tr('نام تأییدکننده (کارفرما)')} required><Input value={a.approverName} onChange={(e) => setA({ ...a, approverName: e.target.value })} /></Field>
        <Field label={tr('سمت')}><Input value={a.approverTitle} onChange={(e) => setA({ ...a, approverTitle: e.target.value })} /></Field>
        <Field label={tr('تاریخ')} required><JalaliDateInput value={a.decidedAt} onChange={(v) => setA({ ...a, decidedAt: v })} label={tr('تاریخ')} /></Field>
        <div className="sm:col-span-2"><Field label={tr('توضیح')}><Textarea value={a.comment} onChange={(e) => setA({ ...a, comment: e.target.value })} /></Field></div>
      </div>
    </Modal>
  );
}

/* installation, counters and people */

function Installation({ p, open }: { p: Project; open: boolean }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const editable = open && can('site.write');
  const [inst, setInst] = useState({ installPlannedAt: p.installPlannedAt ?? '', installedAt: p.installedAt ?? '', installDays: p.installDays ?? '', installCost: num(p.installCost), transportCost: num(p.transportCost), installNotes: p.installNotes ?? '' });
  useEffect(() => setInst({ installPlannedAt: p.installPlannedAt ?? '', installedAt: p.installedAt ?? '', installDays: p.installDays ?? '', installCost: num(p.installCost), transportCost: num(p.transportCost), installNotes: p.installNotes ?? '' }), [p]);
  const [counter, setCounter] = useState<Partial<Counter> & { unitCost?: string | null } | null>(null);
  const [person, setPerson] = useState<{ role: string; userId: string | null; personName: string; phone: string; startsOn: string; endsOn: string; shift: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, done: string) => { try { await fn(); toast(done); await qc.invalidateQueries(); } catch (e) { toast(ask(e), 'danger'); } };
  const photos = p.documents.filter((d) => d.siteRecordType === 'installation');
  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-3">
        <Field label={tr('تاریخ برنامهٔ نصب')}><JalaliDateInput value={inst.installPlannedAt} disabled={!editable} onChange={(v) => setInst({ ...inst, installPlannedAt: v })} label={tr('تاریخ برنامهٔ نصب')} /></Field>
        <Field label={tr('تاریخ واقعی نصب')}><JalaliDateInput value={inst.installedAt} disabled={!editable} onChange={(v) => setInst({ ...inst, installedAt: v })} label={tr('تاریخ واقعی نصب')} /></Field>
        <Field label={tr('مدت نصب (روز)')}><Input type="number" min={0} disabled={!editable} value={inst.installDays} onChange={(e) => setInst({ ...inst, installDays: e.target.value })} /></Field>
        <Field label={tr('هزینهٔ نصب')}><AmountInput value={inst.installCost} onChange={(v) => setInst({ ...inst, installCost: v })} aria-label={tr('هزینهٔ نصب')} /></Field>
        <Field label={tr('هزینهٔ حمل و نقل')}><AmountInput value={inst.transportCost} onChange={(v) => setInst({ ...inst, transportCost: v })} aria-label={tr('هزینهٔ حمل و نقل')} /></Field>
        <Field label={tr('وضعیت نصب')}><div className="pt-2"><StateBadge state={p.installStatus} /></div></Field>
        <div className="sm:col-span-3"><Field label={tr('تأخیرها، استثناها و اقدام اصلاحی')}><Textarea disabled={!editable} value={inst.installNotes} onChange={(e) => setInst({ ...inst, installNotes: e.target.value })} /></Field></div>
        {editable && <div className="sm:col-span-3"><Button size="sm" variant="primary" onClick={() => void run(() => apiPatch(`/site-projects/${p.id}`, {
          version: p.version, installPlannedAt: inst.installPlannedAt || null, installedAt: inst.installedAt || null, installDays: inst.installDays === '' ? null : Number(inst.installDays),
          installCost: inst.installCost || null, transportCost: inst.transportCost || null, installNotes: inst.installNotes || null,
        }), tr('اطلاعات نصب ثبت شد.'))}>{tr('ثبت اطلاعات نصب')}</Button></div>}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between"><h3 className="text-sm font-bold">{tr('کانترها')}</h3>{editable && <Button size="sm" onClick={() => setCounter({ label: '', quantity: 1, unitCost: '' })}><IconPlus className="size-4" />{tr('کانتر')}</Button>}</div>
        {!p.counters.length ? <EmptyState title={tr('کانتری ثبت نشده')} /> : (
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>{tr('عنوان')}</Th><Th>{tr('تعداد')}</Th><Th>{tr('ابعاد (سانتی‌متر)')}</Th><Th>{tr('هزینهٔ ساخت هر عدد')}</Th><Th>{tr('جمع')}</Th><Th>{tr('سازنده')}</Th><Th /></tr></thead>
            <tbody>{p.counters.map((c) => (
              <Tr key={c.id}>
                <Td>{c.label}{c.specs && <span className="block text-xs text-ink-500">{c.specs}</span>}</Td>
                <Td><span className="nums">{localDigits(c.quantity)}</span></Td>
                <Td><span className="nums text-xs" dir="ltr">{[c.widthCm, c.depthCm, c.heightCm].map((x) => (x == null ? '—' : localDigits(x))).join(' × ')}</span></Td>
                <Td><Money value={c.unitCost} currency={p.currency} /></Td>
                <Td><Money value={c.totalCost} currency={p.currency} /></Td>
                <Td>{c.supplier?.name ?? '—'}</Td>
                <Td>{editable && <span className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => setCounter(c)}>{tr('ویرایش')}</Button><Button size="sm" variant="ghost" onClick={() => void run(() => apiDelete(`/site-counters/${c.id}`), tr('کانتر حذف شد.'))}>{tr('حذف')}</Button></span>}</Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between"><h3 className="text-sm font-bold">{tr('پروموترها و نیروهای مستقر')}</h3>{editable && <Button size="sm" onClick={() => setPerson({ role: 'PROMOTER', userId: null, personName: '', phone: '', startsOn: '', endsOn: '', shift: '' })}><IconPlus className="size-4" />{tr('نیرو')}</Button>}</div>
        {!p.assignments.length ? <EmptyState title={tr('نیرویی ثبت نشده')} /> : (
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>{tr('نقش')}</Th><Th>{tr('نام')}</Th><Th>{tr('تلفن')}</Th><Th>{tr('دوره')}</Th><Th>{tr('شیفت')}</Th><Th /></tr></thead>
            <tbody>{p.assignments.map((a) => (
              <Tr key={a.id}>
                <Td><Badge>{pairLabel(ASSIGNMENT_ROLE_LABELS, a.role)}</Badge></Td>
                <Td>{a.user?.fullName ?? a.personName}</Td>
                <Td><span dir="ltr" className="nums text-xs">{a.phone ? localDigits(a.phone) : '—'}</span></Td>
                <Td><span className="text-xs">{a.startsOn ? `${formatDate(a.startsOn)}${a.endsOn ? ` — ${formatDate(a.endsOn)}` : ''}` : '—'}</span></Td>
                <Td><span className="text-xs">{a.shift ?? '—'}</span></Td>
                <Td>{editable && <Button size="sm" variant="ghost" onClick={() => void run(() => apiDelete(`/site-assignments/${a.id}`), tr('نیرو برداشته شد.'))}>{tr('برداشتن')}</Button>}</Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between"><h3 className="text-sm font-bold">{tr('عکس‌های نصب و بهره‌برداری')}</h3>{editable && <SiteUpload label={tr('افزودن عکس نصب')} fields={{ siteProjectId: p.id, siteRecordType: 'installation' }} accept="image/*" />}</div>
        {!photos.length ? <EmptyState title={tr('عکسی ثبت نشده')} /> : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{photos.map((d) => <figure key={d.id}><FilePreview documentId={d.id} mimeType={d.mimeType} /><figcaption className="text-xs text-ink-600">{d.caption} · {formatDate(d.createdAt)}</figcaption></figure>)}</div>
        )}
      </section>

      {counter && (
        <Modal open onClose={() => setCounter(null)} title={counter.id ? tr('ویرایش کانتر') : tr('کانتر تازه')}
          footer={<><Button onClick={() => setCounter(null)}>{tr('انصراف')}</Button><Button variant="primary" disabled={!counter.label} onClick={() => void run(() => {
            const body = { label: counter.label, quantity: Number(counter.quantity) || 1, widthCm: counter.widthCm || null, depthCm: counter.depthCm || null, heightCm: counter.heightCm || null, specs: counter.specs || null, unitCost: counter.unitCost || null };
            return counter.id ? apiPatch(`/site-counters/${counter.id}`, body) : apiPost(`/site-projects/${p.id}/counters`, body);
          }, tr('کانتر ثبت شد.')).then(() => setCounter(null))}>{tr('ثبت')}</Button></>}>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2"><Field label={tr('عنوان')} required><Input value={counter.label ?? ''} onChange={(e) => setCounter({ ...counter, label: e.target.value })} /></Field></div>
            <Field label={tr('تعداد')}><Input type="number" min={1} value={counter.quantity ?? 1} onChange={(e) => setCounter({ ...counter, quantity: Number(e.target.value) })} /></Field>
            <Field label={tr('عرض')}><Input type="number" min={0} value={counter.widthCm ?? ''} onChange={(e) => setCounter({ ...counter, widthCm: e.target.value ? Number(e.target.value) : null })} /></Field>
            <Field label={tr('عمق')}><Input type="number" min={0} value={counter.depthCm ?? ''} onChange={(e) => setCounter({ ...counter, depthCm: e.target.value ? Number(e.target.value) : null })} /></Field>
            <Field label={tr('ارتفاع')}><Input type="number" min={0} value={counter.heightCm ?? ''} onChange={(e) => setCounter({ ...counter, heightCm: e.target.value ? Number(e.target.value) : null })} /></Field>
            <Field label={tr('هزینهٔ ساخت هر عدد')}><AmountInput value={counter.unitCost ?? ''} onChange={(v) => setCounter({ ...counter, unitCost: v })} aria-label={tr('هزینهٔ ساخت هر عدد')} /></Field>
            <div className="sm:col-span-2"><Field label={tr('مشخصات یا حجم‌های قابل استفاده')}><Input value={counter.specs ?? ''} onChange={(e) => setCounter({ ...counter, specs: e.target.value })} /></Field></div>
          </div>
        </Modal>
      )}
      {person && (
        <Modal open onClose={() => setPerson(null)} title={tr('نیروی مستقر')}
          footer={<><Button onClick={() => setPerson(null)}>{tr('انصراف')}</Button><Button variant="primary" disabled={!person.userId && person.personName.trim().length < 2} onClick={() => void run(() => apiPost(`/site-projects/${p.id}/assignments`, {
            role: person.role, userId: person.userId, personName: person.personName || null, phone: person.phone || null, startsOn: person.startsOn || null, endsOn: person.endsOn || null, shift: person.shift || null,
          }), tr('نیرو ثبت شد.')).then(() => setPerson(null))}>{tr('ثبت')}</Button></>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr('نقش')}><Select value={person.role} onChange={(e) => setPerson({ ...person, role: e.target.value })}>{ASSIGNMENT_ROLES.map((r) => <option key={r} value={r}>{pairLabel(ASSIGNMENT_ROLE_LABELS, r)}</option>)}</Select></Field>
            <Field label={tr('همکار')}><PeopleSelect label={tr('همکار')} value={person.userId} onChange={(v) => setPerson({ ...person, userId: v })} empty={tr('— فردی بیرون از سازمان —')} /></Field>
            {!person.userId && <Field label={tr('نام فرد')} required><Input value={person.personName} onChange={(e) => setPerson({ ...person, personName: e.target.value })} /></Field>}
            <Field label={tr('تلفن')}><Input dir="ltr" value={person.phone} onChange={(e) => setPerson({ ...person, phone: e.target.value })} /></Field>
            <Field label={tr('از')}><JalaliDateInput value={person.startsOn} onChange={(v) => setPerson({ ...person, startsOn: v })} label={tr('از')} /></Field>
            <Field label={tr('تا')}><JalaliDateInput value={person.endsOn} onChange={(v) => setPerson({ ...person, endsOn: v })} label={tr('تا')} /></Field>
            <Field label={tr('شیفت')}><Input value={person.shift} onChange={(e) => setPerson({ ...person, shift: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

const RECORD_LABELS: Record<string, () => string> = {
  contract: () => tr('قرارداد'), approval: () => tr('تأییدیه'), installation: () => tr('نصب'), negotiation: () => tr('مذاکره'),
  payment: () => tr('رسید پرداخت'), deduction: () => tr('مستند کسر'), general: () => tr('عمومی'),
};

function Files({ p, open }: { p: Project; open: boolean }) {
  const { can } = useAuth();
  return (
    <div className="space-y-3">
      <div className="flex justify-end">{open && can('site.write') && <SiteUpload label={tr('پیوست تازه')} fields={{ siteProjectId: p.id, siteRecordType: 'general' }} />}</div>
      {!p.documents.length ? <EmptyState title={tr('پیوستی نیست')} /> : (
        <Table>
          <thead className="bg-ink-50/60"><tr><Th>{tr('فایل')}</Th><Th>{tr('شاهدِ')}</Th><Th>{tr('توضیح')}</Th><Th>{tr('بارگذاری')}</Th></tr></thead>
          <tbody>{p.documents.map((d) => (
            <Tr key={d.id}><Td><FileLink doc={d} /></Td><Td><Badge>{RECORD_LABELS[d.siteRecordType ?? 'general']?.() ?? d.siteRecordType}</Badge></Td><Td><span className="text-xs">{d.caption ?? '—'}</span></Td><Td><span className="text-xs">{d.uploadedBy.fullName} · {formatDate(d.createdAt)}</span></Td></Tr>
          ))}</tbody>
        </Table>
      )}
    </div>
  );
}
