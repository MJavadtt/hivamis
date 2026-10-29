import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost, apiUpload, downloadFile, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDate, formatRelative, localDigits } from '../../lib/format';
import { PageBody, PageHeader } from '../../components/Shell';
import { Code } from '../../components/common';
import { FilePreview } from '../../components/Assets';
import {
  Badge, Button, Card, Checkbox, DescRow, EmptyState, ErrorBlock, Field, IconPlus, IconRefresh, IconSearch, Input, LoadingBlock, Modal,
  Pagination, Select, StateBadge, Table, Td, Textarea, Th, Tr, cx, useToast,
} from '../../components/ui';
import { tr, trx } from '../../i18n';
import { Completeness, Money, SitesNav, blank, fieldLabel, useSiteOptions } from './shared';
import { SendSms } from './Messages';
import { ImportButton } from './Excel';

/**
 * The venue database (ADR-103, module A): every place a counter can go, found by any of its details,
 * kept free of duplicates, complete or marked as not, with its people, photos and projects.
 */

interface Contact { id: string; fullName: string; roleCode: string; jobTitle: string | null; phone: string | null; email: string | null; notes: string | null; isPrimary: boolean; channels: Channel[] }
interface Channel { id: string; typeCode: string; value: string; note: string | null; contactId?: string | null }
interface Candidate { id: string; code: string; name: string; city: string; province: string; reasons: string[]; archived: boolean }
interface VenueRow {
  id: string; code: string; name: string; province: string; city: string; address: string | null; typeCode: string; gradeCode: string | null; audienceCodes: string[];
  phone: string | null; isActive: boolean; archivedAt: string | null; updatedAt: string; primaryContact: { fullName: string; phone: string | null } | null;
  contacts: number; photos: number; projects: number; activeProjects: number; completeness: { score: number; missing: string[] }; version: number;
}
interface VenueDetail extends Omit<VenueRow, 'contacts' | 'photos' | 'projects' | 'activeProjects' | 'primaryContact'> {
  email: string | null; website: string | null; notes: string | null; source: string; createdAt: string; createdBy: { fullName: string };
  contacts: Contact[]; channels: Channel[]; mergedIntoId: string | null;
  documents: { id: string; fileName: string; mimeType: string; category: string | null; caption: string | null; takenAt: string | null; createdAt: string; uploadedBy: { fullName: string } }[];
  siteProjects: { id: string; code: string; name: string; state: string; placement: string | null; contractStart: string | null; contractEnd: string | null; responsible: { fullName: string } | null }[];
  duplicates: Candidate[]; mergedFrom: { id: string; code: string; name: string }[]; mergedInto: { id: string; code: string; name: string } | null;
  messages: { id: string; phone: string; text: string; status: string; error: string | null; createdAt: string; sentBy: { fullName: string } | null }[] | null;
  outstanding: { siteProjectId: string; currency: string; amount: string }[] | null;
}

export default function VenuesPage() {
  const { id } = useParams();
  return id ? <VenueProfile id={id} /> : <VenueList />;
}

/* ── the list ────────────────────────────────────────────────────────────── */

const FILTERS = ['q', 'province', 'city', 'typeCode', 'gradeCode', 'audience', 'status', 'incomplete', 'withoutActiveProject', 'sort', 'order', 'page'] as const;

