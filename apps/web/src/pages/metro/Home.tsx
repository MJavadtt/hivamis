import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { METRO_CITIES, METRO_CITY_LABELS, type MetroCity } from '@hiva/contracts';
import { apiGet, apiPatch, apiPost } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDate, localDigits } from '../../lib/format';
import { PageBody, PageHeader } from '../../components/Shell';
import { Button, Card, EmptyState, ErrorBlock, Field, Input, LoadingBlock, Modal, Select, Textarea, useToast } from '../../components/ui';
import { Money } from '../sites/shared';
import { pair, tr } from '../../i18n';
import { BookingState, LineChip, MetroNav, kindFa, type Line } from './shared';
import { MetroIntro } from './Intro';

interface Overview {
  lines: Line[]; counts: { lines: number; stations: number; trains: number; wagons: number };
  capacity: { kind: string; units: number; takenToday: number }[];
  bookings: Record<string, { count: number; amount: number }>;
  money: { billed: number; paid: number; outstanding: number };
  endingSoon: { id: string; code: string; title: string | null; client: string | null; endDate: string; state: string }[];
  settings: { endingSoonDays: number; holdDays: number };
}

/** The metro at a glance (ADR-135): its lines, what it can carry and what is sold today, money, what ends soon. */
export default function MetroHome() {
  const { can } = useAuth();
  const { data, isLoading, error, refetch } = useQuery<Overview>({ queryKey: ['/metro/overview'], queryFn: () => apiGet('/metro/overview') });
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHeader title={tr('تبلیغات مترو')} subtitle={tr('خطوط و ایستگاه‌ها، قطارها و واگن‌ها، و فضاهای بدنه، کتیبه و دستگیره — با رزرو، مبلغ، یادآوری و گزارش')}
        actions={can('metro.book') ? <Link to="/metro/bookings?new=1"><Button variant="primary">{tr('+ رزرو تازه')}</Button></Link> : undefined} />
      <PageBody>
        <MetroNav />
        {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={() => void refetch()} /> : data && (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[[tr('خط'), data.counts.lines], [tr('ایستگاه'), data.counts.stations], [tr('قطار'), data.counts.trains], [tr('واگن'), data.counts.wagons]].map(([l, n]) => (
                <Card key={String(l)}><div className="p-4"><p className="text-xs text-ink-500">{l}</p><p className="text-2xl font-bold text-ink-900 nums">{localDigits(Number(n))}</p></div></Card>
              ))}
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <Card title={tr('ظرفیت و فروش امروز')}>
                <ul className="divide-y divide-ink-100" data-testid="metro-capacity">
                  {data.capacity.map((c) => (
                    <li key={c.kind} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                      <span className="w-20 font-semibold text-ink-800">{kindFa(c.kind)}</span>
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100"><span className="block h-full bg-brand-500" style={{ width: `${c.units ? Math.round((100 * c.takenToday) / c.units) : 0}%` }} /></span>
                      <span className="text-xs text-ink-600 nums">{tr('{0} از {1}', localDigits(c.takenToday), localDigits(c.units))}</span>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card title={tr('مبلغ رزروها')}>
                <div className="grid grid-cols-3 gap-2 p-4 text-sm">
                  <div><p className="text-xs text-ink-500">{tr('کل')}</p><Money value={data.money.billed} /></div>
                  <div><p className="text-xs text-ink-500">{tr('دریافت‌شده')}</p><Money value={data.money.paid} tone="success" /></div>
                  <div><p className="text-xs text-ink-500">{tr('مانده')}</p><Money value={data.money.outstanding} tone={data.money.outstanding > 0 ? 'danger' : 'muted'} /></div>
                </div>
              </Card>
            </div>
            <Card title={tr('خطوط')} action={can('metro.write') ? <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>{tr('+ خط تازه')}</Button> : undefined}>
              {!data.lines.length ? <EmptyState title={tr('خطی ثبت نشده است')} /> : (
                <ul className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="metro-lines">
                  {data.lines.map((l) => (
                    <li key={l.id}>
                      <Link to={`/metro/lines/${l.id}`} className="flex items-center justify-between rounded-lg px-3 py-2.5 ring-1 ring-ink-200 hover:bg-ink-50">
                        <LineChip line={l} />
                        <span className="text-xs text-ink-500">{tr('{0} ایستگاه، {1} قطار', localDigits(l.stations), localDigits(l.trains))}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title={tr('رزروهایی که تا {0} روز دیگر تمام می‌شوند', localDigits(data.settings.endingSoonDays))}>
              {!data.endingSoon.length ? <EmptyState title={tr('رزروی به پایان نزدیک نیست')} /> : (
                <ul className="divide-y divide-ink-100">
                  {data.endingSoon.map((b) => (
                    <li key={b.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                      <Link to={`/metro/bookings/${b.id}`} className="font-semibold text-brand-700 hover:underline">{b.code}</Link>
                      <span>{b.title ?? b.client}</span><BookingState state={b.state} />
                      <span className="ms-auto text-xs text-ink-500">{tr('پایان: {0}', formatDate(b.endDate))}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
        {adding && <LineEditor onClose={() => setAdding(false)} />}
        <MetroIntro />
      </PageBody>
    </>
  );
}

export function LineEditor({ line, onClose }: { line?: Line; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ number: String(line?.number ?? ''), nameFa: line?.nameFa ?? '', nameEn: line?.nameEn ?? '', city: line?.city ?? 'TEHRAN', color: line?.color ?? '#64748b', notes: line?.notes ?? '' });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...f, number: Number(f.number), notes: f.notes || null };
      if (line) await apiPatch(`/metro/lines/${line.id}`, body); else await apiPost('/metro/lines', body);
      toast(tr('خط ذخیره شد.'));
      await qc.invalidateQueries();
      onClose();
    } catch (e: any) { toast(e?.message ?? tr('ذخیره ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open title={line ? tr('ویرایش {0}', line.nameFa) : tr('خط تازه')} onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
      <Button variant="primary" loading={busy} disabled={!f.number || f.nameFa.trim().length < 2} onClick={() => void save()}>{tr('ذخیره')}</Button>
    </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('شمارهٔ خط')} required><Input value={f.number} onChange={(e) => set('number', e.target.value)} inputMode="numeric" className="ltr" /></Field>
        <Field label={tr('شهر')}><Select value={f.city} onChange={(e) => set('city', e.target.value)}>{METRO_CITIES.map((c) => <option key={c} value={c}>{pair(METRO_CITY_LABELS[c as MetroCity])}</option>)}</Select></Field>
        <Field label={tr('نام فارسی')} required><Input value={f.nameFa} onChange={(e) => set('nameFa', e.target.value)} /></Field>
        <Field label={tr('نام انگلیسی')}><Input value={f.nameEn} onChange={(e) => set('nameEn', e.target.value)} className="ltr" /></Field>
        <Field label={tr('رنگ')}><input type="color" value={f.color} onChange={(e) => set('color', e.target.value)} className="h-9 w-20 rounded" aria-label={tr('رنگ')} /></Field>
        <div className="sm:col-span-2"><Field label={tr('یادداشت')}><Textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} rows={2} /></Field></div>
      </div>
    </Modal>
  );
}
