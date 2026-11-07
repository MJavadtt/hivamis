import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { useAuth, useSystemAdmin } from '../lib/auth';
import { Amount, FxRates, FxReport, NewInvoiceModal, NewPaymentModal, PAYMENT_METHODS, money } from '../components/Fx';
import { InvoiceTax, MoadianTab, TaxBadge } from '../components/Moadian';
import { InvoiceDownloads, InvoiceSellers } from '../components/InvoiceSellers';
import { AccountingTab } from '../components/AccountingExport';
import { ESignCard } from '../components/ESign';
import { AttachButton, onRecord } from '../components/RecordFiles';
import { PageBody, PageHeader } from '../components/Shell';
import { Code, EntityList, WorkflowActions } from '../components/common';
import { StageProgress } from '../components/StageProgress';
import { PdfButton } from '../components/PdfButton';
import { PdfBundleButton } from '../components/PdfBundleButton';
import {
  Badge, Button, Card, DescRow, EmptyState, ErrorBlock, IconPencil, LoadingBlock, StateBadge, StatTile,
  Table, Tabs, Td, Th, Tr,
} from '../components/ui';
import { exactCurrency, formatCurrency, formatDate, localDigits } from '../lib/format';
import { tr } from '../i18n';
import { SuggestedForms } from '../components/SuggestedForms';

