import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { localDigits } from '../lib/format';
import { useAuth } from '../lib/auth';
import { PageBody, PageHeader } from '../components/Shell';
import { Badge, Button, Card, EmptyState, ErrorBlock, LoadingBlock, Select, StateBadge, useToast } from '../components/ui';
import { tr } from '../i18n';

/**
 * Data review (ADR-136): what the system flags and leaves to a person. Nothing here merges or
 * deletes by itself. Similar names are a reason to look, not proof that two records are one client.
 */
interface Review {
  duplicateClients: { id: string; legalName: string; brandName: string | null; phone: string | null }[][];
  sharedPhones: { phone: string; contacts: { id: string; fullName: string; companyId: string; company: string | null }[] }[];
  unlinkedLeads: { id: string; code: string; name: string | null; companyName: string; state: string; candidates: { id: string; legalName: string }[] }[];
  unitsWithoutManager: { id: string; code: string; nameFa: string; manager: string | null; reason: 'NONE' | 'LEFT' }[];
  total: number;
}

export default function DataReview() {
  const { data, isLoading, error, refetch } = useQuery<Review>({ queryKey: ['/data-review'], queryFn: () => apiGet('/data-review') });
  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  if (!data) return null;
  return (
    <>
      <PageHeader
        title={tr('بازبینی داده')}
        subtitle={tr('مواردی که سیستم خودش تصمیم نمی‌گیرد: مشتری‌های هم‌نام، شماره‌های تکراری، سرنخ‌های بی‌مشتری و واحدهای بی‌مدیر. چیزی خودکار ادغام یا حذف نمی‌شود.')}
        badge={<Badge tone={data.total ? 'warning' : 'success'}>{data.total ? tr('{0} مورد', localDigits(data.total)) : tr('موردی نیست')}</Badge>}
      />
      <PageBody className="space-y-5">
        {!data.total && <EmptyState title={tr('داده‌ها یکپارچه‌اند')} description={tr('موردی برای بازبینی نیست.')} />}
        {!!data.unlinkedLeads.length && <UnlinkedLeads leads={data.unlinkedLeads} />}
        {!!data.duplicateClients.length && (
          <Card title={tr('مشتری‌های هم‌نام')} subtitle={tr('شاید یک مشتری دو بار ثبت شده باشد. هر دو را باز کنید و اگر یکی‌اند، اطلاعات را در یکی نگه دارید و دیگری را حذف کنید.')}>
            <ul className="divide-y divide-ink-100">
              {data.duplicateClients.map((g) => (
                <li key={g[0]!.id} className="flex flex-wrap gap-2 px-4 py-3">
                  {g.map((c) => (
                    <Link key={c.id} to={`/companies/${c.id}`} className="rounded-lg px-3 py-1.5 text-sm ring-1 ring-edge hover:bg-ink-50">
                      {c.legalName}{c.brandName ? ` (${c.brandName})` : ''}{c.phone ? <span className="ltr ms-2 text-xs text-ink-500">{c.phone}</span> : null}
                    </Link>
                  ))}
                </li>
              ))}
            </ul>
          </Card>
        )}
        {!!data.sharedPhones.length && (
          <Card title={tr('یک شماره برای چند نفر')} subtitle={tr('یک نفر که دو بار ثبت شده، یا شمارهٔ مشترک یک دفتر.')}>
            <ul className="divide-y divide-ink-100">
              {data.sharedPhones.map((p) => (
                <li key={p.phone} className="px-4 py-3">
                  <p className="ltr mb-1 text-start text-sm font-medium text-ink-800">{p.phone}</p>
                  <div className="flex flex-wrap gap-2">
                    {p.contacts.map((c) => (
                      <Link key={c.id} to={`/companies/${c.companyId}`} className="rounded-lg px-3 py-1 text-xs ring-1 ring-edge hover:bg-ink-50">
                        {c.fullName}{c.company ? ` — ${c.company}` : ''}
                      </Link>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {!!data.unitsWithoutManager.length && (
          <Card title={tr('واحدهای بی‌مدیر')} subtitle={tr('تأییدهایی که به مدیر واحد می‌رسند، کسی را ندارند. مدیر را در «واحدها» تعیین کنید.')}>
            <ul className="divide-y divide-ink-100">
              {data.unitsWithoutManager.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <span>{u.nameFa}</span>
                  <span className="text-xs text-ink-500">{u.reason === 'NONE' ? tr('مدیری تعیین نشده') : tr('{0} دیگر در سازمان نیست', u.manager ?? '—')}</span>
                </li>
              ))}
            </ul>
            <div className="border-t border-ink-100 px-4 py-2.5"><Link to="/units" className="text-sm text-accent-700 hover:underline">{tr('رفتن به واحدها')}</Link></div>
          </Card>
        )}
      </PageBody>
    </>
  );
}

function UnlinkedLeads({ leads }: { leads: Review['unlinkedLeads'] }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const link = async (leadId: string) => {
    const companyId = chosen[leadId];
    if (!companyId) return;
    setBusy(leadId);
    try {
      await apiPost(`/data-review/leads/${leadId}/link`, { companyId });
      toast(tr('سرنخ به مشتری پیوند خورد.'));
      await qc.invalidateQueries({ queryKey: ['/data-review'] });
    } catch (e: any) { toast(e?.message ?? tr('عملیات ناموفق بود.'), 'danger'); } finally { setBusy(null); }
  };
  return (
    <Card title={tr('سرنخ‌های بی‌مشتری')} subtitle={tr('سرنخی که به هیچ مشتری‌ای وصل نیست، اما نامش نام یک مشتری است، یا تبدیل شده و مشتری ندارد. اگر همان مشتری است، پیوندش دهید.')}>
      <ul className="divide-y divide-ink-100">
        {leads.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm text-ink-800">{l.name || l.companyName} <span className="text-xs text-ink-500">({l.companyName})</span></p>
              <div className="mt-1 flex items-center gap-2 text-xs text-ink-500"><span className="ltr">{l.code}</span><StateBadge state={l.state} /></div>
            </div>
            {can('crm.lead.write') && (l.candidates.length ? (
              <div className="flex items-center gap-2">
                <Select aria-label={tr('مشتری')} value={chosen[l.id] ?? ''} onChange={(e) => setChosen((c) => ({ ...c, [l.id]: e.target.value }))}>
                  <option value="">{tr('مشتری را برگزینید…')}</option>
                  {l.candidates.map((c) => <option key={c.id} value={c.id}>{c.legalName}</option>)}
                </Select>
                <Button size="sm" variant="primary" disabled={!chosen[l.id]} loading={busy === l.id} onClick={() => void link(l.id)}>{tr('پیوند')}</Button>
              </div>
            ) : <span className="text-xs text-ink-500">{tr('مشتری هم‌نامی پیدا نشد؛ مشتری را بسازید و از ویرایش سرنخ پیوندش دهید.')}</span>)}
          </li>
        ))}
      </ul>
    </Card>
  );
}
