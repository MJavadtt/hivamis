import { useState } from 'react';
import { offlineQuery } from '../lib/offline';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPatch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageBody, PageHeader } from '../components/Shell';
import { Code, Count, EntityList, HealthDot, WorkflowActions } from '../components/common';
import { PdfButton } from '../components/PdfButton';
import { PdfBundleButton } from '../components/PdfBundleButton';
import { SlaClocksCard } from '../components/SlaClocks';
import { RecordHistory } from '../components/RecordHistory';
import { ClientReportButton } from '../components/ClientReportButton';
import { BudgetByOrder } from '../components/BudgetByOrder';
import { Gantt } from '../components/Gantt';
import { ProjectLessons } from '../components/ProjectLessons';
import { ProjectMeetings } from '../components/MeetingMinutes';
import { MilestoneDone, ProjectRevenue } from '../components/Revenue';
import { ProjectMedia } from '../components/Media';
import { useAction } from '../hooks/queries';
import {
  Badge, Button, Card, Checkbox, DescRow, EmptyState, ErrorBlock, LoadingBlock,
  ProgressBar, StateBadge, StatTile, Table, Tabs, Td, Th, Tr, cx,
} from '../components/ui';
import {
  daysFromNow, exactCurrency, formatCurrency, formatDate, formatPercent, formatRelative, localDigits,
} from '../lib/format';
import { REVISION_REASON_LABELS } from '@hiva/contracts';
import { DeliverableApprovalButton } from '../components/ClientApprovals';
import { AnnotateButton } from '../components/Annotations';
import { BrandLibraryCard } from '../components/BrandLibrary';
import { ClientFilesCard, PortalMessagesCard } from '../components/PortalAdmin';
import { loc, tr, trx } from '../i18n';
import { UnitTag } from '../components/UnitTag';
import { SuggestedForms } from '../components/SuggestedForms';

const PROJECT_STATES = [
  'DRAFT', 'PENDING_AUTHORIZATION', 'AUTHORIZED', 'PLANNING', 'ACTIVE',
  'ON_HOLD', 'COMPLETED', 'PENDING_CLOSURE', 'CLOSED', 'CANCELLED',
];

const STATE_LABELS: Record<string, string> = {
  DRAFT: tr('پیش‌نویس'), PENDING_AUTHORIZATION: tr('در انتظار مجوز'), AUTHORIZED: tr('مجوز صادر شد'),
  PLANNING: tr('برنامه‌ریزی'), ACTIVE: tr('در حال اجرا'), ON_HOLD: tr('متوقف'), COMPLETED: tr('تکمیل‌شده'),
  PENDING_CLOSURE: tr('در انتظار بستن'), CLOSED: tr('بسته‌شده'), CANCELLED: tr('لغو شده'),
};

interface ProjectRow {
  id: string; code: string; name: string; state: string; healthStatus: string;
  plannedEnd: string | null; contractValue: string | null;
  company: { id: string; legalName: string };
  accountOwner: { id: string; fullName: string };
  _count: { tasks: number; deliverables: number; changeRequests: number; risks: number };
}

