import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RESOURCE_FEATURES, RESOURCE_FEATURE_LABELS, RESOURCE_TYPE_LABELS, type BookingConflict, type ResourceFeature } from '@hiva/contracts';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, localDigits, sep } from '../lib/format';
import { PageBody, PageHeader } from '../components/Shell';
import { StageProgress } from '../components/StageProgress';
import {
  Badge, Button, Card, DescRow, ErrorBlock, Field, Input, LoadingBlock, Modal, Select, Spinner, StateBadge, Tabs, Textarea, cx, useToast,
} from '../components/ui';
import { EntityList, WorkflowActions, type Column } from '../components/common';
import { JalaliDateInput } from '../components/JalaliDateInput';
import { isEnglish, tr, trx } from '../i18n';

/**
 * Booking a meeting (audit F-9): a room, equipment, parking and the people, decided by the approver
 * named on it and confirmed by its organiser — at which point the room and the people are held and the
 * booking becomes a Hivamis meeting. The meeting platform's booking, inside Hivamis.
 */

interface Person { id: string; fullName: string; jobTitle?: string | null }
interface Room { id: string; name: string; capacity: number; floor: string | null; features: string[]; location: { name: string } | null }
interface Availability { available: boolean; conflicts: BookingConflict[]; freeRooms: Room[]; suggestions: { startsAt: string; endsAt: string }[] }
interface BookingRow {
  id: string; code: string; state: string; title: string; startsAt: string; endsAt: string; placeNote: string | null;
  organizer: Person; room: { id: string; name: string } | null; meeting: { id: string; code: string } | null;
  _count: { participants: number; guests: number };
}
interface Booking extends Omit<BookingRow, '_count'> {
  description: string | null; kind: 'INTERNAL' | 'EXTERNAL'; organizerId: string; approverId: string | null; approver: Person | null;
  room: (Room & { location: { name: string } | null }) | null; parking: { id: string; name: string } | null; parkingSpaces: number;
  project: { id: string; code: string; name: string } | null; company: { id: string; legalName: string } | null;
  participants: { userId: string; fullName: string; response: string }[];
  resources: { id: string; name: string; type: keyof typeof RESOURCE_TYPE_LABELS }[];
  guests: { id: string; fullName: string; company: string | null; email: string | null; phone: string | null; isVip: boolean }[];
  catering: { optionId: string; labelFa: string; labelEn: string; quantity: number }[];
  decisionNote: string | null; cancelReason: string | null; editable: boolean;
  availableTransitions: { action: string; labelFa: string; labelEn: string; requiresReason: boolean; to: string }[];
}

const featureLabel = (f: string) => (isEnglish() ? RESOURCE_FEATURE_LABELS[f as ResourceFeature]?.en : RESOURCE_FEATURE_LABELS[f as ResourceFeature]?.fa) ?? f;
const typeLabel = (t: keyof typeof RESOURCE_TYPE_LABELS) => (isEnglish() ? RESOURCE_TYPE_LABELS[t].en : RESOURCE_TYPE_LABELS[t].fa);
const span = (b: { startsAt: string; endsAt: string }) => `${formatDateTime(b.startsAt)} — ${formatDateTime(b.endsAt).split(' ').at(-1)}`;
const DURATIONS = [30, 45, 60, 90, 120, 180, 240, 480];
/** Inside Telegram's Mini App (audit F-9), where the rest of Hivamis is not a link away. */
const inMiniApp = () => window.location.pathname.startsWith('/tg');
const RESPONSES: Record<string, () => string> = { PENDING: () => tr('بی‌پاسخ'), ACCEPTED: () => tr('می‌آید'), DECLINED: () => tr('نمی‌آید') };

/* ── the list ─────────────────────────────────────────────────────────────── */

