import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageBody, PageHeader } from '../components/Shell';
import { EstimateCheck } from '../components/EstimateCheck';
import { Code, EntityList, StateHistory, WorkflowActions } from '../components/common';
import { PdfButton } from '../components/PdfButton';
import { PdfBundleButton } from '../components/PdfBundleButton';
import { REVISION_REASON_LABELS } from '@hiva/contracts';
import { useAction } from '../hooks/queries';
import {
  Badge, Button, Card, DescRow, EmptyState, ErrorBlock, Field, Input, LoadingBlock,
  Modal, ProgressBar, Select, StateBadge, StatTile, Table, Td, Textarea, Th, Tr, cx,
} from '../components/ui';
import { daysFromNow, formatCurrency, formatDate, formatRelative, toPersianDigits } from '../lib/format';
import { TaskTime } from '../components/TaskTime';

const UNITS = [
  { value: 'ST', label: 'استراتژی' }, { value: 'CR', label: 'خلاقیت / گرافیک / تولید' },
  { value: 'ME', label: 'رسانه' }, { value: 'DM', label: 'دیجیتال مارکتینگ' },
];

/* ── Tasks ─────────────────────────────────────────────────────────────── */

export function TasksList() {
  const [mineOnly, setMineOnly] = useState(true);
  return (
    <>
      <PageHeader
        title="وظایف"
        subtitle="قانون ۶ — هر وظیفه باید به یک سند مرجع (بریف، سفارش، صورتجلسه، درخواست تغییر یا اصلاحیه) متصل باشد"
        actions={
          <div className="flex rounded-lg bg-ink-100 p-0.5">
            {[{ v: true, l: 'وظایف من' }, { v: false, l: 'همه وظایف' }].map((o) => (
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
          searchPlaceholder="جستجو در عنوان وظیفه…"
          filters={[
            { key: 'state', label: 'وضعیت', options: [
              { value: 'ASSIGNED', label: 'تخصیص‌یافته' }, { value: 'ACCEPTED', label: 'پذیرفته‌شده' },
              { value: 'IN_PROGRESS', label: 'در حال انجام' }, { value: 'BLOCKED', label: 'مسدود' },
              { value: 'SUBMITTED', label: 'تحویل‌شده' }, { value: 'IN_QC', label: 'در QC' },
              { value: 'REVISION_REQUIRED', label: 'نیاز به اصلاح' }, { value: 'APPROVED', label: 'تأییدشده' },
            ] },
            { key: 'unit', label: 'واحد', options: UNITS },
          ]}
          emptyTitle="وظیفه‌ای یافت نشد"
          columns={[
            { key: 'title', header: 'وظیفه', render: (r) => (<><p className="font-medium text-ink-800">{r.title}</p><Code>{r.code}</Code></>) },
            { key: 'project', header: 'پروژه', render: (r) => r.project ? <Link to={`/projects/${r.project.id}`} className="text-xs text-brand-600 hover:underline" onClick={(e) => e.stopPropagation()}>{r.project.name}</Link> : '—' },
            { key: 'source', header: 'سند مرجع', render: (r) => <Code>{r.sourceRef}</Code> },
            { key: 'assignee', header: 'مسئول', render: (r) => <span className="text-xs">{r.assignee?.fullName ?? '—'}</span> },
            {
              key: 'due', header: 'مهلت',
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
            { key: 'state', header: 'وضعیت', render: (r) => <StateBadge state={r.state} /> },
            { key: 'actions', header: 'اقدام', render: (r) => (<div onClick={(e) => e.stopPropagation()}><WorkflowActions entity="task" id={r.id} transitions={r.availableTransitions} /></div>) },
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
            <span>واحد {data.departmentCode}</span>
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
          <Card title="شرح وظیفه">
            <div className="px-4 py-3 text-sm text-ink-800">
              {data.description || <span className="text-ink-400">— شرحی ثبت نشده —</span>}
            </div>
          </Card>

          {/* Doc_H §6: no task is valid without a source document behind it. */}
          <TaskTime taskId={data.id} assigneeId={data.assigneeId ?? null} />
          <Card title="سند مبنا" subtitle="Doc_H §۶ — هیچ Task شفاهی معتبر نیست">
            <dl className="px-4 py-1">
              <DescRow label="نوع سند">{SOURCE_LABELS[data.sourceType] ?? data.sourceType}</DescRow>
              <DescRow label="شناسه سند">
                {data.workOrder
                  ? <Link to={`/work-orders/${data.workOrder.id}`} className="text-brand-600 hover:underline">
                      {data.workOrder.code} — {data.workOrder.title}
                    </Link>
                  : <Code>{data.sourceRef}</Code>}
              </DescRow>
            </dl>
          </Card>

          {data.revisions?.length > 0 && (
            <Card title="اصلاحیه‌ها" subtitle={`${toPersianDigits(data.revisions.length)} مورد`}>
              <Table>
                <thead><Tr><Th>کد</Th><Th>علت</Th><Th>وضعیت</Th><Th>مهلت</Th></Tr></thead>
                <tbody>
                  {data.revisions.map((r: any) => (
                    <Tr key={r.id}>
                      <Td><Code>{r.code}</Code></Td>
                      <Td className="text-xs">{REVISION_REASON_LABELS[r.reason] ?? r.reason}</Td>
                      <Td><StateBadge state={r.state} /></Td>
                      <Td className="text-xs">{formatDate(r.dueDate)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}

          {data.qcReviews?.length > 0 && (
            <Card title="کنترل کیفیت">
              <Table>
                <thead><Tr><Th>کد</Th><Th>سطح</Th><Th>نتیجه</Th><Th>یافته‌ها</Th></Tr></thead>
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
          <Card title="مشخصات">
            <dl className="px-4 py-1">
              <DescRow label="مسئول">{data.assignee?.fullName ?? '— تخصیص نیافته —'}</DescRow>
              <DescRow label="مهلت">
                <span className={overdue ? 'text-rose-600' : undefined}>
                  {formatDate(data.dueDate)}{overdue ? ' — سررسید گذشته' : ''}
                </span>
              </DescRow>
              <DescRow label="اولویت">
                <Badge tone={data.priority === 'URGENT' ? 'danger' : data.priority === 'HIGH' ? 'warning' : 'neutral'}>
                  {data.priority}
                </Badge>
              </DescRow>
              <DescRow label="برآورد">
                {data.estimateHours ? `${toPersianDigits(Number(data.estimateHours))} ساعت` : '—'}
              </DescRow>
              <DescRow label="پذیرش">{data.acceptedAt ? formatDate(data.acceptedAt) : '— پذیرفته نشده —'}</DescRow>
              <DescRow label="تحویل">{data.submittedAt ? formatDate(data.submittedAt) : '— تحویل نشده —'}</DescRow>
            </dl>
          </Card>

          {data.blockReason && (
            <Card title="مانع اعلام‌شده">
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
  BRIEF: 'بریف',
  ORDER_FORM: 'فرم سفارش',
  TASK: 'وظیفه',
  MEETING_MINUTES: 'صورتجلسه',
  CHANGE_REQUEST: 'درخواست تغییر',
  REVISION_FORM: 'فرم اصلاحیه',
};

export function WorkOrdersList() {
  return (
    <>
      <PageHeader title="سفارش‌های کار" subtitle="Doc_H §C — هر سفارش باید ۹ عنصر الزامی داشته باشد" />
      <PageBody>
        <EntityList<any>
          path="/work-orders"
          searchPlaceholder="جستجو در عنوان یا شرح کار…"
          rowHref={(r) => `/work-orders/${r.id}`}
          filters={[
            { key: 'state', label: 'وضعیت', options: [
              { value: 'DRAFT', label: 'پیش‌نویس' }, { value: 'ISSUED', label: 'صادرشده' },
              { value: 'PENDING_ACCEPTANCE', label: 'در انتظار پذیرش' }, { value: 'ACCEPTED', label: 'پذیرفته‌شده' },
              { value: 'CLARIFICATION_REQUESTED', label: 'ابهام اعلام شد' },
              { value: 'IN_PROGRESS', label: 'در حال انجام' }, { value: 'SUBMITTED', label: 'تحویل‌شده' },
              { value: 'COMPLETED', label: 'تکمیل‌شده' },
            ] },
            { key: 'unit', label: 'واحد', options: UNITS },
          ]}
          emptyTitle="سفارشی صادر نشده"
          columns={[
            { key: 'title', header: 'سفارش', render: (r) => (<><p className="font-medium text-ink-800">{r.title}</p><Code>{r.code}</Code></>) },
            { key: 'unit', header: 'واحد مقصد', render: (r) => <span className="text-xs">{r.targetDepartmentCode}</span> },
            { key: 'project', header: 'پروژه', render: (r) => <span className="text-xs">{r.project?.name}</span> },
            { key: 'owner', header: 'مسئول', render: (r) => <span className="text-xs">{r.owner?.fullName}</span> },
            { key: 'deadline', header: 'مهلت', render: (r) => <span className="text-xs">{formatDate(r.deadline)}</span> },
            { key: 'state', header: 'وضعیت', render: (r) => <StateBadge state={r.state} /> },
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
          <span>واحد {data.targetDepartmentCode}</span>
          {data.project && <Link to={`/projects/${data.project.id}`} className="text-brand-600 hover:underline">{data.project.name}</Link>}</span>}
        actions={
          <>
            {can('pricing.declare_cost') && (
              <Button variant="secondary" onClick={() => setCosting(true)}>اعلام قیمت تمام‌شده</Button>
            )}
            <PdfButton kind="work-order" id={data.id} />
            <PdfBundleButton kind="work-order" id={data.id} />
            <WorkflowActions entity="workOrder" id={data.id} transitions={data.availableTransitions} />
          </>
        }
      />
      <PageBody className="grid gap-5 lg:grid-cols-3">
        <Card title="عناصر الزامی سفارش" className="lg:col-span-2" subtitle="Doc_H §C">
          <dl className="divide-y divide-ink-100">
            {[['شرح کار', data.scopeOfWork], ['بریف', data.brief], ['خروجی مورد انتظار', data.expectedOutput],
              ['فرمت خروجی', data.outputFormat], ['منابع مورد نیاز', data.requiredResources]].map(([l, v]) => (
              <div key={l as string} className="px-4 py-3">
                <dt className="text-xs font-medium text-ink-500">{l}</dt>
                <dd className={v ? 'mt-1 text-sm text-ink-800' : 'mt-1 text-sm text-rose-500'}>{(v as string) || '— ثبت نشده —'}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <div className="space-y-5">
          <Card title="مشخصات">
            <dl className="px-4 py-1">
              <DescRow label="مسئول">{data.owner?.fullName}</DescRow>
              <DescRow label="مهلت">{formatDate(data.deadline)}</DescRow>
              <DescRow label="بودجه">{formatCurrency(data.budget)}</DescRow>
              <DescRow label="اولویت"><Badge tone={data.priority === 'URGENT' ? 'danger' : data.priority === 'HIGH' ? 'warning' : 'neutral'}>{data.priority}</Badge></DescRow>
              <DescRow label="پذیرش">{data.acceptedAt ? formatDate(data.acceptedAt) : '— پذیرفته نشده —'}</DescRow>
            </dl>
          </Card>

          <Card title="قیمت تمام‌شده اعلامی">
            {!data.costDeclarations?.length ? (
              <EmptyState title="هزینه‌ای اعلام نشده" description="تحویل خروجی بدون اعلام قیمت تمام‌شده مجاز نیست (قانون ۱۲)." />
            ) : (
              <ul className="divide-y divide-ink-100">
                {data.costDeclarations.map((c: any) => (
                  <li key={c.id} className="px-4 py-2.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-ink-500">داخلی</span>
                      <span className="nums">{formatCurrency(c.internalCost)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ink-500">خارجی</span>
                      <span className="nums">{formatCurrency(c.externalCost)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {!!data.tasks?.length && (
          <Card title="وظایف مرتبط" className="lg:col-span-3">
            <Table>
              <thead className="bg-ink-50/60"><tr><Th>وظیفه</Th><Th>مسئول</Th><Th>مهلت</Th><Th>وضعیت</Th></tr></thead>
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
  const [assumptions, setAssumptions] = useState('');

  const save = useAction(
    (body: unknown) => apiPost(`/work-orders/${workOrder.id}/cost`, body),
    'قیمت تمام‌شده ثبت شد.',
  );

  const submit = async () => {
    await save.mutateAsync({
      departmentCode: workOrder.targetDepartmentCode,
      internalCost: Number(internal), externalCost: Number(external || 0),
      assumptions: assumptions || undefined, items: [],
    });
    onClose();
  };

  return (
    <Modal
      open onClose={onClose} title="اعلام قیمت تمام‌شده"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>انصراف</Button>
          <Button variant="primary" loading={save.isPending} disabled={!internal} onClick={() => void submit()}>ثبت</Button>
        </>
      }
    >
      <p className="mb-4 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
        قانون ۱۲ — واحد اجرایی فقط قیمت تمام‌شده را اعلام می‌کند. تعیین قیمت فروش در فرآیند Pricing و توسط نقش‌های مجاز انجام می‌شود.
      </p>
      <div className="space-y-4">
        <Field label="هزینه داخلی (ریال)" required><Input type="number" value={internal} onChange={(e) => setInternal(e.target.value)} className="ltr" /></Field>
        <Field label="هزینه خارجی (ریال)"><Input type="number" value={external} onChange={(e) => setExternal(e.target.value)} className="ltr" /></Field>
        <Field label="مفروضات"><Textarea value={assumptions} onChange={(e) => setAssumptions(e.target.value)} rows={2} /></Field>
        {/* What similar work actually cost, while the figure can still change (roadmap #24). */}
        <EstimateCheck workOrderId={workOrder.id} proposed={Number(internal || 0) + Number(external || 0)} />
      </div>
    </Modal>
  );
}

/* ── Change requests ───────────────────────────────────────────────────── */

export function ChangesList() {
  return (
    <>
      <PageHeader title="درخواست‌های تغییر" subtitle="قانون ۸ — تغییر خارج از Scope بدون ارزیابی اثر و تأیید مشتری اجرا نمی‌شود" />
      <PageBody>
        <EntityList<any>
          path="/change-requests"
          searchPlaceholder="جستجو در عنوان تغییر…"
          rowHref={(r) => `/changes/${r.id}`}
          filters={[
            { key: 'state', label: 'وضعیت', options: [
              { value: 'SUBMITTED', label: 'ثبت‌شده' }, { value: 'SCOPE_REVIEW', label: 'بررسی Scope' },
              { value: 'COMMERCIAL_REVIEW', label: 'بررسی تجاری' },
              { value: 'PENDING_CUSTOMER_APPROVAL', label: 'در انتظار مشتری' },
              { value: 'APPROVED', label: 'تأییدشده' }, { value: 'IMPLEMENTING', label: 'در حال اجرا' },
              { value: 'CLOSED', label: 'بسته‌شده' }, { value: 'REJECTED', label: 'رد شده' },
            ] },
            { key: 'scope', label: 'Scope', options: [
              { value: 'IN_SCOPE', label: 'داخل Scope' }, { value: 'OUT_OF_SCOPE', label: 'خارج از Scope' },
              { value: 'UNDETERMINED', label: 'تعیین‌نشده' },
            ] },
          ]}
          emptyTitle="درخواست تغییری ثبت نشده"
          columns={[
            { key: 'title', header: 'تغییر', render: (r) => (<><p className="font-medium text-ink-800">{r.title}</p><Code>{r.code}</Code></>) },
            { key: 'project', header: 'پروژه', render: (r) => <span className="text-xs">{r.project?.name}</span> },
            { key: 'by', header: 'درخواست‌کننده', render: (r) => <Badge tone="neutral">{r.requestedBy === 'CLIENT' ? 'مشتری' : 'داخلی'}</Badge> },
            { key: 'scope', header: 'Scope', render: (r) =>
              r.scopeVerdict === 'OUT_OF_SCOPE' ? <Badge tone="warning">خارج</Badge>
              : r.scopeVerdict === 'IN_SCOPE' ? <Badge tone="success">داخل</Badge>
              : <Badge tone="neutral">تعیین‌نشده</Badge> },
            { key: 'cost', header: 'اثر هزینه‌ای', render: (r) => <span className="text-xs">{r.costImpact ? formatCurrency(r.costImpact) : '—'}</span> },
            { key: 'state', header: 'وضعیت', render: (r) => <StateBadge state={r.state} /> },
          ]}
        />
      </PageBody>
    </>
  );
}

const IMPACT_FIELDS = [
  { key: 'timeImpactDays', label: 'اثر زمانی (روز)', type: 'number' },
  { key: 'costImpact', label: 'اثر هزینه‌ای (ریال)', type: 'number' },
  { key: 'resourceImpact', label: 'اثر بر منابع', type: 'text' },
  { key: 'scopeImpact', label: 'اثر بر Scope', type: 'text' },
  { key: 'qualityImpact', label: 'اثر بر کیفیت', type: 'text' },
  { key: 'contractImpact', label: 'اثر بر قرارداد', type: 'text' },
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
          {data.scopeVerdict === 'OUT_OF_SCOPE' && <Badge tone="warning">خارج از Scope</Badge>}
          {data.scopeVerdict === 'IN_SCOPE' && <Badge tone="success">داخل Scope</Badge>}
        </>}
        subtitle={<span className="flex items-center gap-2"><Code>{data.code}</Code>
          {data.project && <Link to={`/projects/${data.project.id}`} className="text-brand-600 hover:underline">{data.project.name}</Link>}</span>}
        actions={
          <>
            {can('change.scope_review') && data.scopeVerdict === 'UNDETERMINED' && (
              <Button variant="secondary" onClick={() => setScopeOpen(true)}>ثبت بررسی Scope</Button>
            )}
            {can('change.commercial_review') && data.scopeVerdict === 'OUT_OF_SCOPE' && (
              <Button variant="secondary" onClick={() => setImpactOpen(true)}>ثبت ارزیابی اثر</Button>
            )}
            <WorkflowActions entity="changeRequest" id={data.id} transitions={data.availableTransitions} />
          </>
        }
      />
      <PageBody className="space-y-5">
        {data.scopeVerdict === 'OUT_OF_SCOPE' && missing.length > 0 && (
          <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
            <strong className="font-semibold">قانون ۸ — </strong>
            تا ارزیابی این ابعاد، ارسال به مشتری مجاز نیست:
            <span className="font-medium"> {missing.map((m) => m.label).join('، ')}</span>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="شرح تغییر">
            <dl className="px-4 py-1">
              <DescRow label="درخواست‌کننده">{data.requestedBy === 'CLIENT' ? 'مشتری' : 'داخلی'}</DescRow>
              <DescRow label="تاریخ درخواست">{formatDate(data.requestedDate)}</DescRow>
              <DescRow label="اولویت">{data.priority}</DescRow>
            </dl>
            <p className="border-t border-ink-100 px-4 py-3 text-sm text-ink-700">{data.requestedChange}</p>
            {data.scopeRationale && (
              <p className="border-t border-ink-100 px-4 py-3 text-sm">
                <span className="text-xs text-ink-500">استدلال Scope: </span>
                {data.scopeRationale}
              </p>
            )}
          </Card>

          <Card title="ارزیابی اثر تجاری" subtitle="شش بُعد الزامی قانون ۸"
            action={<Badge tone={missing.length === 0 ? 'success' : 'warning'}>
              {toPersianDigits(assessed.length)} از {toPersianDigits(IMPACT_FIELDS.length)}
            </Badge>}>
            <div className="px-4 py-2">
              <ProgressBar value={(assessed.length / IMPACT_FIELDS.length) * 100} tone={missing.length === 0 ? 'success' : 'warning'} />
            </div>
            <dl className="px-4 pb-2">
              {IMPACT_FIELDS.map((f) => (
                <DescRow key={f.key} label={f.label}>
                  {data[f.key] != null && data[f.key] !== ''
                    ? (f.key === 'costImpact' ? formatCurrency(data[f.key])
                      : f.key === 'timeImpactDays' ? `${toPersianDigits(data[f.key])} روز`
                      : String(data[f.key]))
                    : <span className="text-rose-500">ارزیابی نشده</span>}
                </DescRow>
              ))}
              {data.proposedPrice && <DescRow label="قیمت پیشنهادی">{formatCurrency(data.proposedPrice)}</DescRow>}
            </dl>
          </Card>
        </div>

        {!!data.amendments?.length && (
          <Card title="الحاقیه‌های قرارداد">
            <Table>
              <thead className="bg-ink-50/60"><tr><Th>شماره</Th><Th>تاریخ اجرا</Th><Th>تغییر مبلغ</Th><Th>تمدید</Th></tr></thead>
              <tbody>
                {data.amendments.map((a: any) => (
                  <Tr key={a.id}>
                    <Td className="ltr text-xs">{a.amendmentNumber}</Td>
                    <Td className="text-xs">{formatDate(a.effectiveDate)}</Td>
                    <Td className="text-xs">{formatCurrency(a.valueDelta)}</Td>
                    <Td className="nums text-xs">{toPersianDigits(a.durationDeltaDays)} روز</Td>
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
  const save = useAction((body: unknown) => apiPost(`/change-requests/${id}/scope-review`, body), 'بررسی Scope ثبت شد.');

  return (
    <Modal
      open onClose={onClose} title="بررسی Scope"
      footer={<>
        <Button variant="ghost" onClick={onClose}>انصراف</Button>
        <Button variant="primary" loading={save.isPending} disabled={rationale.trim().length < 3}
          onClick={async () => { await save.mutateAsync({ verdict, rationale }); onClose(); }}>ثبت</Button>
      </>}
    >
      <div className="space-y-4">
        <Field label="نتیجه بررسی" required>
          <Select value={verdict} onChange={(e) => setVerdict(e.target.value as 'IN_SCOPE' | 'OUT_OF_SCOPE')}>
            <option value="IN_SCOPE">داخل Scope قرارداد — اجرا طبق فرآیند عادی</option>
            <option value="OUT_OF_SCOPE">خارج از Scope — نیازمند بررسی تجاری</option>
          </Select>
        </Field>
        <Field label="استدلال" required><Textarea value={rationale} onChange={(e) => setRationale(e.target.value)} rows={3} /></Field>
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
  const save = useAction((body: unknown) => apiPost(`/change-requests/${change.id}/impact`, body), 'ارزیابی اثر ثبت شد.');
  const complete = IMPACT_FIELDS.every((f) => values[f.key]?.trim());

  return (
    <Modal
      open wide onClose={onClose} title="ارزیابی اثر تجاری تغییر"
      footer={<>
        <Button variant="ghost" onClick={onClose}>انصراف</Button>
        <Button variant="primary" loading={save.isPending} disabled={!complete} onClick={async () => {
          await save.mutateAsync({
            timeImpactDays: Number(values.timeImpactDays), costImpact: Number(values.costImpact),
            resourceImpact: values.resourceImpact, scopeImpact: values.scopeImpact,
            qualityImpact: values.qualityImpact, contractImpact: values.contractImpact,
            proposedPrice: values.proposedPrice ? Number(values.proposedPrice) : undefined,
          });
          onClose();
        }}>ثبت ارزیابی</Button>
      </>}
    >
      <p className="mb-4 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
        قانون ۸ — پیش از اجرا باید اثر تغییر بر زمان، هزینه، منابع، Scope، کیفیت و قرارداد مشخص شود.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {IMPACT_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} required>
            {f.type === 'number'
              ? <Input type="number" value={values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className="ltr" />
              : <Textarea rows={2} value={values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />}
          </Field>
        ))}
        <Field label="قیمت پیشنهادی به مشتری (ریال)">
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
        title="ترافیک و ظرفیت"
        subtitle="ظرفیت در دسترس در برابر کار تعهدشده — روی تقویم و مرخصی خود هر فرد، و همان حسابی که پیشنهاد تخصیص از آن می‌آید"
        actions={
          <div className="w-48"><Select value={unit} onChange={(e) => setUnit(e.target.value)}>
            <option value="">همه واحدها</option>
            {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
          </Select></div>
        }
      />
      <PageBody className="space-y-5">
        {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={() => void refetch()} /> : data && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <StatTile label="افراد" value={toPersianDigits(data.summary.people)} />
              <StatTile label="اضافه‌تخصیص" value={toPersianDigits(data.summary.overAllocated)}
                tone={data.summary.overAllocated > 0 ? 'danger' : 'success'} hint="بیش از ۱۰۰٪ ظرفیت" />
              <StatTile label="در سقف ظرفیت" value={toPersianDigits(data.summary.atCapacity)} tone="warning" />
              <StatTile label="در مرخصی" value={toPersianDigits(data.summary.onLeave ?? 0)} tone={data.summary.onLeave > 0 ? 'info' : 'neutral'}
                hint="بخشی از این بازه را نیستند" />
              <StatTile label="میانگین بهره‌وری" value={`${toPersianDigits(data.summary.averageUtilisation)}٪`}
                tone={data.summary.averageUtilisation > 90 ? 'danger' : data.summary.averageUtilisation > 60 ? 'success' : 'warning'} />
            </div>

            <Card title="بار کاری افراد" subtitle={`بازه ${toPersianDigits(data.window.workingDays)} روز کاری`}>
              <Table>
                <thead className="bg-ink-50/60">
                  <tr><Th>فرد</Th><Th>واحد</Th><Th>ظرفیت</Th><Th>تعهدشده</Th><Th>در دسترس</Th><Th>بهره‌وری</Th><Th>وظایف باز</Th></tr>
                </thead>
                <tbody>
                  {data.rows.map((r: any) => (
                    <Tr key={r.user.id}>
                      <Td><p className="text-sm">{r.user.fullName}</p><p className="text-[11px] text-ink-400">{r.user.jobTitle}</p></Td>
                      <Td className="text-xs">{r.department?.nameFa ?? '—'}</Td>
                      <Td className="nums text-xs">
                        {toPersianDigits(r.capacityHours)} س
                        {r.leaveHours > 0 && <Badge tone="info" className="ms-1">{toPersianDigits(r.leaveHours)} س مرخصی</Badge>}
                      </Td>
                      <Td className="nums text-xs">{toPersianDigits(r.committedHours)} س</Td>
                      <Td className={cx('nums text-xs', r.availableHours < 0 && 'font-medium text-rose-600')}>
                        {toPersianDigits(r.availableHours)} س
                      </Td>
                      <Td>
                        <div className="w-24">
                          <ProgressBar value={r.utilisation}
                            tone={r.utilisation > 100 ? 'danger' : r.utilisation >= 85 ? 'warning' : r.utilisation >= 40 ? 'success' : 'neutral'} />
                          <span className="nums text-[11px] text-ink-500">{toPersianDigits(r.utilisation)}٪</span>
                        </div>
                      </Td>
                      <Td className="nums text-xs">
                        {toPersianDigits(r.openTasks)}
                        {r.overdueTasks > 0 && <Badge tone="danger" className="ms-1">{toPersianDigits(r.overdueTasks)} گذشته</Badge>}
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
