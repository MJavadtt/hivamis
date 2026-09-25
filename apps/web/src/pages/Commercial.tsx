import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Amount, FxRates, FxReport, NewInvoiceModal, NewPaymentModal, money } from '../components/Fx';
import { PageBody, PageHeader } from '../components/Shell';
import { Code, EntityList, WorkflowActions } from '../components/common';
import { PdfButton } from '../components/PdfButton';
import { PdfBundleButton } from '../components/PdfBundleButton';
import {
  Badge, Button, Card, DescRow, EmptyState, ErrorBlock, LoadingBlock, StateBadge, StatTile,
  Table, Tabs, Td, Th, Tr,
} from '../components/ui';
import { exactCurrency, formatCurrency, formatDate, toPersianDigits } from '../lib/format';

export function ContractsList() {
  return (
    <>
      <PageHeader title="قراردادها" subtitle="از درخواست انعقاد تا ثبت — قانون ۱۳ مبنای مجوز شروع پروژه" />
      <PageBody>
        <EntityList<any>
          path="/contracts"
          searchPlaceholder="جستجو در عنوان یا شماره قرارداد…"
          rowHref={(r) => `/contracts/${r.id}`}
          filters={[{
            key: 'state', label: 'وضعیت',
            options: [
              { value: 'REQUESTED', label: 'درخواست‌شده' }, { value: 'DRAFTING', label: 'در حال تنظیم' },
              { value: 'LEGAL_REVIEW', label: 'بررسی حقوقی' }, { value: 'INTERNAL_APPROVED', label: 'تأیید داخلی' },
              { value: 'PENDING_SIGNATURE', label: 'در انتظار امضا' }, { value: 'SIGNED', label: 'امضاشده' },
              { value: 'REGISTERED', label: 'ثبت‌شده' }, { value: 'TERMINATED', label: 'فسخ‌شده' },
            ],
          }]}
          emptyTitle="قراردادی ثبت نشده"
          columns={[
            { key: 'title', header: 'قرارداد', render: (r) => (<><p className="font-medium text-ink-800">{r.title}</p><Code>{r.code}</Code></>) },
            { key: 'number', header: 'شماره', render: (r) => <span className="ltr text-xs">{r.contractNumber ?? '—'}</span> },
            { key: 'company', header: 'مشتری', render: (r) => <span className="text-xs">{r.company?.legalName}</span> },
            { key: 'value', header: 'مبلغ', render: (r) => <span className="text-xs" title={exactCurrency(r.contractValue)}><Amount base={r.contractValue} original={r.originalValue} currency={r.currency} /></span> },
            { key: 'period', header: 'دوره', render: (r) => <span className="text-xs">{formatDate(r.startDate)} — {formatDate(r.endDate)}</span> },
            { key: 'state', header: 'وضعیت', render: (r) => <StateBadge state={r.state} /> },
          ]}
        />
      </PageBody>
    </>
  );
}

