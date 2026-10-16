import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RESOURCE_FEATURES, RESOURCE_FEATURE_LABELS, RESOURCE_TYPES, RESOURCE_TYPE_LABELS, type ResourceFeature, type ResourceType,
} from '@hiva/contracts';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatCurrency, localDigits, sep } from '../lib/format';
import { PageBody, PageHeader } from '../components/Shell';
import { Badge, Button, Card, EmptyState, Field, Input, LoadingBlock, Modal, ProgressBar, Select, Table, Tabs, Td, Th, Tr, cx, useToast } from '../components/ui';
import { isEnglish, tr } from '../i18n';

/**
 * Running the rooms (audit F-9, step 4): the meeting platform's admin panel, as a Hivamis page in both
 * languages. Rooms, equipment, parking and vehicles, and where they are; the catering a booking can
 * ask for; and how the rooms are used.
 */

interface Location { id: string; name: string; kind: 'INSIDE' | 'OUTSIDE'; building: string | null; isActive: boolean }
interface Resource {
  id: string; type: ResourceType; name: string; description: string | null; capacity: number; floor: string | null;
  features: ResourceFeature[]; isActive: boolean; location: { id: string; name: string } | null;
}
interface Catering { id: string; labelFa: string; labelEn: string; unitPrice: string; isActive: boolean }
interface Analytics {
  workingHoursPerRoom: number;
  bookings: { total: number; byState: Record<string, number> };
  rooms: { id: string; name: string; capacity: number; isActive: boolean; meetings: number; hours: number; utilization: number }[];
  startsByHour: number[];
  catering: { labelFa: string; labelEn: string; quantity: number; cost: number }[];
}

const typeLabel = (t: ResourceType) => (isEnglish() ? RESOURCE_TYPE_LABELS[t].en : RESOURCE_TYPE_LABELS[t].fa);
const featureLabel = (f: ResourceFeature) => (isEnglish() ? RESOURCE_FEATURE_LABELS[f].en : RESOURCE_FEATURE_LABELS[f].fa);

export default function BookingAdmin() {
  const { can } = useAuth();
  const manages = can('resource.manage');
  const [chosen, setTab] = useState<string | null>(null);
  // Until someone picks a tab: rooms for whoever manages them, the report for whoever only oversees.
  const tab = chosen ?? (manages ? 'resources' : 'report');
  const tabs = [
    ...(manages ? [{ key: 'resources', label: tr('اتاق‌ها و منابع') }, { key: 'catering', label: tr('پذیرایی') }] : []),
    { key: 'report', label: tr('گزارش استفاده') },
  ];
  return (
    <>
      <PageHeader title={tr('مدیریت رزرو')} subtitle={tr('اتاق‌ها، تجهیزات، پارکینگ، پذیرایی — و این‌که چگونه به کار می‌روند')} />
      <PageBody>
        <div className="space-y-4" data-testid="booking-admin">
          <Tabs tabs={tabs} active={tab} onChange={setTab} />
          {tab === 'resources' && <Resources />}
          {tab === 'catering' && <CateringOptions />}
          {tab === 'report' && <Report />}
        </div>
      </PageBody>
    </>
  );
}

/* ── rooms and things ─────────────────────────────────────────────────────── */

