import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { weekdayShort } from '../lib/format';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import { useAction } from '../hooks/queries';
import { JalaliDateInput } from './JalaliDateInput';
import { Badge, Button, Card, EmptyState, Input, Select, Table, Td, Th, Tr } from './ui';
import { formatDate, localDigits } from '../lib/format';
import { loc, tr } from '../i18n';

interface Department { id: string; code: string; nameFa: string; workingDays: number[]; workStartHour: number | null; workEndHour: number | null; breakHours: number | null }
interface Org { workingDays: number[]; workStartHour: number; workEndHour: number; breakHours: number }
interface User { id: string; fullName: string; department?: { code: string } | null }
interface Leave { id: string; from: string; to: string; kind: string; note: string | null }

/** JS day numbers in the order the Iranian week runs: Saturday first. */
const WEEK = [6, 0, 1, 2, 3, 4, 5];

/**
 * One calendar per unit and per person, inheriting upward. A blank cell means "same as the
 * organisation"; a leave is a stretch of days with no working hours at all.
 */
export function WorkCalendars() {
  const { data: org } = useQuery<Org>({ queryKey: ['/organization'], queryFn: () => apiGet('/organization') });
  const { data: departments } = useQuery<Department[]>({ queryKey: ['/departments'], queryFn: () => apiGet('/departments') });
  return (
    <div className="space-y-5">
      <Card title={tr('تقویم واحدها')} subtitle={org ? tr('سازمان: {0} — {1} تا {2}، {3} ساعت استراحت. خالی یعنی مثل سازمان.', org.workingDays.map((d) => weekdayShort(WEEK.indexOf(d))).join(tr('، ')), localDigits(org.workStartHour), localDigits(org.workEndHour), localDigits(org.breakHours)) : undefined}>
        {!departments ? null : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr><Th>{tr('واحد')}</Th>{WEEK.map((d, i) => <Th key={d}>{weekdayShort(i)}</Th>)}<Th>{tr('شروع')}</Th><Th>{tr('پایان')}</Th><Th>{tr('استراحت')}</Th><Th /></tr>
            </thead>
            <tbody data-testid="unit-calendars">
              {departments.map((d) => <DepartmentRow key={d.code} department={d} org={org} />)}
            </tbody>
          </Table>
        )}
      </Card>
      <Leaves />
    </div>
  );
}

function DepartmentRow({ department, org }: { department: Department; org: Org | undefined }) {
  const [days, setDays] = useState<number[]>(department.workingDays);
  const [start, setStart] = useState(department.workStartHour?.toString() ?? '');
  const [end, setEnd] = useState(department.workEndHour?.toString() ?? '');
  const [brk, setBrk] = useState(department.breakHours?.toString() ?? '');
  const save = useAction(
    () => apiPatch(`/departments/${department.code}/calendar`, {
      workingDays: days.length ? days : null,
      workStartHour: start === '' ? null : Number(start),
      workEndHour: end === '' ? null : Number(end),
      breakHours: brk === '' ? null : Number(brk),
    }),
    tr('تقویم {0} ذخیره شد.', department.nameFa),
  );
  const effective = days.length ? days : (org?.workingDays ?? []);
  const inherited = days.length === 0;
  return (
    <Tr>
      <Td><p className="text-sm">{loc(department, 'name')}</p><span className="text-xs text-ink-500">{department.code}{inherited && tr(' · روزها مثل سازمان')}</span></Td>
      {WEEK.map((d) => (
        <Td key={d}>
          <input type="checkbox" className="h-4 w-4 rounded border-ink-300 text-brand-600" aria-label={`${department.code} ${weekdayShort(WEEK.indexOf(d))}`} checked={effective.includes(d)}
            onChange={(e) => {
              const base = inherited ? [...effective] : [...days];
              setDays(e.target.checked ? [...new Set([...base, d])] : base.filter((x) => x !== d));
            }} />
        </Td>
      ))}
      <Td><Input value={start} onChange={(e) => setStart(e.target.value)} placeholder={String(org?.workStartHour ?? '')} className="w-14 text-xs" inputMode="numeric" aria-label={tr('{0} شروع', department.code)} /></Td>
      <Td><Input value={end} onChange={(e) => setEnd(e.target.value)} placeholder={String(org?.workEndHour ?? '')} className="w-14 text-xs" inputMode="numeric" aria-label={tr('{0} پایان', department.code)} /></Td>
      <Td><Input value={brk} onChange={(e) => setBrk(e.target.value)} placeholder={String(org?.breakHours ?? '')} className="w-14 text-xs" inputMode="numeric" aria-label={tr('{0} استراحت', department.code)} /></Td>
      <Td><Button size="sm" loading={save.isPending} onClick={() => save.mutate(undefined)}>{tr('ذخیره')}</Button></Td>
    </Tr>
  );
}

