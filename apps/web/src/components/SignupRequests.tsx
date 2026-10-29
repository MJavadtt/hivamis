import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEPARTMENT_CODES, DEPARTMENT_LABELS, type DepartmentCode } from '@hiva/contracts';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, Modal, Select, Textarea, useToast } from './ui';
import { UnitTag } from './UnitTag';
import { pair, tr } from '../i18n';
import { roleName, useRoleCodes } from '../lib/roles';

/**
 * People asking to join (Hivamis task 4). Nothing is granted by signing up: the administrator of users
 * approves a request and chooses the unit and roles — never system administration, which is given one
 * by one in user management — or rejects it with a reason.
 */

interface Request {
  id: string; method: 'PHONE' | 'GOOGLE' | 'PASSWORD'; fullName: string; email: string; phone: string | null; departmentCode: string | null;
  note: string | null; status: 'PENDING' | 'APPROVED' | 'REJECTED'; createdAt: string; decidedAt: string | null; decisionNote: string | null;
  decidedBy: { fullName: string } | null;
}

const METHOD: Record<Request['method'], string> = { PHONE: tr('شمارهٔ همراه'), GOOGLE: tr('حساب گوگل'), PASSWORD: tr('ایمیل و رمز') };

export function SignupRequests() {
  const { can } = useAuth();
  const { data } = useQuery<Request[]>({ queryKey: ['/signup-requests'], queryFn: () => apiGet('/signup-requests') });
  const [approving, setApproving] = useState<Request | null>(null);
  const [rejecting, setRejecting] = useState<Request | null>(null);
  const pending = data?.filter((r) => r.status === 'PENDING') ?? [];
  const decided = data?.filter((r) => r.status !== 'PENDING').slice(0, 5) ?? [];

  return (
    <Card title={tr('درخواست‌های عضویت')} subtitle={tr('کسانی که با شمارهٔ همراه یا حساب گوگل درخواست عضویت داده‌اند. واحد و نقش را شما تعیین می‌کنید.')}
      action={can('admin.settings') ? <SignupSwitch /> : undefined}>
      {!pending.length ? <EmptyState title={tr('درخواستی در انتظار نیست')} /> : (
        <ul className="divide-y divide-ink-100" data-testid="signup-requests">
          {pending.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink-900">{r.fullName}{' '}<Badge tone="neutral">{METHOD[r.method]}</Badge>{r.method === 'PASSWORD' && <>{' '}<Badge tone="warning">{tr('تأییدنشده')}</Badge></>}</p>
                <p className="text-xs text-ink-500"><span className="ltr">{r.email}</span>{r.phone && <>{' · '}<span className="ltr">{r.phone}</span></>}{' · '}{formatDateTime(r.createdAt)}</p>
                {(r.departmentCode || r.note) && <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-600">{r.departmentCode && <UnitTag code={r.departmentCode} />}{r.note}</p>}
              </div>
              <Button size="sm" variant="primary" onClick={() => setApproving(r)}>{tr('تأیید و ساخت حساب')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setRejecting(r)}>{tr('رد')}</Button>
            </li>
          ))}
        </ul>
      )}
      {decided.length > 0 && (
        <ul className="border-t border-ink-100 px-4 py-2 text-xs text-ink-500">
          {decided.map((r) => (
            <li key={r.id} className="py-0.5">
              {r.fullName}{' — '}{r.status === 'APPROVED' ? tr('تأیید شد') : tr('رد شد')}{r.decidedBy && tr(' به دست {0}', r.decidedBy.fullName)}{r.decidedAt && ` · ${formatDateTime(r.decidedAt)}`}{r.decisionNote && ` · ${r.decisionNote}`}
            </li>
          ))}
        </ul>
      )}
      {approving && <Approve request={approving} onClose={() => setApproving(null)} />}
      {rejecting && <Reject request={rejecting} onClose={() => setRejecting(null)} />}
    </Card>
  );
}

function SignupSwitch() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery<{ enabled: boolean; phone: boolean; google: boolean }>({ queryKey: ['/settings/signup'], queryFn: () => apiGet('/settings/signup') });
  if (!data) return null;
  return (
    <Checkbox
      label={<span className="text-xs">{tr('پذیرش درخواست عضویت')}</span>}
      checked={data.enabled}
      onChange={async (e) => {
        try {
          await apiPatch('/settings/signup', { enabled: e.target.checked });
          await qc.invalidateQueries({ queryKey: ['/settings/signup'] });
          toast(e.target.checked ? tr('درخواست عضویت باز شد.') : tr('درخواست عضویت بسته شد.'));
        } catch (err) { toast((err as Error).message, 'danger'); }
      }}
    />
  );
}

