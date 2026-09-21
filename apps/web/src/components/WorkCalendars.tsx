import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { JALALI_WEEKDAYS } from '../lib/format';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import { useAction } from '../hooks/queries';
import { JalaliDateInput } from './JalaliDateInput';
import { Badge, Button, Card, EmptyState, Input, Select, Table, Td, Th, Tr } from './ui';
import { formatDate, toPersianDigits } from '../lib/format';

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
      <Card title="تقویم واحدها" subtitle={org ? `سازمان: ${org.workingDays.map((d) => JALALI_WEEKDAYS[WEEK.indexOf(d)]).join('، ')} — ${toPersianDigits(org.workStartHour)} تا ${toPersianDigits(org.workEndHour)}، ${toPersianDigits(org.breakHours)} ساعت استراحت. خالی یعنی مثل سازمان.` : undefined}>
        {!departments ? null : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr><Th>واحد</Th>{WEEK.map((d, i) => <Th key={d}>{JALALI_WEEKDAYS[i]}</Th>)}<Th>شروع</Th><Th>پایان</Th><Th>استراحت</Th><Th /></tr>
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
    `تقویم ${department.nameFa} ذخیره شد.`,
  );
  const effective = days.length ? days : (org?.workingDays ?? []);
  const inherited = days.length === 0;
  return (
    <Tr>
      <Td><p className="text-sm">{department.nameFa}</p><span className="text-xs text-ink-500">{department.code}{inherited && ' · روزها مثل سازمان'}</span></Td>
      {WEEK.map((d) => (
        <Td key={d}>
          <input type="checkbox" className="h-4 w-4 rounded border-ink-300 text-brand-600" aria-label={`${department.code} ${JALALI_WEEKDAYS[WEEK.indexOf(d)]}`} checked={effective.includes(d)}
            onChange={(e) => {
              const base = inherited ? [...effective] : [...days];
              setDays(e.target.checked ? [...new Set([...base, d])] : base.filter((x) => x !== d));
            }} />
        </Td>
      ))}
      <Td><Input value={start} onChange={(e) => setStart(e.target.value)} placeholder={String(org?.workStartHour ?? '')} className="w-14 text-xs" inputMode="numeric" aria-label={`${department.code} شروع`} /></Td>
      <Td><Input value={end} onChange={(e) => setEnd(e.target.value)} placeholder={String(org?.workEndHour ?? '')} className="w-14 text-xs" inputMode="numeric" aria-label={`${department.code} پایان`} /></Td>
      <Td><Input value={brk} onChange={(e) => setBrk(e.target.value)} placeholder={String(org?.breakHours ?? '')} className="w-14 text-xs" inputMode="numeric" aria-label={`${department.code} استراحت`} /></Td>
      <Td><Button size="sm" loading={save.isPending} onClick={() => save.mutate(undefined)}>ذخیره</Button></Td>
    </Tr>
  );
}

const KINDS: Record<string, string> = { VACATION: 'مرخصی', SICK: 'استعلاجی', MISSION: 'مأموریت', OTHER: 'سایر' };

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
    'مرخصی ثبت شد.',
  );
  const remove = useAction((id: string) => apiDelete(`/users/${userId}/leaves/${id}`), 'مرخصی حذف شد.');

  return (
    <Card title="مرخصی‌ها و غیبت‌ها" subtitle="در این روزها شخص ساعت کاری ندارد: مهلت‌هایی که با اوست نمی‌سوزد و کاری روی این روزها زمان‌بندی نمی‌شود">
      <div className="flex flex-wrap items-end gap-2 px-4 py-3">
        <label className="text-xs text-ink-600"><span className="mb-1 block">شخص</span>
          <Select value={userId} onChange={(e) => setUserId(e.target.value)} className="w-56 text-xs" aria-label="شخص">
            <option value="">— انتخاب —</option>
            {users?.items.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
          </Select>
        </label>
        <label className="text-xs text-ink-600"><span className="mb-1 block">از</span><JalaliDateInput value={from} onChange={setFrom} id="leave-from" /></label>
        <label className="text-xs text-ink-600"><span className="mb-1 block">تا</span><JalaliDateInput value={to} onChange={setTo} id="leave-to" /></label>
        <label className="text-xs text-ink-600"><span className="mb-1 block">نوع</span>
          <Select value={kind} onChange={(e) => setKind(e.target.value)} className="w-auto text-xs" aria-label="نوع مرخصی">
            {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </label>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="یادداشت" className="w-40 text-xs" aria-label="یادداشت" />
        <Button size="sm" variant="primary" disabled={!userId || !from} loading={add.isPending}
          onClick={() => add.mutate(undefined, { onSuccess: () => { setFrom(''); setTo(''); setNote(''); void refetch(); } })}>ثبت مرخصی</Button>
      </div>
      {userId && (!leaves?.length ? <EmptyState title="مرخصی‌ای ثبت نشده" /> : (
        <ul className="divide-y divide-ink-100" data-testid="leaves">
          {leaves.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
              <span><Badge tone="neutral">{KINDS[l.kind] ?? l.kind}</Badge> {formatDate(l.from)} تا {formatDate(l.to)}{l.note && <span className="text-ink-500"> — {l.note}</span>}</span>
              <Button size="sm" variant="ghost" onClick={() => remove.mutate(l.id, { onSuccess: () => void refetch() })}>حذف</Button>
            </li>
          ))}
        </ul>
      ))}
    </Card>
  );
}