export default function Bookings() {
  const { can } = useAuth();
  const [scope, setScope] = useState<'mine' | 'approve' | 'all'>('mine');
  const [editing, setEditing] = useState(false);
  const columns: Column<BookingRow>[] = [
    { key: 'code', header: tr('کد'), render: (b) => <span className="ltr font-mono text-xs">{b.code}</span> },
    { key: 'title', header: tr('عنوان'), render: (b) => <span className="font-medium text-ink-800">{b.title}</span> },
    { key: 'when', header: tr('زمان'), render: (b) => <span className="text-xs">{span(b)}</span> },
    { key: 'where', header: tr('مکان'), render: (b) => b.room?.name ?? b.placeNote ?? '—' },
    { key: 'organizer', header: tr('برگزارکننده'), render: (b) => b.organizer.fullName },
    { key: 'people', header: tr('حاضران'), render: (b) => localDigits(b._count.participants + 1 + b._count.guests) },
    { key: 'state', header: tr('وضعیت'), render: (b) => <StateBadge state={b.state} /> },
  ];
  const tabs = [
    { key: 'mine', label: tr('رزروهای من') },
    ...(can('meeting.approve') ? [{ key: 'approve', label: tr('در انتظار تأیید من') }] : []),
    ...(can('meeting.view_all') ? [{ key: 'all', label: tr('همهٔ رزروها') }] : []),
  ];
  return (
    <>
      <PageHeader
        title={tr('رزرو جلسه')}
        subtitle={tr('اتاق، تجهیزات، پارکینگ و همکاران — بی‌تداخل، با تأیید، و با صورتجلسه در هیوامیس')}
        actions={<Button variant="primary" onClick={() => setEditing(true)}>{tr('رزرو تازه')}</Button>}
      />
      <PageBody>
        <div className="space-y-4" data-testid="bookings">
          {tabs.length > 1 && <Tabs tabs={tabs} active={scope} onChange={(k) => setScope(k as typeof scope)} />}
          <EntityList<BookingRow>
            key={scope}
            path="/bookings"
            extraQuery={{ scope }}
            columns={columns}
            searchPlaceholder={tr('عنوان یا کد رزرو')}
            rowHref={(b) => `/bookings/${b.id}`}
            emptyTitle={scope === 'approve' ? tr('رزروی در انتظار تأیید شما نیست') : tr('هنوز رزروی نیست')}
            emptyDescription={scope === 'mine' ? tr('با «رزرو تازه» اتاق و همکاران را برای جلسه نگه دارید.') : undefined}
          />
        </div>
      </PageBody>
      {editing && <BookingEditor onClose={() => setEditing(false)} />}
    </>
  );
}

/* ── one booking ──────────────────────────────────────────────────────────── */