function Approve({ request, onClose }: { request: Request; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [unit, setUnit] = useState<string>(request.departmentCode ?? '');
  const [roles, setRoles] = useState<string[]>([]);
  const [jobTitle, setJobTitle] = useState('');
  const [busy, setBusy] = useState(false);
  // The code's roles and the organisation's own (audit F-3); the system administrator is not given by approving a request.
  const assignable = useRoleCodes().filter((r) => r !== 'SUPER_ADMIN');
  const save = async () => {
    setBusy(true);
    try {
      await apiPost(`/signup-requests/${request.id}/approve`, { departmentCode: unit, roles, jobTitle: jobTitle || null });
      await qc.invalidateQueries({ queryKey: ['/signup-requests'] });
      await qc.invalidateQueries({ queryKey: ['/users'] });
      toast(tr('حساب «{0}» ساخته شد.', request.fullName));
      onClose();
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open title={tr('تأیید درخواست «{0}»', request.fullName)} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" loading={busy} disabled={!unit || !roles.length} onClick={() => void save()}>{tr('ساخت حساب')}</Button></>}>
      <div className="space-y-3">
        <p className="text-xs leading-6 text-ink-600">{request.method === 'PHONE'
          ? tr('با همین شمارهٔ همراه وارد می‌شود؛ رمز عبور را بعداً خودش در صفحهٔ خودش می‌گذارد.')
          : request.method === 'PASSWORD'
            ? tr('با همین ایمیل و رمزی که خودش برگزیده وارد می‌شود. نه ایمیل و نه شماره آزموده نشده است: پیش از تأیید، از درستی درخواست مطمئن شوید.')
            : tr('با همان حساب گوگل وارد می‌شود؛ رمز عبور را بعداً خودش در صفحهٔ خودش می‌گذارد.')}</p>
        <Field label={tr('واحد')} required>
          <Select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label={tr('واحد')}>
            <option value="">{tr('— انتخاب کنید —')}</option>
            {DEPARTMENT_CODES.map((c) => <option key={c} value={c}>{pair(DEPARTMENT_LABELS[c as DepartmentCode])}</option>)}
          </Select>
        </Field>
        <Field label={tr('نقش‌ها')} required hint={tr('دسترسی هر نقش همان است که در «نقش‌ها و دسترسی‌ها» داده‌اید.')}>
          <div className="grid gap-1 sm:grid-cols-2">
            {assignable.map((r) => (
              <Checkbox key={r} label={<span className="text-xs">{roleName(r)}</span>} checked={roles.includes(r)}
                onChange={(e) => setRoles((s) => (e.target.checked ? [...s, r] : s.filter((x) => x !== r)))} />
            ))}
          </div>
        </Field>
        <Field label={tr('سمت (اختیاری)')}><Input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} maxLength={120} /></Field>
      </div>
    </Modal>
  );
}

function Reject({ request, onClose }: { request: Request; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await apiPost(`/signup-requests/${request.id}/reject`, { note });
      await qc.invalidateQueries({ queryKey: ['/signup-requests'] });
      toast(tr('درخواست رد شد.'));
      onClose();
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open title={tr('رد درخواست «{0}»', request.fullName)} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button><Button variant="danger" loading={busy} disabled={note.trim().length < 3} onClick={() => void save()}>{tr('رد')}</Button></>}>
      <Field label={tr('دلیل')} required><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} aria-label={tr('دلیل')} /></Field>
    </Modal>
  );
}

/** The SMS sandbox's messages — what a provider would have sent — while no provider is set. */
export function SmsSandbox() {
  const { data } = useQuery<{ mode: string; messages: { id: string; phone: string; text: string; status: string; createdAt: string }[] }>({
    queryKey: ['/admin/sms-outbox'], queryFn: () => apiGet('/admin/sms-outbox'), refetchInterval: 5000,
  });
  if (!data || data.mode !== 'sandbox') return null;
  return (
    <Card title={tr('پیامک‌های محیط آزمایشی')} subtitle={tr('هنوز سرویس پیامکی تنظیم نشده؛ این‌ها پیامک‌هایی‌اند که فرستاده می‌شدند. در نصبی که مردم با آن کار می‌کنند، سرویس پیامک را تنظیم کنید.')}>
      {!data.messages.length ? <EmptyState title={tr('پیامکی نیست')} /> : (
        <ul className="divide-y divide-ink-100 text-sm" data-testid="sms-sandbox">
          {data.messages.slice(0, 10).map((m) => (
            <li key={m.id} className="flex gap-3 px-4 py-2"><span className="ltr w-28 shrink-0 text-ink-500">{m.phone}</span><span className="min-w-0 flex-1">{m.text}</span><span className="text-[12.5px] text-ink-400">{formatDateTime(m.createdAt)}</span></li>
          ))}
        </ul>
      )}
    </Card>
  );
}
