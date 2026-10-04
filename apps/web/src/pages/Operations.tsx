import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageBody, PageHeader } from '../components/Shell';
import { EstimateCheck } from '../components/EstimateCheck';
import { CurrencySelect, FxPreview } from '../components/Fx';
import { Code, EntityList, StateHistory, WorkflowActions } from '../components/common';
import { PdfButton } from '../components/PdfButton';
import { PdfBundleButton } from '../components/PdfBundleButton';
import { REVISION_REASON_LABELS } from '@hiva/contracts';
import { useAction } from '../hooks/queries';
import {
  Badge, Button, Card, DescRow, EmptyState, ErrorBlock, Field, Input, LoadingBlock,
  Modal, ProgressBar, Select, StateBadge, StatTile, Table, Td, Textarea, Th, Tr, cx,
} from '../components/ui';
import { daysFromNow, formatCurrency, formatDate, formatRelative, localDigits } from '../lib/format';
import { TaskTime } from '../components/TaskTime';
import { tr, trx } from '../i18n';
import { UnitTag } from '../components/UnitTag';

const UNITS = [
  { value: 'ST', label: tr('استراتژی') }, { value: 'CR', label: tr('خلاقیت / گرافیک / تولید') },
  { value: 'ME', label: tr('رسانه') }, { value: 'DM', label: tr('دیجیتال مارکتینگ') },
];

/* ── Tasks ─────────────────────────────────────────────────────────────── */

export function TasksList() {
  const [mineOnly, setMineOnly] = useState(true);
  return (
    <>
      <PageHeader
        title={tr('وظایف')}
        subtitle={tr('قانون ۶ — هر وظیفه باید به یک سند مرجع (بریف، سفارش، صورتجلسه، درخواست تغییر یا اصلاحیه) متصل باشد')}
        actions={
          <div className="flex rounded-lg bg-ink-100 p-0.5">
            {[{ v: true, l: tr('وظایف من') }, { v: false, l: tr('همه وظایف') }].map((o) => (
              <button
                key={String(o.v)}
                onClick={() => setMineOnly(o.v)}
                className={cx('rounded-md px-3 py-1.5 text-sm transition', mineOnly === o.v ? 'bg-surface font-medium text-ink-800 shadow-sm' : 'text-ink-500')}
              >
                {o.l}
              </button>
            ))}
          </div>
        }
      />
      <PageBody>
        <EntityList<any>
          key={String(mineOnly)}
          path="/tasks"
          extraQuery={mineOnly ? { mine: 'true' } : undefined}
          searchPlaceholder={tr('جستجو در عنوان وظیفه…')}
          filters={[
            { key: 'state', label: tr('وضعیت'), options: [
              { value: 'ASSIGNED', label: tr('تخصیص‌یافته') }, { value: 'ACCEPTED', label: tr('پذیرفته‌شده') },
              { value: 'IN_PROGRESS', label: tr('در حال انجام') }, { value: 'BLOCKED', label: tr('مسدود') },
              { value: 'SUBMITTED', label: tr('تحویل‌شده') }, { value: 'IN_QC', label: tr('در QC') },
              { value: 'REVISION_REQUIRED', label: tr('نیاز به اصلاح') }, { value: 'APPROVED', label: tr('تأییدشده') },
            ] },
            { key: 'unit', label: tr('واحد'), options: UNITS },
          ]}
          emptyTitle={tr('وظیفه‌ای یافت نشد')}
          columns={[
            { key: 'title', header: tr('وظیفه'), render: (r) => (<><p className="font-medium text-ink-800">{r.title}</p><Code>{r.code}</Code></>) },
            { key: 'project', header: tr('پروژه'), render: (r) => r.project ? <Link to={`/projects/${r.project.id}`} className="text-xs text-brand-600 hover:underline" onClick={(e) => e.stopPropagation()}>{r.project.name}</Link> : '—' },
            { key: 'source', header: tr('سند مرجع'), render: (r) => <Code>{r.sourceRef}</Code> },
            { key: 'assignee', header: tr('مسئول'), render: (r) => <span className="text-xs">{r.assignee?.fullName ?? '—'}</span> },
            {
              key: 'due', header: tr('مهلت'),
              render: (r) => {
                const d = daysFromNow(r.dueDate);
                const late = d !== null && d < 0 && !['APPROVED', 'CLOSED', 'CANCELLED'].includes(r.state);
                return (
                  <div className={cx('text-xs', late && 'font-medium text-rose-600')}>
                    {formatDate(r.dueDate)}
                    <p className="text-[11px] text-ink-400">{formatRelative(r.dueDate)}</p>
                  </div>
                );
              },
            },
            { key: 'state', header: tr('وضعیت'), render: (r) => <StateBadge state={r.state} /> },
            { key: 'actions', header: tr('اقدام'), render: (r) => (<div onClick={(e) => e.stopPropagation()}><WorkflowActions entity="task" id={r.id} transitions={r.availableTransitions} /></div>) },
          ]}
        />
      </PageBody>
    </>
  );
}

