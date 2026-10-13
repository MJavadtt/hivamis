import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageBody, PageHeader } from '../components/Shell';
import { Code, EntityList, WorkflowActions } from '../components/common';
import { PdfButton } from '../components/PdfButton';
import { PdfBundleButton } from '../components/PdfBundleButton';
import { useAction } from '../hooks/queries';
import {
  Badge, Button, Card, DescRow, EmptyState, ErrorBlock, Field, Input, LoadingBlock,
  Modal, StateBadge, StatTile, Table, Tabs, Td, Textarea, Th, Tr, IconPlus,
} from '../components/ui';
import { exactCurrency, formatCurrency, formatDate, formatRelative, localDigits } from '../lib/format';
import { LEAD_SOURCE_KINDS, LEAD_SOURCE_LABELS, leadSourceFa, normalizeIranMobile } from '@hiva/contracts';
import { ApiError } from '../lib/api';
import { LeadSourcePicker, sourceComplete, type LeadSourceValue } from '../components/LeadSource';
import { PortalUsersCard } from '../components/PortalAdmin';
import { BrandLibraryCard } from '../components/BrandLibrary';
import { pair, tr, trx } from '../i18n';
import { SuggestedForms } from '../components/SuggestedForms';


/* ── Leads ─────────────────────────────────────────────────────────────── */

export function LeadsList() {
  const [creating, setCreating] = useState(false);
  const { can } = useAuth();

  return (
    <>
      <PageHeader
        title={tr('سرنخ‌ها')}
        subtitle={tr('مرحله جذب — مالک فرآیند: واحد فروش')}
        actions={can('crm.lead.write') && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <IconPlus className="size-4" />{' '}{tr('سرنخ جدید')}</Button>
        )}
      />
      <PageBody>
        <EntityList<any>
          path="/leads"
          searchPlaceholder={tr('جستجو در نام سرنخ، شرکت یا تلفن همراه…')}
          filters={[{
            key: 'state', label: tr('وضعیت'),
            options: [
              { value: 'NEW', label: tr('جدید') }, { value: 'CONTACTED', label: tr('تماس گرفته‌شده') },
              { value: 'QUALIFIED', label: tr('واجد شرایط') }, { value: 'CONVERTED', label: tr('تبدیل‌شده') },
              { value: 'DISQUALIFIED', label: tr('رد شده') },
            ],
          }, {
            key: 'source', label: tr('منبع ورودی'),
            options: LEAD_SOURCE_KINDS.map((k) => ({ value: k, label: pair(LEAD_SOURCE_LABELS[k]) })),
          }]}
          emptyTitle={tr('سرنخی ثبت نشده')}
          columns={[
            { key: 'name', header: tr('سرنخ'), render: (r) => (<><p className="font-medium text-ink-800">{r.name}</p><Code>{r.code}</Code></>) },
            { key: 'company', header: tr('شرکت'), render: (r) => <span className="text-xs">{r.companyName}</span> },
            { key: 'phone', header: tr('تلفن همراه'), render: (r) => <span className="ltr text-xs">{r.phone ?? '—'}</span> },
            { key: 'source', header: tr('منبع ورودی'), render: (r) => <Badge tone="neutral">{trx(leadSourceFa(r))}</Badge> },
            { key: 'value', header: tr('ارزش تخمینی'), render: (r) => <span className="text-xs" title={exactCurrency(r.estimatedValue)}>{formatCurrency(r.estimatedValue)}</span> },
            { key: 'owner', header: tr('مالک'), render: (r) => <span className="text-xs">{r.owner?.fullName ?? '—'}</span> },
            { key: 'state', header: tr('وضعیت'), render: (r) => <StateBadge state={r.state} /> },
            { key: 'actions', header: tr('اقدام'), render: (r) => <LeadActions lead={r} /> },
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
        <Button size="sm" variant="primary" onClick={() => setConverting(true)}>{tr('تبدیل به فرصت')}</Button>
      )}
      {converting && <ConvertModal lead={lead} onClose={() => setConverting(false)} />}
    </div>
  );
}

interface Duplicates {
  phone: string | null;
  leads: { id: string; code: string; name: string; companyName: string; state: string; owner: string | null }[];
  contacts: { id: string; fullName: string; company: string; companyId: string }[];
}