export function BookingPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  const { data: b, isLoading, error, refetch } = useQuery<Booking>({ queryKey: [`/bookings/${id}`], queryFn: () => apiGet(`/bookings/${id}`) });
  if (isLoading) return <PageBody><LoadingBlock /></PageBody>;
  if (error || !b) return <PageBody><ErrorBlock error={error} onRetry={() => void refetch()} /></PageBody>;

  const mySeat = b.participants.find((p) => p.userId === user?.id);
  const respond = async (response: 'ACCEPTED' | 'DECLINED') => {
    try { await apiPost(`/bookings/${b.id}/respond`, { response }); toast(response === 'ACCEPTED' ? tr('حضورتان ثبت شد.') : tr('ثبت شد که نمی‌آیید.')); await qc.invalidateQueries(); }
    catch (e) { toast((e as Error).message, 'danger'); }
  };
  const moves = b.availableTransitions.filter((t) => t.action !== 'reschedule');
  const canReschedule = b.availableTransitions.some((t) => t.action === 'reschedule');

  return (
    <>
      <PageHeader
        title={b.title}
        badge={<StateBadge state={b.state} />}
        subtitle={<span className="ltr font-mono text-xs">{b.code}</span>}
        actions={b.editable ? <Button onClick={() => setEditing(true)}>{tr('ویرایش')}</Button> : undefined}
      />
      <PageBody>
        <div className="mb-5"><StageProgress inline entity="booking" state={b.state} transitions={b.availableTransitions} owner={b.organizer?.fullName} /></div>
        <div className="grid gap-5 lg:grid-cols-3" data-testid="booking">
          <div className="space-y-5 lg:col-span-2">
            <Card title={tr('جلسه')}>
              <dl className="px-5 py-1">
                <DescRow label={tr('زمان')}>{span(b)}</DescRow>
                <DescRow label={tr('مکان')}>
                  {b.room ? <>{b.room.name}{b.room.floor ? `${sep()}${tr('طبقهٔ {0}', b.room.floor)}` : ''}{b.room.location ? `${sep()}${b.room.location.name}` : ''}</> : b.placeNote ?? '—'}
                </DescRow>
                <DescRow label={tr('برگزارکننده')}>{b.organizer.fullName}</DescRow>
                <DescRow label={tr('تأییدکننده')}>{b.approver?.fullName ?? <span className="text-rose-700">{tr('تعیین نشده')}</span>}</DescRow>
                {b.parkingSpaces > 0 && <DescRow label={tr('پارکینگ')}>{tr('{0} جا در {1}', localDigits(b.parkingSpaces), b.parking?.name ?? '—')}</DescRow>}
                {b.resources.length > 0 && <DescRow label={tr('تجهیزات')}>{b.resources.map((r) => `${r.name} (${typeLabel(r.type)})`).join('، ')}</DescRow>}
                {b.catering.length > 0 && <DescRow label={tr('پذیرایی')}>{b.catering.map((c) => `${isEnglish() ? c.labelEn : c.labelFa} × ${localDigits(c.quantity)}`).join('، ')}</DescRow>}
                {(b.project || b.company) && <DescRow label={tr('برای')}>{[b.project && `${b.project.code} — ${b.project.name}`, b.company?.legalName].filter(Boolean).join(sep())}</DescRow>}
                {b.meeting && (
                  <DescRow label={tr('جلسه در هیوامیس')}>
                    <span className="ltr font-mono text-xs">{b.meeting.code}</span>
                    {b.project && !inMiniApp() && <>{sep()}<Link className="text-brand-700 underline" to={`/projects/${b.project.id}`}>{tr('صورتجلسه در پروژه')}</Link></>}
                  </DescRow>
                )}
                {b.decisionNote && <DescRow label={tr('یادداشت تأییدکننده')}>{b.decisionNote}</DescRow>}
                {b.cancelReason && <DescRow label={tr('دلیل لغو')}>{b.cancelReason}</DescRow>}
              </dl>
              {b.description && <p className="whitespace-pre-line border-t border-ink-100 px-5 py-3 text-sm text-ink-700">{b.description}</p>}
            </Card>
            {(moves.length > 0 || canReschedule) && (
              <Card title={tr('گام بعد')}>
                <div className="space-y-2 p-4">
                  <WorkflowActions entity="booking" id={b.id} transitions={moves} onDone={() => void refetch()} />
                  {canReschedule && <Button size="sm" onClick={() => setRescheduling(true)}>{tr('تغییر زمان')}</Button>}
                </div>
              </Card>
            )}
          </div>
          <div className="space-y-5">
            <Card title={tr('حاضران')}>
              <ul className="divide-y divide-ink-100 text-sm" data-testid="booking-people">
                <li className="flex items-center gap-2 px-4 py-2"><span className="flex-1">{b.organizer.fullName}</span><Badge tone="info">{tr('برگزارکننده')}</Badge></li>
                {b.participants.map((p) => (
                  <li key={p.userId} className="flex items-center gap-2 px-4 py-2">
                    <span className="flex-1">{p.fullName}</span>
                    <Badge tone={p.response === 'ACCEPTED' ? 'success' : p.response === 'DECLINED' ? 'danger' : 'neutral'}>{RESPONSES[p.response]?.() ?? p.response}</Badge>
                  </li>
                ))}
                {b.guests.map((g) => (
                  <li key={g.id} className="flex items-center gap-2 px-4 py-2">
                    <span className="flex-1">{g.fullName}{g.company ? <span className="text-xs text-ink-500"> — {g.company}</span> : null}</span>
                    {g.isVip && <Badge tone="warning">VIP</Badge>}
                    <Badge tone="neutral">{tr('مهمان')}</Badge>
                  </li>
                ))}
              </ul>
              {mySeat && ['APPROVED', 'CONFIRMED', 'PENDING_APPROVAL'].includes(b.state) && (
                <div className="flex gap-2 border-t border-ink-100 px-4 py-3">
                  <Button size="sm" variant={mySeat.response === 'ACCEPTED' ? 'primary' : 'secondary'} onClick={() => void respond('ACCEPTED')}>{tr('می‌آیم')}</Button>
                  <Button size="sm" variant={mySeat.response === 'DECLINED' ? 'danger' : 'secondary'} onClick={() => void respond('DECLINED')}>{tr('نمی‌آیم')}</Button>
                </div>
              )}
            </Card>
          </div>
        </div>
      </PageBody>
      {editing && <BookingEditor booking={b} onClose={() => setEditing(false)} onSaved={() => void refetch()} />}
      {rescheduling && <Reschedule booking={b} onClose={() => setRescheduling(false)} />}
    </>
  );
}

