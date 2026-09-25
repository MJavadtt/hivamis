import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageBody, PageHeader } from '../components/Shell';
import { BriefQuality } from '../components/BriefQuality';
import { Code, EntityList, WorkflowActions } from '../components/common';
import { PdfButton } from '../components/PdfButton';
import { PdfBundleButton } from '../components/PdfBundleButton';
import { useAction } from '../hooks/queries';
import {
  Badge, Button, Card, DescRow, EmptyState, ErrorBlock, Field, Input, LoadingBlock,
  Modal, ProgressBar, StateBadge, StatTile, Table, Td, Textarea, Th, Tr,
} from '../components/ui';
import { exactCurrency, formatCurrency, formatDate, formatPercent, toPersianDigits } from '../lib/format';

/* ── Briefs ────────────────────────────────────────────────────────────── */

export function BriefsList() {
  return (
    <>
      <PageHeader title="بریف‌ها" subtitle="نقطه کنترل — بریف ناقص به فروش بازگردانده می‌شود (چرخه ۱)" />
      <PageBody>
        <EntityList<any>
          path="/briefs"
          searchPlaceholder="جستجو در عنوان بریف…"
          rowHref={(r) => `/briefs/${r.id}`}
          filters={[{
            key: 'state', label: 'وضعیت',
            options: [
              { value: 'DRAFT', label: 'پیش‌نویس' }, { value: 'SUBMITTED', label: 'ارسال‌شده' },
              { value: 'UNDER_REVIEW', label: 'در حال بررسی' },
              { value: 'RETURNED_INCOMPLETE', label: 'بازگشت — ناقص' }, { value: 'APPROVED', label: 'تأییدشده' },
            ],
          }]}
          emptyTitle="بریفی ثبت نشده"
          columns={[
            { key: 'title', header: 'بریف', render: (r) => (<><p className="font-medium text-ink-800">{r.title}</p><Code>{r.code}</Code></>) },
            { key: 'company', header: 'مشتری', render: (r) => <span className="text-xs">{r.opportunity?.company?.legalName ?? '—'}</span> },
            {
              key: 'completeness', header: 'کامل بودن',
              render: (r) => (
                <div className="w-24">
                  <ProgressBar value={r.completenessScore} tone={r.completenessScore === 100 ? 'success' : r.completenessScore >= 60 ? 'warning' : 'danger'} />
                  <span className="nums text-[11px] text-ink-500">{toPersianDigits(r.completenessScore)}٪</span>
                </div>
              ),
            },
            { key: 'returns', header: 'بازگشت', render: (r) => r.returnCount > 0 ? <Badge tone="danger">{toPersianDigits(r.returnCount)} بار</Badge> : <span className="text-xs text-ink-400">—</span> },
            { key: 'budget', header: 'بودجه', render: (r) => <span className="text-xs">{formatCurrency(r.budgetRange)}</span> },
            { key: 'state', header: 'وضعیت', render: (r) => <StateBadge state={r.state} /> },
          ]}
        />
      </PageBody>
    </>
  );
}

