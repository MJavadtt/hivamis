import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageBody, PageHeader } from '../components/Shell';
import { Code, EntityList, WorkflowActions } from '../components/common';
import { useAction } from '../hooks/queries';
import {
  Badge, Button, Card, DescRow, EmptyState, ErrorBlock, Field, Input, LoadingBlock,
  Modal, Select, StateBadge, StatTile, Table, Tabs, Td, Textarea, Th, Tr, IconPlus,
} from '../components/ui';
import { exactCurrency, formatCurrency, formatDate, formatRelative, toPersianDigits } from '../lib/format';

const SOURCES = [
  { value: 'REFERRAL', label: 'معرفی' }, { value: 'INBOUND', label: 'ورودی' },
  { value: 'OUTBOUND', label: 'تماس سرد' }, { value: 'EVENT', label: 'رویداد' },
  { value: 'CAMPAIGN', label: 'کمپین' }, { value: 'OTHER', label: 'سایر' },
];

/* ── Leads ─────────────────────────────────────────────────────────────── */

export function LeadsList() {
  const [creating, setCreating] = useState(false);
  const { can } = useAuth();

  return (
    <>
      <PageHeader
        title="سرنخ‌ها"
        subtitle="مرحله جذب — مالک فرآیند: واحد فروش"
        actions={can('crm.lead.write') && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <IconPlus className="size-4" /> سرنخ جدید
          </Button>
        )}
      />
      <PageBody>
        <EntityList<any>
          path="/leads"
          searchPlaceholder="جستجو در نام سرنخ یا شرکت…"
          filters={[{
            key: 'state', label: 'وضعیت',
            options: [
              { value: 'NEW', label: 'جدید' }, { value: 'CONTACTED', label: 'تماس گرفته‌شده' },
              { value: 'QUALIFIED', label: 'واجد شرایط' }, { value: 'CONVERTED', label: 'تبدیل‌شده' },
              { value: 'DISQUALIFIED', label: 'رد شده' },
            ],
          }]}
          emptyTitle="سرنخی ثبت نشده"
          columns={[
            { key: 'name', header: 'سرنخ', render: (r) => (<><p className="font-medium text-ink-800">{r.name}</p><Code>{r.code}</Code></>) },
            { key: 'company', header: 'شرکت', render: (r) => <span className="text-xs">{r.companyName}</span> },
            { key: 'source', header: 'منبع', render: (r) => <Badge tone="neutral">{SOURCES.find((s) => s.value === r.source)?.label ?? r.source}</Badge> },
            { key: 'value', header: 'ارزش تخمینی', render: (r) => <span className="text-xs" title={exactCurrency(r.estimatedValue)}>{formatCurrency(r.estimatedValue)}</span> },
            { key: 'owner', header: 'مالک', render: (r) => <span className="text-xs">{r.owner?.fullName ?? '—'}</span> },
            { key: 'state', header: 'وضعیت', render: (r) => <StateBadge state={r.state} /> },
            { key: 'actions', header: 'اقدام', render: (r) => <LeadActions lead={r} /> },
          ]}
        />
      </PageBody>
      {creating && <LeadModal onClose={() => setCreating(false)} />}
    </>
  );
}

function LeadActions({ lead }: { lead: any }) {
  const [converting, setConverting] = useState(false);
  const { can } = useAuth();
  const canConvert = can('crm.lead.convert') && lead.state === 'QUALIFIED';

  return (
    <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
      <WorkflowActions entity="lead" id={lead.id} transitions={lead.availableTransitions} />
      {canConvert && (
        <Button size="sm" variant="primary" onClick={() => setConverting(true)}>
          تبدیل به فرصت
        </Button>
      )}
      {converting && <ConvertModal lead={lead} onClose={() => setConverting(false)} />}
    </div>
  );
}

function LeadModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState<Record<string, string>>({ source: 'INBOUND' });
  const create = useAction((body: unknown) => apiPost('/leads', body), 'سرنخ ثبت شد.');
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    await create.mutateAsync({
      name: form.name, companyName: form.companyName, contactName: form.contactName || undefined,
      phone: form.phone || undefined, email: form.email || undefined, source: form.source,
      estimatedValue: form.estimatedValue ? Number(form.estimatedValue) : undefined,
      need: form.need || undefined,
    });
    onClose();
  };

  return (
    <Modal
      open onClose={onClose} title="ثبت سرنخ جدید"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>انصراف</Button>
          <Button variant="primary" loading={create.isPending} disabled={!form.name || !form.companyName} onClick={() => void submit()}>
            ثبت
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="نام سرنخ" required><Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="نام شرکت" required><Input value={form.companyName ?? ''} onChange={(e) => set('companyName', e.target.value)} /></Field>
        <Field label="نام تماس"><Input value={form.contactName ?? ''} onChange={(e) => set('contactName', e.target.value)} /></Field>
        <Field label="تلفن"><Input value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} className="ltr" /></Field>
        <Field label="ایمیل"><Input type="email" value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} className="ltr" /></Field>
        <Field label="منبع" required>
          <Select value={form.source} onChange={(e) => set('source', e.target.value)}>
            {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </Field>
        <Field label="ارزش تخمینی (ریال)"><Input type="number" value={form.estimatedValue ?? ''} onChange={(e) => set('estimatedValue', e.target.value)} className="ltr" /></Field>
        <div className="sm:col-span-2">
          <Field label="نیاز اولیه"><Textarea value={form.need ?? ''} onChange={(e) => set('need', e.target.value)} /></Field>
        </div>
      </div>
    </Modal>
  );
}

function ConvertModal({ lead, onClose }: { lead: any; onClose: () => void }) {
  const [title, setTitle] = useState(`فرصت — ${lead.companyName}`);
  const [value, setValue] = useState(String(lead.estimatedValue ?? ''));
  const navigate = useNavigate();
  const convert = useAction(
    (body: unknown) => apiPost<{ id: string }>(`/leads/${lead.id}/convert`, body),
    'سرنخ به فرصت فروش تبدیل شد.',
  );

  const submit = async () => {
    const opp = await convert.mutateAsync({ title, estimatedValue: value ? Number(value) : undefined });
    onClose();
    navigate(`/opportunities/${(opp as any).id}`);
  };

  return (
    <Modal
      open onClose={onClose} title="تبدیل سرنخ به فرصت فروش"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>انصراف</Button>
          <Button variant="primary" loading={convert.isPending} onClick={() => void submit()}>تبدیل</Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-ink-500">
        در صورت نبود مشتری متناظر، رکورد مشتری به‌صورت خودکار ایجاد می‌شود.
      </p>
      <div className="space-y-4">
        <Field label="عنوان فرصت" required><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="ارزش تخمینی (ریال)"><Input type="number" value={value} onChange={(e) => setValue(e.target.value)} className="ltr" /></Field>
      </div>
    </Modal>
  );
}

/* ── Opportunities ─────────────────────────────────────────────────────── */

export function OpportunitiesList() {
  return (
    <>
      <PageHeader title="فرصت‌های فروش" subtitle="از واجد شرایط شدن تا عقد قرارداد" />
      <PageBody>
        <EntityList<any>
          path="/opportunities"
          searchPlaceholder="جستجو در عنوان فرصت…"
          rowHref={(r) => `/opportunities/${r.id}`}
          filters={[{
            key: 'state', label: 'وضعیت',
            options: [
              { value: 'NEW', label: 'جدید' }, { value: 'QUALIFIED', label: 'واجد شرایط' },
              { value: 'BRIEF_REQUESTED', label: 'در انتظار بریف' }, { value: 'BRIEF_COMPLETED', label: 'بریف تکمیل' },
              { value: 'PROPOSAL', label: 'پروپوزال' }, { value: 'NEGOTIATION', label: 'مذاکره' },
              { value: 'WON', label: 'برنده' }, { value: 'LOST', label: 'از دست رفته' },
            ],
          }]}
          emptyTitle="فرصتی ثبت نشده"
          columns={[
            { key: 'title', header: 'فرصت', render: (r) => (<><p className="font-medium text-ink-800">{r.title}</p><Code>{r.code}</Code></>) },
            { key: 'company', header: 'مشتری', render: (r) => <span className="text-xs">{r.company?.legalName}</span> },
            { key: 'value', header: 'ارزش', render: (r) => <span className="text-xs" title={exactCurrency(r.estimatedValue)}>{formatCurrency(r.estimatedValue)}</span> },
            { key: 'close', header: 'بستن تخمینی', render: (r) => <span className="text-xs">{formatDate(r.expectedCloseDate)}</span> },
            { key: 'owner', header: 'مالک', render: (r) => <span className="text-xs">{r.owner?.fullName ?? '—'}</span> },
            { key: 'state', header: 'وضعیت', render: (r) => <StateBadge state={r.state} /> },
          ]}
        />
      </PageBody>
    </>
  );
}