/**
 * A new lead (Hivamis task 2): its mobile number checked while it is typed — a number that is
 * already a lead or a client's contact is shown before anything is saved — and its source in two
 * clicks. Nothing is sent until the second step of the source has been taken.
 */
function LeadModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [source, setSource] = useState<LeadSourceValue>({});
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const create = useAction((body: unknown) => apiPost('/leads', body), tr('سرنخ ثبت شد.'));
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const mobile = normalizeIranMobile(form.phone);
  const [asked, setAsked] = useState<string | null>(null);
  useEffect(() => {
    if (!mobile) return;
    const t = setTimeout(() => setAsked(mobile), 350);
    return () => clearTimeout(t);
  }, [mobile]);
  const { data: dup, refetch: recheck } = useQuery<Duplicates>({
    queryKey: ['/leads/duplicates', asked], queryFn: () => apiGet('/leads/duplicates', { phone: asked! }), enabled: !!asked,
  });
  const repeated = !!mobile && dup?.phone === mobile && (dup.leads.length > 0 || dup.contacts.length > 0);
  useEffect(() => { setConfirmDuplicate(false); }, [mobile]);

  const ready = !!form.name && !!form.companyName && !!mobile && sourceComplete(source) && (!repeated || confirmDuplicate);
  const submit = async () => {
    try {
      await create.mutateAsync({
        name: form.name, companyName: form.companyName, contactName: form.contactName || undefined,
        phone: mobile, email: form.email || undefined, ...source,
        estimatedValue: form.estimatedValue ? Number(form.estimatedValue) : undefined,
        need: form.need || undefined, confirmDuplicate: confirmDuplicate || undefined,
      });
      onClose();
    } catch (e) {
      // Someone registered the same number between the check and the save: the panel shows who.
      if (e instanceof ApiError && e.body.code === 'DUPLICATE_LEAD') void recheck();
    }
  };

  return (
    <Modal
      open wide onClose={onClose} title={tr('ثبت سرنخ جدید')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
          <Button variant="primary" loading={create.isPending} disabled={!ready} onClick={() => void submit()}>{tr('ثبت')}</Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr('نام سرنخ')} required><Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label={tr('نام شرکت')} required><Input value={form.companyName ?? ''} onChange={(e) => set('companyName', e.target.value)} /></Field>
        <Field label={tr('نام تماس')}><Input value={form.contactName ?? ''} onChange={(e) => set('contactName', e.target.value)} /></Field>
        <Field label={tr('تلفن همراه')} required
          error={form.phone && !mobile ? tr('شمارهٔ همراه معتبر نیست — مانند ۰۹۱۲۱۲۳۴۵۶۷') : undefined}
          hint={mobile && mobile !== form.phone ? tr('ثبت می‌شود: {0}', mobile) : undefined}>
          <Input value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} className="ltr" inputMode="tel" placeholder="09xx xxx xxxx" />
        </Field>
        {repeated && dup && (
          <div className="sm:col-span-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-200" role="alert" data-testid="lead-duplicate">
            <p className="font-medium">{tr('این شماره پیش‌تر ثبت شده است:')}</p>
            <ul className="mt-1 space-y-0.5">
              {dup.leads.map((l) => <li key={l.id}>{tr('سرنخ')}{' '}<span className="ltr whitespace-nowrap">{l.code}</span> «{l.name}» — {l.companyName}{l.owner ? tr(' (مالک: {0})', l.owner) : ''}</li>)}
              {dup.contacts.map((c) => <li key={c.id}>{tr('مخاطب «{0}» از', c.fullName)}{' '}<Link to={`/companies/${c.companyId}`} className="underline">{c.company}</Link></li>)}
            </ul>
            <label className="mt-2 flex items-center gap-2">
              <input type="checkbox" checked={confirmDuplicate} onChange={(e) => setConfirmDuplicate(e.target.checked)} />{tr('سرنخ تازه‌ای است؛ با وجود تکرار ثبت شود')}</label>
          </div>
        )}
        <Field label={tr('ایمیل')}><Input type="email" value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} className="ltr" /></Field>
        <Field label={tr('ارزش تخمینی (ریال)')}><Input type="number" value={form.estimatedValue ?? ''} onChange={(e) => set('estimatedValue', e.target.value)} className="ltr" /></Field>
        <div className="sm:col-span-2">
          <span className="mb-1 flex items-center gap-1 text-xs font-medium text-ink-700">{tr('منبع ورودی')}{' '}<span className="text-rose-700">*</span></span>
          <LeadSourcePicker value={source} onChange={setSource} />
        </div>
        <div className="sm:col-span-2">
          <Field label={tr('نیاز اولیه')}><Textarea value={form.need ?? ''} onChange={(e) => set('need', e.target.value)} /></Field>
        </div>
      </div>
    </Modal>
  );
}