export function ContractsList() {
  return (
    <>
      <PageHeader title={tr('قراردادها')} subtitle={tr('از درخواست انعقاد تا ثبت — قانون ۱۳ مبنای مجوز شروع پروژه')} />
      <PageBody>
        <EntityList<any>
          path="/contracts"
          searchPlaceholder={tr('جستجو در عنوان یا شماره قرارداد…')}
          rowHref={(r) => `/contracts/${r.id}`}
          filters={[{
            key: 'state', label: tr('وضعیت'),
            options: [
              { value: 'REQUESTED', label: tr('درخواست‌شده') }, { value: 'DRAFTING', label: tr('در حال تنظیم') },
              { value: 'LEGAL_REVIEW', label: tr('بررسی حقوقی') }, { value: 'INTERNAL_APPROVED', label: tr('تأیید داخلی') },
              { value: 'PENDING_SIGNATURE', label: tr('در انتظار امضا') }, { value: 'SIGNED', label: tr('امضاشده') },
              { value: 'REGISTERED', label: tr('ثبت‌شده') }, { value: 'TERMINATED', label: tr('فسخ‌شده') },
            ],
          }]}
          emptyTitle={tr('قراردادی ثبت نشده')}
          columns={[
            { key: 'title', header: tr('قرارداد'), render: (r) => (<><p className="font-medium text-ink-800">{r.title}</p><Code>{r.code}</Code></>) },
            { key: 'number', header: tr('شماره'), render: (r) => <span className="ltr whitespace-nowrap text-xs">{r.contractNumber ?? '—'}</span> },
            { key: 'company', header: tr('مشتری'), render: (r) => <span className="text-xs">{r.company?.legalName}</span> },
            { key: 'value', header: tr('مبلغ'), render: (r) => <span className="text-xs" title={exactCurrency(r.contractValue)}><Amount base={r.contractValue} original={r.originalValue} currency={r.currency} /></span> },
            { key: 'period', header: tr('دوره'), render: (r) => <span className="text-xs">{formatDate(r.startDate)} — {formatDate(r.endDate)}</span> },
            { key: 'state', header: tr('وضعیت'), render: (r) => <StateBadge state={r.state} /> },
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
          {data.contractNumber && <span className="ltr whitespace-nowrap">{data.contractNumber}</span>}
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
      <SuggestedForms entity="contract" id={id} />
      <StageProgress entity="contract" state={data.state} transitions={data.availableTransitions} />
      <PageBody className="grid gap-5 lg:grid-cols-3">
        <Card title={tr('اطلاعات قرارداد')} className="lg:col-span-1">
          <dl className="px-4 py-1">
            <DescRow label={tr('مبلغ')}>
              {data.currency && data.currency !== 'IRR' && data.originalValue != null
                ? <>{money(data.originalValue, data.currency)} <span className="text-xs text-ink-500">{tr('— ثبت‌شده {0} به نرخ {1}', exactCurrency(data.contractValue), formatDate(data.fxRateDate))}</span></>
                : exactCurrency(data.contractValue)}
            </DescRow>
            <DescRow label={tr('شروع')}>{formatDate(data.startDate)}</DescRow>
            <DescRow label={tr('پایان')}>{formatDate(data.endDate)}</DescRow>
            <DescRow label={tr('تاریخ امضا')}>{formatDate(data.signedDate)}</DescRow>
            <DescRow label={tr('تاریخ ثبت')}>{formatDate(data.registeredAt)}</DescRow>
            <DescRow label={tr('پروژه')}>
              {data.project ? <Link to={`/projects/${data.project.id}`} className="text-brand-600 hover:underline">{data.project.code}</Link> : '—'}
            </DescRow>
          </dl>
        </Card>

        <Card title={tr('Scope و شرایط')} className="lg:col-span-2">
          <dl className="divide-y divide-ink-100">
            <div className="px-4 py-3">
              <dt className="text-xs font-medium text-ink-500">{tr('خلاصه Scope')}</dt>
              <dd className="mt-1 text-sm text-ink-800">{data.scopeSummary || '—'}</dd>
            </div>
            <div className="px-4 py-3">
              <dt className="text-xs font-medium text-ink-500">{tr('شرایط پرداخت')}</dt>
              <dd className="mt-1 text-sm text-ink-800">{data.paymentTerms || '—'}</dd>
            </div>
            {data.legalReviewNote && (
              <div className="px-4 py-3">
                <dt className="text-xs font-medium text-ink-500">{tr('یادداشت حقوقی')}</dt>
                <dd className="mt-1 text-sm text-ink-800">{data.legalReviewNote}</dd>
              </div>
            )}
          </dl>
        </Card>

        <ESignCard contractId={data.id} />

        {!!data.amendments?.length && (
          <Card title={tr('الحاقیه‌ها')} className="lg:col-span-3">
            <Table>
              <thead className="bg-ink-50/60"><tr><Th>{tr('شماره')}</Th><Th>{tr('تاریخ اجرا')}</Th><Th>{tr('شرح')}</Th><Th>{tr('تغییر مبلغ')}</Th><Th>{tr('تمدید')}</Th></tr></thead>
              <tbody>
                {data.amendments.map((a: any) => (
                  <Tr key={a.id}>
                    <Td className="ltr text-xs">{a.amendmentNumber}</Td>
                    <Td className="text-xs">{formatDate(a.effectiveDate)}</Td>
                    <Td className="max-w-md text-xs">{a.changes}</Td>
                    <Td className="text-xs"><Amount base={a.valueDelta} original={a.originalValueDelta} currency={data.currency} /></Td>
                    <Td className="nums text-xs">{tr('{0} روز', localDigits(a.durationDeltaDays))}</Td>
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
  const [taxFor, setTaxFor] = useState<string | null>(null);
  // A draft by whoever issues invoices; any invoice by the system administrator (ADR-110).
  const [editing, setEditing] = useState<string | null>(null);
  const systemAdmin = useSystemAdmin();
  const mayEdit = (i: { state: string }) => systemAdmin || (can('finance.invoice') && i.state === 'DRAFT');
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
      <PageHeader title={tr('مالی')} subtitle={tr('اسناد مالی، دریافت‌ها و مطالبات — مبالغ ارزی با نرخ روز خودشان به ریال شمرده می‌شوند')}
        actions={
          <div className="flex gap-2">
            {can('finance.payment') && <Button variant="secondary" onClick={() => setReceiving(true)}>{tr('ثبت دریافت/پرداخت')}</Button>}
            {can('finance.invoice') && <Button variant="primary" onClick={() => setIssuing(true)}>{tr('صدور سند مالی')}</Button>}
          </div>
        } />
      <div className="mx-3 mt-3 rounded-xl bg-surface px-2 shadow-sm ring-1 ring-edge sm:mx-5 lg:mx-0 [&>[role=tablist]]:border-b-0">
        <Tabs tabs={[{ key: 'docs', label: tr('اسناد و تراکنش‌ها') }, { key: 'sellers', label: tr('فروشندگان') }, { key: 'moadian', label: tr('سامانهٔ مؤدیان') }, { key: 'accounting', label: tr('خروجی حسابداری') }, { key: 'rates', label: tr('نرخ ارز') }, { key: 'fx', label: tr('اثر نرخ ارز') }]} active={tab} onChange={setTab} />
      </div>
      {issuing && <NewInvoiceModal onClose={() => setIssuing(false)} />}
      {editing && <NewInvoiceModal invoiceId={editing} onClose={() => setEditing(null)} />}
      {receiving && <NewPaymentModal onClose={() => setReceiving(false)} />}
      {taxFor && <InvoiceTax invoiceId={taxFor} onClose={() => setTaxFor(null)} />}
      <PageBody className="space-y-5">
        {tab === 'sellers' && <InvoiceSellers />}
        {tab === 'moadian' && <MoadianTab />}
        {tab === 'accounting' && <AccountingTab />}
        {tab === 'rates' && <FxRates />}
        {tab === 'fx' && <FxReport />}
        {tab === 'docs' && (isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={() => void refetch()} /> : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <StatTile label={tr('مجموع فاکتورشده')} value={formatCurrency(totals.invoiced)} />
              <StatTile label={tr('دریافت‌شده')} value={formatCurrency(totals.received)} tone="success" />
              <StatTile label={tr('مانده مطالبات')} value={formatCurrency(totals.invoiced - totals.received)}
                tone={totals.invoiced - totals.received > 0 ? 'warning' : 'success'} />
            </div>

            <Card title={tr('اسناد مالی')}>
              {!invoices?.items.length ? <EmptyState title={tr('سندی صادر نشده')} /> : (
                <Table>
                  <thead className="bg-ink-50/60">
                    <tr><Th>{tr('شماره')}</Th><Th>{tr('نوع')}</Th><Th>{tr('مشتری')}</Th><Th>{tr('پروژه')}</Th><Th>{tr('صدور')}</Th><Th>{tr('سررسید')}</Th><Th>{tr('مبلغ')}</Th><Th>{tr('دریافتی')}</Th><Th>{tr('وضعیت')}</Th><Th>{tr('مؤدیان')}</Th><Th className="w-10"><span className="sr-only">{tr('ویرایش')}</span></Th></tr>
                  </thead>
                  <tbody>
                    {invoices.items.map((i: any) => (
                      <Tr key={i.id}>
                        <Td className="ltr text-xs whitespace-nowrap">{i.number}</Td>
                        <Td><Badge tone="neutral">{i.kind === 'PROFORMA' ? tr('پیش‌فاکتور') : tr('فاکتور')}</Badge>
                          {i.seller && <span className="mt-1 block whitespace-nowrap text-xs text-ink-500" title={tr('فروشنده')}>{i.seller.shortName}</span>}</Td>
                        <Td className="text-xs">{i.company?.legalName}</Td>
                        <Td className="text-xs">{i.project?.name ?? '—'}</Td>
                        <Td className="text-xs">{formatDate(i.issueDate)}</Td>
                        <Td className="text-xs">{formatDate(i.dueDate)}</Td>
                        <Td className="text-xs" title={exactCurrency(i.total)}><Amount base={i.total} original={i.originalTotal} currency={i.currency} /></Td>
                        <Td className="text-xs"><Amount base={i.paidAmount} original={i.originalPaidAmount} currency={i.currency} /></Td>
                        <Td><StateBadge state={i.state} /></Td>
                        <Td>{i.kind === 'INVOICE' && i.state !== 'DRAFT' && (
                          <button type="button" onClick={() => setTaxFor(i.id)} aria-label={tr('مؤدیان {0}', i.number)}><TaxBadge submission={i.taxSubmissions?.[0]} /></button>
                        )}</Td>
                        <Td><div className="flex flex-wrap items-center gap-1">
                          <InvoiceDownloads invoice={i} />
                          <AttachButton target={onRecord('invoice', i.id)} title={i.number} />
                          {mayEdit(i) && <Button size="sm" variant="ghost" aria-label={tr('ویرایش سند {0}', i.number)} title={tr('ویرایش')} onClick={() => setEditing(i.id)}><IconPencil className="size-4" /></Button>}
                        </div></Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>

            <Card title={tr('دریافت‌ها و پرداخت‌ها')}>
              {!payments?.items.length ? <EmptyState title={tr('تراکنشی ثبت نشده')} /> : (
                <Table>
                  <thead className="bg-ink-50/60"><tr><Th>{tr('جهت')}</Th><Th>{tr('مبلغ')}</Th><Th>{tr('تاریخ')}</Th><Th>{tr('روش')}</Th><Th>{tr('مرجع')}</Th></tr></thead>
                  <tbody>
                    {payments.items.map((p: any) => (
                      <Tr key={p.id}>
                        <Td><Badge tone={p.direction === 'IN' ? 'success' : 'warning'}>{p.direction === 'IN' ? tr('دریافتی') : tr('پرداخت')}</Badge></Td>
                        <Td className="text-xs" title={exactCurrency(p.amount)}><Amount base={p.amount} original={p.originalAmount} currency={p.currency} /></Td>
                        <Td className="text-xs">{formatDate(p.occurredAt)}</Td>
                        <Td className="text-xs">{PAYMENT_METHODS[p.method] ?? p.method}</Td>
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