export function OpportunityDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: [`/opportunities/${id}`],
    queryFn: () => apiGet(`/opportunities/${id}`),
    enabled: !!id,
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
          <Link to={`/companies/${data.company.id}`} className="text-brand-600 hover:underline">{data.company.legalName}</Link></span>}
        actions={<WorkflowActions entity="opportunity" id={data.id} transitions={data.availableTransitions} />}
      />
      <PageBody className="grid gap-5 lg:grid-cols-3">
        <Card title="اطلاعات فرصت" className="lg:col-span-1">
          <dl className="px-4 py-1">
            <DescRow label="ارزش تخمینی">{exactCurrency(data.estimatedValue)}</DescRow>
            <DescRow label="بستن تخمینی">{formatDate(data.expectedCloseDate)}</DescRow>
            <DescRow label="مالک">{data.owner?.fullName ?? '—'}</DescRow>
            <DescRow label="واحدهای مورد نیاز">{data.servicesNeeded?.join('، ') || '—'}</DescRow>
            {data.lostReason && <DescRow label="دلیل باخت">{data.lostReason}</DescRow>}
          </dl>
          {data.description && <p className="border-t border-ink-100 px-4 py-3 text-sm text-ink-600">{data.description}</p>}
        </Card>

        <Card title="بریف‌ها" className="lg:col-span-2">
          {!data.briefs?.length ? (
            <EmptyState title="بریفی ثبت نشده" description="فروش باید بریف را تهیه و به اکانت ارسال کند." />
          ) : (
            <Table>
              <thead className="bg-ink-50/60">
                <tr><Th>بریف</Th><Th>کامل بودن</Th><Th>وضعیت</Th></tr>
              </thead>
              <tbody>
                {data.briefs.map((b: any) => (
                  <Tr key={b.id}>
                    <Td><Link to={`/briefs/${b.id}`} className="text-sm text-brand-600 hover:underline">{b.title}</Link><Code>{b.code}</Code></Td>
                    <Td className="nums text-xs">{toPersianDigits(b.completenessScore)}٪</Td>
                    <Td><StateBadge state={b.state} /></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  );
}

/* ── Companies + Customer 360 ──────────────────────────────────────────── */

export function CompaniesList() {
  return (
    <>
      <PageHeader title="مشتریان" subtitle="پرتفوی مشتریان سازمان" />
      <PageBody>
        <EntityList<any>
          path="/companies"
          searchPlaceholder="جستجو در نام یا صنعت…"
          rowHref={(r) => `/companies/${r.id}`}
          emptyTitle="مشتری‌ای ثبت نشده"
          columns={[
            { key: 'name', header: 'مشتری', render: (r) => (<><p className="font-medium text-ink-800">{r.legalName}</p>{r.brandName && <p className="text-[11px] text-ink-400">{r.brandName}</p>}</>) },
            { key: 'industry', header: 'صنعت', render: (r) => <span className="text-xs">{r.industry ?? '—'}</span> },
            { key: 'account', header: 'مالک اکانت', render: (r) => <span className="text-xs">{r.accountOwner?.fullName ?? '—'}</span> },
            { key: 'sales', header: 'مالک فروش', render: (r) => <span className="text-xs">{r.salesOwner?.fullName ?? '—'}</span> },
            { key: 'projects', header: 'پروژه‌ها', render: (r) => <span className="nums text-xs">{toPersianDigits(r._count?.projects ?? 0)}</span> },
            {
              key: 'health', header: 'سلامت مشتری',
              render: (r) => r.healthScore == null ? <span className="text-xs text-ink-400">—</span>
                : <Badge tone={r.healthScore >= 75 ? 'success' : r.healthScore >= 50 ? 'warning' : 'danger'}>
                    {toPersianDigits(r.healthScore)}
                  </Badge>,
            },
          ]}
        />
      </PageBody>
    </>
  );
}

export function CompanyDetail() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState('overview');

  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: [`/companies/${id}/360`],
    queryFn: () => apiGet(`/companies/${id}/360`),
    enabled: !!id,
  });

  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const c = data.company;
  return (
    <>
      <PageHeader
        title={c.legalName}
        subtitle={<span>{c.brandName ? `${c.brandName} — ` : ''}{c.industry ?? 'صنعت نامشخص'}</span>}
        badge={c.healthScore != null && (
          <Badge tone={c.healthScore >= 75 ? 'success' : c.healthScore >= 50 ? 'warning' : 'danger'}>
            سلامت مشتری: {toPersianDigits(c.healthScore)}
          </Badge>
        )}
      />

      <div className="border-b border-ink-200 bg-white px-2">
        <Tabs
          active={tab} onChange={setTab}
          tabs={[
            { key: 'overview', label: 'نمای کلی' },
            { key: 'projects', label: 'پروژه‌ها', count: data.projects.length },
            { key: 'commercial', label: 'تجاری', count: data.opportunities.length + data.contracts.length },
            ...(data.finance ? [{ key: 'finance', label: 'مالی' }] : []),
            { key: 'engagement', label: 'ارتباطات', count: data.activities.length + data.meetings.length },
          ]}
        />
      </div>

      <PageBody className="space-y-5">
        {tab === 'overview' && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile label="فرصت‌های باز" value={toPersianDigits(data.metrics.openOpportunities)} />
              <StatTile label="پروژه‌های فعال" value={toPersianDigits(data.metrics.activeProjects)} tone="progress" />
              <StatTile label="پروژه‌های بسته‌شده" value={toPersianDigits(data.metrics.closedProjects)} />
              <StatTile
                label="میانگین رضایت (CSAT)"
                value={data.metrics.avgCsat ? toPersianDigits(data.metrics.avgCsat.toFixed(1)) : '—'}
                tone={data.metrics.avgCsat >= 4 ? 'success' : data.metrics.avgCsat ? 'warning' : 'neutral'}
              />
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <Card title="اطلاعات مشتری">
                <dl className="px-4 py-1">
                  <DescRow label="شناسه ملی"><span className="ltr">{c.nationalId ?? '—'}</span></DescRow>
                  <DescRow label="کد اقتصادی"><span className="ltr">{c.economicCode ?? '—'}</span></DescRow>
                  <DescRow label="تلفن"><span className="ltr">{c.phone ?? '—'}</span></DescRow>
                  <DescRow label="وب‌سایت"><span className="ltr">{c.website ?? '—'}</span></DescRow>
                  <DescRow label="مالک اکانت">{c.accountOwner?.fullName ?? '—'}</DescRow>
                  <DescRow label="مالک فروش">{c.salesOwner?.fullName ?? '—'}</DescRow>
                </dl>
              </Card>

              <Card title="مخاطبین">
                {!c.contacts?.length ? <EmptyState title="مخاطبی ثبت نشده" /> : (
                  <ul className="divide-y divide-ink-100">
                    {c.contacts.map((ct: any) => (
                      <li key={ct.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                        <div className="min-w-0">
                          <p className="text-sm text-ink-800">{ct.fullName}</p>
                          <p className="text-xs text-ink-500">{ct.jobTitle ?? '—'}</p>
                        </div>
                        <div className="text-end text-xs text-ink-500">
                          <p className="ltr">{ct.phone ?? ''}</p>
                          {ct.isPrimary && <Badge tone="progress">مخاطب اصلی</Badge>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            {!!data.feedbacks.length && (
              <Card title="بازخوردهای مشتری">
                <ul className="divide-y divide-ink-100">
                  {data.feedbacks.map((f: any) => (
                    <li key={f.id} className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Badge tone={f.csat >= 4 ? 'success' : 'warning'}>CSAT {toPersianDigits(f.csat)}/۵</Badge>
                        <Badge tone={f.nps >= 8 ? 'success' : 'warning'}>NPS {toPersianDigits(f.nps)}</Badge>
                        <span className="text-xs text-ink-400">{formatDate(f.createdAt)}</span>
                      </div>
                      {f.positives && <p className="mt-1.5 text-sm text-ink-700">{f.positives}</p>}
                      {f.futureNeeds && (
                        <p className="mt-1 rounded bg-brand-50 px-2 py-1 text-xs text-brand-700">
                          نیاز آتی: {f.futureNeeds}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}

        {tab === 'projects' && (
          <Card title="پروژه‌ها">
            {!data.projects.length ? <EmptyState title="پروژه‌ای وجود ندارد" /> : (
              <Table>
                <thead className="bg-ink-50/60"><tr><Th>پروژه</Th><Th>وضعیت</Th><Th>وظایف</Th><Th>تغییرات</Th><Th>پایان</Th></tr></thead>
                <tbody>
                  {data.projects.map((p: any) => (
                    <Tr key={p.id}>
                      <Td><Link to={`/projects/${p.id}`} className="text-sm text-brand-600 hover:underline">{p.name}</Link><Code>{p.code}</Code></Td>
                      <Td><StateBadge state={p.state} /></Td>
                      <Td className="nums text-xs">{toPersianDigits(p._count?.tasks ?? 0)}</Td>
                      <Td className="nums text-xs">{toPersianDigits(p._count?.changeRequests ?? 0)}</Td>
                      <Td className="text-xs">{formatDate(p.plannedEnd)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        )}

        {tab === 'commercial' && (
          <div className="space-y-5">
            <Card title="فرصت‌های فروش">
              {!data.opportunities.length ? <EmptyState title="فرصتی ثبت نشده" /> : (
                <Table>
                  <thead className="bg-ink-50/60"><tr><Th>فرصت</Th><Th>ارزش</Th><Th>وضعیت</Th></tr></thead>
                  <tbody>
                    {data.opportunities.map((o: any) => (
                      <Tr key={o.id}>
                        <Td><Link to={`/opportunities/${o.id}`} className="text-sm text-brand-600 hover:underline">{o.title}</Link></Td>
                        <Td className="text-xs">{formatCurrency(o.estimatedValue)}</Td>
                        <Td><StateBadge state={o.state} /></Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
            <Card title="قراردادها">
              {!data.contracts.length ? <EmptyState title="قراردادی ثبت نشده" /> : (
                <Table>
                  <thead className="bg-ink-50/60"><tr><Th>قرارداد</Th><Th>شماره</Th><Th>مبلغ</Th><Th>وضعیت</Th></tr></thead>
                  <tbody>
                    {data.contracts.map((ct: any) => (
                      <Tr key={ct.id}>
                        <Td><Link to={`/contracts/${ct.id}`} className="text-sm text-brand-600 hover:underline">{ct.title}</Link></Td>
                        <Td className="ltr text-xs">{ct.contractNumber ?? '—'}</Td>
                        <Td className="text-xs">{formatCurrency(ct.contractValue)}</Td>
                        <Td><StateBadge state={ct.state} /></Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>
        )}

        {tab === 'finance' && data.finance && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <StatTile label="مجموع فاکتورشده" value={formatCurrency(data.finance.totals.invoiced)} />
              <StatTile label="دریافت‌شده" value={formatCurrency(data.finance.totals.received)} tone="success" />
              <StatTile label="مانده مطالبات" value={formatCurrency(data.finance.totals.outstanding)}
                tone={data.finance.totals.outstanding > 0 ? 'warning' : 'success'} />
            </div>
            <Card title="اسناد مالی">
              {!data.finance.invoices.length ? <EmptyState title="سندی صادر نشده" /> : (
                <Table>
                  <thead className="bg-ink-50/60"><tr><Th>شماره</Th><Th>تاریخ</Th><Th>مبلغ</Th><Th>دریافت‌شده</Th><Th>وضعیت</Th></tr></thead>
                  <tbody>
                    {data.finance.invoices.map((i: any) => (
                      <Tr key={i.id}>
                        <Td className="ltr text-xs">{i.number}</Td>
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
          </>
        )}

        {tab === 'engagement' && (
          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="فعالیت‌ها و مذاکرات">
              {!data.activities.length ? <EmptyState title="فعالیتی ثبت نشده" /> : (
                <ul className="divide-y divide-ink-100">
                  {data.activities.map((a: any) => (
                    <li key={a.id} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <Badge tone="neutral">{a.kind}</Badge>
                        <span className="text-xs text-ink-400">{formatRelative(a.occurredAt)}</span>
                      </div>
                      <p className="mt-1 text-sm text-ink-700">{a.summary}</p>
                      {a.nextStep && <p className="mt-1 text-xs text-brand-600">اقدام بعدی: {a.nextStep}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="جلسات">
              {!data.meetings.length ? <EmptyState title="جلسه‌ای ثبت نشده" /> : (
                <ul className="divide-y divide-ink-100">
                  {data.meetings.map((m: any) => (
                    <li key={m.id} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium text-ink-800">{m.subject}</p>
                        <span className="text-xs text-ink-400">{formatDate(m.heldAt)}</span>
                      </div>
                      {m.decisions && <p className="mt-1 text-xs text-ink-600">تصمیمات: {m.decisions}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </PageBody>
    </>
  );
}
