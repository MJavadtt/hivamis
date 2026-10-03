import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PERMISSIONS, ROLE_LABELS } from '@hiva/contracts';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction } from '../hooks/queries';
import { PageBody, PageHeader } from '../components/Shell';
import { JalaliDateInput } from '../components/JalaliDateInput';
import { Badge, Button, Card, EmptyState, Field, Select, Textarea } from '../components/ui';
import { formatDate, localDigits } from '../lib/format';
import { pair, tr, trx } from '../i18n';

interface Delegation {
  id: string; fromUserId: string; toUserId: string; fromName: string; toName: string;
  permissions: string[]; roles: string[]; startsAt: string; endsAt: string; reason: string;
  status: 'ACTIVE' | 'SCHEDULED' | 'EXPIRED' | 'REVOKED';
}
const STATUS: Record<Delegation['status'], { fa: string; tone: 'success' | 'info' | 'neutral' | 'danger' }> = {
  ACTIVE: { fa: tr('فعال'), tone: 'success' }, SCHEDULED: { fa: tr('برنامه‌ریزی‌شده'), tone: 'info' },
  EXPIRED: { fa: tr('پایان‌یافته'), tone: 'neutral' }, REVOKED: { fa: tr('لغوشده'), tone: 'danger' },
};
const permFa = (p: string) => trx((PERMISSIONS as Record<string, string>)[p] ?? p);
const roleFa = (r: string) => pair((ROLE_LABELS as Record<string, { fa: string; en: string }>)[r]) || r;

/**
 * Lend your authority for a while, formally — instead of your password. What you can lend is
 * exactly what you hold; the delegate's actions are recorded as done on your behalf; you can
 * end it early.
 */