export function ContractDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: [`/contracts/${id}`], queryFn: () => apiGet(`/contracts/${id}`), enabled: !!id,
  });

  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  return (
    <>
      <PageHeader
        title={data.title}
        badge={<StateBadge state={data.state} />}
        subtitle={<span className="flex items-center gap-2">
          <Code>{data.code}</Code>
          {data.contractNumber && <span className="ltr">{data.contractNumber}</span>}
          <Link to={`/companies/${data.company.id}`} className="text-brand-600 hover:underline">{data.company.legalName}</Link>
        </span>}
        actions={
          <>
            <PdfButton kind="contract" id={data.id} />
            <PdfBundleButton kind="contract" id={data.id} />
            <WorkflowActions entity="contract" id={data.id} transitions={data.availableTransitions} />
          </>
        }
      />
      <PageBody className="grid gap-5 lg:grid-cols-3">
        <Card title="اطلاعات قرارداد" className="lg:col-span-1">
          <dl className="px-4 py-1">
            <DescRow label="مبلغ">
              {data.currency && data.currency !== 'IRR' && data.originalValue != null
                ? <>{money(data.originalValue, data.currency)} <span className="text-xs text-ink-500">— ثبت‌شده {exactCurrency(data.contractValue)} به نرخ {formatDate(data.fxRateDate)}</span></>
                : exactCurrency(data.contractValue)}
            </DescRow>
            <DescRow label="شروع">{formatDate(data.startDate)}</DescRow>
            <DescRow label="پایان">{formatDate(data.endDate)}</DescRow>
            <DescRow label="تاریخ امضا">{formatDate(data.signedDate)}</DescRow>
            <DescRow label="تاریخ ثبت">{formatDate(data.registeredAt)}</DescRow>
            <DescRow label="پروژه">
              {data.project ? <Link to={`/projects/${data.project.id}`} className="text-brand-600 hover:underline">{data.project.code}</Link> : '—'}
            </DescRow>
          </dl>
        </Card>

        <Card title="Scope و شرایط" className="lg:col-span-2">
          <dl className="divide-y divide-ink-100">
            <div className="px-4 py-3">
              <dt className="text-xs font-medium text-ink-500">خلاصه Scope</dt>
              <dd className="mt-1 text-sm text-ink-800">{data.scopeSummary || '—'}</dd>
            </div>
            <div className="px-4 py-3">
              <dt className="text-xs font-medium text-ink-500">شرایط پرداخت</dt>
              <dd className="mt-1 text-sm text-ink-800">{data.paymentTerms || '—'}</dd>
            </div>
            {data.legalReviewNote && (
              <div className="px-4 py-3">
                <dt className="text-xs font-medium text-ink-500">یادداشت حقوقی</dt>
                <dd className="mt-1 text-sm text-ink-800">{data.legalReviewNote}</dd>
              </div>
            )}
          </dl>
        </Card>

        {!!data.amendments?.length && (
          <Card title="الحاقیه‌ها" className="lg:col-span-3">
            <Table>
              <thead className="bg-ink-50/60"><tr><Th>شماره</Th><Th>تاریخ اجرا</Th><Th>شرح</Th><Th>تغییر مبلغ</Th><Th>تمدید</Th></tr></thead>
              <tbody>
                {data.amendments.map((a: any) => (
                  <Tr key={a.id}>
                    <Td className="ltr text-xs">{a.amendmentNumber}</Td>
                    <Td className="text-xs">{formatDate(a.effectiveDate)}</Td>
                    <Td className="max-w-md text-xs">{a.changes}</Td>
                    <Td className="text-xs"><Amount base={a.valueDelta} original={a.originalValueDelta} currency={data.currency} /></Td>
                    <Td className="nums text-xs">{toPersianDigits(a.durationDeltaDays)} روز</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
      </PageBody>
    </>
  );
}

export function Finance() {
  const { can } = useAuth();
  const [tab, setTab] = useState('docs');
  const [issuing, setIssuing] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const { data: invoices, isLoading, error, refetch } = useQuery<any>({
    queryKey: ['/invoices'], queryFn: () => apiGet('/invoices', { pageSize: 50 }),
  });
  const { data: payments } = useQuery<any>({
    queryKey: ['/payments'], queryFn: () => apiGet('/payments', { pageSize: 30 }),
  });

  const totals = (invoices?.items ?? []).reduce(
    (acc: { invoiced: number; received: number }, i: any) => ({
      invoiced: acc.invoiced + Number(i.total),
      received: acc.received + Number(i.paidAmount),
    }),
    { invoiced: 0, received: 0 },
  );

  return (
    <>
      <PageHeader title="مالی" subtitle="اسناد مالی، دریافت‌ها و مطالبات — مبالغ ارزی با نرخ روز خودشان به ریال شمرده می‌شوند"
        actions={
          <div className="flex gap-2">
            {can('finance.payment') && <Button variant="secondary" onClick={() => setReceiving(true)}>ثبت دریافت/پرداخت</Button>}
            {can('finance.invoice') && <Button variant="primary" onClick={() => setIssuing(true)}>صدور سند مالی</Button>}
          </div>
        } />
      <div className="border-b border-ink-200 bg-surface px-2">
        <Tabs tabs={[{ key: 'docs', label: 'اسناد و تراکنش‌ها' }, { key: 'rates', label: 'نرخ ارز' }, { key: 'fx', label: 'اثر نرخ ارز' }]} active={tab} onChange={setTab} />
      </div>
      {issuing && <NewInvoiceModal onClose={() => setIssuing(false)} />}
      {receiving && <NewPaymentModal onClose={() => setReceiving(false)} />}
      <PageBody className="space-y-5">
        {tab === 'rates' && <FxRates />}
        {tab === 'fx' && <FxReport />}
        {tab === 'docs' && (isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={() => void refetch()} /> : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <StatTile label="مجموع فاکتورشده" value={formatCurrency(totals.invoiced)} />
              <StatTile label="دریافت‌شده" value={formatCurrency(totals.received)} tone="success" />
              <StatTile label="مانده مطالبات" value={formatCurrency(totals.invoiced - totals.received)}
                tone={totals.invoiced - totals.received > 0 ? 'warning' : 'success'} />
            </div>

            <Card title="اسناد مالی">
              {!invoices?.items.length ? <EmptyState title="سندی صادر نشده" /> : (
                <Table>
                  <thead className="bg-ink-50/60">
                    <tr><Th>شماره</Th><Th>نوع</Th><Th>مشتری</Th><Th>پروژه</Th><Th>صدور</Th><Th>سررسید</Th><Th>مبلغ</Th><Th>دریافتی</Th><Th>وضعیت</Th></tr>
                  </thead>
                  <tbody>
                    {invoices.items.map((i: any) => (
                      <Tr key={i.id}>
                        <Td className="ltr text-xs">{i.number}</Td>
                        <Td><Badge tone="neutral">{i.kind === 'PROFORMA' ? 'پیش‌فاکتور' : 'فاکتور'}</Badge></Td>
                        <Td className="text-xs">{i.company?.legalName}</Td>
                        <Td className="text-xs">{i.project?.name ?? '—'}</Td>
                        <Td className="text-xs">{formatDate(i.issueDate)}</Td>
                        <Td className="text-xs">{formatDate(i.dueDate)}</Td>
                        <Td className="text-xs" title={exactCurrency(i.total)}><Amount base={i.total} original={i.originalTotal} currency={i.currency} /></Td>
                        <Td className="text-xs"><Amount base={i.paidAmount} original={i.originalPaidAmount} currency={i.currency} /></Td>
                        <Td><StateBadge state={i.state} /></Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>

            <Card title="دریافت‌ها و پرداخت‌ها">
              {!payments?.items.length ? <EmptyState title="تراکنشی ثبت نشده" /> : (
                <Table>
                  <thead className="bg-ink-50/60"><tr><Th>جهت</Th><Th>مبلغ</Th><Th>تاریخ</Th><Th>روش</Th><Th>مرجع</Th></tr></thead>
                  <tbody>
                    {payments.items.map((p: any) => (
                      <Tr key={p.id}>
                        <Td><Badge tone={p.direction === 'IN' ? 'success' : 'warning'}>{p.direction === 'IN' ? 'دریافت' : 'پرداخت'}</Badge></Td>
                        <Td className="text-xs" title={exactCurrency(p.amount)}><Amount base={p.amount} original={p.originalAmount} currency={p.currency} /></Td>
                        <Td className="text-xs">{formatDate(p.occurredAt)}</Td>
                        <Td className="text-xs">{p.method}</Td>
                        <Td className="ltr text-xs">{p.reference ?? '—'}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </>
        ))}
      </PageBody>
    </>
  );
}
