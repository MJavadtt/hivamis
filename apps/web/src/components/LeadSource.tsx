import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { formatDate, localDigits } from '../lib/format';
import { Badge, Button, Card, EmptyState, ErrorBlock, Field, Input, LoadingBlock, Table, Td, Th, Tr, cx, useToast } from './ui';
import { loc, pair, tr } from '../i18n';

/**
 * Where a lead came from, in two clicks (Hivamis task 2): the kind — sales team, marketers, company
 * staff, direct contact, partner companies — then exactly who or what. Every choice is on screen;
 * nothing is hidden in a dropdown a seller has to open to find out what it holds.
 */

export interface LeadSourceValue {
  source?: string;
  sourceUserId?: string;
  sourceReferrerId?: string;
  sourceChannel?: string;
  /** A partner company not on the list yet — added when the lead is saved. */
  sourcePartnerName?: string;
}

interface Person { id: string; fullName: string; jobTitle: string | null; department: string | null }
export interface SourceOptions {
  kinds: { value: string; fa: string; detailFa: string }[];
  channels: { value: string; fa: string }[];
  salesTeam: Person[];
  staff: Person[];
  marketers: { id: string; name: string }[];
  partners: { id: string; name: string }[];
  canManageMarketers: boolean;
  canAddPartners: boolean;
}

export const useSourceOptions = () =>
  useQuery<SourceOptions>({ queryKey: ['/leads/source-options'], queryFn: () => apiGet('/leads/source-options'), staleTime: 60_000 });

/** Whether the second step has been taken — the form is not ready until it has. */
export function sourceComplete(v: LeadSourceValue): boolean {
  switch (v.source) {
    case 'SALES_TEAM': case 'STAFF': return !!v.sourceUserId;
    case 'MARKETER': return !!v.sourceReferrerId;
    case 'PARTNER': return !!v.sourceReferrerId || !!v.sourcePartnerName?.trim();
    case 'DIRECT': return !!v.sourceChannel;
    default: return false;
  }
}

const Chip = ({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string }) => (
  <button type="button" onClick={onClick} title={title} aria-pressed={on}
    className={cx('rounded-lg px-3 py-1.5 text-sm ring-1 ring-inset transition',
      on ? 'btn-accent ring-brand-600' : 'bg-surface text-ink-700 ring-ink-300 hover:bg-ink-50')}>
    {children}
  </button>
);

/** People to choose from: all of them as chips when few, a filter first when many. */
function PersonPicker({ people, value, onChange, emptyFa }: { people: Person[]; value?: string; onChange: (id: string) => void; emptyFa: string }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => people.filter((p) => !q || p.fullName.includes(q) || p.department?.includes(q)), [people, q]);
  if (!people.length) return <p className="text-xs text-ink-500">{emptyFa}</p>;
  return (
    <div className="space-y-2">
      {people.length > 8 && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('جستجوی نام یا واحد…')} aria-label={tr('جستجوی فرد')} />}
      <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
        {shown.map((p) => (
          <Chip key={p.id} on={value === p.id} onClick={() => onChange(p.id)} title={[p.jobTitle, p.department].filter(Boolean).join(' — ')}>
            {p.fullName}{people.length > 8 && p.department ? <span className="ms-1 text-[12.5px] opacity-70">({p.department})</span> : null}
          </Chip>
        ))}
      </div>
    </div>
  );
}

