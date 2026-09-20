import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPatch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageBody, PageHeader } from '../components/Shell';
import { Code, Count, EntityList, HealthDot, WorkflowActions } from '../components/common';
import { PdfButton } from '../components/PdfButton';
import { PdfBundleButton } from '../components/PdfBundleButton';
import { useAction } from '../hooks/queries';
import {
  Badge, Button, Card, Checkbox, DescRow, EmptyState, ErrorBlock, LoadingBlock,
  ProgressBar, StateBadge, StatTile, Table, Tabs, Td, Th, Tr, cx,
} from '../components/ui';
import {
  daysFromNow, exactCurrency, formatCurrency, formatDate, formatPercent, formatRelative, toPersianDigits,
} from '../lib/format';
import { REVISION_REASON_LABELS } from '@hiva/contracts';

const PROJECT_STATES = [
  'DRAFT', 'PENDING_AUTHORIZATION', 'AUTHORIZED', 'PLANNING', 'ACTIVE',
  'ON_HOLD', 'COMPLETED', 'PENDING_CLOSURE', 'CLOSED', 'CANCELLED',
];

const STATE_LABELS: Record<string, string> = {
  DRAFT: 'پیش‌نویس', PENDING_AUTHORIZATION: 'در انتظار مجوز', AUTHORIZED: 'مجوز صادر شد',
  PLANNING: 'برنامه‌ریزی', ACTIVE: 'در حال اجرا', ON_HOLD: 'متوقف', COMPLETED: 'تکمیل‌شده',
  PENDING_CLOSURE: 'در انتظار بستن', CLOSED: 'بسته‌شده', CANCELLED: 'لغو شده',
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
      <PageHeader title="پروژه‌ها" subtitle="پرتفوی پروژه‌های سازمان" />
      <PageBody>
        <EntityList<ProjectRow>
          path="/projects"
          searchPlaceholder="جستجو در نام یا هدف پروژه…"
          rowHref={(r) => `/projects/${r.id}`}
          filters={[
            { key: 'state', label: 'وضعیت', options: PROJECT_STATES.map((s) => ({ value: s, label: STATE_LABELS[s] })) },
            { key: 'health', label: 'سلامت', options: [
              { value: 'GREEN', label: 'سالم' }, { value: 'AMBER', label: 'نیازمند توجه' }, { value: 'RED', label: 'بحرانی' },
            ] },
          ]}
          emptyTitle="پروژه‌ای یافت نشد"
          columns={[
            {
              key: 'name', header: 'پروژه',
              render: (r) => (
                <>
                  <p className="font-medium text-ink-800">{r.name}</p>
                  <Code>{r.code}</Code>
                </>
              ),
            },
            { key: 'company', header: 'مشتری', render: (r) => <span className="text-xs">{r.company?.legalName}</span> },
            { key: 'owner', header: 'مالک اکانت', render: (r) => <span className="text-xs">{r.accountOwner?.fullName}</span> },
            { key: 'state', header: 'وضعیت', render: (r) => <StateBadge state={r.state} /> },
            { key: 'health', header: 'سلامت', render: (r) => <HealthDot status={r.healthStatus} /> },
            {
              key: 'end', header: 'پایان', render: (r) => {
                const d = daysFromNow(r.plannedEnd);
                return (
                  <span className={cx('text-xs', d !== null && d < 0 && !['CLOSED', 'COMPLETED'].includes(r.state) && 'font-medium text-rose-600')}>
                    {formatDate(r.plannedEnd)}
                  </span>
                );
              },
            },
            {
              key: 'counts', header: 'وظایف / تغییرات',
              render: (r) => (
                <span className="text-xs text-ink-500 nums">
                  {toPersianDigits(r._count?.tasks ?? 0)} / {toPersianDigits(r._count?.changeRequests ?? 0)}
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
  allDeliverablesDelivered: 'تحویل تمام خروجی‌ها',
  finalQcDone: 'انجام QC نهایی',
  clientApprovalRecorded: 'ثبت تأیید مشتری',
  closureReportDone: 'تکمیل گزارش پایان پروژه',
  financialStatusClear: 'مشخص بودن وضعیت مالی',
  feedbackRecorded: 'ثبت Feedback مشتری',
  lessonsLearnedRecorded: 'ثبت Lessons Learned',
};

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState('overview');
  const { can } = useAuth();

  const { data, isLoading, error, refetch } = useQuery<Project360>({
    queryKey: [`/projects/${id}/360`],
    queryFn: () => apiGet(`/projects/${id}/360`),
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
            <span>مالک اکانت: {p.accountOwner.fullName}</span>
          </span>
        }
        actions={
          <>
            <PdfButton kind="project" id={p.id} label="پرونده پروژه" />
            <PdfBundleButton kind="project" id={p.id} />
            {['COMPLETED', 'PENDING_CLOSURE', 'CLOSED'].includes(p.state) && (
              <PdfButton kind="closure-report" id={p.id} label="گزارش پایان" />
            )}
            <WorkflowActions entity="project" id={p.id} transitions={data.availableTransitions} />
          </>
        }
      />

      {!authorized && ['ACTIVE', 'PLANNING'].includes(p.state) && (
        <div className="mx-5 mt-4 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-inset ring-rose-200">
          <strong className="font-semibold">نقض قانون ۱۳ — </strong>
          این پروژه در حال اجراست اما هیچ مجوز شروع معتبری برای آن ثبت نشده است.
        </div>
      )}

      <div className="border-b border-ink-200 bg-surface px-2">
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { key: 'overview', label: 'نمای کلی' },
            { key: 'work', label: 'اجرا', count: data.tasks.length },
            { key: 'quality', label: 'کیفیت', count: data.revisions.length },
            { key: 'governance', label: 'حاکمیت', count: data.risks.length + data.issues.length + data.changeRequests.length },
            ...(data.finance ? [{ key: 'finance', label: 'مالی' }] : []),
            { key: 'closure', label: 'بستن پروژه' },
          ]}
        />
      </div>

      <PageBody className="space-y-5">
        {tab === 'overview' && <Overview data={data} />}
        {tab === 'work' && <WorkTab data={data} />}
        {tab === 'quality' && <QualityTab data={data} />}
        {tab === 'governance' && <GovernanceTab data={data} />}
        {tab === 'finance' && data.finance && <FinanceTab finance={data.finance} project={p} />}
        {tab === 'closure' && <ClosureTab projectId={p.id} canEdit={can('project.close')} />}
      </PageBody>
    </>
  );
}

function Overview({ data }: { data: Project360 }) {
  const p = data.project;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="پیشرفت وظایف" value={`${toPersianDigits(data.metrics.taskCompletion)}٪`}
          hint={`${toPersianDigits(data.metrics.tasksDone)} از ${toPersianDigits(data.metrics.taskCount)}`} />
        <StatTile label="وظایف سررسید گذشته" value={<Count value={data.metrics.overdueTasks} />}
          tone={data.metrics.overdueTasks > 0 ? 'danger' : 'success'} />
        <StatTile label="اصلاحیه‌ها" value={<Count value={data.metrics.revisionCount} />}
          tone={data.metrics.revisionCount > 3 ? 'warning' : 'neutral'} hint="شاخص کیفیت خروجی" />
        <StatTile label="درخواست‌های تغییر باز" value={<Count value={data.metrics.openChangeRequests} />}
          tone={data.metrics.openChangeRequests > 0 ? 'warning' : 'neutral'} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="اطلاعات پروژه" className="lg:col-span-1">
          <dl className="px-4 py-1">
            <DescRow label="بریف مرجع">
              {p.brief ? <Link to={`/briefs/${p.brief.id}`} className="text-brand-600 hover:underline">{p.brief.code}</Link> : '—'}
            </DescRow>
            <DescRow label="پروپوزال">
              {p.proposal ? <Link to={`/proposals/${p.proposal.id}`} className="text-brand-600 hover:underline">{p.proposal.code}</Link> : '—'}
            </DescRow>
            <DescRow label="شروع برنامه‌ریزی‌شده">{formatDate(p.plannedStart)}</DescRow>
            <DescRow label="پایان برنامه‌ریزی‌شده">{formatDate(p.plannedEnd)}</DescRow>
            <DescRow label="شروع واقعی">{formatDate(p.actualStart)}</DescRow>
            <DescRow label="ارزش قرارداد">
              <span title={exactCurrency(p.contractValue)}>{formatCurrency(p.contractValue)}</span>
            </DescRow>
          </dl>
        </Card>

        <Card title="مجوز شروع پروژه" subtitle="قانون ۱۳ — بدون مجوز، اجرا مجاز نیست" className="lg:col-span-1">
          {!p.authorizations?.length ? (
            <EmptyState title="مجوزی ثبت نشده" description="پروژه بدون یکی از سه مبنای مجاز وارد اجرا نمی‌شود." />
          ) : (
            <ul className="divide-y divide-ink-100">
              {p.authorizations.map((a: any) => (
                <li key={a.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <Badge tone="success">
                      {a.basis === 'CONTRACT' ? 'قرارداد معتبر'
                        : a.basis === 'OFFICIAL_ORDER' ? 'سفارش رسمی' : 'دستور اجرای فاکتوری'}
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

        <Card title="ماتریس RACI" subtitle="مسئولیت‌های واحدها" className="lg:col-span-1">
          {!p.raciAssignments?.length ? (
            <EmptyState title="RACI تعریف نشده" description="پروژه بدون RACI وارد اجرا نمی‌شود." />
          ) : (
            <Table className="min-w-0">
              <thead className="bg-ink-50/60">
                <tr><Th>فعالیت</Th><Th>واحد</Th><Th>نقش</Th></tr>
              </thead>
              <tbody>
                {p.raciAssignments.map((r: any) => (
                  <Tr key={r.id}>
                    <Td className="text-xs">{r.activity}</Td>
                    <Td className="text-xs">{r.departmentCode}</Td>
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
        <Card title="نقاط عطف">
          {!p.milestones?.length ? <EmptyState title="نقطه عطفی ثبت نشده" /> : (
            <ul className="divide-y divide-ink-100">
              {p.milestones.map((m: any) => {
                const d = daysFromNow(m.dueDate);
                return (
                  <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ink-800">{m.name}</p>
                      <p className="text-xs text-ink-500">{formatDate(m.dueDate)} — {formatRelative(m.dueDate)}</p>
                    </div>
                    {m.completedAt ? <Badge tone="success">انجام‌شده</Badge>
                      : d !== null && d < 0 ? <Badge tone="danger">گذشته</Badge>
                      : <Badge tone="neutral">پیش رو</Badge>}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="آخرین گزارش وضعیت">
          {!data.statusReports.length ? <EmptyState title="گزارشی ثبت نشده" /> : (
            <div className="space-y-2 px-4 py-3 text-sm">
              <p className="text-xs text-ink-500">دوره: {data.statusReports[0].period}</p>
              <p className="text-ink-800">{data.statusReports[0].progress}</p>
              {data.statusReports[0].risks && (
                <p className="rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                  ریسک‌ها: {data.statusReports[0].risks}
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
      <Card title="سفارش‌های کار واحدها" subtitle="Doc_H §C — هر سفارش باید ۹ عنصر الزامی داشته باشد">
        {!data.workOrders.length ? <EmptyState title="سفارشی صادر نشده" /> : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr><Th>عنوان</Th><Th>واحد</Th><Th>مسئول</Th><Th>مهلت</Th><Th>وضعیت</Th></tr>
            </thead>
            <tbody>
              {data.workOrders.map((w) => (
                <Tr key={w.id}>
                  <Td><p className="text-sm">{w.title}</p><Code>{w.code}</Code></Td>
                  <Td className="text-xs">{w.targetDepartmentCode}</Td>
                  <Td className="text-xs">{w.owner?.fullName}</Td>
                  <Td className="text-xs">{formatDate(w.deadline)}</Td>
                  <Td><StateBadge state={w.state} /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="وظایف" subtitle="هر وظیفه باید به یک سند مرجع متصل باشد (قانون ۶)">
        {!data.tasks.length ? <EmptyState title="وظیفه‌ای ایجاد نشده" /> : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr><Th>وظیفه</Th><Th>واحد</Th><Th>مسئول</Th><Th>سند مرجع</Th><Th>مهلت</Th><Th>وضعیت</Th></tr>
            </thead>
            <tbody>
              {data.tasks.map((t) => {
                const d = daysFromNow(t.dueDate);
                return (
                  <Tr key={t.id}>
                    <Td><p className="text-sm">{t.title}</p><Code>{t.code}</Code></Td>
                    <Td className="text-xs">{t.departmentCode}</Td>
                    <Td className="text-xs">{t.assignee?.fullName ?? '—'}</Td>
                    <Td><Code>{t.sourceRef}</Code></Td>
                    <Td className={cx('text-xs', d !== null && d < 0 && !['APPROVED', 'CLOSED'].includes(t.state) && 'font-medium text-rose-600')}>
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

      <Card title="خروجی‌ها">
        {!data.deliverables.length ? <EmptyState title="خروجی‌ای تعریف نشده" /> : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr><Th>خروجی</Th><Th>واحد</Th><Th>نسخه</Th><Th>مهلت</Th><Th>وضعیت</Th></tr>
            </thead>
            <tbody>
              {data.deliverables.map((d) => (
                <Tr key={d.id}>
                  <Td><p className="text-sm">{d.name}</p><Code>{d.code}</Code></Td>
                  <Td className="text-xs">{d.departmentCode}</Td>
                  <Td className="ltr text-xs">{d.version}</Td>
                  <Td className="text-xs">{formatDate(d.dueDate)}</Td>
                  <Td><StateBadge state={d.state} /></Td>
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
    <Card title="اصلاحیه‌ها" subtitle="قانون ۱۰ — هیچ اصلاحی بدون ثبت علت انجام نمی‌شود">
      {!data.revisions.length ? (
        <EmptyState title="اصلاحیه‌ای ثبت نشده" description="خروجی‌های این پروژه در QC رد نشده‌اند." />
      ) : (
        <Table>
          <thead className="bg-ink-50/60">
            <tr><Th>خروجی</Th><Th>علت</Th><Th>اصلاح مورد انتظار</Th><Th>واحد</Th><Th>مهلت</Th><Th>وضعیت</Th></tr>
          </thead>
          <tbody>
            {data.revisions.map((r) => (
              <Tr key={r.id}>
                <Td><Code>{r.code}</Code></Td>
                <Td><Badge tone="warning">{REVISION_REASON_LABELS[r.reason] ?? r.reason}</Badge></Td>
                <Td className="max-w-sm text-xs">{r.requiredCorrection}</Td>
                <Td className="text-xs">{r.responsibleDepartmentCode}</Td>
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
      <Card title="درخواست‌های تغییر" subtitle="قانون ۸ — تغییر خارج از Scope نیازمند ارزیابی اثر و تأیید مشتری است">
        {!data.changeRequests.length ? <EmptyState title="درخواست تغییری ثبت نشده" /> : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr><Th>عنوان</Th><Th>Scope</Th><Th>اثر زمانی</Th><Th>اثر هزینه‌ای</Th><Th>وضعیت</Th></tr>
            </thead>
            <tbody>
              {data.changeRequests.map((c) => (
                <Tr key={c.id}>
                  <Td><Link to={`/changes/${c.id}`} className="text-sm text-brand-600 hover:underline">{c.title}</Link><Code>{c.code}</Code></Td>
                  <Td>
                    {c.scopeVerdict === 'OUT_OF_SCOPE' ? <Badge tone="warning">خارج از Scope</Badge>
                      : c.scopeVerdict === 'IN_SCOPE' ? <Badge tone="success">داخل Scope</Badge>
                      : <Badge tone="neutral">تعیین‌نشده</Badge>}
                  </Td>
                  <Td className="text-xs nums">{c.timeImpactDays ? `${toPersianDigits(c.timeImpactDays)} روز` : '—'}</Td>
                  <Td className="text-xs">{c.costImpact ? formatCurrency(c.costImpact) : '—'}</Td>
                  <Td><StateBadge state={c.state} /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="ریسک‌ها">
          {!data.risks.length ? <EmptyState title="ریسکی ثبت نشده" /> : (
            <ul className="divide-y divide-ink-100">
              {data.risks.map((r) => (
                <li key={r.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-ink-800">{r.title}</p>
                    <StateBadge state={r.state} />
                  </div>
                  <p className="mt-1 text-xs text-ink-500">{r.description}</p>
                  <div className="mt-1.5 flex gap-1.5">
                    <Badge tone="neutral">احتمال: {r.probability}</Badge>
                    <Badge tone={r.impact === 'CRITICAL' || r.impact === 'HIGH' ? 'danger' : 'neutral'}>اثر: {r.impact}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="مسائل و تصمیمات">
          {!data.issues.length && !data.decisions.length ? <EmptyState title="موردی ثبت نشده" /> : (
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
                    <Badge tone="progress">تصمیم</Badge>
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
        <StatTile label="درآمد قرارداد" value={formatCurrency(finance.revenue)} />
        <StatTile label="هزینه واقعی" value={formatCurrency(finance.actualCost)}
          hint={finance.budget > 0 ? `${toPersianDigits(Math.round(budgetUsed))}٪ از بودجه` : undefined}
          tone={budgetUsed > 100 ? 'danger' : budgetUsed > 85 ? 'warning' : 'neutral'} />
        <StatTile label="حاشیه سود" value={formatCurrency(finance.margin)}
          tone={finance.margin > 0 ? 'success' : 'danger'} hint={formatPercent(finance.marginPercent)} />
        <StatTile label="مانده مطالبات" value={formatCurrency(finance.invoiced - finance.received)}
          tone={finance.invoiced - finance.received > 0 ? 'warning' : 'success'} />
      </div>

      <Card title="مصرف بودجه">
        <div className="px-4 py-4">
          <div className="mb-2 flex justify-between text-xs text-ink-500">
            <span>هزینه واقعی: {formatCurrency(finance.actualCost)}</span>
            <span>بودجه: {formatCurrency(finance.budget)}</span>
          </div>
          <ProgressBar value={budgetUsed} tone={budgetUsed > 100 ? 'danger' : budgetUsed > 85 ? 'warning' : 'success'} />
        </div>
      </Card>

      <Card title="اسناد مالی">
        {!finance.invoices.length ? <EmptyState title="سند مالی صادر نشده" /> : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr><Th>شماره</Th><Th>نوع</Th><Th>تاریخ صدور</Th><Th>مبلغ کل</Th><Th>دریافت‌شده</Th><Th>وضعیت</Th></tr>
            </thead>
            <tbody>
              {finance.invoices.map((i: any) => (
                <Tr key={i.id}>
                  <Td className="ltr text-xs">{i.number}</Td>
                  <Td className="text-xs">{i.kind === 'PROFORMA' ? 'پیش‌فاکتور' : 'فاکتور'}</Td>
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
      <p className="text-xs text-ink-400">
        ارزش قرارداد ثبت‌شده: {exactCurrency(project.contractValue)}
      </p>
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
    'چک‌لیست به‌روزرسانی شد.',
  );

  if (isLoading) return <LoadingBlock />;

  return (
    <Card
      title="چک‌لیست پایان پروژه"
      subtitle="قانون ۱۵ — پروژه تا تحقق تمام شرایط زیر بسته نمی‌شود"
      action={data?.complete ? <Badge tone="success">آماده بستن</Badge> : <Badge tone="warning">ناتمام</Badge>}
    >
      <div className="space-y-3 px-4 py-4">
        {data?.items.filter((i) => i.key !== 'closedInSystem').map((item) => (
          <div key={item.key} className="flex items-center justify-between gap-3 rounded-lg bg-ink-50/50 px-3 py-2.5">
            {canEdit && CLOSURE_LABELS[item.key] ? (
              <Checkbox
                label={item.labelFa}
                checked={item.done}
                onChange={(e) => update.mutate({ [item.key]: e.target.checked })}
              />
            ) : (
              <span className="text-sm text-ink-700">{item.labelFa}</span>
            )}
            {item.done ? <Badge tone="success">تکمیل</Badge> : <Badge tone="neutral">در انتظار</Badge>}
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>به‌روزرسانی</Button>
      </div>
    </Card>
  );
}
