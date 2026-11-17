import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { METRO_BOOKING_STATES, METRO_SPACE_KINDS, metroDays, metroSuggestedAmount, type MetroSpaceKind } from '@hiva/contracts';
import { apiDelete, apiGet, apiPatch, apiPost } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDate, localDigits } from '../../lib/format';
import { PageBody, PageHeader } from '../../components/Shell';
import { JalaliDateInput } from '../../components/JalaliDateInput';
import { Button, Card, EmptyState, ErrorBlock, Field, Input, LoadingBlock, Modal, Select, Table, Td, Textarea, Th, Tr, useToast } from '../../components/ui';
import { EntitySelect } from '../Forms';
import { Money } from '../sites/shared';
import { tr } from '../../i18n';
import { BookingState, LineChip, MetroNav, kindFa, plusDays, stateFa, today, type Line } from './shared';

interface Row { id: string; code: string; title: string | null; client: string | null; state: string; startDate: string; endDate: string; amount: number; paid: number; balance: number; units: Record<string, number>; lines: { number: number; color: string }[] }

export default function MetroBookingsPage() {
  const { id } = useParams();
  return id ? <BookingDetail id={id} /> : <BookingList />;
}

function BookingList() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const state = params.get('state') ?? '';
  const lineId = params.get('lineId') ?? '';
  const lines = useQuery<Line[]>({ queryKey: ['/metro/lines'], queryFn: () => apiGet('/metro/lines') });
  const { data, isLoading, error, refetch } = useQuery<{ items: Row[]; total: number }>({
    queryKey: ['/metro/bookings', state, lineId, q], queryFn: () => apiGet('/metro/bookings', { state: state || undefined, lineId: lineId || undefined, q: q.trim() || undefined, pageSize: 200 }),
  });
  const creating = params.get('new') === '1';
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  return (
    <>
      <PageHeader title={tr('رزروهای مترو')} subtitle={tr('هر رزرو: مشتری، تاریخ‌ها، فضاها، مبلغ و پرداخت‌ها')}
        actions={can('metro.book') ? <Button variant="primary" onClick={() => set('new', '1')} data-testid="metro-new-booking">{tr('+ رزرو تازه')}</Button> : undefined} />
      <PageBody>
        <MetroNav />
        <div className="mb-3 flex flex-wrap gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('جستجو در کد، عنوان یا مشتری…')} className="w-64" aria-label={tr('جستجو')} />
          <Select value={state} onChange={(e) => set('state', e.target.value)} aria-label={tr('وضعیت')} className="w-40">
            <option value="">{tr('همهٔ وضعیت‌ها')}</option>
            {METRO_BOOKING_STATES.map((s) => <option key={s} value={s}>{stateFa(s)}</option>)}
          </Select>
          <Select value={lineId} onChange={(e) => set('lineId', e.target.value)} aria-label={tr('خط')} className="w-48">
            <option value="">{tr('همهٔ خطوط')}</option>
            {(lines.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.nameFa}</option>)}
          </Select>
        </div>
        <Card>
          {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={() => void refetch()} /> : !data?.items.length ? <EmptyState title={tr('رزروی نیست')} /> : (
            <Table>
              <thead className="bg-ink-50/60"><tr><Th>{tr('کد')}</Th><Th>{tr('مشتری')}</Th><Th>{tr('خط')}</Th><Th>{tr('فضاها')}</Th><Th>{tr('تاریخ')}</Th><Th>{tr('مبلغ')}</Th><Th>{tr('مانده')}</Th><Th>{tr('وضعیت')}</Th></tr></thead>
              <tbody>
                {data.items.map((b) => (
                  <Tr key={b.id}>
                    <Td><Link to={`/metro/bookings/${b.id}`} className="font-semibold text-brand-700 hover:underline">{b.code}</Link>{b.title && <p className="text-xs text-ink-500">{b.title}</p>}</Td>
                    <Td className="text-sm">{b.client ?? '—'}</Td>
                    <Td><span className="flex gap-1">{b.lines.map((l) => <LineChip key={l.number} line={l}>{''}</LineChip>)}</span></Td>
                    <Td className="text-xs">{Object.entries(b.units).map(([k, n]) => tr('{0} {1}', localDigits(n), kindFa(k))).join(tr('، '))}</Td>
                    <Td className="text-xs">{formatDate(b.startDate)} — {formatDate(b.endDate)}</Td>
                    <Td><Money value={b.amount} /></Td>
                    <Td><Money value={b.balance} tone={b.balance > 0 ? 'danger' : 'muted'} /></Td>
                    <Td><BookingState state={b.state} /></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        {creating && <BookingForm onClose={() => set('new', '')} />}
      </PageBody>
    </>
  );
}

interface Avail { id: string; kind: MetroSpaceKind; label: string | null; quantity: number; monthlyPrice: number; taken: number; free: number; wagon: { id: string; number: number; train: { id: string; code: string; line: { id: string; number: number; nameFa: string; color: string } } } }
interface Detail {
  id: string; code: string; title: string | null; state: string; client: string | null; companyId: string | null; clientName: string | null; projectId: string | null;
  company: { id: string; legalName: string } | null; project: { id: string; code: string; name: string } | null;
  startDate: string; endDate: string; days: number; amount: number; paid: number; balance: number; notes: string | null; moves: string[];
  owner: { id: string; fullName: string } | null; createdBy: { id: string; fullName: string } | null;
  items: { id: string; spaceId: string; quantity: number; monthlyPrice: number; space: { id: string; kind: string; label: string | null; quantity: number; wagon: { number: number; train: { code: string; line: { id: string; number: number; nameFa: string; color: string } } } } }[];
  payments: { id: string; amount: number; paidAt: string; method: string | null; reference: string | null; note: string | null }[];
}

/** A booking made or changed: client, dates, and the spaces picked from what is free on those dates. */
export function BookingForm({ booking, onClose }: { booking?: Detail; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [f, setF] = useState({
    title: booking?.title ?? '', companyId: booking?.companyId ?? '', clientName: booking?.clientName ?? '', projectId: booking?.projectId ?? '',
    startDate: booking?.startDate ?? today(), endDate: booking?.endDate ?? plusDays(today(), 29), amount: booking ? String(booking.amount) : '', notes: booking?.notes ?? '', state: 'HOLD',
  });
  const [lineId, setLineId] = useState(booking?.items[0]?.space.wagon.train.line.id ?? '');
  const [kind, setKind] = useState<MetroSpaceKind | ''>('');
  const [picked, setPicked] = useState<Record<string, number>>(() => Object.fromEntries((booking?.items ?? []).map((i) => [i.spaceId, i.quantity])));
  const [busy, setBusy] = useState(false);
  const lines = useQuery<Line[]>({ queryKey: ['/metro/lines'], queryFn: () => apiGet('/metro/lines') });
  const ok = f.endDate >= f.startDate;
  const avail = useQuery<Avail[]>({
    queryKey: ['/metro/availability', f.startDate, f.endDate, lineId, kind],
    queryFn: () => apiGet('/metro/availability', { from: f.startDate, to: f.endDate, lineId: lineId || undefined, kind: kind || undefined }),
    enabled: ok && !!lineId,
  });
  // What this booking itself holds is free to it.
  const mine = (id: string) => (booking?.items.find((i) => i.spaceId === id)?.quantity ?? 0);
  const rows = avail.data ?? [];
  const priced = useMemo(() => {
    const known = new Map(rows.map((r) => [r.id, r.monthlyPrice]));
    for (const i of booking?.items ?? []) if (!known.has(i.spaceId)) known.set(i.spaceId, i.monthlyPrice);
    return Object.entries(picked).filter(([, n]) => n > 0).map(([id, n]) => ({ spaceId: id, quantity: n, monthlyPrice: known.get(id) ?? 0 }));
  }, [picked, rows, booking]);
  const suggested = ok ? metroSuggestedAmount(priced, f.startDate, f.endDate) : 0;
  const save = async () => {
    setBusy(true);
    const body = {
      title: f.title || null, companyId: f.companyId || null, clientName: f.clientName || null, projectId: f.projectId || null,
      startDate: f.startDate, endDate: f.endDate, amount: f.amount ? Number(f.amount) : null, notes: f.notes || null,
      items: priced.map((p) => ({ spaceId: p.spaceId, quantity: p.quantity })), ...(booking ? {} : { state: f.state }),
    };
    try {
      const out = booking ? await apiPatch<Detail>(`/metro/bookings/${booking.id}`, body) : await apiPost<Detail>('/metro/bookings', body);
      toast(booking ? tr('رزرو ذخیره شد.') : tr('رزرو {0} ثبت شد.', out.code));
      await qc.invalidateQueries();
      onClose();
      if (!booking) navigate(`/metro/bookings/${out.id}`);
    } catch (e: any) { toast(e?.message ?? tr('ذخیره ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open wide title={booking ? tr('ویرایش رزرو {0}', booking.code) : tr('رزرو تازهٔ مترو')} onClose={onClose} draftKey={booking ? `metro:${booking.id}` : 'metro:new'} footer={<>
      <span className="me-auto text-sm text-ink-600">{tr('{0} روز، پیشنهاد مبلغ:', localDigits(ok ? metroDays(f.startDate, f.endDate) : 0))} <Money value={suggested} /></span>
      <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
      <Button variant="primary" loading={busy} disabled={!ok || !priced.length || (!f.companyId && !f.clientName.trim())} onClick={() => void save()} data-testid="metro-save-booking">{tr('ذخیره')}</Button>
    </>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr('مشتری (از فهرست)')}><EntitySelect entity="company" value={f.companyId} onChange={(v) => setF({ ...f, companyId: v })} /></Field>
          <Field label={tr('یا نام مشتری')}><Input value={f.clientName} onChange={(e) => setF({ ...f, clientName: e.target.value })} /></Field>
          <Field label={tr('عنوان کمپین')}><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label={tr('پروژه')}><EntitySelect entity="project" value={f.projectId} onChange={(v) => setF({ ...f, projectId: v })} /></Field>
          <Field label={tr('از')} required><JalaliDateInput value={f.startDate} onChange={(v) => setF({ ...f, startDate: v })} label={tr('از')} /></Field>
          <Field label={tr('تا')} required error={ok ? undefined : tr('پایان پیش از آغاز است.')}><JalaliDateInput value={f.endDate} onChange={(v) => setF({ ...f, endDate: v })} label={tr('تا')} /></Field>
          <Field label={tr('مبلغ (ریال)')} hint={tr('خالی بماند، مبلغ پیشنهادی ثبت می‌شود.')}><Input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} inputMode="numeric" className="ltr" placeholder={String(suggested)} /></Field>
          {!booking && <Field label={tr('وضعیت')}><Select value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })}><option value="HOLD">{stateFa('HOLD')}</option><option value="CONFIRMED">{stateFa('CONFIRMED')}</option></Select></Field>}
        </div>
        <div className="rounded-lg bg-ink-50/60 p-3 ring-1 ring-ink-200">
          <div className="mb-2 flex flex-wrap gap-2">
            <Select value={lineId} onChange={(e) => setLineId(e.target.value)} aria-label={tr('خط')} className="w-48">
              <option value="">{tr('— خط را برگزینید —')}</option>
              {(lines.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.nameFa}</option>)}
            </Select>
            <Select value={kind} onChange={(e) => setKind(e.target.value as MetroSpaceKind | '')} aria-label={tr('نوع فضا')} className="w-36">
              <option value="">{tr('همهٔ فضاها')}</option>
              {METRO_SPACE_KINDS.map((k) => <option key={k} value={k}>{kindFa(k)}</option>)}
            </Select>
            <span className="ms-auto self-center text-xs text-ink-600">{tr('{0} فضا برگزیده', localDigits(priced.length))}</span>
          </div>
          {!lineId ? <p className="text-sm text-ink-500">{tr('خط را برگزینید تا فضاهای آزادش در این تاریخ‌ها دیده شود.')}</p> : avail.isLoading ? <LoadingBlock /> : !rows.length ? <p className="text-sm text-ink-500">{tr('در این خط فضایی ثبت نشده است.')}</p> : (
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-sm" data-testid="metro-availability">
                <thead><tr className="text-xs text-ink-500"><th className="text-start">{tr('قطار / واگن')}</th><th className="text-start">{tr('فضا')}</th><th className="text-start">{tr('آزاد')}</th><th className="text-start">{tr('قیمت ماهانه')}</th><th className="text-start">{tr('تعداد')}</th></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const free = r.free + mine(r.id);
                    return (
                      <tr key={r.id} className="border-t border-ink-100">
                        <td className="py-1">{tr('قطار {0} / واگن {1}', r.wagon.train.code, localDigits(r.wagon.number))}</td>
                        <td>{kindFa(r.kind)}{r.label ? ` — ${r.label}` : ''}</td>
                        <td className="nums">{localDigits(free)} / {localDigits(r.quantity)}</td>
                        <td><Money value={r.monthlyPrice} tone="muted" /></td>
                        <td><Input value={String(picked[r.id] ?? '')} onChange={(e) => setPicked({ ...picked, [r.id]: Math.max(0, Math.min(free, Number(e.target.value.replace(/\D/g, '') || 0))) })}
                          inputMode="numeric" className="ltr w-16" disabled={!free} aria-label={tr('تعداد از {0} واگن {1}', kindFa(r.kind), localDigits(r.wagon.number))} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <Field label={tr('یادداشت')}><Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} rows={2} /></Field>
      </div>
    </Modal>
  );
}

function BookingDetail({ id }: { id: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { data: b, isLoading, error, refetch } = useQuery<Detail>({ queryKey: ['/metro/bookings', id], queryFn: () => apiGet(`/metro/bookings/${id}`) });
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const may = can('metro.book');
  if (isLoading) return <PageBody><LoadingBlock /></PageBody>;
  if (error || !b) return <PageBody><ErrorBlock error={error} onRetry={() => void refetch()} /></PageBody>;
  const move = async (to: string) => {
    const reason = to === 'CANCELLED' ? window.prompt(tr('دلیل لغو')) : null;
    if (to === 'CANCELLED' && !reason) return;
    try { await apiPost(`/metro/bookings/${id}/state`, { to, reason }); toast(tr('وضعیت: {0}', stateFa(to))); await qc.invalidateQueries(); }
    catch (e: any) { toast(e?.message ?? tr('ناموفق بود.'), 'danger'); }
  };
  const remove = async () => {
    if (!window.confirm(tr('رزرو {0} برای همیشه حذف شود؟', b.code))) return;
    try { await apiDelete(`/metro/bookings/${id}`); toast(tr('حذف شد.')); await qc.invalidateQueries(); navigate('/metro/bookings'); }
    catch (e: any) { toast(e?.message ?? tr('حذف ناموفق بود.'), 'danger'); }
  };
  const unpay = async (pid: string) => {
    if (!window.confirm(tr('این پرداخت برداشته شود؟'))) return;
    try { await apiDelete(`/metro/payments/${pid}`); await qc.invalidateQueries(); } catch (e: any) { toast(e?.message ?? tr('حذف ناموفق بود.'), 'danger'); }
  };
  return (
    <>
      <PageHeader title={tr('رزرو {0}', b.code)} subtitle={[b.title, b.client].filter(Boolean).join(' — ')}
        actions={may ? <div className="flex flex-wrap gap-1.5">
          {b.moves.map((m) => <Button key={m} variant={m === 'CANCELLED' ? 'ghost' : 'secondary'} onClick={() => void move(m)}>{m === 'CANCELLED' ? <span className="text-rose-700">{tr('لغو')}</span> : tr('به «{0}»', stateFa(m))}</Button>)}
          <Button variant="ghost" onClick={() => setEditing(true)}>{tr('ویرایش')}</Button>
          <Button variant="ghost" onClick={() => void remove()}><span className="text-rose-700">{tr('حذف')}</span></Button>
        </div> : undefined} />
      <PageBody>
        <MetroNav />
        <div className="grid gap-3 lg:grid-cols-3">
          <Card title={tr('رزرو')}>
            <dl className="space-y-1.5 p-4 text-sm">
              <div className="flex justify-between"><dt className="text-ink-500">{tr('وضعیت')}</dt><dd><BookingState state={b.state} /></dd></div>
              <div className="flex justify-between"><dt className="text-ink-500">{tr('مشتری')}</dt><dd>{b.company ? <Link to={`/companies/${b.company.id}`} className="text-brand-700 hover:underline">{b.company.legalName}</Link> : b.clientName ?? '—'}</dd></div>
              {b.project && <div className="flex justify-between"><dt className="text-ink-500">{tr('پروژه')}</dt><dd><Link to={`/projects/${b.project.id}`} className="text-brand-700 hover:underline">{b.project.name}</Link></dd></div>}
              <div className="flex justify-between"><dt className="text-ink-500">{tr('تاریخ')}</dt><dd>{formatDate(b.startDate)} — {formatDate(b.endDate)} ({tr('{0} روز', localDigits(b.days))})</dd></div>
              <div className="flex justify-between"><dt className="text-ink-500">{tr('مسئول')}</dt><dd>{b.owner?.fullName ?? '—'}</dd></div>
              {b.notes && <p className="whitespace-pre-wrap pt-2 text-ink-700">{b.notes}</p>}
            </dl>
          </Card>
          <Card title={tr('مبلغ و پرداخت')} action={may ? <Button size="sm" variant="secondary" onClick={() => setPaying(true)}>{tr('+ پرداخت')}</Button> : undefined}>
            <dl className="space-y-1 p-4 text-sm">
              <div className="flex justify-between"><dt className="text-ink-500">{tr('مبلغ')}</dt><dd><Money value={b.amount} /></dd></div>
              <div className="flex justify-between"><dt className="text-ink-500">{tr('پرداخت‌شده')}</dt><dd><Money value={b.paid} tone="success" /></dd></div>
              <div className="flex justify-between"><dt className="text-ink-500">{tr('مانده')}</dt><dd><Money value={b.balance} tone={b.balance > 0 ? 'danger' : 'muted'} /></dd></div>
            </dl>
            <ul className="divide-y divide-ink-100 px-4 pb-3 text-sm" data-testid="metro-payments">
              {b.payments.map((p) => (
                <li key={p.id} className="flex items-center gap-2 py-1.5">
                  <Money value={p.amount} /><span className="text-xs text-ink-500">{formatDate(p.paidAt)}{p.method ? ` — ${p.method}` : ''}{p.reference ? ` (${p.reference})` : ''}</span>
                  {may && <button type="button" onClick={() => void unpay(p.id)} className="ms-auto text-ink-400 hover:text-rose-700" aria-label={tr('برداشتن پرداخت')}>×</button>}
                </li>
              ))}
            </ul>
          </Card>
          <Card title={tr('فضاها')}>
            <ul className="divide-y divide-ink-100 text-sm">
              {b.items.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-2 px-4 py-1.5">
                  <LineChip line={i.space.wagon.train.line}>{''}</LineChip>
                  <span>{tr('قطار {0} / واگن {1}', i.space.wagon.train.code, localDigits(i.space.wagon.number))}</span>
                  <span className="font-semibold">{kindFa(i.space.kind)}</span>
                  <span className="ms-auto nums">{tr('{0} واحد', localDigits(i.quantity))}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
        {editing && <BookingForm booking={b} onClose={() => setEditing(false)} />}
        {paying && <PaymentForm bookingId={b.id} balance={b.balance} onClose={() => setPaying(false)} />}
      </PageBody>
    </>
  );
}

function PaymentForm({ bookingId, balance, onClose }: { bookingId: string; balance: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ amount: balance > 0 ? String(balance) : '', paidAt: today(), method: '', reference: '', note: '' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await apiPost(`/metro/bookings/${bookingId}/payments`, { ...f, amount: Number(f.amount), method: f.method || null, reference: f.reference || null, note: f.note || null }); toast(tr('پرداخت ثبت شد.')); await qc.invalidateQueries(); onClose(); }
    catch (e: any) { toast(e?.message ?? tr('ذخیره ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open title={tr('ثبت پرداخت')} onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
      <Button variant="primary" loading={busy} disabled={!Number(f.amount)} onClick={() => void save()}>{tr('ثبت')}</Button>
    </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('مبلغ (ریال)')} required><Input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} inputMode="numeric" className="ltr" /></Field>
        <Field label={tr('تاریخ')} required><JalaliDateInput value={f.paidAt} onChange={(v) => setF({ ...f, paidAt: v })} label={tr('تاریخ')} /></Field>
        <Field label={tr('روش پرداخت')}><Input value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} /></Field>
        <Field label={tr('شمارهٔ پیگیری')}><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} className="ltr" /></Field>
        <div className="sm:col-span-2"><Field label={tr('یادداشت')}><Textarea value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} rows={2} /></Field></div>
      </div>
    </Modal>
  );
}