export function LeadSourcePicker({ value, onChange }: { value: LeadSourceValue; onChange: (v: LeadSourceValue) => void }) {
  const { data, isLoading, error } = useSourceOptions();
  const [partnerText, setPartnerText] = useState(value.sourcePartnerName ?? '');
  if (isLoading) return <LoadingBlock />;
  if (error || !data) return <ErrorBlock error={error} />;

  const pick = (kind: string) => onChange({ source: kind });
  const kind = data.kinds.find((k) => k.value === value.source);
  const typed = partnerText.trim();
  const partnersShown = data.partners.filter((p) => !typed || p.name.includes(typed));
  const exact = data.partners.find((p) => p.name === typed);

  return (
    <div className="space-y-3" data-testid="lead-source">
      <div role="group" aria-label={tr('نوع منبع')} className="flex flex-wrap gap-1.5">
        {data.kinds.map((k) => <Chip key={k.value} on={value.source === k.value} onClick={() => pick(k.value)}>{pair(k)}</Chip>)}
      </div>
      {kind && (
        <div className="rounded-lg bg-ink-50/70 p-3" role="group" aria-label={loc(kind, 'detail')}>
          <p className="mb-2 text-xs font-medium text-ink-700">{loc(kind, 'detail')}</p>
          {value.source === 'SALES_TEAM' && (
            <PersonPicker people={data.salesTeam} value={value.sourceUserId} onChange={(id) => onChange({ source: 'SALES_TEAM', sourceUserId: id })} emptyFa={tr('کسی در واحد فروش ثبت نشده است.')} />
          )}
          {value.source === 'STAFF' && (
            <PersonPicker people={data.staff} value={value.sourceUserId} onChange={(id) => onChange({ source: 'STAFF', sourceUserId: id })} emptyFa={tr('همکاری بیرون از تیم فروش ثبت نشده است.')} />
          )}
          {value.source === 'DIRECT' && (
            <div className="flex flex-wrap gap-1.5">
              {data.channels.map((c) => <Chip key={c.value} on={value.sourceChannel === c.value} onClick={() => onChange({ source: 'DIRECT', sourceChannel: c.value })}>{pair(c)}</Chip>)}
            </div>
          )}
          {value.source === 'MARKETER' && (
            data.marketers.length ? (
              <div className="flex flex-wrap gap-1.5">
                {data.marketers.map((m) => <Chip key={m.id} on={value.sourceReferrerId === m.id} onClick={() => onChange({ source: 'MARKETER', sourceReferrerId: m.id })}>{m.name}</Chip>)}
              </div>
            ) : (
              <p className="text-xs text-ink-500">{tr('فهرست بازاریابان خالی است؛ آن را مدیر سیستم نگه می‌دارد.')}{data.canManageMarketers && <> <Link to="/admin?tab=referrers" className="text-brand-700 underline">{tr('افزودن بازاریاب')}</Link></>}
              </p>
            )
          )}
          {value.source === 'PARTNER' && (
            <div className="space-y-2">
              <Input value={partnerText} placeholder={tr('نام شرکت همکار…')} aria-label={tr('نام شرکت همکار')}
                onChange={(e) => {
                  setPartnerText(e.target.value);
                  const found = data.partners.find((p) => p.name === e.target.value.trim());
                  onChange(found ? { source: 'PARTNER', sourceReferrerId: found.id } : { source: 'PARTNER', sourcePartnerName: e.target.value });
                }} />
              <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                {partnersShown.map((p) => (
                  <Chip key={p.id} on={value.sourceReferrerId === p.id} onClick={() => { setPartnerText(p.name); onChange({ source: 'PARTNER', sourceReferrerId: p.id }); }}>{p.name}</Chip>
                ))}
              </div>
              {typed && !exact && (
                <p className="text-xs text-ink-600">
                  {data.canAddPartners ? <>{tr('«{0}» در فهرست نیست و با ثبت سرنخ به شرکت‌های همکار افزوده می‌شود.', typed)}</> : tr('این شرکت در فهرست نیست.')}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── The admin's list of marketers, and the partner companies sellers have named ── */

interface Referrer { id: string; kind: 'MARKETER' | 'PARTNER'; name: string; phone: string | null; note: string | null; isActive: boolean; leads: number; createdAt: string }

export function LeadReferrers() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery<{ items: Referrer[] }>({ queryKey: ['/lead-referrers', 'all'], queryFn: () => apiGet('/lead-referrers', { all: 'true' }) });
  const [form, setForm] = useState({ kind: 'MARKETER' as Referrer['kind'], name: '', phone: '' });
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try {
      await apiPost('/lead-referrers', { kind: form.kind, name: form.name, phone: form.phone || undefined });
      toast(form.kind === 'MARKETER' ? tr('بازاریاب افزوده شد.') : tr('شرکت همکار افزوده شد.'));
      setForm((f) => ({ ...f, name: '', phone: '' }));
      await qc.invalidateQueries({ queryKey: ['/lead-referrers'] });
      await qc.invalidateQueries({ queryKey: ['/leads/source-options'] });
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  const toggle = async (r: Referrer) => {
    try {
      await apiPatch(`/lead-referrers/${r.id}`, { isActive: !r.isActive });
      await qc.invalidateQueries({ queryKey: ['/lead-referrers'] });
      await qc.invalidateQueries({ queryKey: ['/leads/source-options'] });
    } catch (e) { toast((e as Error).message, 'danger'); }
  };

  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  const rows = data?.items ?? [];

  return (
    <div className="space-y-5">
      <Card title={tr('افزودن به فهرست')} subtitle={tr('بازاریابان را فقط مدیر سیستم می‌افزاید؛ شرکت همکار را فروشنده هم هنگام ثبت سرنخ می‌تواند بیفزاید.')}>
        <div className="flex flex-wrap items-end gap-3 p-4">
          <div className="flex gap-1.5" role="group" aria-label={tr('نوع')}>
            <Chip on={form.kind === 'MARKETER'} onClick={() => setForm((f) => ({ ...f, kind: 'MARKETER' }))}>{tr('بازاریاب')}</Chip>
            <Chip on={form.kind === 'PARTNER'} onClick={() => setForm((f) => ({ ...f, kind: 'PARTNER' }))}>{tr('شرکت همکار')}</Chip>
          </div>
          <div className="min-w-48 flex-1"><Field label={tr('نام')}><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></Field></div>
          <div className="w-44"><Field label={tr('تلفن')}><Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} className="ltr" /></Field></div>
          <Button variant="primary" loading={busy} disabled={form.name.trim().length < 2} onClick={() => void add()}>{tr('افزودن')}</Button>
        </div>
      </Card>
      <Card title={tr('منابع سرنخ')} subtitle={tr('آنچه کنار گذاشته شود در سرنخ‌های تازه انتخاب نمی‌شود؛ سرنخ‌های پیشین نامش را نگه می‌دارند.')}>
        {!rows.length ? <EmptyState title={tr('فهرست خالی است')} /> : (
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>{tr('نام')}</Th><Th>{tr('نوع')}</Th><Th>{tr('تلفن')}</Th><Th>{tr('سرنخ‌ها')}</Th><Th>{tr('افزوده شده')}</Th><Th>{tr('وضعیت')}</Th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id}>
                  <Td className="font-medium">{r.name}</Td>
                  <Td><Badge tone={r.kind === 'MARKETER' ? 'info' : 'neutral'}>{r.kind === 'MARKETER' ? tr('بازاریاب') : tr('شرکت همکار')}</Badge></Td>
                  <Td className="ltr text-xs">{r.phone ?? '—'}</Td>
                  <Td className="text-xs">{localDigits(r.leads)}</Td>
                  <Td className="text-xs">{formatDate(r.createdAt)}</Td>
                  <Td>
                    <Button size="sm" variant={r.isActive ? 'ghost' : 'secondary'} onClick={() => void toggle(r)}>
                      {r.isActive ? tr('کنار گذاشتن') : tr('بازگرداندن')}
                    </Button>
                    {!r.isActive && <Badge tone="neutral" className="ms-1">{tr('کنار گذاشته')}</Badge>}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