function Resources() {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Resource | 'new' | null>(null);
  const { data: resources, isLoading } = useQuery<Resource[]>({ queryKey: ['/booking/resources', 'all'], queryFn: () => apiGet('/booking/resources', { all: 'true' }) });
  const { data: locations } = useQuery<Location[]>({ queryKey: ['/booking/locations'], queryFn: () => apiGet('/booking/locations') });
  const toggle = async (r: Resource) => {
    try { await apiPatch(`/booking/resources/${r.id}`, { isActive: !r.isActive }); await qc.invalidateQueries({ queryKey: ['/booking/resources'] }); }
    catch (e) { toast((e as Error).message, 'danger'); }
  };
  return (
    <div className="space-y-4">
      <Card title={tr('اتاق‌ها، تجهیزات، پارکینگ و خودروها')} action={<Button size="sm" variant="primary" onClick={() => setEditing('new')}>{tr('افزودن')}</Button>}>
        {isLoading ? <LoadingBlock /> : !resources?.length ? <EmptyState title={tr('هنوز چیزی برای رزرو نیست')} description={tr('نخست اتاق‌های جلسه را بیفزایید.')} /> : (
          <Table>
            <thead><tr><Th>{tr('نام')}</Th><Th>{tr('نوع')}</Th><Th>{tr('ظرفیت')}</Th><Th>{tr('مکان')}</Th><Th>{tr('امکانات')}</Th><Th>{tr('وضعیت')}</Th><Th /></tr></thead>
            <tbody data-testid="resources">
              {resources.map((r) => (
                <Tr key={r.id}>
                  <Td className="font-medium text-ink-800">{r.name}</Td>
                  <Td>{typeLabel(r.type)}</Td>
                  <Td>{localDigits(r.capacity)}</Td>
                  <Td>{[r.location?.name, r.floor && tr('طبقهٔ {0}', r.floor)].filter(Boolean).join(sep()) || '—'}</Td>
                  <Td className="text-xs">{r.features.map(featureLabel).join('، ') || '—'}</Td>
                  <Td>{r.isActive ? <Badge tone="success">{tr('فعال')}</Badge> : <Badge tone="neutral">{tr('غیرفعال')}</Badge>}</Td>
                  <Td className="whitespace-nowrap text-end">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>{tr('ویرایش')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => void toggle(r)}>{r.isActive ? tr('غیرفعال کردن') : tr('فعال کردن')}</Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Locations locations={locations ?? []} />
      {editing && <ResourceEditor resource={editing === 'new' ? null : editing} locations={locations ?? []} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ResourceEditor({ resource, locations, onClose }: { resource: Resource | null; locations: Location[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState<ResourceType>(resource?.type ?? 'ROOM');
  const [name, setName] = useState(resource?.name ?? '');
  const [capacity, setCapacity] = useState(resource?.capacity ?? 6);
  const [floor, setFloor] = useState(resource?.floor ?? '');
  const [locationId, setLocationId] = useState(resource?.location?.id ?? '');
  const [features, setFeatures] = useState<ResourceFeature[]>(resource?.features ?? []);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const body = { type, name: name.trim(), capacity, floor: floor.trim() || undefined, locationId: locationId || null, features };
    try {
      if (resource) await apiPatch(`/booking/resources/${resource.id}`, body); else await apiPost('/booking/resources', body);
      toast(tr('ذخیره شد.'));
      await qc.invalidateQueries({ queryKey: ['/booking/resources'] });
      onClose();
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open title={resource ? tr('ویرایش {0}', resource.name) : tr('افزودن منبع')} onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
      <Button variant="primary" loading={busy} disabled={name.trim().length < 2} onClick={() => void save()}>{tr('ذخیره')}</Button>
    </>}>
      <div className="space-y-3" data-testid="resource-editor">
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('نوع')}>
            <Select value={type} onChange={(e) => setType(e.target.value as ResourceType)}>
              {RESOURCE_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
            </Select>
          </Field>
          <Field label={type === 'PARKING' ? tr('جای پارک') : type === 'ROOM' ? tr('صندلی') : tr('ظرفیت')}>
            <Input type="number" min={type === 'PARKING' ? 1 : 0} value={capacity} onChange={(e) => setCapacity(Math.max(0, Number(e.target.value) || 0))} />
          </Field>
        </div>
        <Field label={tr('نام')} required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('مکان')}>
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">—</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
          <Field label={tr('طبقه')}><Input value={floor} onChange={(e) => setFloor(e.target.value)} /></Field>
        </div>
        {type === 'ROOM' && (
          <fieldset>
            <legend className="mb-1 text-xs font-bold text-ink-700">{tr('امکانات')}</legend>
            <div className="flex flex-wrap gap-1.5">
              {RESOURCE_FEATURES.map((f) => {
                const on = features.includes(f);
                return <button key={f} type="button" aria-pressed={on} onClick={() => setFeatures(on ? features.filter((x) => x !== f) : [...features, f])}
                  className={cx('rounded-full px-2.5 py-1 text-xs ring-1 ring-inset', on ? 'bg-brand-50 text-brand-700 ring-brand-200' : 'text-ink-600 ring-ink-200')}>{featureLabel(f)}</button>;
              })}
            </div>
          </fieldset>
        )}
      </div>
    </Modal>
  );
}

function Locations({ locations }: { locations: Location[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const add = async () => {
    try { await apiPost('/booking/locations', { name: name.trim() }); setName(''); await qc.invalidateQueries({ queryKey: ['/booking/locations'] }); }
    catch (e) { toast((e as Error).message, 'danger'); }
  };
  return (
    <Card title={tr('مکان‌ها')} subtitle={tr('ساختمان‌ها یا دفترهایی که اتاق‌ها در آن‌اند.')}>
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap gap-1.5">{locations.length ? locations.map((l) => <Badge key={l.id} tone="info">{l.name}</Badge>) : <span className="text-xs text-ink-500">{tr('هنوز مکانی نیست.')}</span>}</div>
        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('نام مکان')} aria-label={tr('نام مکان')} />
          <Button size="sm" disabled={name.trim().length < 2} onClick={() => void add()}>{tr('افزودن مکان')}</Button>
        </div>
      </div>
    </Card>
  );
}

/* ── catering ─────────────────────────────────────────────────────────────── */

function CateringOptions() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery<Catering[]>({ queryKey: ['/booking/catering', 'all'], queryFn: () => apiGet('/booking/catering', { all: 'true' }) });
  const [labelFa, setLabelFa] = useState('');
  const [labelEn, setLabelEn] = useState('');
  const [price, setPrice] = useState(0);
  const refresh = () => qc.invalidateQueries({ queryKey: ['/booking/catering'] });
  const add = async () => {
    try { await apiPost('/booking/catering', { labelFa: labelFa.trim(), labelEn: labelEn.trim(), unitPrice: price }); setLabelFa(''); setLabelEn(''); setPrice(0); await refresh(); }
    catch (e) { toast((e as Error).message, 'danger'); }
  };
  const toggle = async (c: Catering) => {
    try { await apiPatch(`/booking/catering/${c.id}`, { isActive: !c.isActive }); await refresh(); } catch (e) { toast((e as Error).message, 'danger'); }
  };
  return (
    <Card title={tr('گزینه‌های پذیرایی')} subtitle={tr('آنچه برگزارکننده می‌تواند برای جلسه بخواهد، با بهای هر واحد.')}>
      {isLoading ? <LoadingBlock /> : (
        <Table>
          <thead><tr><Th>{tr('نام فارسی')}</Th><Th>{tr('نام انگلیسی')}</Th><Th>{tr('بهای واحد')}</Th><Th>{tr('وضعیت')}</Th><Th /></tr></thead>
          <tbody data-testid="catering">
            {data?.map((c) => (
              <Tr key={c.id}>
                <Td>{c.labelFa}</Td><Td className="ltr">{c.labelEn}</Td><Td>{formatCurrency(c.unitPrice, false)}</Td>
                <Td>{c.isActive ? <Badge tone="success">{tr('فعال')}</Badge> : <Badge tone="neutral">{tr('غیرفعال')}</Badge>}</Td>
                <Td className="text-end"><Button size="sm" variant="ghost" onClick={() => void toggle(c)}>{c.isActive ? tr('غیرفعال کردن') : tr('فعال کردن')}</Button></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <div className="grid gap-2 border-t border-ink-100 p-4 sm:grid-cols-4">
        <Input value={labelFa} onChange={(e) => setLabelFa(e.target.value)} placeholder={tr('نام فارسی')} aria-label={tr('نام فارسی')} />
        <Input value={labelEn} onChange={(e) => setLabelEn(e.target.value)} placeholder="English name" aria-label={tr('نام انگلیسی')} className="ltr" />
        <Input type="number" min={0} value={price} onChange={(e) => setPrice(Math.max(0, Number(e.target.value) || 0))} aria-label={tr('بهای واحد')} />
        <Button disabled={labelFa.trim().length < 2 || labelEn.trim().length < 2} onClick={() => void add()}>{tr('افزودن')}</Button>
      </div>
    </Card>
  );
}

/* ── how the rooms are used ───────────────────────────────────────────────── */

const SPANS: Record<string, { label: () => string; days: number }> = {
  week: { label: () => tr('هفتهٔ پیش رو'), days: 7 },
  month: { label: () => tr('سی روز گذشته'), days: -30 },
  quarter: { label: () => tr('نود روز گذشته'), days: -90 },
};

function Report() {
  const [span, setSpan] = useState('week');
  const days = SPANS[span]!.days;
  const now = new Date();
  const range = days > 0
    ? { from: now.toISOString(), to: new Date(now.getTime() + days * 86_400_000).toISOString() }
    : { from: new Date(now.getTime() + days * 86_400_000).toISOString(), to: now.toISOString() };
  const { data, isLoading } = useQuery<Analytics>({ queryKey: ['/booking/analytics', span], queryFn: () => apiGet('/booking/analytics', range) });
  const peak = Math.max(1, ...(data?.startsByHour ?? [0]));
  const counted = ['CONFIRMED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'PENDING_APPROVAL'];
  return (
    <div className="space-y-4" data-testid="booking-report">
      <div className="w-56"><Select value={span} onChange={(e) => setSpan(e.target.value)} aria-label={tr('بازه')}>{Object.entries(SPANS).map(([k, s]) => <option key={k} value={k}>{s.label()}</option>)}</Select></div>
      {isLoading || !data ? <LoadingBlock /> : (
        <>
          <Card title={tr('رزروها')}>
            <div className="flex flex-wrap gap-4 p-4 text-sm">
              <span>{tr('همه: {0}', localDigits(data.bookings.total))}</span>
              {counted.map((s) => <span key={s} className="text-ink-600">{STATE_NAME[s]!()}: {localDigits(data.bookings.byState[s] ?? 0)}</span>)}
            </div>
          </Card>
          <Card title={tr('استفاده از اتاق‌ها')} subtitle={tr('ساعت‌های رزروشده در برابر {0} ساعت کاری هر اتاق در این بازه', localDigits(data.workingHoursPerRoom))}>
            <ul className="divide-y divide-ink-100" data-testid="room-use">
              {data.rooms.map((r) => (
                <li key={r.id} className="space-y-1 px-4 py-2.5">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="flex-1 font-medium text-ink-800">{r.name}</span>
                    <span className="text-xs text-ink-500">{tr('{0} جلسه، {1} ساعت، {2}٪', localDigits(r.meetings), localDigits(r.hours), localDigits(r.utilization))}</span>
                  </div>
                  <ProgressBar value={Math.min(r.utilization, 100)} tone={r.utilization > 80 ? 'warning' : 'progress'} />
                </li>
              ))}
            </ul>
          </Card>
          <Card title={tr('ساعت آغاز جلسه‌ها')}>
            <div className="flex h-32 items-end gap-1 px-4 pb-2 pt-4 ltr" aria-label={tr('شمار جلسه‌ها بر پایهٔ ساعت آغاز')}>
              {data.startsByHour.map((n, h) => (
                <div key={h} className="flex flex-1 flex-col items-center gap-1" title={tr('ساعت {0}: {1} جلسه', localDigits(h), localDigits(n))}>
                  <div className="w-full rounded-t bg-brand-400" style={{ height: `${(n / peak) * 96}px` }} />
                  {h % 3 === 0 && <span className="text-[12px] text-ink-400">{localDigits(h)}</span>}
                </div>
              ))}
            </div>
          </Card>
          {data.catering.length > 0 && (
            <Card title={tr('پذیرایی سفارش‌داده‌شده')}>
              <ul className="divide-y divide-ink-100 text-sm">
                {data.catering.map((c) => (
                  <li key={c.labelFa} className="flex gap-2 px-4 py-2"><span className="flex-1">{isEnglish() ? c.labelEn : c.labelFa}</span><span>× {localDigits(c.quantity)}</span><span className="w-32 text-end text-ink-600">{formatCurrency(c.cost, false)}</span></li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

const STATE_NAME: Record<string, () => string> = {
  CONFIRMED: () => tr('قطعی'), COMPLETED: () => tr('برگزارشده'), CANCELLED: () => tr('لغوشده'), REJECTED: () => tr('ردشده'), PENDING_APPROVAL: () => tr('در انتظار تأیید'),
};