export function ProjectsList() {
  return (
    <>
      <PageHeader title={tr('پروژه‌ها')} subtitle={tr('پرتفوی پروژه‌های سازمان')} />
      <PageBody>
        <EntityList<ProjectRow>
          path="/projects"
          offline
          searchPlaceholder={tr('جستجو در نام یا هدف پروژه…')}
          rowHref={(r) => `/projects/${r.id}`}
          filters={[
            { key: 'state', label: tr('وضعیت'), options: PROJECT_STATES.map((s) => ({ value: s, label: STATE_LABELS[s] })) },
            { key: 'health', label: tr('سلامت'), options: [
              { value: 'GREEN', label: tr('سالم') }, { value: 'AMBER', label: tr('نیازمند توجه') }, { value: 'RED', label: tr('بحرانی') },
            ] },
          ]}
          emptyTitle={tr('پروژه‌ای یافت نشد')}
          columns={[
            {
              key: 'name', header: tr('پروژه'),
              render: (r) => (
                <>
                  <p className="font-medium text-ink-800">{r.name}</p>
                  <Code>{r.code}</Code>
                </>
              ),
            },
            { key: 'company', header: tr('مشتری'), render: (r) => <span className="text-xs">{r.company?.legalName}</span> },
            { key: 'owner', header: tr('مالک اکانت'), render: (r) => <span className="text-xs">{r.accountOwner?.fullName}</span> },
            { key: 'state', header: tr('وضعیت'), render: (r) => <StateBadge state={r.state} /> },
            { key: 'health', header: tr('سلامت'), render: (r) => <HealthDot status={r.healthStatus} /> },
            {
              key: 'end', header: tr('پایان'), render: (r) => {
                const d = daysFromNow(r.plannedEnd);
                return (
                  <span className={cx('text-xs', d !== null && d < 0 && !['CLOSED', 'COMPLETED'].includes(r.state) && 'font-medium text-rose-700')}>
                    {formatDate(r.plannedEnd)}
                  </span>
                );
              },
            },
            {
              key: 'counts', header: tr('وظایف / تغییرات'),
              render: (r) => (
                <span className="text-xs text-ink-500 nums">
                  {localDigits(r._count?.tasks ?? 0)} / {localDigits(r._count?.changeRequests ?? 0)}
                </span>
              ),
            },
          ]}
        />
      </PageBody>
    </>
  );
}

/* ── Project 360 ───────────────────────────────────────────────────────── */

interface Project360 {
  project: any;
  workOrders: any[]; tasks: any[]; deliverables: any[]; changeRequests: any[];
  risks: any[]; issues: any[]; decisions: any[]; meetings: any[];
  statusReports: any[]; revisions: any[]; allocations: any[]; documents: any[]; slaClocks: any[];
  finance: null | {
    budget: number; actualCost: number; revenue: number; margin: number; marginPercent: number | null;
    invoiced: number; received: number; invoices: any[]; payments: any[];
  };
  metrics: {
    taskCount: number; tasksDone: number; taskCompletion: number; overdueTasks: number;
    openRisks: number; openIssues: number; openChangeRequests: number;
    revisionCount: number; deliverablesAccepted: number;
  };
  availableTransitions: any[];
}