/* ── Work orders ───────────────────────────────────────────────────────── */

/**
 * Global search returns a `task` group, but there was no /tasks/:id route, so every task result
 * fell through App's catch-all and silently bounced the user to the dashboard.
 */
export function TaskDetail() {
  const { id } = useParams<{ id: string }>();

  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: [`/tasks/${id}`], queryFn: () => apiGet(`/tasks/${id}`), enabled: !!id,
  });

  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const overdue = data.dueDate && new Date(data.dueDate) < new Date()
    && !['APPROVED', 'CLOSED', 'CANCELLED'].includes(data.state);

  return (
    <>
      <PageHeader
        title={data.title}
        badge={<StateBadge state={data.state} />}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Code>{data.code}</Code>
            <UnitTag code={data.departmentCode} />
            {data.project && (
              <Link to={`/projects/${data.project.id}`} className="text-brand-600 hover:underline">
                {data.project.name}
              </Link>
            )}
          </span>
        }
        actions={<WorkflowActions entity="task" id={data.id} transitions={data.availableTransitions} />}
      />
      <PageBody className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title={tr('شرح وظیفه')}>
            <div className="px-4 py-3 text-sm text-ink-800">
              {data.description || <span className="text-ink-400">{tr('— شرحی ثبت نشده —')}</span>}
            </div>
          </Card>

          {/* Doc_H §6: no task is valid without a source document behind it. */}
          <TaskTime taskId={data.id} assigneeId={data.assigneeId ?? null} />
          <Card title={tr('سند مبنا')} subtitle={tr('Doc_H §۶ — هیچ Task شفاهی معتبر نیست')}>
            <dl className="px-4 py-1">
              <DescRow label={tr('نوع سند')}>{trx(SOURCE_LABELS[data.sourceType] ?? data.sourceType)}</DescRow>
              <DescRow label={tr('شناسه سند')}>
                {data.workOrder
                  ? <Link to={`/work-orders/${data.workOrder.id}`} className="text-brand-600 hover:underline">
                      {data.workOrder.code} — {data.workOrder.title}
                    </Link>
                  : <Code>{data.sourceRef}</Code>}
              </DescRow>
            </dl>
          </Card>

          {data.revisions?.length > 0 && (
            <Card title={tr('اصلاحیه‌ها')} subtitle={tr('{0} مورد', localDigits(data.revisions.length))}>
              <Table>
                <thead><Tr><Th>{tr('کد')}</Th><Th>{tr('علت')}</Th><Th>{tr('وضعیت')}</Th><Th>{tr('مهلت')}</Th></Tr></thead>
                <tbody>
                  {data.revisions.map((r: any) => (
                    <Tr key={r.id}>
                      <Td><Code>{r.code}</Code></Td>
                      <Td className="text-xs">{trx(REVISION_REASON_LABELS[r.reason] ?? r.reason)}</Td>
                      <Td><StateBadge state={r.state} /></Td>
                      <Td className="text-xs">{formatDate(r.dueDate)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}

          {data.qcReviews?.length > 0 && (
            <Card title={tr('کنترل کیفیت')}>
              <Table>
                <thead><Tr><Th>{tr('کد')}</Th><Th>{tr('سطح')}</Th><Th>{tr('نتیجه')}</Th><Th>{tr('یافته‌ها')}</Th></Tr></thead>
                <tbody>
                  {data.qcReviews.map((q: any) => (
                    <Tr key={q.id}>
                      <Td><Code>{q.code}</Code></Td>
                      <Td className="text-xs">{q.level}</Td>
                      <Td><StateBadge state={q.verdict} /></Td>
                      <Td className="text-xs text-ink-600">{q.findings || '—'}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card title={tr('مشخصات')}>
            <dl className="px-4 py-1">
              <DescRow label={tr('مسئول')}>{data.assignee?.fullName ?? tr('— تخصیص نیافته —')}</DescRow>
              <DescRow label={tr('مهلت')}>
                <span className={overdue ? 'text-rose-600' : undefined}>
                  {formatDate(data.dueDate)}{overdue ? tr(' — سررسید گذشته') : ''}
                </span>
              </DescRow>
              <DescRow label={tr('اولویت')}>
                <Badge tone={data.priority === 'URGENT' ? 'danger' : data.priority === 'HIGH' ? 'warning' : 'neutral'}>
                  {data.priority}
                </Badge>
              </DescRow>
              <DescRow label={tr('برآورد')}>
                {data.estimateHours ? tr('{0} ساعت', localDigits(Number(data.estimateHours))) : '—'}
              </DescRow>
              <DescRow label={tr('پذیرش')}>{data.acceptedAt ? formatDate(data.acceptedAt) : tr('— پذیرفته نشده —')}</DescRow>
              <DescRow label={tr('تحویل')}>{data.submittedAt ? formatDate(data.submittedAt) : tr('— تحویل نشده —')}</DescRow>
            </dl>
          </Card>

          {data.blockReason && (
            <Card title={tr('مانع اعلام‌شده')}>
              <p className="px-4 py-3 text-sm text-amber-800">{data.blockReason}</p>
            </Card>
          )}

          <StateHistory entity="task" id={data.id} />
        </div>
      </PageBody>
    </>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  BRIEF: tr('بریف'),
  ORDER_FORM: tr('فرم سفارش'),
  TASK: tr('وظیفه'),
  MEETING_MINUTES: tr('صورتجلسه'),
  CHANGE_REQUEST: tr('درخواست تغییر'),
  REVISION_FORM: tr('فرم اصلاحیه'),
};

export function WorkOrdersList() {
  return (
    <>
      <PageHeader title={tr('سفارش‌های کار')} subtitle={tr('Doc_H §C — هر سفارش باید ۹ عنصر الزامی داشته باشد')} />
      <PageBody>
        <EntityList<any>
          path="/work-orders"
          searchPlaceholder={tr('جستجو در عنوان یا شرح کار…')}
          rowHref={(r) => `/work-orders/${r.id}`}
          filters={[
            { key: 'state', label: tr('وضعیت'), options: [
              { value: 'DRAFT', label: tr('پیش‌نویس') }, { value: 'ISSUED', label: tr('صادرشده') },
              { value: 'PENDING_ACCEPTANCE', label: tr('در انتظار پذیرش') }, { value: 'ACCEPTED', label: tr('پذیرفته‌شده') },
              { value: 'CLARIFICATION_REQUESTED', label: tr('ابهام اعلام شد') },
              { value: 'IN_PROGRESS', label: tr('در حال انجام') }, { value: 'SUBMITTED', label: tr('تحویل‌شده') },
              { value: 'COMPLETED', label: tr('تکمیل‌شده') },
            ] },
            { key: 'unit', label: tr('واحد'), options: UNITS },
          ]}
          emptyTitle={tr('سفارشی صادر نشده')}
          columns={[
            { key: 'title', header: tr('سفارش'), render: (r) => (<><p className="font-medium text-ink-800">{r.title}</p><Code>{r.code}</Code></>) },
            { key: 'unit', header: tr('واحد مقصد'), render: (r) => <UnitTag code={r.targetDepartmentCode} /> },
            { key: 'project', header: tr('پروژه'), render: (r) => <span className="text-xs">{r.project?.name}</span> },
            { key: 'owner', header: tr('مسئول'), render: (r) => <span className="text-xs">{r.owner?.fullName}</span> },
            { key: 'deadline', header: tr('مهلت'), render: (r) => <span className="text-xs">{formatDate(r.deadline)}</span> },
            { key: 'state', header: tr('وضعیت'), render: (r) => <StateBadge state={r.state} /> },
          ]}
        />
      </PageBody>
    </>
  );
}

export function WorkOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const [costing, setCosting] = useState(false);
  const { can } = useAuth();

  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: [`/work-orders/${id}`], queryFn: () => apiGet(`/work-orders/${id}`), enabled: !!id,
  });

  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  return (
    <>
      <PageHeader
        title={data.title}
        badge={<StateBadge state={data.state} />}
        subtitle={<span className="flex items-center gap-2"><Code>{data.code}</Code>
          <UnitTag code={data.targetDepartmentCode} />
          {data.project && <Link to={`/projects/${data.project.id}`} className="text-brand-600 hover:underline">{data.project.name}</Link>}</span>}
        actions={
          <>
            {can('pricing.declare_cost') && (
              <Button variant="secondary" onClick={() => setCosting(true)}>{tr('اعلام قیمت تمام‌شده')}</Button>
            )}
            <PdfButton kind="work-order" id={data.id} />
            <PdfBundleButton kind="work-order" id={data.id} />
            <WorkflowActions entity="workOrder" id={data.id} transitions={data.availableTransitions} />
          </>
        }
      />
      <PageBody className="grid gap-5 lg:grid-cols-3">
        <Card title={tr('عناصر الزامی سفارش')} className="lg:col-span-2" subtitle="Doc_H §C">
          <dl className="divide-y divide-ink-100">
            {[[tr('شرح کار'), data.scopeOfWork], [tr('بریف'), data.brief], [tr('خروجی مورد انتظار'), data.expectedOutput],
              [tr('فرمت خروجی'), data.outputFormat], [tr('منابع مورد نیاز'), data.requiredResources]].map(([l, v]) => (
              <div key={l as string} className="px-4 py-3">
                <dt className="text-xs font-medium text-ink-500">{l}</dt>
                <dd className={v ? 'mt-1 text-sm text-ink-800' : 'mt-1 text-sm text-rose-500'}>{(v as string) || tr('— ثبت نشده —')}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <div className="space-y-5">
          <Card title={tr('مشخصات')}>
            <dl className="px-4 py-1">
              <DescRow label={tr('مسئول')}>{data.owner?.fullName}</DescRow>
              <DescRow label={tr('مهلت')}>{formatDate(data.deadline)}</DescRow>
              <DescRow label={tr('بودجه')}>{formatCurrency(data.budget)}</DescRow>
              <DescRow label={tr('اولویت')}><Badge tone={data.priority === 'URGENT' ? 'danger' : data.priority === 'HIGH' ? 'warning' : 'neutral'}>{data.priority}</Badge></DescRow>
              <DescRow label={tr('پذیرش')}>{data.acceptedAt ? formatDate(data.acceptedAt) : tr('— پذیرفته نشده —')}</DescRow>
            </dl>
          </Card>

          <Card title={tr('قیمت تمام‌شده اعلامی')}>
            {!data.costDeclarations?.length ? (
              <EmptyState title={tr('هزینه‌ای اعلام نشده')} description={tr('تحویل خروجی بدون اعلام قیمت تمام‌شده مجاز نیست (قانون ۱۲).')} />
            ) : (
              <ul className="divide-y divide-ink-100">
                {data.costDeclarations.map((c: any) => (
                  <li key={c.id} className="px-4 py-2.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-ink-500">{tr('داخلی')}</span>
                      <span className="nums">{formatCurrency(c.internalCost)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ink-500">{tr('خارجی')}</span>
                      <span className="nums">{formatCurrency(c.externalCost)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {!!data.tasks?.length && (
          <Card title={tr('وظایف مرتبط')} className="lg:col-span-3">
            <Table>
              <thead className="bg-ink-50/60"><tr><Th>{tr('وظیفه')}</Th><Th>{tr('مسئول')}</Th><Th>{tr('مهلت')}</Th><Th>{tr('وضعیت')}</Th></tr></thead>
              <tbody>
                {data.tasks.map((t: any) => (
                  <Tr key={t.id}>
                    <Td><p className="text-sm">{t.title}</p><Code>{t.code}</Code></Td>
                    <Td className="text-xs">{t.assigneeId ? '—' : '—'}</Td>
                    <Td className="text-xs">{formatDate(t.dueDate)}</Td>
                    <Td><StateBadge state={t.state} /></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
      </PageBody>

      {costing && <CostModal workOrder={data} onClose={() => setCosting(false)} />}
    </>
  );
}

function CostModal({ workOrder, onClose }: { workOrder: any; onClose: () => void }) {
  const [internal, setInternal] = useState('');
  const [external, setExternal] = useState('0');
  const [externalCurrency, setExternalCurrency] = useState('IRR');
  const [assumptions, setAssumptions] = useState('');
  // A foreign external cost is compared with history in rials, at today's rate (roadmap #28).
  const { data: rate } = useQuery<{ rate: number | null; usable: boolean }>({
    queryKey: ['/fx/rate', externalCurrency, 'today'],
    queryFn: () => apiGet('/fx/rate', { currency: externalCurrency }),
    enabled: externalCurrency !== 'IRR',
  });
  const externalBase = externalCurrency === 'IRR' ? Number(external || 0) : Number(external || 0) * Number(rate?.rate ?? 0);

  const save = useAction(
    (body: unknown) => apiPost(`/work-orders/${workOrder.id}/cost`, body),
    tr('قیمت تمام‌شده ثبت شد.'),
  );

  const submit = async () => {
    await save.mutateAsync({
      departmentCode: workOrder.targetDepartmentCode,
      internalCost: Number(internal), externalCost: Number(external || 0), externalCurrency,
      assumptions: assumptions || undefined, items: [],
    });
    onClose();
  };

  return (
    <Modal
      open onClose={onClose} title={tr('اعلام قیمت تمام‌شده')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!internal} onClick={() => void submit()}>{tr('ثبت')}</Button>
        </>
      }
    >
      <p className="mb-4 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">{tr('قانون ۱۲ — واحد اجرایی فقط قیمت تمام‌شده را اعلام می‌کند. تعیین قیمت فروش در فرآیند Pricing و توسط نقش‌های مجاز انجام می‌شود.')}</p>
      <div className="space-y-4">
        <Field label={tr('هزینه داخلی (ریال)')} required><Input type="number" value={internal} onChange={(e) => setInternal(e.target.value)} className="ltr" /></Field>
        <div className="grid grid-cols-[1fr_12rem] gap-3">
          <Field label={tr('هزینه خارجی')} hint={tr('رسانهٔ خارجی، لایسنس یا فریلنسر خارجی را به ارز خودش وارد کنید')}><Input type="number" value={external} onChange={(e) => setExternal(e.target.value)} className="ltr" aria-label={tr('هزینه خارجی')} /></Field>
          <Field label={tr('ارز هزینهٔ خارجی')}><CurrencySelect value={externalCurrency} onChange={setExternalCurrency} label={tr('ارز هزینهٔ خارجی')} /></Field>
        </div>
        <FxPreview currency={externalCurrency} amount={Number(external || 0)} on={null} />
        <Field label={tr('مفروضات')}><Textarea value={assumptions} onChange={(e) => setAssumptions(e.target.value)} rows={2} /></Field>
        {/* What similar work actually cost, while the figure can still change (roadmap #24). */}
        <EstimateCheck workOrderId={workOrder.id} proposed={Number(internal || 0) + externalBase} />
      </div>
    </Modal>
  );
}

/* ── Change requests ───────────────────────────────────────────────────── */

export function ChangesList() {
  return (
    <>
      <PageHeader title={tr('درخواست‌های تغییر')} subtitle={tr('قانون ۸ — تغییر خارج از Scope بدون ارزیابی اثر و تأیید مشتری اجرا نمی‌شود')} />
      <PageBody>
        <EntityList<any>
          path="/change-requests"
          searchPlaceholder={tr('جستجو در عنوان تغییر…')}
          rowHref={(r) => `/changes/${r.id}`}
          filters={[
            { key: 'state', label: tr('وضعیت'), options: [
              { value: 'SUBMITTED', label: tr('ثبت‌شده') }, { value: 'SCOPE_REVIEW', label: tr('بررسی Scope') },
              { value: 'COMMERCIAL_REVIEW', label: tr('بررسی تجاری') },
              { value: 'PENDING_CUSTOMER_APPROVAL', label: tr('در انتظار مشتری') },
              { value: 'APPROVED', label: tr('تأییدشده') }, { value: 'IMPLEMENTING', label: tr('در حال اجرا') },
              { value: 'CLOSED', label: tr('بسته‌شده') }, { value: 'REJECTED', label: tr('رد شده') },
            ] },
            { key: 'scope', label: 'Scope', options: [
              { value: 'IN_SCOPE', label: tr('داخل Scope') }, { value: 'OUT_OF_SCOPE', label: tr('خارج از Scope') },
              { value: 'UNDETERMINED', label: tr('تعیین‌نشده') },
            ] },
          ]}
          emptyTitle={tr('درخواست تغییری ثبت نشده')}
          columns={[
            { key: 'title', header: tr('تغییر'), render: (r) => (<><p className="font-medium text-ink-800">{r.title}</p><Code>{r.code}</Code></>) },
            { key: 'project', header: tr('پروژه'), render: (r) => <span className="text-xs">{r.project?.name}</span> },
            { key: 'by', header: tr('درخواست‌کننده'), render: (r) => <Badge tone="neutral">{r.requestedBy === 'CLIENT' ? tr('مشتری') : tr('داخلی')}</Badge> },
            { key: 'scope', header: 'Scope', render: (r) =>
              r.scopeVerdict === 'OUT_OF_SCOPE' ? <Badge tone="warning">{tr('خارج')}</Badge>
              : r.scopeVerdict === 'IN_SCOPE' ? <Badge tone="success">{tr('داخل')}</Badge>
              : <Badge tone="neutral">{tr('تعیین‌نشده')}</Badge> },
            { key: 'cost', header: tr('اثر هزینه‌ای'), render: (r) => <span className="text-xs">{r.costImpact ? formatCurrency(r.costImpact) : '—'}</span> },
            { key: 'state', header: tr('وضعیت'), render: (r) => <StateBadge state={r.state} /> },
          ]}
        />
      </PageBody>
    </>
  );
}

const IMPACT_FIELDS = [
  { key: 'timeImpactDays', label: tr('اثر زمانی (روز)'), type: 'number' },
  { key: 'costImpact', label: tr('اثر هزینه‌ای (ریال)'), type: 'number' },
  { key: 'resourceImpact', label: tr('اثر بر منابع'), type: 'text' },
  { key: 'scopeImpact', label: tr('اثر بر Scope'), type: 'text' },
  { key: 'qualityImpact', label: tr('اثر بر کیفیت'), type: 'text' },
  { key: 'contractImpact', label: tr('اثر بر قرارداد'), type: 'text' },
] as const;

export function ChangeDetail() {
  const { id } = useParams<{ id: string }>();
  const [scopeOpen, setScopeOpen] = useState(false);
  const [impactOpen, setImpactOpen] = useState(false);
  const { can } = useAuth();

  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: [`/change-requests/${id}`], queryFn: () => apiGet(`/change-requests/${id}`), enabled: !!id,
  });

  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const assessed = IMPACT_FIELDS.filter((f) => data[f.key] != null && data[f.key] !== '');
  const missing = IMPACT_FIELDS.filter((f) => data[f.key] == null || data[f.key] === '');

  return (
    <>
      <PageHeader
        title={data.title}
        badge={<>
          <StateBadge state={data.state} />
          {data.scopeVerdict === 'OUT_OF_SCOPE' && <Badge tone="warning">{tr('خارج از Scope')}</Badge>}
          {data.scopeVerdict === 'IN_SCOPE' && <Badge tone="success">{tr('داخل Scope')}</Badge>}
        </>}
        subtitle={<span className="flex items-center gap-2"><Code>{data.code}</Code>
          {data.project && <Link to={`/projects/${data.project.id}`} className="text-brand-600 hover:underline">{data.project.name}</Link>}</span>}
        actions={
          <>
            {can('change.scope_review') && data.scopeVerdict === 'UNDETERMINED' && (
              <Button variant="secondary" onClick={() => setScopeOpen(true)}>{tr('ثبت بررسی Scope')}</Button>
            )}
            {can('change.commercial_review') && data.scopeVerdict === 'OUT_OF_SCOPE' && (
              <Button variant="secondary" onClick={() => setImpactOpen(true)}>{tr('ثبت ارزیابی اثر')}</Button>
            )}
            <WorkflowActions entity="changeRequest" id={data.id} transitions={data.availableTransitions} />
          </>
        }
      />
      <PageBody className="space-y-5">
        {data.scopeVerdict === 'OUT_OF_SCOPE' && missing.length > 0 && (
          <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
            <strong className="font-semibold">{tr('قانون ۸ —')}{' '}</strong>{tr('تا ارزیابی این ابعاد، ارسال به مشتری مجاز نیست:')}<span className="font-medium"> {missing.map((m) => m.label).join(tr('، '))}</span>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-2">
          <Card title={tr('شرح تغییر')}>
            <dl className="px-4 py-1">
              <DescRow label={tr('درخواست‌کننده')}>{data.requestedBy === 'CLIENT' ? tr('مشتری') : tr('داخلی')}</DescRow>
              <DescRow label={tr('تاریخ درخواست')}>{formatDate(data.requestedDate)}</DescRow>
              <DescRow label={tr('اولویت')}>{data.priority}</DescRow>
            </dl>
            <p className="border-t border-ink-100 px-4 py-3 text-sm text-ink-700">{data.requestedChange}</p>
            {data.scopeRationale && (
              <p className="border-t border-ink-100 px-4 py-3 text-sm">
                <span className="text-xs text-ink-500">{tr('استدلال Scope:')}{' '}</span>
                {data.scopeRationale}
              </p>
            )}
          </Card>

          <Card title={tr('ارزیابی اثر تجاری')} subtitle={tr('شش بُعد الزامی قانون ۸')}
            action={<Badge tone={missing.length === 0 ? 'success' : 'warning'}>{tr('{0} از {1}', localDigits(assessed.length), localDigits(IMPACT_FIELDS.length))}</Badge>}>
            <div className="px-4 py-2">
              <ProgressBar value={(assessed.length / IMPACT_FIELDS.length) * 100} tone={missing.length === 0 ? 'success' : 'warning'} />
            </div>
            <dl className="px-4 pb-2">
              {IMPACT_FIELDS.map((f) => (
                <DescRow key={f.key} label={f.label}>
                  {data[f.key] != null && data[f.key] !== ''
                    ? (f.key === 'costImpact' ? formatCurrency(data[f.key])
                      : f.key === 'timeImpactDays' ? tr('{0} روز', localDigits(data[f.key]))
                      : String(data[f.key]))
                    : <span className="text-rose-500">{tr('ارزیابی نشده')}</span>}
                </DescRow>
              ))}
              {data.proposedPrice && <DescRow label={tr('قیمت پیشنهادی')}>{formatCurrency(data.proposedPrice)}</DescRow>}
            </dl>
          </Card>
        </div>

        {!!data.amendments?.length && (
          <Card title={tr('الحاقیه‌های قرارداد')}>
            <Table>
              <thead className="bg-ink-50/60"><tr><Th>{tr('شماره')}</Th><Th>{tr('تاریخ اجرا')}</Th><Th>{tr('تغییر مبلغ')}</Th><Th>{tr('تمدید')}</Th></tr></thead>
              <tbody>
                {data.amendments.map((a: any) => (
                  <Tr key={a.id}>
                    <Td className="ltr text-xs">{a.amendmentNumber}</Td>
                    <Td className="text-xs">{formatDate(a.effectiveDate)}</Td>
                    <Td className="text-xs">{formatCurrency(a.valueDelta)}</Td>
                    <Td className="nums text-xs">{tr('{0} روز', localDigits(a.durationDeltaDays))}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
      </PageBody>

      {scopeOpen && <ScopeModal id={data.id} onClose={() => setScopeOpen(false)} />}
      {impactOpen && <ImpactModal change={data} onClose={() => setImpactOpen(false)} />}
    </>
  );
}

function ScopeModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [verdict, setVerdict] = useState<'IN_SCOPE' | 'OUT_OF_SCOPE'>('IN_SCOPE');
  const [rationale, setRationale] = useState('');
  const save = useAction((body: unknown) => apiPost(`/change-requests/${id}/scope-review`, body), tr('بررسی Scope ثبت شد.'));

  return (
    <Modal
      open onClose={onClose} title={tr('بررسی Scope')}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
        <Button variant="primary" loading={save.isPending} disabled={rationale.trim().length < 3}
          onClick={async () => { await save.mutateAsync({ verdict, rationale }); onClose(); }}>{tr('ثبت')}</Button>
      </>}
    >
      <div className="space-y-4">
        <Field label={tr('نتیجه بررسی')} required>
          <Select value={verdict} onChange={(e) => setVerdict(e.target.value as 'IN_SCOPE' | 'OUT_OF_SCOPE')}>
            <option value="IN_SCOPE">{tr('داخل Scope قرارداد — اجرا طبق فرآیند عادی')}</option>
            <option value="OUT_OF_SCOPE">{tr('خارج از Scope — نیازمند بررسی تجاری')}</option>
          </Select>
        </Field>
        <Field label={tr('استدلال')} required><Textarea value={rationale} onChange={(e) => setRationale(e.target.value)} rows={3} /></Field>
      </div>
    </Modal>
  );
}

function ImpactModal({ change, onClose }: { change: any; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const f of IMPACT_FIELDS) initial[f.key] = change[f.key] != null ? String(change[f.key]) : '';
    initial.proposedPrice = change.proposedPrice != null ? String(change.proposedPrice) : '';
    return initial;
  });
  const save = useAction((body: unknown) => apiPost(`/change-requests/${change.id}/impact`, body), tr('ارزیابی اثر ثبت شد.'));
  const complete = IMPACT_FIELDS.every((f) => values[f.key]?.trim());

  return (
    <Modal
      open wide onClose={onClose} title={tr('ارزیابی اثر تجاری تغییر')}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
        <Button variant="primary" loading={save.isPending} disabled={!complete} onClick={async () => {
          await save.mutateAsync({
            timeImpactDays: Number(values.timeImpactDays), costImpact: Number(values.costImpact),
            resourceImpact: values.resourceImpact, scopeImpact: values.scopeImpact,
            qualityImpact: values.qualityImpact, contractImpact: values.contractImpact,
            proposedPrice: values.proposedPrice ? Number(values.proposedPrice) : undefined,
          });
          onClose();
        }}>{tr('ثبت ارزیابی')}</Button>
      </>}
    >
      <p className="mb-4 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">{tr('قانون ۸ — پیش از اجرا باید اثر تغییر بر زمان، هزینه، منابع، Scope، کیفیت و قرارداد مشخص شود.')}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {IMPACT_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} required>
            {f.type === 'number'
              ? <Input type="number" value={values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className="ltr" />
              : <Textarea rows={2} value={values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />}
          </Field>
        ))}
        <Field label={tr('قیمت پیشنهادی به مشتری (ریال)')}>
          <Input type="number" value={values.proposedPrice} onChange={(e) => setValues((v) => ({ ...v, proposedPrice: e.target.value }))} className="ltr" />
        </Field>
      </div>
    </Modal>
  );
}

/* ── Traffic ───────────────────────────────────────────────────────────── */

export function Traffic() {
  const [unit, setUnit] = useState('');
  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: ['/traffic', unit],
    queryFn: () => apiGet('/traffic', { unit: unit || undefined }),
  });

  return (
    <>
      <PageHeader
        title={tr('ترافیک و ظرفیت')}
        subtitle={tr('ظرفیت در دسترس در برابر کار تعهدشده — روی تقویم و مرخصی خود هر فرد، و همان حسابی که پیشنهاد تخصیص از آن می‌آید')}
        actions={
          <div className="w-48"><Select value={unit} onChange={(e) => setUnit(e.target.value)}>
            <option value="">{tr('همه واحدها')}</option>
            {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
          </Select></div>
        }
      />
      <PageBody className="space-y-5">
        {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={() => void refetch()} /> : data && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <StatTile label={tr('افراد')} value={localDigits(data.summary.people)} />
              <StatTile label={tr('اضافه‌تخصیص')} value={localDigits(data.summary.overAllocated)}
                tone={data.summary.overAllocated > 0 ? 'danger' : 'success'} hint={tr('بیش از ۱۰۰٪ ظرفیت')} />
              <StatTile label={tr('در سقف ظرفیت')} value={localDigits(data.summary.atCapacity)} tone="warning" />
              <StatTile label={tr('در مرخصی')} value={localDigits(data.summary.onLeave ?? 0)} tone={data.summary.onLeave > 0 ? 'info' : 'neutral'}
                hint={tr('بخشی از این بازه را نیستند')} />
              <StatTile label={tr('میانگین بهره‌وری')} value={tr('{0}٪', localDigits(data.summary.averageUtilisation))}
                tone={data.summary.averageUtilisation > 90 ? 'danger' : data.summary.averageUtilisation > 60 ? 'success' : 'warning'} />
            </div>

            <Card title={tr('بار کاری افراد')} subtitle={tr('بازه {0} روز کاری', localDigits(data.window.workingDays))}>
              <Table>
                <thead className="bg-ink-50/60">
                  <tr><Th>{tr('فرد')}</Th><Th>{tr('واحد')}</Th><Th>{tr('ظرفیت')}</Th><Th>{tr('تعهدشده')}</Th><Th>{tr('در دسترس')}</Th><Th>{tr('بهره‌وری')}</Th><Th>{tr('وظایف باز')}</Th></tr>
                </thead>
                <tbody>
                  {data.rows.map((r: any) => (
                    <Tr key={r.user.id}>
                      <Td><p className="text-sm">{r.user.fullName}</p><p className="text-[11px] text-ink-400">{trx(r.user.jobTitle)}</p></Td>
                      <Td><UnitTag code={r.department?.code} /></Td>
                      <Td className="nums text-xs">{tr('{0} س', localDigits(r.capacityHours))}{r.leaveHours > 0 && <Badge tone="info" className="ms-1">{tr('{0} س مرخصی', localDigits(r.leaveHours))}</Badge>}
                      </Td>
                      <Td className="nums text-xs">{tr('{0} س', localDigits(r.committedHours))}</Td>
                      <Td className={cx('nums text-xs', r.availableHours < 0 && 'font-medium text-rose-600')}>{tr('{0} س', localDigits(r.availableHours))}</Td>
                      <Td>
                        <div className="w-24">
                          <ProgressBar value={r.utilisation}
                            tone={r.utilisation > 100 ? 'danger' : r.utilisation >= 85 ? 'warning' : r.utilisation >= 40 ? 'success' : 'neutral'} />
                          <span className="nums text-[11px] text-ink-500">{tr('{0}٪', localDigits(r.utilisation))}</span>
                        </div>
                      </Td>
                      <Td className="nums text-xs">
                        {localDigits(r.openTasks)}
                        {r.overdueTasks > 0 && <Badge tone="danger" className="ms-1">{tr('{0} گذشته', localDigits(r.overdueTasks))}</Badge>}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          </>
        )}
      </PageBody>
    </>
  );
}