function ConvertModal({ lead, onClose }: { lead: any; onClose: () => void }) {
  const [title, setTitle] = useState(tr('فرصت — {0}', lead.companyName));
  const [value, setValue] = useState(String(lead.estimatedValue ?? ''));
  const navigate = useNavigate();
  const convert = useAction(
    (body: unknown) => apiPost<{ id: string }>(`/leads/${lead.id}/convert`, body),
    tr('سرنخ به فرصت فروش تبدیل شد.'),
  );

  const submit = async () => {
    const opp = await convert.mutateAsync({ title, estimatedValue: value ? Number(value) : undefined });
    onClose();
    navigate(`/opportunities/${(opp as any).id}`);
  };

  return (
    <Modal
      open onClose={onClose} title={tr('تبدیل سرنخ به فرصت فروش')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
          <Button variant="primary" loading={convert.isPending} onClick={() => void submit()}>{tr('تبدیل')}</Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-ink-500">{tr('در صورت نبود مشتری متناظر، رکورد مشتری به‌صورت خودکار ایجاد می‌شود.')}</p>
      <div className="space-y-4">
        <Field label={tr('عنوان فرصت')} required><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label={tr('ارزش تخمینی (ریال)')}><Input type="number" value={value} onChange={(e) => setValue(e.target.value)} className="ltr" /></Field>
      </div>
    </Modal>
  );
}

/* ── Opportunities ─────────────────────────────────────────────────────── */

export function OpportunitiesList() {
  return (
    <>
      <PageHeader title={tr('فرصت‌های فروش')} subtitle={tr('از واجد شرایط شدن تا عقد قرارداد')} />
      <PageBody>
        <EntityList<any>
          path="/opportunities"
          searchPlaceholder={tr('جستجو در عنوان فرصت…')}
          rowHref={(r) => `/opportunities/${r.id}`}
          filters={[{
            key: 'state', label: tr('وضعیت'),
            options: [
              { value: 'NEW', label: tr('جدید') }, { value: 'QUALIFIED', label: tr('واجد شرایط') },
              { value: 'BRIEF_REQUESTED', label: tr('در انتظار بریف') }, { value: 'BRIEF_COMPLETED', label: tr('بریف تکمیل') },
              { value: 'PROPOSAL', label: tr('پروپوزال') }, { value: 'NEGOTIATION', label: tr('مذاکره') },
              { value: 'WON', label: tr('برنده') }, { value: 'LOST', label: tr('از دست رفته') },
            ],
          }]}
          emptyTitle={tr('فرصتی ثبت نشده')}
          columns={[
            { key: 'title', header: tr('فرصت'), render: (r) => (<><p className="font-medium text-ink-800">{r.title}</p><Code>{r.code}</Code></>) },
            { key: 'company', header: tr('مشتری'), render: (r) => <span className="text-xs">{r.company?.legalName}</span> },
            { key: 'value', header: tr('ارزش'), render: (r) => <span className="text-xs" title={exactCurrency(r.estimatedValue)}>{formatCurrency(r.estimatedValue)}</span> },
            { key: 'close', header: tr('بستن تخمینی'), render: (r) => <span className="text-xs">{formatDate(r.expectedCloseDate)}</span> },
            { key: 'owner', header: tr('مالک'), render: (r) => <span className="text-xs">{r.owner?.fullName ?? '—'}</span> },
            { key: 'state', header: tr('وضعیت'), render: (r) => <StateBadge state={r.state} /> },
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
      <SuggestedForms entity="opportunity" id={id} />
      <PageBody className="grid gap-5 lg:grid-cols-3">
        <Card title={tr('اطلاعات فرصت')} className="lg:col-span-1">
          <dl className="px-4 py-1">
            <DescRow label={tr('ارزش تخمینی')}>{exactCurrency(data.estimatedValue)}</DescRow>
            <DescRow label={tr('بستن تخمینی')}>{formatDate(data.expectedCloseDate)}</DescRow>
            <DescRow label={tr('مالک')}>{data.owner?.fullName ?? '—'}</DescRow>
            <DescRow label={tr('واحدهای مورد نیاز')}>{data.servicesNeeded?.join(tr('، ')) || '—'}</DescRow>
            {data.lostReason && <DescRow label={tr('دلیل باخت')}>{data.lostReason}</DescRow>}
          </dl>
          {data.description && <p className="border-t border-ink-100 px-4 py-3 text-sm text-ink-600">{data.description}</p>}
        </Card>

        <Card title={tr('بریف‌ها')} className="lg:col-span-2">
          {!data.briefs?.length ? (
            <EmptyState title={tr('بریفی ثبت نشده')} description={tr('فروش باید بریف را تهیه و به اکانت ارسال کند.')} />
          ) : (
            <Table>
              <thead className="bg-ink-50/60">
                <tr><Th>{tr('بریف')}</Th><Th>{tr('کامل بودن')}</Th><Th>{tr('وضعیت')}</Th></tr>
              </thead>
              <tbody>
                {data.briefs.map((b: any) => (
                  <Tr key={b.id}>
                    <Td><Link to={`/briefs/${b.id}`} className="text-sm text-brand-600 hover:underline">{b.title}</Link><Code>{b.code}</Code></Td>
                    <Td className="nums text-xs">{tr('{0}٪', localDigits(b.completenessScore))}</Td>
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
      <PageHeader title={tr('مشتریان')} subtitle={tr('پرتفوی مشتریان سازمان')} />
      <PageBody>
        <EntityList<any>
          path="/companies"
          searchPlaceholder={tr('جستجو در نام یا صنعت…')}
          rowHref={(r) => `/companies/${r.id}`}
          emptyTitle={tr('مشتری‌ای ثبت نشده')}
          columns={[
            { key: 'name', header: tr('مشتری'), render: (r) => (<><p className="font-medium text-ink-800">{r.legalName}</p>{r.brandName && <p className="text-[12.5px] text-ink-400">{r.brandName}</p>}</>) },
            { key: 'industry', header: tr('صنعت'), render: (r) => <span className="text-xs">{r.industry ?? '—'}</span> },
            { key: 'account', header: tr('مالک اکانت'), render: (r) => <span className="text-xs">{r.accountOwner?.fullName ?? '—'}</span> },
            { key: 'sales', header: tr('مالک فروش'), render: (r) => <span className="text-xs">{r.salesOwner?.fullName ?? '—'}</span> },
            { key: 'projects', header: tr('پروژه‌ها'), render: (r) => <span className="nums text-xs">{localDigits(r._count?.projects ?? 0)}</span> },
            {
              key: 'health', header: tr('سلامت مشتری'),
              render: (r) => r.healthScore == null ? <span className="text-xs text-ink-400">—</span>
                : <Badge tone={r.healthScore >= 75 ? 'success' : r.healthScore >= 50 ? 'warning' : 'danger'}>
                    {localDigits(r.healthScore)}
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
        subtitle={<span>{c.brandName ? `${c.brandName} — ` : ''}{c.industry ?? tr('صنعت نامشخص')}</span>}
        badge={c.healthScore != null && (
          <Badge tone={c.healthScore >= 75 ? 'success' : c.healthScore >= 50 ? 'warning' : 'danger'}>{tr('سلامت مشتری: {0}', localDigits(c.healthScore))}</Badge>
        )}
        actions={
          <>
            <PdfButton kind="company" id={c.id} label={tr('پرونده مشتری')} />
            <PdfBundleButton kind="company" id={c.id} />
          </>
        }
      />
      <SuggestedForms entity="company" id={id} />

      <div className="mx-3 mt-3 rounded-xl bg-surface px-2 shadow-sm ring-1 ring-edge sm:mx-5 lg:mx-0 [&>[role=tablist]]:border-b-0">
        <Tabs
          active={tab} onChange={setTab}
          tabs={[
            { key: 'overview', label: tr('نمای کلی') },
            { key: 'projects', label: tr('پروژه‌ها'), count: data.projects.length },
            { key: 'commercial', label: tr('تجاری'), count: data.opportunities.length + data.contracts.length },
            ...(data.finance ? [{ key: 'finance', label: tr('مالی') }] : []),
            { key: 'engagement', label: tr('ارتباطات'), count: data.activities.length + data.meetings.length },
          ]}
        />
      </div>

      <PageBody className="space-y-5">
        {tab === 'overview' && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile label={tr('فرصت‌های باز')} value={localDigits(data.metrics.openOpportunities)} />
              <StatTile label={tr('پروژه‌های فعال')} value={localDigits(data.metrics.activeProjects)} tone="progress" />
              <StatTile label={tr('پروژه‌های بسته‌شده')} value={localDigits(data.metrics.closedProjects)} />
              <StatTile
                label={tr('میانگین رضایت (CSAT)')}
                value={data.metrics.avgCsat ? localDigits(data.metrics.avgCsat.toFixed(1)) : '—'}
                tone={data.metrics.avgCsat >= 4 ? 'success' : data.metrics.avgCsat ? 'warning' : 'neutral'}
              />
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <Card title={tr('اطلاعات مشتری')}>
                <dl className="px-4 py-1">
                  <DescRow label={tr('شناسه ملی')}><span className="ltr">{c.nationalId ?? '—'}</span></DescRow>
                  <DescRow label={tr('کد اقتصادی')}><span className="ltr">{c.economicCode ?? '—'}</span></DescRow>
                  <DescRow label={tr('تلفن')}><span className="ltr">{c.phone ?? '—'}</span></DescRow>
                  <DescRow label={tr('وب‌سایت')}><span className="ltr">{c.website ?? '—'}</span></DescRow>
                  <DescRow label={tr('مالک اکانت')}>{c.accountOwner?.fullName ?? '—'}</DescRow>
                  <DescRow label={tr('مالک فروش')}>{c.salesOwner?.fullName ?? '—'}</DescRow>
                </dl>
              </Card>

              <Card title={tr('مخاطبین')}>
                {!c.contacts?.length ? <EmptyState title={tr('مخاطبی ثبت نشده')} /> : (
                  <ul className="divide-y divide-ink-100">
                    {c.contacts.map((ct: any) => (
                      <li key={ct.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                        <div className="min-w-0">
                          <p className="text-sm text-ink-800">{ct.fullName}</p>
                          <p className="text-xs text-ink-500">{ct.jobTitle ?? '—'}</p>
                        </div>
                        <div className="text-end text-xs text-ink-500">
                          <p className="ltr">{ct.phone ?? ''}</p>
                          {ct.isPrimary && <Badge tone="progress">{tr('مخاطب اصلی')}</Badge>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            <PortalUsersCard companyId={c.id} contacts={c.contacts ?? []} />

            <BrandLibraryCard companyId={c.id} />

            {!!data.feedbacks.length && (
              <Card title={tr('بازخوردهای مشتری')}>
                <ul className="divide-y divide-ink-100">
                  {data.feedbacks.map((f: any) => (
                    <li key={f.id} className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Badge tone={f.csat >= 4 ? 'success' : 'warning'}>{tr('CSAT {0}/۵', localDigits(f.csat))}</Badge>
                        <Badge tone={f.nps >= 8 ? 'success' : 'warning'}>NPS {localDigits(f.nps)}</Badge>
                        <span className="text-xs text-ink-400">{formatDate(f.createdAt)}</span>
                      </div>
                      {f.positives && <p className="mt-1.5 text-sm text-ink-700">{f.positives}</p>}
                      {f.futureNeeds && (
                        <p className="mt-1 rounded bg-brand-50 px-2 py-1 text-xs text-brand-700">{tr('نیاز آتی:')}{' '}{f.futureNeeds}
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
          <Card title={tr('پروژه‌ها')}>
            {!data.projects.length ? <EmptyState title={tr('پروژه‌ای وجود ندارد')} /> : (
              <Table>
                <thead className="bg-ink-50/60"><tr><Th>{tr('پروژه')}</Th><Th>{tr('وضعیت')}</Th><Th>{tr('وظایف')}</Th><Th>{tr('تغییرات')}</Th><Th>{tr('پایان')}</Th></tr></thead>
                <tbody>
                  {data.projects.map((p: any) => (
                    <Tr key={p.id}>
                      <Td><Link to={`/projects/${p.id}`} className="text-sm text-brand-600 hover:underline">{p.name}</Link><Code>{p.code}</Code></Td>
                      <Td><StateBadge state={p.state} /></Td>
                      <Td className="nums text-xs">{localDigits(p._count?.tasks ?? 0)}</Td>
                      <Td className="nums text-xs">{localDigits(p._count?.changeRequests ?? 0)}</Td>
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
            <Card title={tr('فرصت‌های فروش')}>
              {!data.opportunities.length ? <EmptyState title={tr('فرصتی ثبت نشده')} /> : (
                <Table>
                  <thead className="bg-ink-50/60"><tr><Th>{tr('فرصت')}</Th><Th>{tr('ارزش')}</Th><Th>{tr('وضعیت')}</Th></tr></thead>
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
            <Card title={tr('قراردادها')}>
              {!data.contracts.length ? <EmptyState title={tr('قراردادی ثبت نشده')} /> : (
                <Table>
                  <thead className="bg-ink-50/60"><tr><Th>{tr('قرارداد')}</Th><Th>{tr('شماره')}</Th><Th>{tr('مبلغ')}</Th><Th>{tr('وضعیت')}</Th></tr></thead>
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
              <StatTile label={tr('مجموع فاکتورشده')} value={formatCurrency(data.finance.totals.invoiced)} />
              <StatTile label={tr('دریافت‌شده')} value={formatCurrency(data.finance.totals.received)} tone="success" />
              <StatTile label={tr('مانده مطالبات')} value={formatCurrency(data.finance.totals.outstanding)}
                tone={data.finance.totals.outstanding > 0 ? 'warning' : 'success'} />
            </div>
            <Card title={tr('اسناد مالی')}>
              {!data.finance.invoices.length ? <EmptyState title={tr('سندی صادر نشده')} /> : (
                <Table>
                  <thead className="bg-ink-50/60"><tr><Th>{tr('شماره')}</Th><Th>{tr('تاریخ')}</Th><Th>{tr('مبلغ')}</Th><Th>{tr('دریافت‌شده')}</Th><Th>{tr('وضعیت')}</Th></tr></thead>
                  <tbody>
                    {data.finance.invoices.map((i: any) => (
                      <Tr key={i.id}>
                        <Td className="ltr text-xs whitespace-nowrap">{i.number}</Td>
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
            <Card title={tr('فعالیت‌ها و مذاکرات')}>
              {!data.activities.length ? <EmptyState title={tr('فعالیتی ثبت نشده')} /> : (
                <ul className="divide-y divide-ink-100">
                  {data.activities.map((a: any) => (
                    <li key={a.id} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <Badge tone="neutral">{a.kind}</Badge>
                        <span className="text-xs text-ink-400">{formatRelative(a.occurredAt)}</span>
                      </div>
                      <p className="mt-1 text-sm text-ink-700">{a.summary}</p>
                      {a.nextStep && <p className="mt-1 text-xs text-brand-600">{tr('اقدام بعدی:')}{' '}{a.nextStep}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title={tr('جلسات')}>
              {!data.meetings.length ? <EmptyState title={tr('جلسه‌ای ثبت نشده')} /> : (
                <ul className="divide-y divide-ink-100">
                  {data.meetings.map((m: any) => (
                    <li key={m.id} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium text-ink-800">{m.subject}</p>
                        <span className="text-xs text-ink-400">{formatDate(m.heldAt)}</span>
                      </div>
                      {m.decisions && <p className="mt-1 text-xs text-ink-600">{tr('تصمیمات:')}{' '}{m.decisions}</p>}
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