const KINDS: Record<string, string> = { VACATION: tr('مرخصی'), SICK: tr('استعلاجی'), MISSION: tr('مأموریت'), OTHER: tr('سایر') };

function Leaves() {
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState('VACATION');
  const [note, setNote] = useState('');
  const { data: users } = useQuery<{ items: User[] }>({ queryKey: ['/users'], queryFn: () => apiGet('/users', { pageSize: 100 }) });
  const { data: leaves, refetch } = useQuery<Leave[]>({
    queryKey: ['/users', userId, 'leaves'], queryFn: () => apiGet(`/users/${userId}/leaves`), enabled: !!userId,
  });
  const add = useAction(
    () => apiPost(`/users/${userId}/leaves`, { from, to: to || from, kind, note: note || undefined }),
    tr('مرخصی ثبت شد.'),
  );
  const remove = useAction((id: string) => apiDelete(`/users/${userId}/leaves/${id}`), tr('مرخصی حذف شد.'));

  return (
    <Card title={tr('مرخصی‌ها و غیبت‌ها')} subtitle={tr('در این روزها شخص ساعت کاری ندارد: مهلت‌هایی که با اوست نمی‌سوزد و کاری روی این روزها زمان‌بندی نمی‌شود')}>
      <div className="flex flex-wrap items-end gap-2 px-4 py-3">
        <label className="text-xs text-ink-600"><span className="mb-1 block">{tr('شخص')}</span>
          <Select value={userId} onChange={(e) => setUserId(e.target.value)} className="w-56 text-xs" aria-label={tr('شخص')}>
            <option value="">{tr('— انتخاب —')}</option>
            {users?.items.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
          </Select>
        </label>
        <label className="text-xs text-ink-600"><span className="mb-1 block">{tr('از')}</span><JalaliDateInput value={from} onChange={setFrom} id="leave-from" /></label>
        <label className="text-xs text-ink-600"><span className="mb-1 block">{tr('تا')}</span><JalaliDateInput value={to} onChange={setTo} id="leave-to" /></label>
        <label className="text-xs text-ink-600"><span className="mb-1 block">{tr('نوع')}</span>
          <Select value={kind} onChange={(e) => setKind(e.target.value)} className="w-auto text-xs" aria-label={tr('نوع مرخصی')}>
            {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </label>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('یادداشت')} className="w-40 text-xs" aria-label={tr('یادداشت')} />
        <Button size="sm" variant="primary" disabled={!userId || !from} loading={add.isPending}
          onClick={() => add.mutate(undefined, { onSuccess: () => { setFrom(''); setTo(''); setNote(''); void refetch(); } })}>{tr('ثبت مرخصی')}</Button>
      </div>
      {userId && (!leaves?.length ? <EmptyState title={tr('مرخصی‌ای ثبت نشده')} /> : (
        <ul className="divide-y divide-ink-100" data-testid="leaves">
          {leaves.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
              <span><Badge tone="neutral">{KINDS[l.kind] ?? l.kind}</Badge>{' '}{tr('{0} تا {1}', formatDate(l.from), formatDate(l.to))}{l.note && <span className="text-ink-500"> — {l.note}</span>}</span>
              <Button size="sm" variant="ghost" onClick={() => remove.mutate(l.id, { onSuccess: () => void refetch() })}>{tr('حذف')}</Button>
            </li>
          ))}
        </ul>
      ))}
    </Card>
  );
}
