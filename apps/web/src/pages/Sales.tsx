import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageBody, PageHeader } from '../components/Shell';
import { BriefQuality } from '../components/BriefQuality';
import { Code, EntityList, WorkflowActions } from '../components/common';
import { StageProgress } from '../components/StageProgress';
import { PdfButton } from '../components/PdfButton';
import { PdfBundleButton } from '../components/PdfBundleButton';
import { useAction } from '../hooks/queries';
import {
  Badge, Button, Card, DescRow, EmptyState, ErrorBlock, Field, Input, LoadingBlock,
  Modal, ProgressBar, StateBadge, StatTile, Table, Td, Textarea, Th, Tr,
} from '../components/ui';
import { exactCurrency, formatCurrency, formatDate, formatPercent, localDigits } from '../lib/format';
import { ProposalApprovalCard } from '../components/ClientApprovals';
import { tr } from '../i18n';
import { UnitTag } from '../components/UnitTag';
import { SuggestedForms } from '../components/SuggestedForms';

/* ── Briefs ────────────────────────────────────────────────────────────── */

export function BriefsList() {
  return (
    <>
      <PageHeader title={tr('بریف‌ها')} subtitle={tr('نقطه کنترل — بریف ناقص به فروش بازگردانده می‌شود (چرخه ۱)')} />
      <PageBody>
        <EntityList<any>
          path="/briefs"
          searchPlaceholder={tr('جستجو در عنوان بریف…')}
          rowHref={(r) => `/briefs/${r.id}`}
          filters={[{
            key: 'state', label: tr('وضعیت'),
            options: [
              { value: 'DRAFT', label: tr('پیش‌نویس') }, { value: 'SUBMITTED', label: tr('ارسال‌شده') },
              { value: 'UNDER_REVIEW', label: tr('در حال بررسی') },
              { value: 'RETURNED_INCOMPLETE', label: tr('بازگشت — ناقص') }, { value: 'APPROVED', label: tr('تأییدشده') },
            ],
          }]}
          emptyTitle={tr('بریفی ثبت نشده')}
          columns={[
            { key: 'title', header: tr('بریف'), render: (r) => (<><p className="font-medium text-ink-800">{r.title}</p><Code>{r.code}</Code></>) },
            { key: 'company', header: tr('مشتری'), render: (r) => <span className="text-xs">{r.opportunity?.company?.legalName ?? '—'}</span> },
            {
              key: 'completeness', header: tr('کامل بودن'),
              render: (r) => (
                <div className="w-24">
                  <ProgressBar value={r.completenessScore} tone={r.completenessScore === 100 ? 'success' : r.completenessScore >= 60 ? 'warning' : 'danger'} />
                  <span className="nums text-[12.5px] text-ink-500">{tr('{0}٪', localDigits(r.completenessScore))}</span>
                </div>
              ),
            },
            { key: 'returns', header: tr('بازگشت'), render: (r) => r.returnCount > 0 ? <Badge tone="danger">{tr('{0} بار', localDigits(r.returnCount))}</Badge> : <span className="text-xs text-ink-400">—</span> },
            { key: 'budget', header: tr('بودجه'), render: (r) => <span className="text-xs">{formatCurrency(r.budgetRange)}</span> },
            { key: 'state', header: tr('وضعیت'), render: (r) => <StateBadge state={r.state} /> },
          ]}
        />
      </PageBody>
    </>
  );
}