export default function Delegations() {
  const { user } = useAuth();
  const { data, refetch } = useQuery<Delegation[]>({ queryKey: ['/delegations'], queryFn: () => apiGet('/delegations') });
  const { data: users } = useQuery<{ items: { id: string; fullName: string; jobTitle: string | null }[] }>({
    queryKey: ['/users'], queryFn: () => apiGet('/users', { pageSize: 100 }),
  });
  const [toUserId, setTo] = useState('');
  const [perms, setPerms] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [startsAt, setStart] = useState('');
  const [endsAt, setEnd] = useState('');
  const [reason, setReason] = useState('');

  const grant = useAction(
    () => apiPost('/delegations', { toUserId, permissions: perms, roles, startsAt: startsAt || undefined, endsAt, reason }),
    tr('تفویض ثبت شد — با توکن بعدیِ گیرنده فعال می‌شود.'),
  );
  const revoke = useAction((id: string) => apiPost(`/delegations/${id}/revoke`), tr('تفویض لغو شد.'));

  const own = (user?.permissions ?? []).filter((p) => !user?.delegated?.[p]);
  const ownRoles = (user?.roles ?? []).filter((r) => !user?.delegatedRoles?.[r]);
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const given = (data ?? []).filter((d) => d.fromUserId === user?.id);
  const received = (data ?? []).filter((d) => d.toUserId === user?.id);

  return (
    <>
      <PageHeader title={tr('تفویض اختیار')} subtitle={tr('به‌جای رمز عبور: اختیار خود را برای مدتی مشخص، با دامنهٔ مشخص و دلیل، به کسی بسپارید — هر کاری که با آن انجام شود به نام شما ثبت می‌شود')} />
      <PageBody>
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title={tr('تفویض جدید')} subtitle={tr('فقط آنچه خودتان دارید قابل تفویض است؛ حداکثر ۹۰ روز')}>
            <form className="space-y-3 px-4 py-3" onSubmit={(e) => { e.preventDefault(); grant.mutate(undefined, { onSuccess: () => { setPerms([]); setRoles([]); setReason(''); setEnd(''); void refetch(); } }); }}>
              <Field label={tr('به')} required>
                <Select value={toUserId} onChange={(e) => setTo(e.target.value)} aria-label={tr('گیرنده')}>
                  <option value="">{tr('— انتخاب —')}</option>
                  {users?.items.filter((u) => u.id !== user?.id).map((u) => <option key={u.id} value={u.id}>{u.fullName}{u.jobTitle ? ` — ${trx(u.jobTitle)}` : ''}</option>)}
                </Select>
              </Field>
              <Field label={tr('دسترسی‌ها')} hint={tr('آنچه گیرنده در این مدت می‌تواند انجام دهد')}>
                <div className="grid max-h-48 grid-cols-1 gap-1 overflow-auto rounded-lg bg-ink-50/60 p-2 text-xs sm:grid-cols-2" data-testid="permission-picker">
                  {own.map((p) => (
                    <label key={p} className="flex cursor-pointer items-center gap-2">
                      <input type="checkbox" checked={perms.includes(p)} onChange={() => toggle(perms, setPerms, p)} aria-label={p} />
                      <span>{permFa(p)}</span>
                    </label>
                  ))}
                </div>
              </Field>
              {ownRoles.length > 0 && (
                <Field label={tr('نقش‌های تأییدکننده')} hint={tr('برای فرم‌هایی که تأییدکننده‌شان یک نقش است')}>
                  <div className="flex flex-wrap gap-3 text-xs">
                    {ownRoles.map((r) => (
                      <label key={r} className="flex cursor-pointer items-center gap-2">
                        <input type="checkbox" checked={roles.includes(r)} onChange={() => toggle(roles, setRoles, r)} aria-label={r} />
                        <span>{roleFa(r)}</span>
                      </label>
                    ))}
                  </div>
                </Field>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label={tr('از')} hint={tr('خالی یعنی اکنون')}><JalaliDateInput value={startsAt} onChange={setStart} mode="datetime" id="delegation-from" /></Field>
                <Field label={tr('تا')} required><JalaliDateInput value={endsAt} onChange={setEnd} mode="datetime" id="delegation-to" /></Field>
              </div>
              <Field label={tr('دلیل')} required>
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} aria-label={tr('دلیل')} />
              </Field>
              <Button type="submit" variant="primary" loading={grant.isPending} disabled={!toUserId || !endsAt || !reason.trim() || (perms.length === 0 && roles.length === 0)}>{tr('ثبت تفویض')}</Button>
            </form>
          </Card>

          <div className="space-y-5">
            <List title={tr('تفویض‌های من به دیگران')} items={given} who={(d) => d.toName} empty={tr('چیزی تفویض نکرده‌اید')} onRevoke={(id) => revoke.mutate(id, { onSuccess: () => void refetch() })} />
            <List title={tr('اختیاراتی که به من داده شده')} items={received} who={(d) => tr('از طرف {0}', d.fromName)} empty={tr('اختیاری به شما تفویض نشده')} onRevoke={(id) => revoke.mutate(id, { onSuccess: () => void refetch() })} />
          </div>
        </div>
      </PageBody>
    </>
  );
}

function List({ title, items, who, empty, onRevoke }: {
  title: string; items: Delegation[]; who: (d: Delegation) => string; empty: string; onRevoke: (id: string) => void;
}) {
  return (
    <Card title={title}>
      {!items.length ? <EmptyState title={empty} /> : (
        <ul className="divide-y divide-ink-100" data-testid="delegation-list">
          {items.map((d) => (
            <li key={d.id} className="px-4 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink-800">{who(d)}</span>
                <Badge tone={STATUS[d.status].tone}>{pair(STATUS[d.status])}</Badge>
                <span className="text-ink-500">{tr('{0} تا {1}', formatDate(d.startsAt), formatDate(d.endsAt))}</span>
                {(d.status === 'ACTIVE' || d.status === 'SCHEDULED') && (
                  <Button size="sm" variant="ghost" className="ms-auto" onClick={() => onRevoke(d.id)}>{tr('لغو')}</Button>
                )}
              </div>
              <p className="mt-1 text-ink-600">
                {[...d.permissions.map(permFa), ...d.roles.map((r) => tr('نقش {0}', roleFa(r)))].join(tr('، '))}
                {' '}<span className="text-ink-400">({localDigits(d.permissions.length + d.roles.length)})</span> — {d.reason}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
