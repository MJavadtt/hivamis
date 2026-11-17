import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { METRO_SPACE_KINDS, METRO_WAGON_TEMPLATE, type MetroSpaceKind } from '@hiva/contracts';
import { apiDelete, apiGet, apiPatch, apiPost } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { localDigits } from '../../lib/format';
import { PageBody, PageHeader } from '../../components/Shell';
import { AttachButton, onRecord } from '../../components/RecordFiles';
import { Badge, Button, Card, EmptyState, ErrorBlock, Field, Input, LoadingBlock, Modal, Select, Textarea, cx, useToast } from '../../components/ui';
import { Money } from '../sites/shared';
import { tr } from '../../i18n';
import { LineEditor } from './Home';
import { LineChip, MetroNav, kindFa, type Line, type Space, type Station, type Train, type Wagon } from './shared';

interface LineDetail extends Omit<Line, 'stations' | 'trains'> { stations: Station[]; trains: Train[] }

/** One line (ADR-135): its stations, and its trains, wagons and spaces — each added, edited and deleted here. */
export default function MetroLinePage() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery<LineDetail>({ queryKey: ['/metro/lines', id], queryFn: () => apiGet(`/metro/lines/${id}`) });
  const [tab, setTab] = useState<'trains' | 'stations'>('trains');
  const [editing, setEditing] = useState(false);
  const write = can('metro.write');
  const refresh = () => qc.invalidateQueries();
  const remove = async (path: string, what: string, after?: () => void) => {
    if (!window.confirm(tr('«{0}» برای همیشه حذف شود؟', what))) return;
    try { await apiDelete(path); toast(tr('حذف شد.')); await refresh(); after?.(); } catch (e: any) { toast(e?.message ?? tr('حذف ناموفق بود.'), 'danger'); }
  };
  if (isLoading) return <PageBody><LoadingBlock /></PageBody>;
  if (error || !data) return <PageBody><ErrorBlock error={error} onRetry={() => void refetch()} /></PageBody>;
  const units = (k: MetroSpaceKind) => data.trains.reduce((s, t) => s + t.wagons.reduce((w, wg) => w + wg.spaces.filter((x) => x.kind === k).reduce((q, x) => q + x.quantity, 0), 0), 0);
  return (
    <>
      <PageHeader title={data.nameFa} subtitle={data.notes ?? tr('ایستگاه‌ها، قطارها، واگن‌ها و فضاهای تبلیغاتی این خط')}
        actions={write ? <div className="flex gap-1.5">
          <Button variant="ghost" onClick={() => setEditing(true)}>{tr('ویرایش خط')}</Button>
          <Button variant="ghost" onClick={() => void remove(`/metro/lines/${data.id}`, data.nameFa, () => navigate('/metro'))}><span className="text-rose-700">{tr('حذف خط')}</span></Button>
        </div> : undefined} />
      <PageBody>
        <MetroNav />
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <LineChip line={data} />
          {METRO_SPACE_KINDS.map((k) => <Badge key={k}>{tr('{0}: {1} واحد', kindFa(k), localDigits(units(k)))}</Badge>)}
        </div>
        <div className="mb-3 flex gap-1" role="tablist">
          {(['trains', 'stations'] as const).map((t) => (
            <Button key={t} size="sm" variant={tab === t ? 'primary' : 'secondary'} onClick={() => setTab(t)} role="tab" aria-selected={tab === t}>
              {t === 'trains' ? tr('قطارها ({0})', localDigits(data.trains.length)) : tr('ایستگاه‌ها ({0})', localDigits(data.stations.length))}
            </Button>
          ))}
        </div>
        {tab === 'stations'
          ? <Stations line={data} write={write} onRemove={remove} />
          : <Trains line={data} write={write} onRemove={remove} />}
        {editing && <LineEditor line={{ ...data, stations: data.stations.length, trains: data.trains.length }} onClose={() => setEditing(false)} />}
      </PageBody>
    </>
  );
}