/** A new time sends a booking back for approval; the dialog checks it first. */
function Reschedule({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const length = new Date(booking.endsAt).getTime() - new Date(booking.startsAt).getTime();
  const [start, setStart] = useState(booking.startsAt);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const end = new Date(new Date(start).getTime() + length).toISOString();
  const check = useAvailability({
    startsAt: start, endsAt: end, roomId: booking.room?.id, participantIds: booking.participants.map((p) => p.userId),
    resourceIds: booking.resources.map((r) => r.id), parkingSpaces: booking.parkingSpaces, excludeBookingId: booking.id,
  });
  const save = async () => {
    setBusy(true);
    try {
      await apiPost(`/workflow/booking/${booking.id}/transitions`, { action: 'reschedule', reason, payload: { startsAt: start, endsAt: end } });
      toast(tr('زمان تازه برای تأیید فرستاده شد.'));
      await qc.invalidateQueries();
      onClose();
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open title={tr('تغییر زمان')} draftKey={`reschedule:${booking.id}`} onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
      <Button variant="primary" loading={busy} disabled={!reason.trim() || !check.data?.available} onClick={() => void save()}>{tr('فرستادن برای تأیید')}</Button>
    </>}>
      <div className="space-y-3">
        <Field label={tr('آغاز تازه')}><JalaliDateInput mode="datetime" value={start} onChange={setStart} id="reschedule-start" /></Field>
        <Conflicts check={check} onPick={(s) => setStart(s)} />
        <Field label={tr('دلیل')} required><Textarea rows={2} aria-label={tr('دلیل')} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <p className="text-xs text-ink-500">{tr('رزرو دوباره به تأیید می‌رود و اتاق و افراد تا قطعی شدن دوباره آزاد می‌شوند.')}</p>
      </div>
    </Modal>
  );
}

/* ── whether a time works ─────────────────────────────────────────────────── */

interface Ask { startsAt: string; endsAt: string; roomId?: string | null; participantIds: string[]; resourceIds?: string[]; parkingSpaces: number; seats?: number; features?: string[]; excludeBookingId?: string }

function useAvailability(ask: Ask) {
  const valid = !!ask.startsAt && !Number.isNaN(new Date(ask.startsAt).getTime());
  const [key, setKey] = useState(ask);
  // Asked once the person stops changing it, not at every keystroke.
  useEffect(() => { const t = setTimeout(() => setKey(ask), 300); return () => clearTimeout(t); }, [JSON.stringify(ask)]); // eslint-disable-line react-hooks/exhaustive-deps
  return useQuery<Availability>({
    queryKey: ['/bookings/availability', key],
    queryFn: () => apiPost('/bookings/availability', { ...key, roomId: key.roomId || undefined }),
    enabled: valid,
  });
}

function Conflicts({ check, onPick }: { check: ReturnType<typeof useAvailability>; onPick: (startsAt: string) => void }) {
  if (check.isFetching && !check.data) return <p className="flex items-center gap-2 text-xs text-ink-500"><Spinner className="size-3" />{tr('در حال بررسی تداخل…')}</p>;
  if (!check.data) return null;
  if (check.data.available) return <p className="text-xs text-emerald-700" data-testid="booking-free">✓ {tr('این زمان آزاد است.')}</p>;
  return (
    <div className="space-y-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800" data-testid="booking-conflicts">
      <ul className="space-y-0.5">{check.data.conflicts.map((c, i) => <li key={i}>✗ {trx(c.messageFa)}{c.bookingCode ? <span className="ltr ms-1 font-mono">({c.bookingCode})</span> : null}</li>)}</ul>
      {check.data.suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-ink-700">
          <span>{tr('زمان‌های آزاد بعدی:')}</span>
          {check.data.suggestions.map((s) => <Button key={s.startsAt} size="sm" variant="ghost" onClick={() => onPick(s.startsAt)}>{formatDateTime(s.startsAt)}</Button>)}
        </div>
      )}
    </div>
  );
}

/* ── writing a booking ────────────────────────────────────────────────────── */