const CLOSURE_LABELS: Record<string, string> = {
  allDeliverablesDelivered: tr('تحویل تمام خروجی‌ها'),
  finalQcDone: tr('انجام QC نهایی'),
  clientApprovalRecorded: tr('ثبت تأیید مشتری'),
  closureReportDone: tr('تکمیل گزارش پایان پروژه'),
  financialStatusClear: tr('مشخص بودن وضعیت مالی'),
  feedbackRecorded: tr('ثبت Feedback مشتری'),
  lessonsLearnedRecorded: tr('ثبت Lessons Learned'),
};

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState('overview');
  const { can } = useAuth();

  const { data, isLoading, error, refetch } = useQuery<Project360>({
    // A project's summary, kept on the device for the field (audit F-7).
    ...offlineQuery<Project360>(`/projects/${id}/360`),
    enabled: !!id,
  });

  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const p = data.project;
  const authorized = (p.authorizations?.length ?? 0) > 0;

  return (
    <>
      <PageHeader
        title={p.name}
        badge={<><StateBadge state={p.state} /><HealthDot status={p.healthStatus} /></>}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Code>{p.code}</Code>
            <Link to={`/companies/${p.company.id}`} className="text-brand-600 hover:underline">
              {p.company.legalName}
            </Link>
            <span className="text-ink-400">·</span>
            <span>{tr('مالک اکانت:')}{' '}{p.accountOwner.fullName}</span>
          </span>
        }
        actions={
          <>
            <PdfButton kind="project" id={p.id} label={tr('پرونده پروژه')} />
            <PdfBundleButton kind="project" id={p.id} />
            <RecordHistory entityType="project" entityId={p.id} />
            {['COMPLETED', 'PENDING_CLOSURE', 'CLOSED'].includes(p.state) && (
              <PdfButton kind="closure-report" id={p.id} label={tr('گزارش پایان')} />
            )}
            <WorkflowActions entity="project" id={p.id} transitions={data.availableTransitions} />
          </>
        }
      />
      <SuggestedForms entity="project" id={id} />

      {!authorized && ['ACTIVE', 'PLANNING'].includes(p.state) && (
        <div className="mx-5 mt-4 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-inset ring-rose-200">
          <strong className="font-semibold">{tr('نقض قانون ۱۳ —')}{' '}</strong>{tr('این پروژه در حال اجراست اما هیچ مجوز شروع معتبری برای آن ثبت نشده است.')}</div>
      )}

      <div className="mx-3 mt-3 rounded-xl bg-surface px-2 shadow-sm ring-1 ring-edge sm:mx-5 lg:mx-0 [&>[role=tablist]]:border-b-0">
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { key: 'overview', label: tr('نمای کلی') },
            { key: 'work', label: tr('اجرا'), count: data.tasks.length },
            { key: 'schedule', label: tr('زمان‌بندی') },
            { key: 'quality', label: tr('کیفیت'), count: data.revisions.length },
            { key: 'governance', label: tr('حاکمیت'), count: data.risks.length + data.issues.length + data.changeRequests.length },
            ...(data.finance ? [{ key: 'finance', label: tr('مالی') }] : []),
            ...(can('pricing.read') ? [{ key: 'media', label: tr('رسانه') }] : []),
            { key: 'client', label: tr('مشتری') },
            { key: 'closure', label: tr('بستن پروژه') },
          ]}
        />
      </div>

      <PageBody className="space-y-5">
        {tab === 'overview' && (
          <>
            {/* At the top of the project, where it can still change how the work is run. */}
            <ProjectLessons projectId={p.id} />
            <Overview data={data} />
          </>
        )}
        {tab === 'work' && <WorkTab data={data} />}
        {tab === 'schedule' && <Gantt projectId={p.id} />}
        {tab === 'quality' && <QualityTab data={data} />}
        {tab === 'governance' && <GovernanceTab data={data} />}
        {tab === 'finance' && data.finance && <FinanceTab finance={data.finance} project={p} />}
        {tab === 'media' && <ProjectMedia projectId={p.id} />}
        {tab === 'closure' && <ClosureTab projectId={p.id} canEdit={can('project.close')} />}
        {tab === 'client' && (
          <>
            <div className="grid gap-5 lg:grid-cols-2">
              <PortalMessagesCard projectId={p.id} />
              <ClientFilesCard projectId={p.id} />
            </div>
            {/* The client's brand, where the people designing for them work (roadmap #42). */}
            <BrandLibraryCard companyId={p.company.id} />
          </>
        )}
      </PageBody>
    </>
  );
}