export function BriefDetail() {
  const { id } = useParams<{ id: string }>();
  const { canAny } = useAuth();
  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: [`/briefs/${id}`], queryFn: () => apiGet(`/briefs/${id}`), enabled: !!id,
  });

  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const complete = data.completenessScore === 100;

  return (
    <>
      <PageHeader
        title={data.title}
        badge={<StateBadge state={data.state} />}
        subtitle={<span className="flex items-center gap-2"><Code>{data.code}</Code>
          {data.opportunity && <Link to={`/opportunities/${data.opportunity.id}`} className="text-brand-600 hover:underline">{data.opportunity.title}</Link>}</span>}
        actions={
          <>
            {canAny('brief.review', 'proposal.write') && <Link to={`/account/journey/${data.id}`}><Button variant="primary">{tr('مسیر اکانت')}</Button></Link>}
            <PdfButton kind="brief" id={data.id} />
            <PdfBundleButton kind="brief" id={data.id} />
            <WorkflowActions entity="brief" id={data.id} transitions={data.availableTransitions} />
          </>
        }
      />
      <SuggestedForms entity="brief" id={id} />
      <StageProgress entity="brief" state={data.state} transitions={data.availableTransitions} />
      <PageBody className="space-y-5">
        {!complete && (
          <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
            <strong className="font-semibold">{tr('بریف ناقص —')}{' '}</strong>{tr('طبق نقطه کنترل Doc_H تا تکمیل موارد زیر، بریف قابل تأیید نیست:')}<span className="font-medium"> {data.missingItems?.join(tr('، '))}</span>
          </div>
        )}
        {data.returnCount > 0 && data.returnReason && (
          <div className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-inset ring-rose-200">
            <strong className="font-semibold">{tr('سابقه بازگشت ({0} بار):', localDigits(data.returnCount))}{' '}</strong>
            {data.returnReason}
          </div>
        )}

        <BriefQuality briefId={data.id} />

        <div className="grid gap-5 lg:grid-cols-3">
          <Card title={tr('خلاصه')} className="lg:col-span-1">
            <div className="px-4 py-3">
              <p className="mb-1 text-xs text-ink-500">{tr('میزان کامل بودن')}</p>
              <ProgressBar value={data.completenessScore} tone={complete ? 'success' : 'warning'} />
              <p className="mt-1 text-sm font-medium nums">{tr('{0}٪', localDigits(data.completenessScore))}</p>
            </div>
            <dl className="px-4 pb-1">
              <DescRow label={tr('بودجه تقریبی')}>{exactCurrency(data.budgetRange)}</DescRow>
              <DescRow label={tr('زمان مورد انتظار')}>{formatDate(data.desiredDeadline)}</DescRow>
              <DescRow label={tr('واحدهای درگیر')}>{data.unitsNeeded?.join(tr('، ')) || '—'}</DescRow>
            </dl>
          </Card>

          <Card title={tr('محتوای بریف')} className="lg:col-span-2">
            <dl className="divide-y divide-ink-100">
              {[
                [tr('هدف کسب‌وکار'), data.businessObjective],
                [tr('مخاطب هدف'), data.targetAudience],
                [tr('Scope درخواستی'), data.scope],
                [tr('خروجی‌های مورد انتظار'), data.expectedDeliverables],
                [tr('رقبا و سابقه'), data.competitorContext],
                [tr('محدودیت‌ها'), data.constraints],
                [tr('معیار موفقیت'), data.successCriteria],
              ].map(([label, value]) => (
                <div key={label as string} className="px-4 py-3">
                  <dt className="text-xs font-medium text-ink-500">{label}</dt>
                  <dd className={value ? 'mt-1 text-sm text-ink-800' : 'mt-1 text-sm text-rose-700'}>
                    {value || tr('— ثبت نشده —')}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>

        {!!data.proposals?.length && (
          <Card title={tr('پروپوزال‌ها')}>
            <Table>
              <thead className="bg-ink-50/60"><tr><Th>{tr('پروپوزال')}</Th><Th>{tr('نسخه')}</Th><Th>{tr('وضعیت')}</Th></tr></thead>
              <tbody>
                {data.proposals.map((p: any) => (
                  <Tr key={p.id}>
                    <Td><Link to={`/proposals/${p.id}`} className="text-sm text-brand-600 hover:underline">{p.title}</Link><Code>{p.code}</Code></Td>
                    <Td className="nums text-xs">{localDigits(p.version)}</Td>
                    <Td><StateBadge state={p.state} /></Td>
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

/* ── Proposals ─────────────────────────────────────────────────────────── */

export function ProposalsList() {
  return (
    <>
      <PageHeader title={tr('پروپوزال‌ها')} subtitle={tr('از یکپارچه‌سازی خروجی واحدها تا تأیید مشتری')} />
      <PageBody>
        <EntityList<any>
          path="/proposals"
          searchPlaceholder={tr('جستجو در عنوان پروپوزال…')}
          rowHref={(r) => `/proposals/${r.id}`}
          filters={[{
            key: 'state', label: tr('وضعیت'),
            options: [
              { value: 'DRAFT', label: tr('پیش‌نویس') }, { value: 'AWAITING_UNIT_OUTPUTS', label: tr('در انتظار واحدها') },
              { value: 'INTEGRATION', label: tr('یکپارچه‌سازی') }, { value: 'PRICING', label: tr('قیمت‌گذاری') },
              { value: 'FINAL_QC', label: tr('QC نهایی') }, { value: 'APPROVED', label: tr('تأییدشده') },
              { value: 'DELIVERED_TO_SALES', label: tr('تحویل به فروش') },
              { value: 'PRESENTED_TO_CLIENT', label: tr('ارائه به مشتری') },
              { value: 'CLIENT_APPROVED', label: tr('تأیید مشتری') }, { value: 'CLIENT_REJECTED', label: tr('رد مشتری') },
            ],
          }]}
          emptyTitle={tr('پروپوزالی ثبت نشده')}
          columns={[
            { key: 'title', header: tr('پروپوزال'), render: (r) => (<><p className="font-medium text-ink-800">{r.title}</p><Code>{r.code}</Code></>) },
            { key: 'company', header: tr('مشتری'), render: (r) => <span className="text-xs">{r.brief?.opportunity?.company?.legalName ?? '—'}</span> },
            { key: 'version', header: tr('نسخه'), render: (r) => <span className="nums text-xs">{localDigits(r.version)}</span> },
            { key: 'cost', header: tr('قیمت تمام‌شده'), render: (r) => <span className="text-xs">{formatCurrency(r.totalCost)}</span> },
            { key: 'price', header: tr('قیمت فروش'), render: (r) => <span className="text-xs font-medium">{formatCurrency(r.salePrice)}</span> },
            { key: 'margin', header: tr('حاشیه'), render: (r) => r.marginPercent == null ? <span className="text-xs text-ink-400">—</span>
              : <Badge tone={Number(r.marginPercent) >= 30 ? 'success' : Number(r.marginPercent) >= 15 ? 'warning' : 'danger'}>{formatPercent(r.marginPercent)}</Badge> },
            { key: 'state', header: tr('وضعیت'), render: (r) => <StateBadge state={r.state} /> },
          ]}
        />
      </PageBody>
    </>
  );
}

export function ProposalDetail() {
  const { id } = useParams<{ id: string }>();
  const [pricing, setPricing] = useState(false);
  const { can, canAny } = useAuth();

  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: [`/proposals/${id}`], queryFn: () => apiGet(`/proposals/${id}`), enabled: !!id,
  });

  const approvePricing = useAction(
    () => apiPost(`/proposals/${id}/pricing/approve`),
    tr('قیمت‌گذاری تأیید شد.'),
  );

  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const finalQc = data.qcReviews?.find((q: any) => q.level === 'FINAL');

  return (
    <>
      <PageHeader
        title={data.title}
        badge={<StateBadge state={data.state} />}
        subtitle={<span className="flex items-center gap-2"><Code>{data.code}</Code>
          <span>{tr('نسخه {0}', localDigits(data.version))}</span>
          {data.brief && <Link to={`/briefs/${data.brief.id}`} className="text-brand-600 hover:underline">{data.brief.code}</Link>}</span>}
        actions={
          <>
            {can('pricing.set_price') && (
              <Button variant="secondary" onClick={() => setPricing(true)}>{tr('تعیین قیمت')}</Button>
            )}
            {can('pricing.approve') && data.salePrice && !data.pricingApprovedAt && (
              <Button variant="primary" loading={approvePricing.isPending} onClick={() => approvePricing.mutate(undefined)}>{tr('تأیید قیمت‌گذاری')}</Button>
            )}
            {data.brief && canAny('brief.review', 'proposal.write') && <Link to={`/account/journey/${data.brief.id}`}><Button variant="ghost">{tr('مسیر اکانت')}</Button></Link>}
            <PdfButton kind="proposal" id={data.id} />
            <PdfBundleButton kind="proposal" id={data.id} />
            <WorkflowActions entity="proposal" id={data.id} transitions={data.availableTransitions} />
          </>
        }
      />
      <SuggestedForms entity="proposal" id={id} />
      <StageProgress entity="proposal" state={data.state} transitions={data.availableTransitions} />
      <PageBody className="space-y-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label={tr('قیمت تمام‌شده')} value={formatCurrency(data.totalCost)} hint={tr('اعلام‌شده توسط واحدها')} />
          <StatTile label={tr('قیمت فروش')} value={formatCurrency(data.salePrice)}
            tone={data.salePrice ? 'progress' : 'neutral'} hint={data.pricedAt ? tr('تعیین: {0}', formatDate(data.pricedAt)) : tr('تعیین نشده')} />
          <StatTile label={tr('حاشیه سود')} value={formatPercent(data.marginPercent)}
            tone={Number(data.marginPercent) >= 30 ? 'success' : data.marginPercent ? 'warning' : 'neutral'} />
          <StatTile label={tr('تعداد اصلاحیه')} value={localDigits(data.revisionCount ?? 0)}
            tone={data.revisionCount > 1 ? 'warning' : 'neutral'} />
        </div>

        {data.salePrice && !data.pricingApprovedAt && (
          <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
            <strong className="font-semibold">{tr('قانون ۱۲ —')}{' '}</strong>{tr('قیمت فروش تعیین شده اما هنوز توسط مقام مجاز تأیید نشده است. تا تأیید، پروپوزال قابل تصویب نیست.')}</div>
        )}

        <ProposalApprovalCard proposal={data} />

        <div className="grid gap-5 lg:grid-cols-3">
          <Card title={tr('سفارش‌های واحدها')} className="lg:col-span-2">
            {!data.workOrders?.length ? <EmptyState title={tr('سفارشی صادر نشده')} /> : (
              <Table>
                <thead className="bg-ink-50/60"><tr><Th>{tr('عنوان')}</Th><Th>{tr('واحد')}</Th><Th>{tr('مهلت')}</Th><Th>{tr('وضعیت')}</Th></tr></thead>
                <tbody>
                  {data.workOrders.map((w: any) => (
                    <Tr key={w.id}>
                      <Td><p className="text-sm">{w.title}</p><Code>{w.code}</Code></Td>
                      <Td><UnitTag code={w.targetDepartmentCode} /></Td>
                      <Td className="text-xs">{formatDate(w.deadline)}</Td>
                      <Td><StateBadge state={w.state} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card title={tr('قیمت تمام‌شده اعلامی')}>
            {!data.costDeclarations?.length ? (
              <EmptyState title={tr('هزینه‌ای اعلام نشده')} description={tr('قیمت‌گذاری تا اعلام هزینه همه واحدها ممکن نیست.')} />
            ) : (
              <ul className="divide-y divide-ink-100">
                {data.costDeclarations.map((c: any) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                    <UnitTag code={c.departmentCode} />
                    <span className="text-sm nums" title={exactCurrency(Number(c.internalCost) + Number(c.externalCost))}>
                      {formatCurrency(Number(c.internalCost) + Number(c.externalCost))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card title={tr('محتوای پروپوزال')}>
            <dl className="divide-y divide-ink-100">
              {[[tr('خلاصه مدیریتی'), data.executiveSummary], [tr('رویکرد'), data.approach],
                [tr('خروجی‌ها'), data.deliverablesSummary], [tr('زمان‌بندی'), data.timelineSummary],
                [tr('مبنای قیمت‌گذاری'), data.pricingRationale], [tr('شرایط پرداخت'), data.paymentTerms]].map(([l, v]) => (
                <div key={l as string} className="px-4 py-3">
                  <dt className="text-xs font-medium text-ink-500">{l}</dt>
                  <dd className="mt-1 text-sm text-ink-800">{(v as string) || '—'}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <div className="space-y-5">
            <Card title={tr('کنترل کیفیت نهایی')} subtitle={tr('قانون ۹ — سطح ۳')}>
              {!finalQc ? (
                <EmptyState title={tr('QC نهایی ثبت نشده')} description={tr('پروپوزال بدون QC نهایی تأییدشده قابل تصویب نیست.')} />
              ) : (
                <div className="px-4 py-3">
                  <StateBadge state={finalQc.verdict} />
                  {finalQc.findings && <p className="mt-2 text-sm text-ink-700">{finalQc.findings}</p>}
                  <p className="mt-1 text-xs text-ink-400">{formatDate(finalQc.reviewedAt)}</p>
                </div>
              )}
            </Card>

            {!!data.versions?.length && (
              <Card title={tr('نسخه‌های پیشین')}>
                <ul className="divide-y divide-ink-100">
                  {data.versions.map((v: any) => (
                    <li key={v.id} className="flex items-center justify-between px-4 py-2.5">
                      <span className="text-sm">{tr('نسخه {0}', localDigits(v.version))}</span>
                      <span className="text-xs text-ink-400">{formatDate(v.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {data.clientFeedback && (
              <Card title={tr('بازخورد مشتری')}>
                <p className="px-4 py-3 text-sm text-ink-700">{data.clientFeedback}</p>
              </Card>
            )}
          </div>
        </div>
      </PageBody>

      {pricing && <PricingModal proposal={data} onClose={() => setPricing(false)} />}
    </>
  );
}

function PricingModal({ proposal, onClose }: { proposal: any; onClose: () => void }) {
  const [salePrice, setSalePrice] = useState(String(proposal.salePrice ?? ''));
  const [rationale, setRationale] = useState(proposal.pricingRationale ?? '');
  const [terms, setTerms] = useState(proposal.paymentTerms ?? '');
  const [band, setBand] = useState(proposal.contractScaleBand ?? '');

  const price = Number(salePrice);
  const cost = Number(proposal.totalCost ?? 0);
  const margin = price > 0 ? ((price - cost) / price) * 100 : 0;

  const save = useAction(
    (body: unknown) => apiPost(`/proposals/${proposal.id}/pricing`, body),
    tr('قیمت‌گذاری ثبت شد و در انتظار تأیید مدیریت است.'),
  );

  const submit = async () => {
    await save.mutateAsync({
      salePrice: price, rationale,
      paymentTerms: terms || undefined,
      contractScaleBand: band || undefined,
    });
    onClose();
  };

  return (
    <Modal
      open onClose={onClose} title={tr('تعیین قیمت فروش')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!price || rationale.trim().length < 3} onClick={() => void submit()}>{tr('ثبت قیمت')}</Button>
        </>
      }
    >
      <p className="mb-4 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">{tr('قیمت تمام‌شده اعلامی واحدها:')}{' '}<strong className="nums">{exactCurrency(proposal.totalCost)}</strong>
        <br />{tr('طبق قانون ۱۲، قیمت فروش پس از ثبت باید توسط مقام مجاز تأیید شود.')}</p>
      <div className="space-y-4">
        <Field label={tr('قیمت فروش (ریال)')} required>
          <Input type="number" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} className="ltr" />
        </Field>
        {price > 0 && (
          <div className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800">{tr('حاشیه سود محاسبه‌شده:')}{' '}<strong className="nums">{tr('{0}٪', localDigits(margin.toFixed(1)))}</strong>
            {margin < 15 && <span className="ms-2 text-rose-700">{tr('— کمتر از حد مطلوب')}</span>}
          </div>
        )}
        <Field label={tr('اشل قرارداد')}>
          <select value={band} onChange={(e) => setBand(e.target.value)} className="w-full rounded-lg border-0 bg-surface px-3 py-2 text-sm ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-brand-600">
            <option value="">{tr('— انتخاب —')}</option>
            <option value="S">{tr('کوچک')}</option><option value="M">{tr('متوسط')}</option>
            <option value="L">{tr('بزرگ')}</option><option value="XL">{tr('ویژه')}</option>
          </select>
        </Field>
        <Field label={tr('شرایط پرداخت')}><Input value={terms} onChange={(e) => setTerms(e.target.value)} placeholder={tr('۴۰/۳۰/۳۰')} /></Field>
        <Field label={tr('مبنای قیمت‌گذاری')} required hint={tr('این توضیح در رهگیری حسابرسی ثبت می‌شود.')}>
          <Textarea value={rationale} onChange={(e) => setRationale(e.target.value)} rows={3} />
        </Field>
      </div>
    </Modal>
  );
}