function nextHour() {
  const d = new Date(Date.now() + 3_600_000);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

export function BookingEditor({ booking, onClose, onSaved }: { booking?: Booking; onClose: () => void; onSaved?: (id: string) => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState(booking?.title ?? '');
  const [description, setDescription] = useState(booking?.description ?? '');
  const [kind, setKind] = useState<'INTERNAL' | 'EXTERNAL'>(booking?.kind ?? 'INTERNAL');
  const [start, setStart] = useState(booking?.startsAt ?? nextHour());
  const [minutes, setMinutes] = useState(booking ? Math.round((new Date(booking.endsAt).getTime() - new Date(booking.startsAt).getTime()) / 60_000) : 60);
  const [roomId, setRoomId] = useState<string | null>(booking?.room?.id ?? null);
  const [placeNote, setPlaceNote] = useState(booking?.placeNote ?? '');
  const [people, setPeople] = useState<Person[]>(booking?.participants.map((p) => ({ id: p.userId, fullName: p.fullName })) ?? []);
  const [guests, setGuests] = useState(booking?.guests.map((g) => ({ fullName: g.fullName, company: g.company ?? '', isVip: g.isVip })) ?? []);
  const [parking, setParking] = useState(booking?.parkingSpaces ?? 0);
  const [features, setFeatures] = useState<string[]>([]);
  const [catering, setCatering] = useState<Record<string, number>>(Object.fromEntries(booking?.catering.map((c) => [c.optionId, c.quantity]) ?? []));
  const [approverId, setApproverId] = useState(booking?.approverId ?? '');
  const [busy, setBusy] = useState<'draft' | 'send' | null>(null);
  const end = useMemo(() => new Date(new Date(start).getTime() + minutes * 60_000).toISOString(), [start, minutes]);

  const { data: approvers } = useQuery<{ approvers: Person[]; suggested: string | null }>({ queryKey: ['/bookings/approvers'], queryFn: () => apiGet('/bookings/approvers') });
  const { data: options } = useQuery<{ id: string; labelFa: string; labelEn: string }[]>({ queryKey: ['/booking/catering'], queryFn: () => apiGet('/booking/catering') });
  useEffect(() => { if (!approverId && approvers?.suggested) setApproverId(approvers.suggested); }, [approvers, approverId]);
  const check = useAvailability({
    startsAt: start, endsAt: end, roomId, participantIds: people.map((p) => p.id), parkingSpaces: parking,
    seats: people.length + guests.length + 1, features, excludeBookingId: booking?.id,
  });
  const rooms = check.data?.freeRooms ?? [];

  const body = () => ({
    title: title.trim(), description: description.trim() || undefined, kind, startsAt: start, endsAt: end,
    roomId, placeNote: roomId ? undefined : placeNote.trim() || undefined,
    participantIds: people.map((p) => p.id), parkingSpaces: parking, approverId: approverId || null,
    guests: guests.filter((g) => g.fullName.trim().length >= 2).map((g) => ({ fullName: g.fullName.trim(), company: g.company.trim() || undefined, isVip: g.isVip })),
    catering: Object.entries(catering).filter(([, q]) => q > 0).map(([optionId, quantity]) => ({ optionId, quantity })),
  });
  const save = async (send: boolean) => {
    setBusy(send ? 'send' : 'draft');
    try {
      const saved = booking ? await apiPut<Booking>(`/bookings/${booking.id}`, body()) : await apiPost<Booking>('/bookings', body());
      if (send) await apiPost(`/workflow/booking/${saved.id}/transitions`, { action: 'submit' });
      toast(send ? tr('رزرو برای تأیید فرستاده شد.') : draft ? tr('پیش‌نویس رزرو ذخیره شد.') : tr('رزرو ویرایش شد.'));
      await qc.invalidateQueries();
      onClose();
      if (onSaved) onSaved(saved.id); else navigate(`/bookings/${saved.id}`);
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(null); }
  };
  const ready = title.trim().length >= 3 && !Number.isNaN(new Date(start).getTime());
  // Past its draft only the system administrator edits it (ADR-110): saved as it stands, at the stage it is.
  const draft = !booking || ['DRAFT', 'CHANGES_REQUESTED'].includes(booking.state);

  return (
    <Modal open wide title={booking ? tr('ویرایش رزرو {0}', booking.code) : tr('رزرو تازه')} onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
      {draft ? <>
        <Button loading={busy === 'draft'} disabled={!ready || !!busy} onClick={() => void save(false)}>{tr('ذخیرهٔ پیش‌نویس')}</Button>
        <Button variant="primary" loading={busy === 'send'} disabled={!ready || !!busy || !approverId} onClick={() => void save(true)}>{tr('ذخیره و فرستادن برای تأیید')}</Button>
      </> : <Button variant="primary" loading={busy === 'draft'} disabled={!ready || !!busy} onClick={() => void save(false)}>{tr('ذخیره')}</Button>}
    </>}>
      <div className="grid gap-4 md:grid-cols-2" data-testid="booking-editor">
        <div className="space-y-3">
          <Field label={tr('عنوان جلسه')} required><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('آغاز')} required><JalaliDateInput mode="datetime" value={start} onChange={setStart} id="booking-start" /></Field>
            <Field label={tr('مدت')}>
              <Select value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))}>
                {DURATIONS.map((m) => <option key={m} value={m}>{m < 60 ? tr('{0} دقیقه', localDigits(m)) : tr('{0} ساعت', localDigits(m / 60))}</option>)}
              </Select>
            </Field>
          </div>
          <Field label={tr('نوع')}>
            <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="INTERNAL">{tr('درون‌سازمانی')}</option>
              <option value="EXTERNAL">{tr('با مهمان بیرونی')}</option>
            </Select>
          </Field>
          <Group label={tr('همکاران دعوت‌شده')}><PeoplePicker picked={people} onPick={setPeople} /></Group>
          <Group label={tr('مهمانان بیرونی')} hint={tr('پذیرش، آن‌ها را با نام می‌شناسد.')}>
            <div className="space-y-2">
              {guests.map((g, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input value={g.fullName} placeholder={tr('نام')} aria-label={tr('نام مهمان')} onChange={(e) => setGuests(guests.map((x, j) => (j === i ? { ...x, fullName: e.target.value } : x)))} />
                  <Input value={g.company} placeholder={tr('شرکت')} aria-label={tr('شرکت مهمان')} onChange={(e) => setGuests(guests.map((x, j) => (j === i ? { ...x, company: e.target.value } : x)))} />
                  <Button size="sm" variant="ghost" aria-label={tr('برداشتن مهمان')} onClick={() => setGuests(guests.filter((_, j) => j !== i))}>×</Button>
                </div>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setGuests([...guests, { fullName: '', company: '', isVip: false }])}>{tr('افزودن مهمان')}</Button>
            </div>
          </Group>
          <Field label={tr('توضیح و دستور جلسه')}><Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>

        <div className="space-y-3">
          <Group label={tr('امکانات لازم')}>
            <div className="flex flex-wrap gap-1.5">
              {RESOURCE_FEATURES.map((f) => {
                const on = features.includes(f);
                return <button key={f} type="button" aria-pressed={on} onClick={() => setFeatures(on ? features.filter((x) => x !== f) : [...features, f])}
                  className={cx('rounded-full px-2.5 py-1 text-xs ring-1 ring-inset', on ? 'bg-brand-50 text-brand-700 ring-brand-200' : 'text-ink-600 ring-ink-200')}>{featureLabel(f)}</button>;
              })}
            </div>
          </Group>
          <Group label={tr('اتاق')} hint={tr('اتاق‌هایی که در این زمان آزادند و جای همه را دارند.')}>
            <ul className="max-h-52 divide-y divide-ink-100 overflow-y-auto rounded-lg ring-1 ring-inset ring-ink-200" data-testid="free-rooms">
              <li>
                <button type="button" onClick={() => setRoomId(null)} aria-pressed={!roomId} className={cx('w-full px-3 py-2 text-start text-sm hover:bg-ink-50', !roomId && 'bg-brand-50')}>{tr('جای دیگری (بی‌رزرو اتاق)')}</button>
              </li>
              {booking?.room && !rooms.some((r) => r.id === booking.room!.id) && roomId === booking.room.id && (
                <li className="px-3 py-2 text-sm text-rose-700">{booking.room.name} — {tr('در این زمان آزاد نیست')}</li>
              )}
              {rooms.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => setRoomId(r.id)} aria-pressed={roomId === r.id} className={cx('flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-ink-50', roomId === r.id && 'bg-brand-50')}>
                    <span className="flex-1">{r.name}<span className="block text-xs text-ink-500">{tr('{0} نفر', localDigits(r.capacity))}{r.floor ? `${sep()}${tr('طبقهٔ {0}', r.floor)}` : ''}{r.features.length ? `${sep()}${r.features.map(featureLabel).join(isEnglish() ? ', ' : '، ')}` : ''}</span></span>
                    {roomId === r.id && <span className="text-xs text-brand-700">✓</span>}
                  </button>
                </li>
              ))}
            </ul>
          </Group>
          {!roomId && <Field label={tr('کجا')}><Input value={placeNote} onChange={(e) => setPlaceNote(e.target.value)} placeholder={tr('دفتر مشتری، اتاق مدیرعامل، …')} /></Field>}
          <Conflicts check={check} onPick={setStart} />
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('جای پارک')}><Input type="number" min={0} max={50} value={parking} onChange={(e) => setParking(Math.max(0, Math.min(50, Number(e.target.value) || 0)))} /></Field>
            <Field label={tr('تأییدکننده')} required>
              <Select value={approverId} onChange={(e) => setApproverId(e.target.value)}>
                <option value="">{tr('برگزینید')}</option>
                {approvers?.approvers.map((a) => <option key={a.id} value={a.id}>{a.fullName}{a.id === approvers.suggested ? ` (${tr('مدیر واحد')})` : ''}</option>)}
              </Select>
            </Field>
          </div>
          {!!options?.length && (
            <Group label={tr('پذیرایی')}>
              <div className="space-y-1.5">
                {options.map((o) => (
                  <div key={o.id} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1">{isEnglish() ? o.labelEn : o.labelFa}</span>
                    <div className="w-24 shrink-0">
                      <Input type="number" min={0} max={500} aria-label={tr('تعداد {0}', isEnglish() ? o.labelEn : o.labelFa)} value={catering[o.id] ?? 0}
                        onChange={(e) => setCatering({ ...catering, [o.id]: Math.max(0, Math.min(500, Number(e.target.value) || 0)) })} />
                    </div>
                  </div>
                ))}
              </div>
            </Group>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * A caption for a control made of several (a list of rooms, chips, rows): a <label> around buttons
 * would give the first of them the whole caption and list as its name.
 */
function Group({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="block min-w-0">
      <legend className="mb-1 text-xs font-bold text-ink-700">{label}</legend>
      {children}
      {hint && <p className="mt-1 text-[12.5px] text-ink-500">{hint}</p>}
    </fieldset>
  );
}

/** Colleagues by name, to invite. */
function PeoplePicker({ picked, onPick }: { picked: Person[]; onPick: (p: Person[]) => void }) {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const { data, isLoading } = useQuery<Person[]>({ queryKey: ['/people', q], queryFn: () => apiGet('/people', { q: q || undefined }) });
  const rows = (data ?? []).filter((p) => p.id !== user?.id);
  const toggle = (p: Person) => onPick(picked.some((x) => x.id === p.id) ? picked.filter((x) => x.id !== p.id) : [...picked, { id: p.id, fullName: p.fullName }]);
  return (
    <div className="space-y-2">
      {picked.length > 0 && <div className="flex flex-wrap gap-1.5">{picked.map((p) => <button key={p.id} type="button" onClick={() => toggle(p)}><Badge tone="info">{p.fullName} ×</Badge></button>)}</div>}
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('نام همکار')} aria-label={tr('جستجوی همکار')} />
      <ul className="max-h-40 divide-y divide-ink-100 overflow-y-auto rounded-lg ring-1 ring-inset ring-ink-200" aria-label={tr('همکاران')}>
        {isLoading ? <li className="p-3"><Spinner className="size-4" /></li> : rows.slice(0, 30).map((p) => {
          const on = picked.some((x) => x.id === p.id);
          return (
            <li key={p.id}>
              <button type="button" onClick={() => toggle(p)} aria-pressed={on} className={cx('flex w-full items-center gap-2 px-3 py-1.5 text-start text-sm hover:bg-ink-50', on && 'bg-brand-50')}>
                <span className="flex-1">{p.fullName}{p.jobTitle && <span className="text-xs text-ink-500"> — {p.jobTitle}</span>}</span>
                {on && <span className="text-xs text-brand-700">✓</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