export function BriefDetail() {
  const { id } = useParams<{ id: string }>();
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
            <PdfButton kind="brief" id={data.id} />
            <PdfBundleButton kind="brief" id={data.id} />
            <WorkflowActions entity="brief" id={data.id} transitions={data.availableTransitions} />
          </>
        }
      />
      <PageBody className="space-y-5">
        {!complete && (
          <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
            <strong className="font-semibold">بریف ناقص — </strong>
            طبق نقطه کنترل Doc_H تا تکمیل موارد زیر، بریف قابل تأیید نیست:
            <span className="font-medium"> {data.missingItems?.join('، ')}</span>
          </div>
        )}
        {data.returnCount > 0 && data.returnReason && (
          <div className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-inset ring-rose-200">
            <strong className="font-semibold">سابقه بازگشت ({toPersianDigits(data.returnCount)} بار): </strong>
            {data.returnReason}
          </div>
        )}

        <BriefQuality briefId={data.id} />

        <div className="grid gap-5 lg:grid-cols-3">
          <Card title="خلاصه" className="lg:col-span-1">
            <div className="px-4 py-3">
              <p className="mb-1 text-xs text-ink-500">میزان کامل بودن</p>
              <ProgressBar value={data.completenessScore} tone={complete ? 'success' : 'warning'} />
              <p className="mt-1 text-sm font-medium nums">{toPersianDigits(data.completenessScore)}٪</p>
            </div>
            <dl className="px-4 pb-1">
              <DescRow label="بودجه تقریبی">{exactCurrency(data.budgetRange)}</DescRow>
              <DescRow label="زمان مورد انتظار">{formatDate(data.desiredDeadline)}</DescRow>
              <DescRow label="واحدهای درگیر">{data.unitsNeeded?.join('، ') || '—'}</DescRow>
            </dl>
          </Card>

          <Card title="محتوای بریف" className="lg:col-span-2">
            <dl className="divide-y divide-ink-100">
              {[
                ['هدف کسب‌وکار', data.businessObjective],
                ['مخاطب هدف', data.targetAudience],
                ['Scope درخواستی', data.scope],
                ['خروجی‌های مورد انتظار', data.expectedDeliverables],
                ['رقبا و سابقه', data.competitorContext],
                ['محدودیت‌ها', data.constraints],
                ['معیار موفقیت', data.successCriteria],
              ].map(([label, value]) => (
                <div key={label as string} className="px-4 py-3">
                  <dt className="text-xs font-medium text-ink-500">{label}</dt>
                  <dd className={value ? 'mt-1 text-sm text-ink-800' : 'mt-1 text-sm text-rose-500'}>
                    {value || '— ثبت نشده —'}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>

        {!!data.proposals?.length && (
          <Card title="پروپوزال‌ها">
            <Table>
              <thead className="bg-ink-50/60"><tr><Th>پروپوزال</Th><Th>نسخه</Th><Th>وضعیت</Th></tr></thead>
              <tbody>
                {data.proposals.map((p: any) => (
                  <Tr key={p.id}>
                    <Td><Link to={`/proposals/${p.id}`} className="text-sm text-brand-600 hover:underline">{p.title}</Link><Code>{p.code}</Code></Td>
                    <Td className="nums text-xs">{toPersianDigits(p.version)}</Td>
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
      <PageHeader title="پروپوزال‌ها" subtitle="از یکپارچه‌سازی خروجی واحدها تا تأیید مشتری" />
      <PageBody>
        <EntityList<any>
          path="/proposals"
          searchPlaceholder="جستجو در عنوان پروپوزال…"
          rowHref={(r) => `/proposals/${r.id}`}
          filters={[{
            key: 'state', label: 'وضعیت',
            options: [
              { value: 'DRAFT', label: 'پیش‌نویس' }, { value: 'AWAITING_UNIT_OUTPUTS', label: 'در انتظار واحدها' },
              { value: 'INTEGRATION', label: 'یکپارچه‌سازی' }, { value: 'PRICING', label: 'قیمت‌گذاری' },
              { value: 'FINAL_QC', label: 'QC نهایی' }, { value: 'APPROVED', label: 'تأییدشده' },
              { value: 'DELIVERED_TO_SALES', label: 'تحویل به فروش' },
              { value: 'PRESENTED_TO_CLIENT', label: 'ارائه به مشتری' },
              { value: 'CLIENT_APPROVED', label: 'تأیید مشتری' }, { value: 'CLIENT_REJECTED', label: 'رد مشتری' },
            ],
          }]}
          emptyTitle="پروپوزالی ثبت نشده"
          columns={[
            { key: 'title', header: 'پروپوزال', render: (r) => (<><p className="font-medium text-ink-800">{r.title}</p><Code>{r.code}</Code></>) },
            { key: 'company', header: 'مشتری', render: (r) => <span className="text-xs">{r.brief?.opportunity?.company?.legalName ?? '—'}</span> },
            { key: 'version', header: 'نسخه', render: (r) => <span className="nums text-xs">{toPersianDigits(r.version)}</span> },
            { key: 'cost', header: 'قیمت تمام‌شده', render: (r) => <span className="text-xs">{formatCurrency(r.totalCost)}</span> },
            { key: 'price', header: 'قیمت فروش', render: (r) => <span className="text-xs font-medium">{formatCurrency(r.salePrice)}</span> },
            { key: 'margin', header: 'حاشیه', render: (r) => r.marginPercent == null ? <span className="text-xs text-ink-400">—</span>
              : <Badge tone={Number(r.marginPercent) >= 30 ? 'success' : Number(r.marginPercent) >= 15 ? 'warning' : 'danger'}>{formatPercent(r.marginPercent)}</Badge> },
            { key: 'state', header: 'وضعیت', render: (r) => <StateBadge state={r.state} /> },
          ]}
        />
      </PageBody>
    </>
  );
}

export function ProposalDetail() {
  const { id } = useParams<{ id: string }>();
  const [pricing, setPricing] = useState(false);
  const { can } = useAuth();

  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: [`/proposals/${id}`], queryFn: () => apiGet(`/proposals/${id}`), enabled: !!id,
  });

  const approvePricing = useAction(
    () => apiPost(`/proposals/${id}/pricing/approve`),
    'قیمت‌گذاری تأیید شد.',
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
          <span>نسخه {toPersianDigits(data.version)}</span>
          {data.brief && <Link to={`/briefs/${data.brief.id}`} className="text-brand-600 hover:underline">{data.brief.code}</Link>}</span>}
        actions={
          <>
            {can('pricing.set_price') && (
              <Button variant="secondary" onClick={() => setPricing(true)}>تعیین قیمت</Button>
            )}
            {can('pricing.approve') && data.salePrice && !data.pricingApprovedAt && (
              <Button variant="primary" loading={approvePricing.isPending} onClick={() => approvePricing.mutate(undefined)}>
                تأیید قیمت‌گذاری
              </Button>
            )}
            <PdfButton kind="proposal" id={data.id} />
            <PdfBundleButton kind="proposal" id={data.id} />
            <WorkflowActions entity="proposal" id={data.id} transitions={data.availableTransitions} />
          </>
        }
      />
      <PageBody className="space-y-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="قیمت تمام‌شده" value={formatCurrency(data.totalCost)} hint="اعلام‌شده توسط واحدها" />
          <StatTile label="قیمت فروش" value={formatCurrency(data.salePrice)}
            tone={data.salePrice ? 'progress' : 'neutral'} hint={data.pricedAt ? `تعیین: ${formatDate(data.pricedAt)}` : 'تعیین نشده'} />
          <StatTile label="حاشیه سود" value={formatPercent(data.marginPercent)}
            tone={Number(data.marginPercent) >= 30 ? 'success' : data.marginPercent ? 'warning' : 'neutral'} />
          <StatTile label="تعداد اصلاحیه" value={toPersianDigits(data.revisionCount ?? 0)}
            tone={data.revisionCount > 1 ? 'warning' : 'neutral'} />
        </div>

        {data.salePrice && !data.pricingApprovedAt && (
          <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
            <strong className="font-semibold">قانون ۱۲ — </strong>
            قیمت فروش تعیین شده اما هنوز توسط مقام مجاز تأیید نشده است. تا تأیید، پروپوزال قابل تصویب نیست.
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-3">
          <Card title="سفارش‌های واحدها" className="lg:col-span-2">
            {!data.workOrders?.length ? <EmptyState title="سفارشی صادر نشده" /> : (
              <Table>
                <thead className="bg-ink-50/60"><tr><Th>عنوان</Th><Th>واحد</Th><Th>مهلت</Th><Th>وضعیت</Th></tr></thead>
                <tbody>
                  {data.workOrders.map((w: any) => (
                    <Tr key={w.id}>
                      <Td><p className="text-sm">{w.title}</p><Code>{w.code}</Code></Td>
                      <Td className="text-xs">{w.targetDepartmentCode}</Td>
                      <Td className="text-xs">{formatDate(w.deadline)}</Td>
                      <Td><StateBadge state={w.state} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card title="قیمت تمام‌شده اعلامی">
            {!data.costDeclarations?.length ? (
              <EmptyState title="هزینه‌ای اعلام نشده" description="قیمت‌گذاری تا اعلام هزینه همه واحدها ممکن نیست." />
            ) : (
              <ul className="divide-y divide-ink-100">
                {data.costDeclarations.map((c: any) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                    <span className="text-sm text-ink-700">{c.departmentCode}</span>
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
          <Card title="محتوای پروپوزال">
            <dl className="divide-y divide-ink-100">
              {[['خلاصه مدیریتی', data.executiveSummary], ['رویکرد', data.approach],
                ['خروجی‌ها', data.deliverablesSummary], ['زمان‌بندی', data.timelineSummary],
                ['مبنای قیمت‌گذاری', data.pricingRationale], ['شرایط پرداخت', data.paymentTerms]].map(([l, v]) => (
                <div key={l as string} className="px-4 py-3">
                  <dt className="text-xs font-medium text-ink-500">{l}</dt>
                  <dd className="mt-1 text-sm text-ink-800">{(v as string) || '—'}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <div className="space-y-5">
            <Card title="کنترل کیفیت نهایی" subtitle="قانون ۹ — سطح ۳">
              {!finalQc ? (
                <EmptyState title="QC نهایی ثبت نشده" description="پروپوزال بدون QC نهایی تأییدشده قابل تصویب نیست." />
              ) : (
                <div className="px-4 py-3">
                  <StateBadge state={finalQc.verdict} />
                  {finalQc.findings && <p className="mt-2 text-sm text-ink-700">{finalQc.findings}</p>}
                  <p className="mt-1 text-xs text-ink-400">{formatDate(finalQc.reviewedAt)}</p>
                </div>
              )}
            </Card>

            {!!data.versions?.length && (
              <Card title="نسخه‌های پیشین">
                <ul className="divide-y divide-ink-100">
                  {data.versions.map((v: any) => (
                    <li key={v.id} className="flex items-center justify-between px-4 py-2.5">
                      <span className="text-sm">نسخه {toPersianDigits(v.version)}</span>
                      <span className="text-xs text-ink-400">{formatDate(v.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {data.clientFeedback && (
              <Card title="بازخورد مشتری">
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
    'قیمت‌گذاری ثبت شد و در انتظار تأیید مدیریت است.',
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
      open onClose={onClose} title="تعیین قیمت فروش"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>انصراف</Button>
          <Button variant="primary" loading={save.isPending} disabled={!price || rationale.trim().length < 3} onClick={() => void submit()}>
            ثبت قیمت
          </Button>
        </>
      }
    >
      <p className="mb-4 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
        قیمت تمام‌شده اعلامی واحدها: <strong className="nums">{exactCurrency(proposal.totalCost)}</strong>
        <br />
        طبق قانون ۱۲، قیمت فروش پس از ثبت باید توسط مقام مجاز تأیید شود.
      </p>
      <div className="space-y-4">
        <Field label="قیمت فروش (ریال)" required>
          <Input type="number" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} className="ltr" />
        </Field>
        {price > 0 && (
          <div className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800">
            حاشیه سود محاسبه‌شده: <strong className="nums">{toPersianDigits(margin.toFixed(1))}٪</strong>
            {margin < 15 && <span className="ms-2 text-rose-600">— کمتر از حد مطلوب</span>}
          </div>
        )}
        <Field label="اشل قرارداد">
          <select value={band} onChange={(e) => setBand(e.target.value)} className="w-full rounded-lg border-0 bg-surface px-3 py-2 text-sm ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-brand-600">
            <option value="">— انتخاب —</option>
            <option value="S">کوچک</option><option value="M">متوسط</option>
            <option value="L">بزرگ</option><option value="XL">ویژه</option>
          </select>
        </Field>
        <Field label="شرایط پرداخت"><Input value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="۴۰/۳۰/۳۰" /></Field>
        <Field label="مبنای قیمت‌گذاری" required hint="این توضیح در رهگیری حسابرسی ثبت می‌شود.">
          <Textarea value={rationale} onChange={(e) => setRationale(e.target.value)} rows={3} />
        </Field>
      </div>
    </Modal>
  );
}