function VenueList() {
  const { can } = useAuth();
  const opts = useSiteOptions();
  const navigate = useNavigate();
  // The filters live in the address: a list filtered, opened and come back to is as it was.
  const [params, setParams] = useSearchParams();
  const f = Object.fromEntries(FILTERS.map((k) => [k, params.get(k) ?? ''])) as Record<(typeof FILTERS)[number], string>;
  const set = (patch: Partial<typeof f>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };
  const [q, setQ] = useState(f.q);
  const [creating, setCreating] = useState(params.get('new') === '1');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [texting, setTexting] = useState(false);
  const query = { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), pageSize: '25' };
  const { data, isLoading, error, refetch, isFetching } = useQuery<Page<VenueRow>>({ queryKey: ['/venues', query], queryFn: () => apiGet('/venues', query) });
  const { data: facets } = useQuery<{ places: { province: string; city: string; n: number }[] }>({ queryKey: ['/venues/facets'], queryFn: () => apiGet('/venues/facets') });
  const provinces = [...new Set(facets?.places.map((p) => p.province) ?? [])];
  const cities = (facets?.places ?? []).filter((p) => !f.province || p.province === f.province).map((p) => p.city);
  const toggle = (vid: string) => setSelected((s) => { const n = new Set(s); n.has(vid) ? n.delete(vid) : n.add(vid); return n; });
  const sortBy = (k: string) => set({ sort: k, order: f.sort === k && f.order !== 'desc' ? 'desc' : 'asc' });

  return (
    <>
      <PageHeader title={tr('بانک مکان‌ها')} subtitle={tr('مجتمع‌ها، ایستگاه‌ها، شهربازی‌ها و هر جایی که پروژه می‌تواند مستقر شود')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void downloadFile(`/site-data/export/venues?${new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([k, v]) => v && !['page', 'sort', 'order'].includes(k))))}`, 'venues.xlsx')}>{tr('خروجی اکسل')}</Button>
            <ImportButton kind="VENUES" />
            {can('venue.write') && <Button size="sm" variant="primary" onClick={() => setCreating(true)}><IconPlus className="size-4" />{tr('مکان تازه')}</Button>}
          </div>
        } />
      <PageBody>
        <SitesNav />
        <SavedViews page="venues" current={f} onApply={(filters) => setParams(new URLSearchParams(filters), { replace: true })} />
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 p-3">
            <form onSubmit={(e) => { e.preventDefault(); set({ q }); }} className="relative flex-1 basis-56 max-w-sm">
              <IconSearch className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-ink-400" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} className="ps-9" placeholder={tr('نام، کد، شهر، آدرس، تلفن یا نام مخاطب…')} aria-label={tr('جستجو در مکان‌ها')} />
            </form>
            <FilterSelect label={tr('استان')} value={f.province} onChange={(v) => set({ province: v, city: '' })} options={provinces.map((p) => ({ value: p, label: p }))} />
            <FilterSelect label={tr('شهر')} value={f.city} onChange={(v) => set({ city: v })} options={[...new Set(cities)].map((c) => ({ value: c, label: c }))} />
            <FilterSelect label={tr('نوع مکان')} value={f.typeCode} onChange={(v) => set({ typeCode: v })} options={opts.choices('VENUE_TYPE')} />
            <FilterSelect label={tr('گرید')} value={f.gradeCode} onChange={(v) => set({ gradeCode: v })} options={opts.choices('VENUE_GRADE')} />
            <FilterSelect label={tr('مخاطبان')} value={f.audience} onChange={(v) => set({ audience: v })} options={opts.choices('AUDIENCE')} />
            <FilterSelect label={tr('وضعیت')} value={f.status} onChange={(v) => set({ status: v })} all={tr('فعال')}
              options={[{ value: 'inactive', label: tr('غیرفعال') }, { value: 'archived', label: tr('بایگانی‌شده') }, { value: 'all', label: tr('همه') }]} />
            <Checkbox label={tr('فقط ناقص‌ها')} checked={f.incomplete === 'true'} onChange={(e) => set({ incomplete: e.target.checked ? 'true' : '' })} />
            <Checkbox label={tr('بی‌پروژهٔ فعال')} checked={f.withoutActiveProject === 'true'} onChange={(e) => set({ withoutActiveProject: e.target.checked ? 'true' : '' })} />
            <Button variant="ghost" size="sm" onClick={() => void refetch()} aria-label={tr('به‌روزرسانی')}><IconRefresh className={cx('size-4', isFetching && 'animate-spin')} /></Button>
          </div>
          {selected.size > 0 && (
            <div className="flex items-center gap-3 border-b border-ink-100 bg-brand-50/50 px-4 py-2 text-sm">
              <span>{tr('{0} مکان برگزیده', localDigits(selected.size))}</span>
              {can('venue.sms') && <Button size="sm" onClick={() => setTexting(true)}>{tr('ارسال پیامک')}</Button>}
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>{tr('لغو انتخاب')}</Button>
            </div>
          )}
          {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={() => void refetch()} /> : !data?.items.length ? (
            <EmptyState title={tr('مکانی با این مشخصات نیست')} description={can('venue.write') ? tr('مکان تازه ثبت کنید یا از اکسل وارد کنید.') : undefined} />
          ) : (
            <>
              <Table>
                <thead className="bg-ink-50/60">
                  <tr>
                    <Th><span className="sr-only">{tr('انتخاب')}</span></Th>
                    <Th><button type="button" onClick={() => sortBy('name')} className="font-bold">{tr('نام مکان')}{f.sort === 'name' ? (f.order === 'desc' ? ' ↓' : ' ↑') : ''}</button></Th>
                    <Th><button type="button" onClick={() => sortBy('city')} className="font-bold">{tr('شهر')}{f.sort === 'city' ? (f.order === 'desc' ? ' ↓' : ' ↑') : ''}</button></Th>
                    <Th>{tr('نوع / گرید')}</Th><Th>{tr('مخاطب اصلی')}</Th><Th>{tr('پروژه‌ها')}</Th><Th>{tr('کامل بودن')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((v) => (
                    <Tr key={v.id} onClick={() => navigate(`/sites/venues/${v.id}`)}>
                      <Td><span onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={tr('انتخاب {0}', v.name)} checked={selected.has(v.id)} onChange={() => toggle(v.id)} className="size-4 accent-brand-600" /></span></Td>
                      <Td><p className="font-medium text-ink-800">{v.name}</p><span className="text-xs text-ink-500"><Code>{v.code}</Code>{!v.isActive && <> · {tr('غیرفعال')}</>}{v.archivedAt && <> · {tr('بایگانی‌شده')}</>}</span></Td>
                      <Td><span className="text-sm">{v.city}</span><span className="block text-xs text-ink-500">{v.province}</span></Td>
                      <Td><span className="text-xs">{opts.label('VENUE_TYPE', v.typeCode)}</span>{v.gradeCode && <Badge tone="info" className="ms-1">{opts.label('VENUE_GRADE', v.gradeCode)}</Badge>}</Td>
                      <Td><span className="text-xs">{v.primaryContact?.fullName ?? '—'}</span>{v.primaryContact?.phone && <span className="block text-xs text-ink-500 ltr nums">{localDigits(v.primaryContact.phone)}</span>}</Td>
                      <Td><span className="nums text-xs">{localDigits(v.projects)}</span>{v.activeProjects > 0 && <Badge tone="success" className="ms-1">{tr('{0} فعال', localDigits(v.activeProjects))}</Badge>}</Td>
                      <Td><Completeness score={v.completeness.score} missing={v.completeness.missing} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={data.page} pageCount={data.pageCount} total={data.total} onChange={(p) => set({ page: String(p) })} />
            </>
          )}
        </Card>
      </PageBody>
      {creating && <VenueForm onClose={() => { setCreating(false); if (params.get('new')) { const next = new URLSearchParams(params); next.delete('new'); setParams(next, { replace: true }); } }} onSaved={(vid) => navigate(`/sites/venues/${vid}`)} />}
      {texting && <SendSms venueIds={[...selected]} onClose={() => { setTexting(false); setSelected(new Set()); }} />}
    </>
  );
}

export function FilterSelect({ label, value, onChange, options, all }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; all?: string }) {
  return (
    <div className="w-40 shrink-0">
      <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <option value="">{all ?? tr('{0} — همه', label)}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </div>
  );
}