type Remove = (path: string, what: string, after?: () => void) => Promise<void>;

function Stations({ line, write, onRemove }: { line: LineDetail; write: boolean; onRemove: Remove }) {
  const [editing, setEditing] = useState<Station | 'new' | null>(null);
  return (
    <Card action={write ? <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>{tr('+ ایستگاه')}</Button> : undefined}>
      {!line.stations.length ? <EmptyState title={tr('ایستگاهی ثبت نشده است')} /> : (
        <ol className="divide-y divide-ink-100" data-testid="metro-stations">
          {line.stations.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
              <span className="grid size-6 place-items-center rounded-full text-[12px] font-bold text-white nums" style={{ backgroundColor: line.color }}>{localDigits(s.order)}</span>
              <span className="font-semibold text-ink-800">{s.nameFa}</span>
              {s.branch && <Badge>{s.branch}</Badge>}
              {s.isInterchange && <Badge tone="info">{tr('تقاطعی')}</Badge>}
              {s.underConstruction && <Badge tone="warning">{tr('در حال ساخت')}</Badge>}
              {s.notes && <span className="text-xs text-ink-500">{s.notes}</span>}
              <span className="ms-auto flex items-center gap-1">
                <AttachButton target={onRecord('metroStation', s.id)} title={s.nameFa} />
                {write && <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>{tr('ویرایش')}</Button>}
                {write && <Button size="sm" variant="ghost" onClick={() => void onRemove(`/metro/stations/${s.id}`, s.nameFa)}><span className="text-rose-700">{tr('حذف')}</span></Button>}
              </span>
            </li>
          ))}
        </ol>
      )}
      {editing && <StationEditor lineId={line.id} station={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function StationEditor({ lineId, station, onClose }: { lineId: string; station?: Station; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ nameFa: station?.nameFa ?? '', nameEn: station?.nameEn ?? '', order: station ? String(station.order) : '', branch: station?.branch ?? '', isInterchange: station?.isInterchange ?? false, underConstruction: station?.underConstruction ?? false, notes: station?.notes ?? '' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const body = { ...f, order: f.order ? Number(f.order) : undefined, branch: f.branch || null, notes: f.notes || null };
    try {
      if (station) await apiPatch(`/metro/stations/${station.id}`, body); else await apiPost(`/metro/lines/${lineId}/stations`, body);
      toast(tr('ایستگاه ذخیره شد.')); await qc.invalidateQueries(); onClose();
    } catch (e: any) { toast(e?.message ?? tr('ذخیره ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open title={station ? tr('ویرایش ایستگاه {0}', station.nameFa) : tr('ایستگاه تازه')} onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
      <Button variant="primary" loading={busy} disabled={f.nameFa.trim().length < 2} onClick={() => void save()}>{tr('ذخیره')}</Button>
    </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('نام فارسی')} required><Input value={f.nameFa} onChange={(e) => setF({ ...f, nameFa: e.target.value })} /></Field>
        <Field label={tr('نام انگلیسی')}><Input value={f.nameEn} onChange={(e) => setF({ ...f, nameEn: e.target.value })} className="ltr" /></Field>
        <Field label={tr('ترتیب در خط')}><Input value={f.order} onChange={(e) => setF({ ...f, order: e.target.value })} inputMode="numeric" className="ltr" /></Field>
        <Field label={tr('شاخه')} hint={tr('برای ایستگاه‌های یک شاخه، مانند «شاخهٔ فرودگاه»')}><Input value={f.branch} onChange={(e) => setF({ ...f, branch: e.target.value })} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isInterchange} onChange={(e) => setF({ ...f, isInterchange: e.target.checked })} />{tr('ایستگاه تقاطعی')}</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.underConstruction} onChange={(e) => setF({ ...f, underConstruction: e.target.checked })} />{tr('در حال ساخت')}</label>
        <div className="sm:col-span-2"><Field label={tr('یادداشت')}><Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} rows={2} /></Field></div>
      </div>
    </Modal>
  );
}

function Trains({ line, write, onRemove }: { line: LineDetail; write: boolean; onRemove: Remove }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(line.trains[0]?.id ?? null);
  const [space, setSpace] = useState<{ wagon: Wagon; space?: Space } | null>(null);
  const [wagonsFor, setWagonsFor] = useState<Train | null>(null);
  const renameTrain = async (t: Train) => {
    const code = window.prompt(tr('شمارهٔ تازهٔ قطار'), t.code);
    if (!code || code === t.code) return;
    try { await apiPatch(`/metro/trains/${t.id}`, { code }); await qc.invalidateQueries(); } catch (e: any) { toast(e?.message ?? tr('ذخیره ناموفق بود.'), 'danger'); }
  };
  return (
    <Card action={write ? <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>{tr('+ قطار')}</Button> : undefined}>
      {!line.trains.length ? <EmptyState title={tr('قطاری ثبت نشده است')} description={write ? tr('قطار را با شمارهٔ واگن‌هایش بسازید؛ هر واگن با بدنه، کتیبه‌ها و دستگیره‌هایش ساخته می‌شود.') : undefined} /> : (
        <ul className="divide-y divide-ink-100" data-testid="metro-trains">
          {line.trains.map((t) => (
            <li key={t.id} className="px-4 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => setOpen(open === t.id ? null : t.id)} aria-expanded={open === t.id} className="font-semibold text-ink-800 hover:text-brand-700">
                  {open === t.id ? '▾' : '▸'} {tr('قطار {0}', t.code)}
                </button>
                <span className="text-xs text-ink-500">{tr('{0} واگن', localDigits(t.wagons.length))}</span>
                {!t.isActive && <Badge tone="warning">{tr('غیرفعال')}</Badge>}
                <span className="ms-auto flex items-center gap-1">
                  <AttachButton target={onRecord('metroTrain', t.id)} title={tr('قطار {0}', t.code)} />
                  {write && <Button size="sm" variant="ghost" onClick={() => setWagonsFor(t)}>{tr('+ واگن')}</Button>}
                  {write && <Button size="sm" variant="ghost" onClick={() => void renameTrain(t)}>{tr('ویرایش')}</Button>}
                  {write && <Button size="sm" variant="ghost" onClick={() => void apiPatch(`/metro/trains/${t.id}`, { isActive: !t.isActive }).then(() => qc.invalidateQueries())}>{t.isActive ? tr('غیرفعال کردن') : tr('فعال کردن')}</Button>}
                  {write && <Button size="sm" variant="ghost" onClick={() => void onRemove(`/metro/trains/${t.id}`, tr('قطار {0}', t.code))}><span className="text-rose-700">{tr('حذف')}</span></Button>}
                </span>
              </div>
              {open === t.id && (
                <div className="mt-2 grid gap-2 lg:grid-cols-2">
                  {t.wagons.map((w) => (
                    <div key={w.id} className="rounded-lg bg-ink-50/60 p-2.5 ring-1 ring-ink-200" data-testid="metro-wagon">
                      <div className="mb-1.5 flex items-center gap-2 text-sm">
                        <span className="font-semibold">{tr('واگن {0}', localDigits(w.number))}</span>
                        {w.notes && <span className="text-xs text-ink-500">{w.notes}</span>}
                        <span className="ms-auto flex items-center gap-1">
                          <AttachButton target={onRecord('metroWagon', w.id)} title={tr('واگن {0} قطار {1}', localDigits(w.number), t.code)} />
                          {write && <Button size="sm" variant="ghost" onClick={() => setSpace({ wagon: w })}>{tr('+ فضا')}</Button>}
                          {write && <Button size="sm" variant="ghost" onClick={() => void onRemove(`/metro/wagons/${w.id}`, tr('واگن {0}', localDigits(w.number)))}><span className="text-rose-700">{tr('حذف')}</span></Button>}
                        </span>
                      </div>
                      <ul className="space-y-1">
                        {w.spaces.map((s) => (
                          <li key={s.id} className={cx('flex flex-wrap items-center gap-2 rounded bg-surface px-2 py-1 text-xs ring-1 ring-ink-100', !s.isActive && 'opacity-60')}>
                            <span className="font-semibold text-ink-800">{kindFa(s.kind)}</span>
                            {s.label && <span className="text-ink-600">{s.label}</span>}
                            <span className="text-ink-500 nums">{tr('{0} واحد، {1} آزاد امروز', localDigits(s.quantity), localDigits(s.quantity - (s.takenToday ?? 0)))}</span>
                            <Money value={s.monthlyPrice} tone="muted" /><span className="text-ink-400">{tr('/ ماه')}</span>
                            <span className="ms-auto flex items-center">
                              <AttachButton target={onRecord('metroSpace', s.id)} title={kindFa(s.kind)} />
                              {write && <Button size="sm" variant="ghost" onClick={() => setSpace({ wagon: w, space: s })}>{tr('ویرایش')}</Button>}
                              {write && <Button size="sm" variant="ghost" onClick={() => void onRemove(`/metro/spaces/${s.id}`, kindFa(s.kind))}><span className="text-rose-700">×</span></Button>}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && <TrainCreator lineId={line.id} onClose={() => setAdding(false)} />}
      {wagonsFor && <WagonCreator train={wagonsFor} onClose={() => setWagonsFor(null)} />}
      {space && <SpaceEditor wagon={space.wagon} space={space.space} onClose={() => setSpace(null)} />}
    </Card>
  );
}

/** How many of each kind a new wagon carries, and at what monthly price. */
function TemplateFields({ t, setT }: { t: Record<MetroSpaceKind, { n: string; p: string }>; setT: (v: Record<MetroSpaceKind, { n: string; p: string }>) => void }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-bold text-ink-700">{tr('فضاهای هر واگن')}</p>
      {METRO_SPACE_KINDS.map((k) => (
        <div key={k} className="grid grid-cols-[6rem_1fr_1fr] items-center gap-2">
          <span className="text-sm font-semibold">{kindFa(k)}</span>
          <Input value={t[k].n} onChange={(e) => setT({ ...t, [k]: { ...t[k], n: e.target.value } })} inputMode="numeric" className="ltr" aria-label={tr('تعداد {0}', kindFa(k))} placeholder={tr('تعداد')} />
          <Input value={t[k].p} onChange={(e) => setT({ ...t, [k]: { ...t[k], p: e.target.value } })} inputMode="numeric" className="ltr" aria-label={tr('قیمت ماهانهٔ هر {0}', kindFa(k))} placeholder={tr('قیمت ماهانه (ریال)')} />
        </div>
      ))}
    </div>
  );
}
const blankTemplate = () => Object.fromEntries(METRO_SPACE_KINDS.map((k) => [k, { n: String(METRO_WAGON_TEMPLATE[k]), p: '' }])) as Record<MetroSpaceKind, { n: string; p: string }>;
const templateBody = (t: Record<MetroSpaceKind, { n: string; p: string }>) => ({
  template: Object.fromEntries(METRO_SPACE_KINDS.map((k) => [k, Number(t[k].n || 0)])),
  prices: Object.fromEntries(METRO_SPACE_KINDS.map((k) => [k, Number(t[k].p || 0)])),
});

function TrainCreator({ lineId, onClose }: { lineId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [wagons, setWagons] = useState('7');
  const [t, setT] = useState(blankTemplate);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await apiPost(`/metro/lines/${lineId}/trains`, { code: code.trim(), wagons: Number(wagons || 0), ...templateBody(t) }); toast(tr('قطار ساخته شد.')); await qc.invalidateQueries(); onClose(); }
    catch (e: any) { toast(e?.message ?? tr('ذخیره ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open title={tr('قطار تازه')} onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
      <Button variant="primary" loading={busy} disabled={!code.trim()} onClick={() => void save()}>{tr('ساختن قطار')}</Button>
    </>}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('شمارهٔ قطار')} required><Input value={code} onChange={(e) => setCode(e.target.value)} className="ltr" /></Field>
          <Field label={tr('تعداد واگن')}><Input value={wagons} onChange={(e) => setWagons(e.target.value)} inputMode="numeric" className="ltr" /></Field>
        </div>
        <TemplateFields t={t} setT={setT} />
      </div>
    </Modal>
  );
}

function WagonCreator({ train, onClose }: { train: Train; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [count, setCount] = useState('1');
  const [t, setT] = useState(blankTemplate);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await apiPost(`/metro/trains/${train.id}/wagons`, { count: Number(count || 1), ...templateBody(t) }); toast(tr('واگن افزوده شد.')); await qc.invalidateQueries(); onClose(); }
    catch (e: any) { toast(e?.message ?? tr('ذخیره ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open title={tr('واگن تازه برای قطار {0}', train.code)} onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
      <Button variant="primary" loading={busy} onClick={() => void save()}>{tr('افزودن')}</Button>
    </>}>
      <div className="space-y-3">
        <Field label={tr('تعداد واگن')}><Input value={count} onChange={(e) => setCount(e.target.value)} inputMode="numeric" className="ltr w-24" /></Field>
        <TemplateFields t={t} setT={setT} />
      </div>
    </Modal>
  );
}

function SpaceEditor({ wagon, space, onClose }: { wagon: Wagon; space?: Space; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ kind: space?.kind ?? 'KATIBEH', label: space?.label ?? '', quantity: String(space?.quantity ?? 1), widthCm: String(space?.widthCm ?? ''), heightCm: String(space?.heightCm ?? ''), monthlyPrice: String(space?.monthlyPrice ?? ''), isActive: space?.isActive ?? true, notes: space?.notes ?? '' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const body = { ...f, label: f.label || null, quantity: Number(f.quantity || 1), widthCm: f.widthCm ? Number(f.widthCm) : null, heightCm: f.heightCm ? Number(f.heightCm) : null, monthlyPrice: Number(f.monthlyPrice || 0), notes: f.notes || null };
    try {
      if (space) await apiPatch(`/metro/spaces/${space.id}`, body); else await apiPost(`/metro/wagons/${wagon.id}/spaces`, body);
      toast(tr('فضا ذخیره شد.')); await qc.invalidateQueries(); onClose();
    } catch (e: any) { toast(e?.message ?? tr('ذخیره ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open title={space ? tr('ویرایش فضا') : tr('فضای تازه در واگن {0}', localDigits(wagon.number))} onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
      <Button variant="primary" loading={busy} onClick={() => void save()}>{tr('ذخیره')}</Button>
    </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('نوع')}><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as MetroSpaceKind })}>{METRO_SPACE_KINDS.map((k) => <option key={k} value={k}>{kindFa(k)}</option>)}</Select></Field>
        <Field label={tr('عنوان')}><Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
        <Field label={tr('تعداد واحد')}><Input value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} inputMode="numeric" className="ltr" /></Field>
        <Field label={tr('قیمت ماهانهٔ هر واحد (ریال)')}><Input value={f.monthlyPrice} onChange={(e) => setF({ ...f, monthlyPrice: e.target.value })} inputMode="numeric" className="ltr" /></Field>
        <Field label={tr('عرض (سانتی‌متر)')}><Input value={f.widthCm} onChange={(e) => setF({ ...f, widthCm: e.target.value })} inputMode="numeric" className="ltr" /></Field>
        <Field label={tr('ارتفاع (سانتی‌متر)')}><Input value={f.heightCm} onChange={(e) => setF({ ...f, heightCm: e.target.value })} inputMode="numeric" className="ltr" /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />{tr('فعال')}</label>
        <div className="sm:col-span-2"><Field label={tr('یادداشت')}><Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} rows={2} /></Field></div>
      </div>
    </Modal>
  );
}