function Overview({ data }: { data: Project360 }) {
  const p = data.project;
  const canPlan = useAuth().can('project.plan');
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={tr('پیشرفت وظایف')} value={tr('{0}٪', localDigits(data.metrics.taskCompletion))}
          hint={tr('{0} از {1}', localDigits(data.metrics.tasksDone), localDigits(data.metrics.taskCount))} />
        <StatTile label={tr('وظایف سررسید گذشته')} value={<Count value={data.metrics.overdueTasks} />}
          tone={data.metrics.overdueTasks > 0 ? 'danger' : 'success'} />
        <StatTile label={tr('اصلاحیه‌ها')} value={<Count value={data.metrics.revisionCount} />}
          tone={data.metrics.revisionCount > 3 ? 'warning' : 'neutral'} hint={tr('شاخص کیفیت خروجی')} />
        <StatTile label={tr('درخواست‌های تغییر باز')} value={<Count value={data.metrics.openChangeRequests} />}
          tone={data.metrics.openChangeRequests > 0 ? 'warning' : 'neutral'} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title={tr('اطلاعات پروژه')} className="lg:col-span-1">
          <dl className="px-4 py-1">
            <DescRow label={tr('بریف مرجع')}>
              {p.brief ? <Link to={`/briefs/${p.brief.id}`} className="text-brand-600 hover:underline">{p.brief.code}</Link> : '—'}
            </DescRow>
            <DescRow label={tr('پروپوزال')}>
              {p.proposal ? <Link to={`/proposals/${p.proposal.id}`} className="text-brand-600 hover:underline">{p.proposal.code}</Link> : '—'}
            </DescRow>
            <DescRow label={tr('شروع برنامه‌ریزی‌شده')}>{formatDate(p.plannedStart)}</DescRow>
            <DescRow label={tr('پایان برنامه‌ریزی‌شده')}>{formatDate(p.plannedEnd)}</DescRow>
            <DescRow label={tr('شروع واقعی')}>{formatDate(p.actualStart)}</DescRow>
            <DescRow label={tr('ارزش قرارداد')}>
              <span title={exactCurrency(p.contractValue)}>{formatCurrency(p.contractValue)}</span>
            </DescRow>
          </dl>
        </Card>

        <Card title={tr('مجوز شروع پروژه')} subtitle={tr('قانون ۱۳ — بدون مجوز، اجرا مجاز نیست')} className="lg:col-span-1">
          {!p.authorizations?.length ? (
            <EmptyState title={tr('مجوزی ثبت نشده')} description={tr('پروژه بدون یکی از سه مبنای مجاز وارد اجرا نمی‌شود.')} />
          ) : (
            <ul className="divide-y divide-ink-100">
              {p.authorizations.map((a: any) => (
                <li key={a.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <Badge tone="success">
                      {a.basis === 'CONTRACT' ? tr('قرارداد معتبر')
                        : a.basis === 'OFFICIAL_ORDER' ? tr('سفارش رسمی') : tr('دستور اجرای فاکتوری')}
                    </Badge>
                    <span className="text-xs text-ink-400">{formatDate(a.authorizedAt)}</span>
                  </div>
                  <p className="ltr mt-1 text-xs text-ink-600">{a.referenceDocument}</p>
                  {a.notes && <p className="mt-1 text-xs text-ink-500">{a.notes}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={tr('ماتریس RACI')} subtitle={tr('مسئولیت‌های واحدها')} className="lg:col-span-1">
          {!p.raciAssignments?.length ? (
            <EmptyState title={tr('RACI تعریف نشده')} description={tr('پروژه بدون RACI وارد اجرا نمی‌شود.')} />
          ) : (
            <Table className="min-w-0">
              <thead className="bg-ink-50/60">
                <tr><Th>{tr('فعالیت')}</Th><Th>{tr('واحد')}</Th><Th>{tr('نقش')}</Th></tr>
              </thead>
              <tbody>
                {p.raciAssignments.map((r: any) => (
                  <Tr key={r.id}>
                    <Td className="text-xs">{r.activity}</Td>
                    <Td><UnitTag code={r.departmentCode} /></Td>
                    <Td>
                      <Badge tone={r.raciRole === 'A' ? 'progress' : r.raciRole === 'R' ? 'success' : 'neutral'}>
                        {r.raciRole}
                      </Badge>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={tr('نقاط عطف')}>
          {!p.milestones?.length ? <EmptyState title={tr('نقطه عطفی ثبت نشده')} /> : (
            <ul className="divide-y divide-ink-100">
              {p.milestones.map((m: any) => {
                const d = daysFromNow(m.dueDate);
                return (
                  <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ink-800">{m.name}</p>
                      <p className="text-xs text-ink-500">{formatDate(m.dueDate)} — {formatRelative(m.dueDate)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {!m.completedAt && canPlan && <MilestoneDone projectId={p.id} milestoneId={m.id} />}
                      {m.completedAt ? <Badge tone="success">{tr('انجام‌شده')}</Badge>
                        : d !== null && d < 0 ? <Badge tone="danger">{tr('گذشته')}</Badge>
                        : <Badge tone="neutral">{tr('پیش رو')}</Badge>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <SlaClocksCard entityType="project" entityId={p.id} />

        <Card title={tr('آخرین گزارش وضعیت')}
          action={data.statusReports.length ? <ClientReportButton reportId={data.statusReports[0].id} /> : undefined}>
          {!data.statusReports.length ? <EmptyState title={tr('گزارشی ثبت نشده')} /> : (
            <div className="space-y-2 px-4 py-3 text-sm">
              <p className="text-xs text-ink-500">{tr('دوره:')}{' '}{data.statusReports[0].period}</p>
              <p className="text-ink-800">{data.statusReports[0].progress}</p>
              {data.statusReports[0].risks && (
                <p className="rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-800">{tr('ریسک‌ها:')}{' '}{data.statusReports[0].risks}
                </p>
              )}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function WorkTab({ data }: { data: Project360 }) {
  return (
    <div className="space-y-5">
      <Card title={tr('سفارش‌های کار واحدها')} subtitle={tr('Doc_H §C — هر سفارش باید ۹ عنصر الزامی داشته باشد')}>
        {!data.workOrders.length ? <EmptyState title={tr('سفارشی صادر نشده')} /> : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr><Th>{tr('عنوان')}</Th><Th>{tr('واحد')}</Th><Th>{tr('مسئول')}</Th><Th>{tr('مهلت')}</Th><Th>{tr('وضعیت')}</Th></tr>
            </thead>
            <tbody>
              {data.workOrders.map((w) => (
                <Tr key={w.id}>
                  <Td><p className="text-sm">{w.title}</p><Code>{w.code}</Code></Td>
                  <Td><UnitTag code={w.targetDepartmentCode} /></Td>
                  <Td className="text-xs">{w.owner?.fullName}</Td>
                  <Td className="text-xs">{formatDate(w.deadline)}</Td>
                  <Td><StateBadge state={w.state} /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title={tr('وظایف')} subtitle={tr('هر وظیفه باید به یک سند مرجع متصل باشد (قانون ۶)')}>
        {!data.tasks.length ? <EmptyState title={tr('وظیفه‌ای ایجاد نشده')} /> : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr><Th>{tr('وظیفه')}</Th><Th>{tr('واحد')}</Th><Th>{tr('مسئول')}</Th><Th>{tr('سند مرجع')}</Th><Th>{tr('مهلت')}</Th><Th>{tr('وضعیت')}</Th></tr>
            </thead>
            <tbody>
              {data.tasks.map((t) => {
                const d = daysFromNow(t.dueDate);
                return (
                  <Tr key={t.id}>
                    <Td><p className="text-sm">{t.title}</p><Code>{t.code}</Code></Td>
                    <Td><UnitTag code={t.departmentCode} /></Td>
                    <Td className="text-xs">{t.assignee?.fullName ?? '—'}</Td>
                    <Td><Code>{t.sourceRef}</Code></Td>
                    <Td className={cx('text-xs', d !== null && d < 0 && !['APPROVED', 'CLOSED'].includes(t.state) && 'font-medium text-rose-700')}>
                      {formatDate(t.dueDate)}
                    </Td>
                    <Td><StateBadge state={t.state} /></Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title={tr('خروجی‌ها')}>
        {!data.deliverables.length ? <EmptyState title={tr('خروجی‌ای تعریف نشده')} /> : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr><Th>{tr('خروجی')}</Th><Th>{tr('واحد')}</Th><Th>{tr('نسخه')}</Th><Th>{tr('مهلت')}</Th><Th>{tr('وضعیت')}</Th><Th /></tr>
            </thead>
            <tbody>
              {data.deliverables.map((d) => (
                <Tr key={d.id}>
                  <Td><p className="text-sm">{d.name}</p><Code>{d.code}</Code></Td>
                  <Td><UnitTag code={d.departmentCode} /></Td>
                  <Td className="ltr text-xs">{d.version}</Td>
                  <Td className="text-xs">{formatDate(d.dueDate)}</Td>
                  <Td><StateBadge state={d.state} /></Td>
                  <Td><div className="flex gap-1"><AnnotateButton deliverable={d} /><DeliverableApprovalButton deliverable={d} /></div></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function QualityTab({ data }: { data: Project360 }) {
    return (
    <Card title={tr('اصلاحیه‌ها')} subtitle={tr('قانون ۱۰ — هیچ اصلاحی بدون ثبت علت انجام نمی‌شود')}>
      {!data.revisions.length ? (
        <EmptyState title={tr('اصلاحیه‌ای ثبت نشده')} description={tr('خروجی‌های این پروژه در QC رد نشده‌اند.')} />
      ) : (
        <Table>
          <thead className="bg-ink-50/60">
            <tr><Th>{tr('خروجی')}</Th><Th>{tr('علت')}</Th><Th>{tr('اصلاح مورد انتظار')}</Th><Th>{tr('واحد')}</Th><Th>{tr('مهلت')}</Th><Th>{tr('وضعیت')}</Th></tr>
          </thead>
          <tbody>
            {data.revisions.map((r) => (
              <Tr key={r.id}>
                <Td><Code>{r.code}</Code></Td>
                <Td><Badge tone="warning">{trx(REVISION_REASON_LABELS[r.reason] ?? r.reason)}</Badge></Td>
                <Td className="max-w-sm text-xs">{r.requiredCorrection}</Td>
                <Td><UnitTag code={r.responsibleDepartmentCode} /></Td>
                <Td className="text-xs">{formatDate(r.dueDate)}</Td>
                <Td><StateBadge state={r.state} /></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function GovernanceTab({ data }: { data: Project360 }) {
  return (
    <div className="space-y-5">
      <Card title={tr('درخواست‌های تغییر')} subtitle={tr('قانون ۸ — تغییر خارج از Scope نیازمند ارزیابی اثر و تأیید مشتری است')}>
        {!data.changeRequests.length ? <EmptyState title={tr('درخواست تغییری ثبت نشده')} /> : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr><Th>{tr('عنوان')}</Th><Th>Scope</Th><Th>{tr('اثر زمانی')}</Th><Th>{tr('اثر هزینه‌ای')}</Th><Th>{tr('وضعیت')}</Th></tr>
            </thead>
            <tbody>
              {data.changeRequests.map((c) => (
                <Tr key={c.id}>
                  <Td><Link to={`/changes/${c.id}`} className="text-sm text-brand-600 hover:underline">{c.title}</Link><Code>{c.code}</Code></Td>
                  <Td>
                    {c.scopeVerdict === 'OUT_OF_SCOPE' ? <Badge tone="warning">{tr('خارج از Scope')}</Badge>
                      : c.scopeVerdict === 'IN_SCOPE' ? <Badge tone="success">{tr('داخل Scope')}</Badge>
                      : <Badge tone="neutral">{tr('تعیین‌نشده')}</Badge>}
                  </Td>
                  <Td className="text-xs nums">{c.timeImpactDays ? tr('{0} روز', localDigits(c.timeImpactDays)) : '—'}</Td>
                  <Td className="text-xs">{c.costImpact ? formatCurrency(c.costImpact) : '—'}</Td>
                  <Td><StateBadge state={c.state} /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <ProjectMeetings projectId={data.project.id} meetings={data.meetings} />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={tr('ریسک‌ها')}>
          {!data.risks.length ? <EmptyState title={tr('ریسکی ثبت نشده')} /> : (
            <ul className="divide-y divide-ink-100">
              {data.risks.map((r) => (
                <li key={r.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-ink-800">{r.title}</p>
                    <StateBadge state={r.state} />
                  </div>
                  <p className="mt-1 text-xs text-ink-500">{r.description}</p>
                  <div className="mt-1.5 flex gap-1.5">
                    <Badge tone="neutral">{tr('احتمال:')}{' '}{r.probability}</Badge>
                    <Badge tone={r.impact === 'CRITICAL' || r.impact === 'HIGH' ? 'danger' : 'neutral'}>{tr('اثر:')}{' '}{r.impact}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={tr('مسائل و تصمیمات')}>
          {!data.issues.length && !data.decisions.length ? <EmptyState title={tr('موردی ثبت نشده')} /> : (
            <ul className="divide-y divide-ink-100">
              {data.issues.map((i) => (
                <li key={i.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-ink-800">{i.title}</p>
                    <StateBadge state={i.state} />
                  </div>
                  <p className="mt-0.5 text-xs text-ink-500">{i.description}</p>
                </li>
              ))}
              {data.decisions.map((d) => (
                <li key={d.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-ink-800">{d.title}</p>
                    <Badge tone="progress">{tr('تصمیم')}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-500">{d.decision}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function FinanceTab({ finance, project }: { finance: NonNullable<Project360['finance']>; project: any }) {
  const budgetUsed = finance.budget > 0 ? (finance.actualCost / finance.budget) * 100 : 0;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={tr('درآمد قرارداد')} value={formatCurrency(finance.revenue)} />
        <StatTile label={tr('هزینه واقعی')} value={formatCurrency(finance.actualCost)}
          hint={finance.budget > 0 ? tr('{0}٪ از بودجه', localDigits(Math.round(budgetUsed))) : undefined}
          tone={budgetUsed > 100 ? 'danger' : budgetUsed > 85 ? 'warning' : 'neutral'} />
        <StatTile label={tr('حاشیه سود')} value={formatCurrency(finance.margin)}
          tone={finance.margin > 0 ? 'success' : 'danger'} hint={formatPercent(finance.marginPercent)} />
        <StatTile label={tr('مانده مطالبات')} value={formatCurrency(finance.invoiced - finance.received)}
          tone={finance.invoiced - finance.received > 0 ? 'warning' : 'success'} />
      </div>

      <Card title={tr('مصرف بودجه')}>
        <div className="px-4 py-4">
          <div className="mb-2 flex justify-between text-xs text-ink-500">
            <span>{tr('هزینه واقعی: {0}', formatCurrency(finance.actualCost))}</span>
            <span>{tr('بودجه: {0}', formatCurrency(finance.budget))}</span>
          </div>
          <ProgressBar value={budgetUsed} tone={budgetUsed > 100 ? 'danger' : budgetUsed > 85 ? 'warning' : 'success'} />
        </div>
      </Card>

      <BudgetByOrder projectId={project.id} />

      <ProjectRevenue projectId={project.id} />

      <Card title={tr('اسناد مالی')}>
        {!finance.invoices.length ? <EmptyState title={tr('سند مالی صادر نشده')} /> : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr><Th>{tr('شماره')}</Th><Th>{tr('نوع')}</Th><Th>{tr('تاریخ صدور')}</Th><Th>{tr('مبلغ کل')}</Th><Th>{tr('دریافت‌شده')}</Th><Th>{tr('وضعیت')}</Th></tr>
            </thead>
            <tbody>
              {finance.invoices.map((i: any) => (
                <Tr key={i.id}>
                  <Td className="ltr text-xs whitespace-nowrap">{i.number}</Td>
                  <Td className="text-xs">{i.kind === 'PROFORMA' ? tr('پیش‌فاکتور') : tr('فاکتور')}</Td>
                  <Td className="text-xs">{formatDate(i.issueDate)}</Td>
                  <Td className="text-xs" title={exactCurrency(i.total)}>{formatCurrency(i.total)}</Td>
                  <Td className="text-xs">{formatCurrency(i.paidAmount)}</Td>
                  <Td><StateBadge state={i.state} /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <p className="text-xs text-ink-400">{tr('ارزش قرارداد ثبت‌شده: {0}', exactCurrency(project.contractValue))}</p>
    </div>
  );
}

function ClosureTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const { data, isLoading, refetch } = useQuery<{
    checklist: Record<string, boolean | string> | null;
    items: { key: string; labelFa: string; done: boolean }[];
    complete: boolean;
  }>({
    queryKey: [`/projects/${projectId}/closure`],
    queryFn: () => apiGet(`/projects/${projectId}/closure`),
  });

  const update = useAction(
    (patch: Record<string, boolean>) => apiPatch(`/projects/${projectId}/closure`, patch),
    tr('چک‌لیست به‌روزرسانی شد.'),
  );

  if (isLoading) return <LoadingBlock />;

  return (
    <Card
      title={tr('چک‌لیست پایان پروژه')}
      subtitle={tr('قانون ۱۵ — پروژه تا تحقق تمام شرایط زیر بسته نمی‌شود')}
      action={data?.complete ? <Badge tone="success">{tr('آماده بستن')}</Badge> : <Badge tone="warning">{tr('ناتمام')}</Badge>}
    >
      <div className="space-y-3 px-4 py-4">
        {data?.items.filter((i) => i.key !== 'closedInSystem').map((item) => (
          <div key={item.key} className="flex items-center justify-between gap-3 rounded-lg bg-ink-50/50 px-3 py-2.5">
            {canEdit && CLOSURE_LABELS[item.key] ? (
              <Checkbox
                label={loc(item, 'label')}
                checked={item.done}
                onChange={(e) => update.mutate({ [item.key]: e.target.checked })}
              />
            ) : (
              <span className="text-sm text-ink-700">{loc(item, 'label')}</span>
            )}
            {item.done ? <Badge tone="success">{tr('تکمیل')}</Badge> : <Badge tone="neutral">{tr('در انتظار')}</Badge>}
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>{tr('به‌روزرسانی')}</Button>
      </div>
    </Card>
  );
}