/** A list's filters kept under a name — one's own, or shared with colleagues. */
export function SavedViews({ page, current, onApply }: { page: 'venues' | 'projects' | 'rentals'; current: Record<string, string>; onApply: (filters: Record<string, string>) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const { data } = useQuery<{ id: string; page: string; name: string; filters: Record<string, string>; shared: boolean; userId: string; user: { fullName: string } }[]>({ queryKey: ['/site-saved-views'], queryFn: () => apiGet('/site-saved-views') });
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const views = (data ?? []).filter((v) => v.page === page);
  const filters = Object.fromEntries(Object.entries(current).filter(([k, v]) => v && k !== 'page'));
  const save = async () => {
    try {
      await apiPost('/site-saved-views', { page, name, filters, shared });
      toast(tr('نما ذخیره شد.'));
      setNaming(false); setName('');
      await qc.invalidateQueries({ queryKey: ['/site-saved-views'] });
    } catch (e: any) { toast(e?.message ?? tr('عملیات ناموفق بود.'), 'danger'); }
  };
  if (!views.length && !Object.keys(filters).length) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-ink-500">{tr('نماهای ذخیره‌شده:')}</span>
      {views.map((v) => (
        <span key={v.id} className="inline-flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 ring-1 ring-edge">
          <button type="button" className="font-semibold text-brand-700" onClick={() => onApply(v.filters)}>{v.name}</button>
          {v.shared && <span className="text-ink-400" title={v.user.fullName}>{tr('(مشترک)')}</span>}
          {v.userId === user?.id && (
            <button type="button" aria-label={tr('حذف نمای {0}', v.name)} className="text-ink-400 hover:text-rose-600"
              onClick={async () => { await apiDelete(`/site-saved-views/${v.id}`).catch(() => undefined); await qc.invalidateQueries({ queryKey: ['/site-saved-views'] }); }}>×</button>
          )}
        </span>
      ))}
      {Object.keys(filters).length > 0 && !naming && <Button size="sm" variant="ghost" onClick={() => setNaming(true)}>{tr('ذخیرهٔ همین فیلترها')}</Button>}
      {naming && (
        <span className="inline-flex items-center gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('نام نما')} aria-label={tr('نام نما')} className="w-40 py-1 text-xs" />
          <Checkbox label={tr('مشترک')} checked={shared} onChange={(e) => setShared(e.target.checked)} />
          <Button size="sm" variant="primary" disabled={name.trim().length < 2} onClick={() => void save()}>{tr('ذخیره')}</Button>
        </span>
      )}
    </div>
  );
}

/* ── the form ────────────────────────────────────────────────────────────── */

interface ContactDraft { fullName: string; roleCode: string; phone: string; email: string; isPrimary: boolean; whatsapp: string }
const emptyContact = (roleCode: string, isPrimary = false): ContactDraft => ({ fullName: '', roleCode, phone: '', email: '', isPrimary, whatsapp: '' });

export function VenueForm({ venue, onClose, onSaved }: { venue?: VenueDetail; onClose: () => void; onSaved?: (id: string) => void }) {
  const opts = useSiteOptions();
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState({
    name: venue?.name ?? '', province: venue?.province ?? '', city: venue?.city ?? '', address: venue?.address ?? '',
    typeCode: venue?.typeCode ?? '', gradeCode: venue?.gradeCode ?? '', audienceCodes: venue?.audienceCodes ?? [] as string[],
    phone: venue?.phone ?? '', email: venue?.email ?? '', website: venue?.website ?? '', notes: venue?.notes ?? '', isActive: venue?.isActive ?? true,
  });
  // A new venue's people, typed with it: the managing director, marketing and technical, as the document lists them.
  const [contacts, setContacts] = useState<ContactDraft[]>(venue ? [] : [emptyContact('CEO', true), emptyContact('MARKETING'), emptyContact('TECHNICAL')]);
  const [channels, setChannels] = useState<{ typeCode: string; value: string }[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const up = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }));

  // Possible duplicates, asked as the name, city and phone are typed — before saving, not after.
  useEffect(() => {
    if (v.name.trim().length < 3 || !v.city.trim()) return;
    const t = setTimeout(() => {
      void apiPost<{ candidates: Candidate[] }>('/venues/duplicates', {
        name: v.name, city: v.city, phone: v.phone || null, address: v.address || null, excludeId: venue?.id,
        contactPhones: contacts.map((c) => c.phone).filter(Boolean),
      }).then((r) => setCandidates(r.candidates)).catch(() => undefined);
    }, 500);
    return () => clearTimeout(t);
  }, [v.name, v.city, v.phone, v.address, venue?.id, contacts]);

  const save = async () => {
    setBusy(true); setIssues({});
    try {
      const base = { ...v, gradeCode: blank(v.gradeCode), address: v.address || null, phone: v.phone || null, email: v.email || null, website: v.website || null, notes: v.notes || null, confirmNotDuplicate: confirmed };
      if (venue) {
        await apiPatch(`/venues/${venue.id}`, { ...base, version: venue.version });
        toast(tr('مکان به‌روز شد.'));
        await qc.invalidateQueries();
        onClose();
      } else {
        const made = await apiPost<{ id: string }>('/venues', {
          ...base,
          contacts: contacts.filter((c) => c.fullName.trim()).map((c) => ({
            fullName: c.fullName, roleCode: c.roleCode, phone: c.phone || null, email: c.email || null, isPrimary: c.isPrimary,
            channels: c.whatsapp ? [{ typeCode: 'WHATSAPP', value: c.whatsapp }] : [],
          })),
          channels: channels.filter((c) => c.value.trim()),
        });
        toast(tr('مکان ثبت شد.'));
        await qc.invalidateQueries({ queryKey: ['/venues'] });
        onSaved?.(made.id);
        onClose();
      }
    } catch (e: any) {
      if (e?.code === 'POSSIBLE_DUPLICATE') setCandidates(e.details?.candidates ?? []);
      const list = e?.details?.issues as { path: string; message: string }[] | undefined;
      if (list) setIssues(Object.fromEntries(list.map((i) => [i.path, trx(i.message)])));
      toast(e?.message ?? tr('عملیات ناموفق بود.'), 'danger');
    } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} wide title={venue ? tr('ویرایش مکان {0}', venue.name) : tr('مکان تازه')}
      footer={<><Button onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" loading={busy} disabled={!v.name || !v.province || !v.city || !v.typeCode || (candidates.length > 0 && !confirmed)} onClick={() => void save()}>{tr('ثبت')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('نام مکان')} required error={issues.name}><Input value={v.name} onChange={(e) => up({ name: e.target.value })} /></Field>
        <Field label={tr('نوع مکان')} required error={issues.typeCode}>
          <Select value={v.typeCode} onChange={(e) => up({ typeCode: e.target.value })}><option value="">{tr('— برگزینید —')}</option>{opts.choices('VENUE_TYPE').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
        </Field>
        <Field label={tr('استان')} required error={issues.province}><Input value={v.province} onChange={(e) => up({ province: e.target.value })} /></Field>
        <Field label={tr('شهر')} required error={issues.city}><Input value={v.city} onChange={(e) => up({ city: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label={tr('آدرس')} error={issues.address}><Input value={v.address} onChange={(e) => up({ address: e.target.value })} /></Field></div>
        <Field label={tr('گرید')} error={issues.gradeCode}>
          <Select value={v.gradeCode} onChange={(e) => up({ gradeCode: e.target.value })}><option value="">{tr('— بدون گرید —')}</option>{opts.choices('VENUE_GRADE').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
        </Field>
        <Field label={tr('تلفن')} error={issues.phone}><Input dir="ltr" value={v.phone} onChange={(e) => up({ phone: e.target.value })} /></Field>
        <div className="sm:col-span-2">
          <span className="mb-1 block text-xs font-bold text-ink-700">{tr('مخاطبان مکان')}</span>
          <div className="flex flex-wrap gap-3">
            {opts.choices('AUDIENCE').map((a) => (
              <Checkbox key={a.value} label={a.label} checked={v.audienceCodes.includes(a.value)}
                onChange={(e) => up({ audienceCodes: e.target.checked ? [...v.audienceCodes, a.value] : v.audienceCodes.filter((x) => x !== a.value) })} />
            ))}
          </div>
        </div>
        <Field label={tr('ایمیل')} error={issues.email}><Input dir="ltr" type="email" value={v.email} onChange={(e) => up({ email: e.target.value })} /></Field>
        <Field label={tr('وب‌سایت')}><Input dir="ltr" value={v.website} onChange={(e) => up({ website: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label={tr('یادداشت و مشاهدات')}><Textarea value={v.notes} onChange={(e) => up({ notes: e.target.value })} /></Field></div>
        {venue && <Checkbox label={tr('فعال')} checked={v.isActive} onChange={(e) => up({ isActive: e.target.checked })} />}
      </div>

      {!venue && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between"><h3 className="text-sm font-bold text-ink-800">{tr('افراد مکان')}</h3>
            <Button size="sm" variant="ghost" onClick={() => setContacts((c) => [...c, emptyContact('OTHER')])}><IconPlus className="size-4" />{tr('فرد دیگر')}</Button></div>
          {contacts.map((c, i) => (
            <div key={i} className="grid gap-2 rounded-lg p-2 ring-1 ring-ink-100 sm:grid-cols-6">
              <Select aria-label={tr('سمت')} value={c.roleCode} onChange={(e) => setContacts((cs) => cs.map((x, j) => (j === i ? { ...x, roleCode: e.target.value } : x)))}>
                {opts.choices('CONTACT_ROLE').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
              <Input aria-label={tr('نام')} placeholder={tr('نام')} value={c.fullName} onChange={(e) => setContacts((cs) => cs.map((x, j) => (j === i ? { ...x, fullName: e.target.value } : x)))} className="sm:col-span-2" />
              <Input aria-label={tr('تلفن')} placeholder={tr('تلفن')} dir="ltr" value={c.phone} onChange={(e) => setContacts((cs) => cs.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)))} />
              <Input aria-label={tr('واتس‌اپ')} placeholder={tr('واتس‌اپ')} dir="ltr" value={c.whatsapp} onChange={(e) => setContacts((cs) => cs.map((x, j) => (j === i ? { ...x, whatsapp: e.target.value } : x)))} />
              <Checkbox label={tr('اصلی')} checked={c.isPrimary} onChange={() => setContacts((cs) => cs.map((x, j) => ({ ...x, isPrimary: j === i })))} />
            </div>
          ))}
          <div className="flex items-center justify-between"><h3 className="text-sm font-bold text-ink-800">{tr('راه‌های ارتباطی مکان')}</h3>
            <Button size="sm" variant="ghost" onClick={() => setChannels((c) => [...c, { typeCode: 'EMAIL', value: '' }])}><IconPlus className="size-4" />{tr('راه ارتباطی')}</Button></div>
          {channels.map((c, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-3">
              <Select aria-label={tr('نوع راه ارتباطی')} value={c.typeCode} onChange={(e) => setChannels((cs) => cs.map((x, j) => (j === i ? { ...x, typeCode: e.target.value } : x)))}>{opts.choices('CHANNEL').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
              <Input aria-label={tr('مقدار')} dir="ltr" value={c.value} onChange={(e) => setChannels((cs) => cs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} className="sm:col-span-2" />
            </div>
          ))}
        </div>
      )}

      {candidates.length > 0 && (
        <div role="alert" className="mt-4 rounded-lg bg-amber-50 p-3 text-sm ring-1 ring-amber-200">
          <p className="font-semibold text-amber-900">{tr('این مکان شبیه این مکان‌های ثبت‌شده است:')}</p>
          <ul className="my-2 space-y-1">
            {candidates.map((c) => (
              <li key={c.id}><Link to={`/sites/venues/${c.id}`} target="_blank" className="text-brand-700 underline">{c.name}</Link> — {c.city} <Code>{c.code}</Code>
                <span className="ms-2 text-xs text-amber-800">{c.reasons.map((r) => ({ NAME_CITY: tr('نام و شهر یکسان'), PHONE: tr('تلفن مشترک'), ADDRESS: tr('آدرس یکسان') }[r] ?? r)).join('، ')}</span></li>
            ))}
          </ul>
          <Checkbox label={tr('دیدم؛ این مکان دیگری است و تکراری نیست')} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        </div>
      )}
    </Modal>
  );
}

/* ── the profile ─────────────────────────────────────────────────────────── */

function VenueProfile({ id }: { id: string }) {
  const { can } = useAuth();
  const opts = useSiteOptions();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: v, isLoading, error, refetch } = useQuery<VenueDetail>({ queryKey: ['/venues', id], queryFn: () => apiGet(`/venues/${id}`) });
  const [editing, setEditing] = useState(false);
  const [contact, setContact] = useState<Contact | 'new' | null>(null);
  const [texting, setTexting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [reason, setReason] = useState('');
  const [deciding, setDeciding] = useState<{ c: Candidate; decision: 'MERGE' | 'DISTINCT' } | null>(null);
  const photos = useMemo(() => v?.documents.filter((d) => d.mimeType.startsWith('image/')) ?? [], [v]);
  if (isLoading) return <LoadingBlock />;
  if (error || !v) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try { await fn(); toast(done); await qc.invalidateQueries(); } catch (e: any) { toast(e?.message ?? tr('عملیات ناموفق بود.'), 'danger'); }
  };
  const live = !v.archivedAt && !v.mergedIntoId;

  return (
    <>
      <PageHeader title={v.name} subtitle={<>{opts.label('VENUE_TYPE', v.typeCode)} · {v.city}، {v.province} · <Code>{v.code}</Code></>}
        badge={v.archivedAt ? <StateBadge state="ARCHIVED" /> : !v.isActive ? <Badge>{tr('غیرفعال')}</Badge> : v.gradeCode ? <Badge tone="info">{tr('گرید {0}', opts.label('VENUE_GRADE', v.gradeCode))}</Badge> : undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            {live && can('site.write') && <Link to={`/sites/projects?new=1&venueId=${v.id}`}><Button size="sm" variant="primary">{tr('پروژهٔ تازه در این مکان')}</Button></Link>}
            {live && can('venue.sms') && <Button size="sm" onClick={() => setTexting(true)}>{tr('ارسال پیامک')}</Button>}
            {live && can('venue.write') && <Button size="sm" onClick={() => setEditing(true)}>{tr('ویرایش')}</Button>}
            {live && can('venue.manage') && <Button size="sm" variant="danger" onClick={() => setArchiving(true)}>{tr('بایگانی')}</Button>}
            {v.archivedAt && !v.mergedIntoId && can('venue.manage') && <Button size="sm" onClick={() => void act(() => apiPost(`/venues/${v.id}/restore`), tr('مکان از بایگانی بیرون آمد.'))}>{tr('بازگرداندن')}</Button>}
            <Link to="/sites/venues"><Button size="sm" variant="ghost">{tr('همهٔ مکان‌ها')}</Button></Link>
          </div>
        } />
      <PageBody>
        <SitesNav />
        {v.mergedInto && <div className="mb-4 rounded-lg bg-amber-50 p-3 text-sm ring-1 ring-amber-200">{tr('این رکورد تکراری بود و در «{0}» ادغام شد.', v.mergedInto.name)} <Link className="text-brand-700 underline" to={`/sites/venues/${v.mergedInto.id}`}>{tr('رفتن به مکان اصلی')}</Link></div>}

        {v.duplicates.length > 0 && can('venue.manage') && (
          <Card className="mb-4" title={tr('مکان‌های شبیه این مکان')} subtitle={tr('اگر همین مکان‌اند ادغام کنید؛ اگر نه، جدا نگه دارید تا دوباره پیشنهاد نشوند')}>
            <ul className="divide-y divide-ink-100">
              {v.duplicates.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2 px-5 py-2 text-sm">
                  <Link to={`/sites/venues/${c.id}`} className="font-medium text-brand-700 hover:underline">{c.name}</Link><span className="text-ink-500">{c.city}</span><Code>{c.code}</Code>
                  <span className="text-xs text-ink-500">{c.reasons.map((r) => ({ NAME_CITY: tr('نام و شهر یکسان'), PHONE: tr('تلفن مشترک'), ADDRESS: tr('آدرس یکسان') }[r] ?? r)).join('، ')}</span>
                  <span className="ms-auto flex gap-1">
                    <Button size="sm" onClick={() => setDeciding({ c, decision: 'MERGE' })}>{tr('ادغام در این مکان')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeciding({ c, decision: 'DISTINCT' })}>{tr('مکان دیگری است')}</Button>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <div className="grid gap-5 lg:grid-cols-3">
          <Card title={tr('مشخصات')} className="lg:col-span-1">
            <dl className="divide-y divide-ink-100 px-5">
              <DescRow label={tr('آدرس')}>{v.address ?? '—'}</DescRow>
              <DescRow label={tr('تلفن')}><span dir="ltr" className="nums">{v.phone ? localDigits(v.phone) : '—'}</span></DescRow>
              <DescRow label={tr('ایمیل')}><span dir="ltr">{v.email ?? '—'}</span></DescRow>
              <DescRow label={tr('وب‌سایت')}><span dir="ltr">{v.website ?? '—'}</span></DescRow>
              <DescRow label={tr('مخاطبان')}>{v.audienceCodes.length ? v.audienceCodes.map((a) => <Badge key={a} className="me-1">{opts.label('AUDIENCE', a)}</Badge>) : '—'}</DescRow>
              {v.channels.map((c) => <DescRow key={c.id} label={opts.label('CHANNEL', c.typeCode)}><span dir="ltr">{c.value}</span></DescRow>)}
              <DescRow label={tr('منشأ')}>{v.source === 'IMPORT' ? tr('ورود از اکسل') : tr('ثبت دستی')} · {v.createdBy.fullName} · {formatDate(v.createdAt)}</DescRow>
            </dl>
            <div className="px-5 py-3"><Completeness score={v.completeness.score} missing={v.completeness.missing} />
              {v.completeness.missing.length > 0 && <p className="mt-1 text-xs text-amber-700">{tr('کم دارد: {0}', v.completeness.missing.map(fieldLabel).join('، '))}</p>}</div>
            {v.notes && <p className="whitespace-pre-line border-t border-ink-100 px-5 py-3 text-sm text-ink-700">{v.notes}</p>}
          </Card>

          <Card title={tr('افراد و راه‌های ارتباطی')} className="lg:col-span-2"
            action={live && can('venue.write') ? <Button size="sm" onClick={() => setContact('new')}><IconPlus className="size-4" />{tr('فرد تازه')}</Button> : undefined}>
            {!v.contacts.length ? <EmptyState title={tr('فردی ثبت نشده')} /> : (
              <ul className="divide-y divide-ink-100">
                {v.contacts.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-start gap-3 px-5 py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-ink-800">{c.fullName} {c.isPrimary && <Badge tone="success">{tr('مخاطب اصلی')}</Badge>}</p>
                      <p className="text-xs text-ink-500">{opts.label('CONTACT_ROLE', c.roleCode)}{c.jobTitle && ` · ${c.jobTitle}`}</p>
                      <p className="mt-1 flex flex-wrap gap-3 text-xs">
                        {c.phone && <a href={`tel:${c.phone}`} dir="ltr" className="nums text-brand-700">{localDigits(c.phone)}</a>}
                        {c.email && <a href={`mailto:${c.email}`} dir="ltr" className="text-brand-700">{c.email}</a>}
                        {c.channels.map((ch) => <span key={ch.id}>{opts.label('CHANNEL', ch.typeCode)}: <span dir="ltr">{ch.value}</span></span>)}
                      </p>
                      {c.notes && <p className="mt-1 text-xs text-ink-600">{c.notes}</p>}
                    </div>
                    {live && can('venue.write') && (
                      <span className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setContact(c)}>{tr('ویرایش')}</Button>
                        <Button size="sm" variant="ghost" onClick={() => void act(() => apiPost(`/venue-contacts/${c.id}/archive`), tr('فرد کنار گذاشته شد؛ در سوابق می‌ماند.'))}>{tr('کنار گذاشتن')}</Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card className="mt-5" title={tr('عکس‌ها')} subtitle={tr('ورودی، داخل، محل استقرار — با توضیح و تاریخ')} action={live && can('venue.write') ? <PhotoUpload venueId={v.id} onDone={() => void refetch()} /> : undefined}>
          {!photos.length ? <EmptyState title={tr('عکسی ثبت نشده')} /> : (
            <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 lg:grid-cols-6">
              {photos.map((d) => (
                <figure key={d.id} className="space-y-1">
                  <FilePreview documentId={d.id} mimeType={d.mimeType} />
                  <figcaption className="text-xs text-ink-600"><Badge>{opts.label('PHOTO_CATEGORY', d.category)}</Badge> {d.caption}
                    <span className="block text-ink-400">{d.takenAt ? formatDate(d.takenAt) : formatDate(d.createdAt)}</span></figcaption>
                </figure>
              ))}
            </div>
          )}
        </Card>

        <Card className="mt-5" title={tr('سابقهٔ پروژه‌ها در این مکان')}>
          {!v.siteProjects.length ? <EmptyState title={tr('هنوز پروژه‌ای در این مکان نبوده')} /> : (
            <Table>
              <thead className="bg-ink-50/60"><tr><Th>{tr('پروژه')}</Th><Th>{tr('وضعیت')}</Th><Th>{tr('محل استقرار')}</Th><Th>{tr('دورهٔ قرارداد')}</Th><Th>{tr('مسئول')}</Th>{v.outstanding && <Th>{tr('مانده')}</Th>}</tr></thead>
              <tbody>
                {v.siteProjects.map((p) => (
                  <Tr key={p.id}>
                    <Td><Link to={`/sites/projects/${p.id}`} className="font-medium text-brand-700 hover:underline">{p.name}</Link> <Code>{p.code}</Code></Td>
                    <Td><StateBadge state={p.state} /></Td><Td>{p.placement ?? '—'}</Td>
                    <Td><span className="text-xs">{p.contractStart ? `${formatDate(p.contractStart)} — ${formatDate(p.contractEnd)}` : '—'}</span></Td>
                    <Td>{p.responsible?.fullName ?? '—'}</Td>
                    {v.outstanding && <Td>{v.outstanding.filter((o) => o.siteProjectId === p.id).map((o) => <Money key={o.currency} value={o.amount} currency={o.currency} />)}</Td>}
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        {v.messages && (
          <Card className="mt-5" title={tr('پیامک‌های فرستاده‌شده')}>
            {!v.messages.length ? <EmptyState title={tr('پیامکی فرستاده نشده')} /> : (
              <ul className="divide-y divide-ink-100">
                {v.messages.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-start gap-2 px-5 py-2 text-xs">
                    <StateBadge state={m.status} /><span dir="ltr" className="nums">{localDigits(m.phone)}</span>
                    <span className="min-w-0 flex-1 text-ink-700">{m.text}{m.error && <span className="block text-rose-700">{trx(m.error)}</span>}</span>
                    <span className="text-ink-400">{m.sentBy?.fullName} · {formatRelative(m.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        {v.mergedFrom.length > 0 && <p className="mt-3 text-xs text-ink-500">{tr('ادغام‌شده در این مکان: {0}', v.mergedFrom.map((m) => `${m.name} (${m.code})`).join('، '))}</p>}
      </PageBody>

      {editing && <VenueForm venue={v} onClose={() => setEditing(false)} />}
      {contact && <ContactForm venueId={v.id} contact={contact === 'new' ? null : contact} onClose={() => setContact(null)} />}
      {texting && <SendSms venueIds={[v.id]} onClose={() => setTexting(false)} />}
      <Modal open={archiving} onClose={() => setArchiving(false)} title={tr('بایگانی {0}', v.name)}
        footer={<><Button onClick={() => setArchiving(false)}>{tr('انصراف')}</Button><Button variant="danger" disabled={reason.trim().length < 3} onClick={() => void act(() => apiPost(`/venues/${v.id}/archive`, { reason }), tr('مکان بایگانی شد.')).then(() => setArchiving(false))}>{tr('بایگانی')}</Button></>}>
        <p className="mb-2 text-sm text-ink-600">{tr('مکان بایگانی‌شده از فهرست‌ها بیرون می‌رود و سوابقش می‌ماند. مکانی که پروژهٔ جاری دارد بایگانی نمی‌شود.')}</p>
        <Field label={tr('دلیل')} required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
      {deciding && <DuplicateDecision venue={v} candidate={deciding.c} decision={deciding.decision} onClose={() => setDeciding(null)} />}
    </>
  );
}

function DuplicateDecision({ venue, candidate, decision, onClose }: { venue: VenueDetail; candidate: Candidate; decision: 'MERGE' | 'DISTINCT'; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const toast = useToast();
  const qc = useQueryClient();
  const go = async () => {
    try {
      await apiPost(`/venues/${venue.id}/duplicates/decision`, { otherId: candidate.id, decision, reason });
      toast(decision === 'MERGE' ? tr('«{0}» در این مکان ادغام شد.', candidate.name) : tr('دو مکان جدا ماندند.'));
      await qc.invalidateQueries(); onClose();
    } catch (e: any) { toast(e?.message ?? tr('عملیات ناموفق بود.'), 'danger'); }
  };
  return (
    <Modal open onClose={onClose} title={decision === 'MERGE' ? tr('ادغام «{0}» در «{1}»', candidate.name, venue.name) : tr('«{0}» مکان دیگری است', candidate.name)}
      footer={<><Button onClick={onClose}>{tr('انصراف')}</Button><Button variant={decision === 'MERGE' ? 'danger' : 'primary'} disabled={reason.trim().length < 3} onClick={() => void go()}>{tr('ثبت تصمیم')}</Button></>}>
      <p className="mb-2 text-sm text-ink-600">{decision === 'MERGE'
        ? tr('افراد، راه‌های ارتباطی، عکس‌ها، پروژه‌ها و پیامک‌های آن مکان به این مکان می‌آیند و آن رکورد بایگانی می‌شود و به این مکان اشاره می‌کند. آنچه این مکان ندارد از آن پر می‌شود؛ چیزی بازنویسی نمی‌شود.')
        : tr('دو مکان جدا می‌مانند و دیگر تکراریِ هم پیشنهاد نمی‌شوند.')}</p>
      <Field label={tr('دلیل')} required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}

function ContactForm({ venueId, contact, onClose }: { venueId: string; contact: Contact | null; onClose: () => void }) {
  const opts = useSiteOptions();
  const toast = useToast();
  const qc = useQueryClient();
  const [c, setC] = useState({ fullName: contact?.fullName ?? '', roleCode: contact?.roleCode ?? 'OTHER', jobTitle: contact?.jobTitle ?? '', phone: contact?.phone ?? '', email: contact?.email ?? '', notes: contact?.notes ?? '', isPrimary: contact?.isPrimary ?? false });
  const [channel, setChannel] = useState({ typeCode: 'WHATSAPP', value: '' });
  const save = async () => {
    try {
      const body = { ...c, jobTitle: c.jobTitle || null, phone: c.phone || null, email: c.email || null, notes: c.notes || null };
      if (contact) {
        await apiPatch(`/venue-contacts/${contact.id}`, body);
        if (channel.value.trim()) await apiPost(`/venues/${venueId}/channels`, { ...channel, contactId: contact.id });
      } else {
        await apiPost(`/venues/${venueId}/contacts`, { ...body, channels: channel.value.trim() ? [channel] : [] });
      }
      toast(tr('ثبت شد.')); await qc.invalidateQueries(); onClose();
    } catch (e: any) { toast(e?.message ?? tr('عملیات ناموفق بود.'), 'danger'); }
  };
  return (
    <Modal open onClose={onClose} title={contact ? tr('ویرایش {0}', contact.fullName) : tr('فرد تازه در مکان')}
      footer={<><Button onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" disabled={c.fullName.trim().length < 2} onClick={() => void save()}>{tr('ثبت')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('نام و نام خانوادگی')} required><Input value={c.fullName} onChange={(e) => setC({ ...c, fullName: e.target.value })} /></Field>
        <Field label={tr('سمت')} required><Select value={c.roleCode} onChange={(e) => setC({ ...c, roleCode: e.target.value })}>{opts.choices('CONTACT_ROLE').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
        <Field label={tr('عنوان شغلی')}><Input value={c.jobTitle} onChange={(e) => setC({ ...c, jobTitle: e.target.value })} /></Field>
        <Field label={tr('تلفن')}><Input dir="ltr" value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} /></Field>
        <Field label={tr('ایمیل')}><Input dir="ltr" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} /></Field>
        <Field label={tr('راه ارتباطی دیگر')}>
          <div className="flex gap-2">
            <Select aria-label={tr('نوع راه ارتباطی')} value={channel.typeCode} onChange={(e) => setChannel({ ...channel, typeCode: e.target.value })} className="w-32">{opts.choices('CHANNEL').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
            <Input aria-label={tr('مقدار')} dir="ltr" value={channel.value} onChange={(e) => setChannel({ ...channel, value: e.target.value })} />
          </div>
        </Field>
        <div className="sm:col-span-2"><Field label={tr('یادداشت')}><Textarea value={c.notes} onChange={(e) => setC({ ...c, notes: e.target.value })} /></Field></div>
        <Checkbox label={tr('مخاطب اصلی مکان')} checked={c.isPrimary} onChange={(e) => setC({ ...c, isPrimary: e.target.checked })} />
      </div>
    </Modal>
  );
}

function PhotoUpload({ venueId, onDone }: { venueId: string; onDone: () => void }) {
  const opts = useSiteOptions();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [category, setCategory] = useState('ENTRANCE');
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      for (const file of files) {
        const form = new FormData();
        form.append('venueId', venueId); form.append('category', category);
        if (caption) form.append('caption', caption);
        form.append('file', file);
        await apiUpload('/documents', form);
      }
      toast(tr('{0} عکس افزوده شد.', localDigits(files.length)));
      setOpen(false); setFiles([]); setCaption(''); onDone();
    } catch (e: any) { toast(e?.message ?? tr('عملیات ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><IconPlus className="size-4" />{tr('افزودن عکس')}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={tr('افزودن عکس مکان')}
        footer={<><Button onClick={() => setOpen(false)}>{tr('انصراف')}</Button><Button variant="primary" loading={busy} disabled={!files.length} onClick={() => void send()}>{tr('بارگذاری')}</Button></>}>
        <div className="space-y-3">
          <Field label={tr('عکس‌ها')} required><Input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} /></Field>
          <Field label={tr('دستهٔ عکس')}><Select value={category} onChange={(e) => setCategory(e.target.value)}>{opts.choices('PHOTO_CATEGORY').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
          <Field label={tr('توضیح')}><Input value={caption} onChange={(e) => setCaption(e.target.value)} /></Field>
        </div>
      </Modal>
    </>
  );
}
