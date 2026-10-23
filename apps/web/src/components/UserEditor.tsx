import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  DEPARTMENT_CODES, DEPARTMENT_LABELS, OVERSIGHT_GRANTOR_ROLE, OVERSIGHT_PERMISSIONS, PERMISSIONS, PERMISSION_GROUPS,
  permissionGroup, type DepartmentCode, type Permission,
} from '@hiva/contracts';
import { api, apiGet, apiPatch, apiPost, apiPut } from '../lib/api';
import { useAuth } from '../lib/auth';
import { localDigits } from '../lib/format';
import { loc, pair, tr, trx } from '../i18n';
import { Badge, Button, Checkbox, Field, Input, LoadingBlock, Modal, Select, Tabs, cx, useToast } from './ui';
import type { PositionRow } from './Positions';
import { useTeams, useUnits } from './UnitTag';

/**
 * One person's account, in the administrator's hands (audit F-3; owner's report, 2026-10-23):
 *
 * - details — name, the user name they sign in with, mobile, unit, position, team and roles. A
 *   position's usual roles are offered when it is chosen, ticked for the administrator to confirm;
 * - permissions — beyond the roles: given to this person, or withheld from them;
 * - password — set by the administrator, the person's sign-ins ended with the old one;
 * - account — active or not, removal, and, for the system administrator, working in the account.
 */

export interface EditableUser {
  id: string; fullName: string; email?: string; phone?: string | null; isActive?: boolean;
  department?: { code: string } | null; positionId?: string | null; team?: { id: string } | null; roles?: { role: { code: string } }[];
}
interface RoleOption { code: string; nameFa: string; nameEn: string; fullAccess?: boolean }

type TabKey = 'details' | 'permissions' | 'password' | 'account';

export function UserEditor({ user, onClose, onSaved }: { user: EditableUser; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const { can } = useAuth();
  const [tab, setTab] = useState<TabKey>('details');
  const tabs: { key: TabKey; label: string }[] = [
    { key: 'details', label: tr('مشخصات و نقش‌ها') },
    ...(can('admin.roles') ? [{ key: 'permissions' as const, label: tr('دسترسی‌ها') }] : []),
    { key: 'password', label: tr('رمز عبور') },
    { key: 'account', label: tr('حساب') },
  ];
  return (
    <Modal open wide title={tr('مدیریت «{0}»', user.fullName)} onClose={onClose}>
      <div className="space-y-3" data-testid="user-editor">
        <Tabs active={tab} onChange={(k) => setTab(k as TabKey)} tabs={tabs} />
        {tab === 'details' && <Details user={user} onClose={onClose} onSaved={onSaved} />}
        {tab === 'permissions' && <PersonPermissions user={user} />}
        {tab === 'password' && <SetPassword user={user} />}
        {tab === 'account' && <Account user={user} onClose={onClose} onSaved={onSaved} />}
      </div>
    </Modal>
  );
}

function Details({ user, onClose, onSaved }: { user: EditableUser; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const toast = useToast();
  const { data: roles } = useQuery<RoleOption[]>({ queryKey: ['/roles'], queryFn: () => apiGet('/roles') });
  const { data: positions } = useQuery<PositionRow[]>({ queryKey: ['/positions'], queryFn: () => apiGet('/positions') });
  const { data: units } = useUnits();
  const { data: teams } = useTeams();
  const [fullName, setFullName] = useState(user.fullName);
  const [email, setEmail] = useState(user.email ?? '');
  const [phone, setPhone] = useState(user.phone ?? '');
  const [unit, setUnit] = useState(user.department?.code ?? '');
  // A team of the person's unit (list 3, item 6); another unit's team does not travel with them.
  const [teamId, setTeamId] = useState(user.team?.id ?? '');
  const unitTeams = (teams ?? []).filter((t) => t.departmentCode === unit);
  const [positionId, setPositionId] = useState(user.positionId ?? '');
  const [picked, setPicked] = useState<string[]>((user.roles ?? []).map((r) => r.role.code));
  const [busy, setBusy] = useState(false);

  const choosePosition = (id: string) => {
    setPositionId(id);
    const p = positions?.find((x) => x.id === id);
    if (!p) return;
    // Its usual roles, offered: added to the ticks, for the administrator to keep or clear.
    setPicked((now) => [...new Set([...now, ...p.defaultRoleCodes])]);
    if (p.departmentCode && p.departmentCode !== unit) { setUnit(p.departmentCode); setTeamId(''); }
  };
  const save = async () => {
    setBusy(true);
    try {
      await apiPatch(`/users/${user.id}`, {
        departmentCode: unit || undefined, positionId: positionId || null, teamId: teamId || null, roleCodes: picked,
        ...(fullName.trim() && fullName.trim() !== user.fullName ? { fullName: fullName.trim() } : {}),
        ...(email.trim() && email.trim() !== (user.email ?? '') ? { email: email.trim() } : {}),
        ...(phone.trim() !== (user.phone ?? '') ? { phone: phone.trim() } : {}),
      });
      toast(tr('اطلاعات «{0}» ذخیره شد.', fullName.trim() || user.fullName), 'success');
      await onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('نام و نام خانوادگی')}><Input value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
        {user.email !== undefined && (
          <Field label={tr('نام کاربری (ایمیل)')}><Input value={email} onChange={(e) => setEmail(e.target.value)} className="ltr" type="email" /></Field>
        )}
        {user.phone !== undefined && (
          <Field label={tr('موبایل')}><Input value={phone} onChange={(e) => setPhone(e.target.value)} className="ltr" inputMode="tel" /></Field>
        )}
        <Field label={tr('سمت')}>
          <Select value={positionId} onChange={(e) => choosePosition(e.target.value)} aria-label={tr('سمت')}>
            <option value="">—</option>
            {(positions ?? []).map((p) => <option key={p.id} value={p.id}>{loc(p, 'name')}</option>)}
          </Select>
        </Field>
        <Field label={tr('واحد')}>
          <Select value={unit} onChange={(e) => { setUnit(e.target.value); setTeamId(''); }} aria-label={tr('واحد')}>
            {DEPARTMENT_CODES.map((c) => {
              const named = units?.find((u) => u.code === c);
              return <option key={c} value={c}>{named ? loc(named, 'name') : pair(DEPARTMENT_LABELS[c as DepartmentCode])}</option>;
            })}
          </Select>
        </Field>
        {unitTeams.length > 0 && (
          <Field label={tr('تیم')}>
            <Select value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label={tr('تیم')}>
              <option value="">—</option>
              {unitTeams.map((t) => <option key={t.id} value={t.id}>{loc(t, 'name')}</option>)}
            </Select>
          </Field>
        )}
      </div>
      <fieldset>
        <legend className="mb-1 text-xs font-bold text-ink-700">{tr('نقش‌ها')}</legend>
        <div className="grid max-h-56 gap-1 overflow-y-auto sm:grid-cols-2">
          {(roles ?? []).map((r) => (
            <Checkbox key={r.code} label={loc(r, 'name')} checked={picked.includes(r.code)}
              onChange={(e) => setPicked((now) => e.target.checked ? [...now, r.code] : now.filter((x) => x !== r.code))} />
          ))}
        </div>
        <p className="mt-2 text-[12.5px] text-ink-500">{tr('با تغییر نقش‌ها، نشست‌های این نفر بسته می‌شود تا دسترسی تازه همان دم اعمال شود.')}</p>
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{tr('انصراف')}</Button>
        <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!picked.length}>{tr('ذخیره')}</Button>
      </div>
    </div>
  );
}

const GROUPED = PERMISSION_GROUPS.map((g) => ({
  ...g, permissions: (Object.keys(PERMISSIONS) as Permission[]).filter((p) => permissionGroup(p) === g.key),
})).filter((g) => g.permissions.length);

interface PersonGrants { fromRoles: string[]; grant: string[]; deny: string[]; isSystemAdmin: boolean }

/**
 * Beyond the roles: a tick on a permission the roles do not give gives it to this person; clearing
 * one they do withholds it. The marks say which is which; «as the roles» undoes both.
 */
function PersonPermissions({ user }: { user: EditableUser }) {
  const toast = useToast();
  const { user: me } = useAuth();
  const { data, isLoading, refetch } = useQuery<PersonGrants>({ queryKey: [`/users/${user.id}/permissions`], queryFn: () => apiGet(`/users/${user.id}/permissions`) });
  const [grant, setGrant] = useState<Set<string> | null>(null);
  const [deny, setDeny] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const roles = useMemo(() => new Set(data?.fromRoles ?? []), [data]);
  const g = grant ?? new Set(data?.grant ?? []);
  const d = deny ?? new Set(data?.deny ?? []);
  // Oversight is given by the system administrator alone (audit F-5).
  const mayOversee = !!me?.roles.includes(OVERSIGHT_GRANTOR_ROLE) && !me.delegatedRoles?.[OVERSIGHT_GRANTOR_ROLE];
  if (isLoading || !data) return <LoadingBlock />;
  if (data.isSystemAdmin) {
    return <p className="rounded-lg bg-ink-50 p-3 text-sm text-ink-600">{tr('مدیر سیستم به همهٔ سامانه دسترسی دارد و دسترسی‌اش برای یک نفر کم یا زیاد نمی‌شود.')}</p>;
  }
  const on = (p: string) => (roles.has(p) || g.has(p)) && !d.has(p);
  const toggle = (p: string) => {
    const ng = new Set(g), nd = new Set(d);
    if (on(p)) { ng.delete(p); if (roles.has(p)) nd.add(p); } else { nd.delete(p); if (!roles.has(p)) ng.add(p); }
    setGrant(ng); setDeny(nd);
  };
  const reset = () => { setGrant(new Set()); setDeny(new Set()); };
  const save = async () => {
    setBusy(true);
    try {
      await apiPut(`/users/${user.id}/permissions`, { grant: [...g], deny: [...d] });
      toast(tr('دسترسی‌های «{0}» ذخیره شد و همان دم اعمال می‌شود.', user.fullName), 'success');
      setGrant(null); setDeny(null);
      await refetch();
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3" data-testid="person-permissions">
      <p className="text-[12.5px] text-ink-500">
        {tr('تیک‌ها همان دسترسی‌های نقش‌های این نفر است. تیک زدنِ آنچه نقش‌ها نمی‌دهند به خودِ او می‌دهد؛ برداشتنِ آنچه می‌دهند از خودِ او می‌گیرد.')}
        {' '}{tr('داده‌شده: {0} — گرفته‌شده: {1}', localDigits(g.size), localDigits(d.size))}
      </p>
      <div className="grid max-h-[50vh] gap-3 overflow-y-auto sm:grid-cols-2">
        {GROUPED.map((grp) => (
          <fieldset key={grp.key} className="rounded-lg p-3 ring-1 ring-inset ring-ink-200">
            <legend className="px-1 text-xs font-bold text-ink-700">{pair(grp)}</legend>
            <div className="space-y-1">
              {grp.permissions.map((p) => {
                const locked = OVERSIGHT_PERMISSIONS.includes(p) && !mayOversee && !on(p);
                return (
                  <label key={p} className={cx('flex items-start gap-2 text-xs text-ink-700', locked ? 'opacity-50' : 'cursor-pointer')}>
                    <input type="checkbox" className="mt-0.5 size-3.5" checked={on(p)} disabled={locked} onChange={() => toggle(p)} aria-label={trx(PERMISSIONS[p])} />
                    <span>
                      {trx(PERMISSIONS[p])}
                      {g.has(p) && <Badge tone="success" className="ms-1">{tr('داده‌شده به این نفر')}</Badge>}
                      {d.has(p) && <Badge tone="danger" className="ms-1">{tr('گرفته‌شده از این نفر')}</Badge>}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={reset} disabled={!g.size && !d.size}>{tr('همان نقش‌ها')}</Button>
        <Button variant="primary" loading={busy} onClick={() => void save()}>{tr('ذخیرهٔ دسترسی‌ها')}</Button>
      </div>
    </div>
  );
}

/** A password the administrator can hand over: 16 characters from an alphabet without look-alikes. */
export function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/** A password field with a generator and a way to see what was typed. */
export function PasswordInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [shown, setShown] = useState(false);
  return (
    <Field label={label} hint={tr('دست‌کم ۱۲ نویسه.')}>
      <div className="flex gap-2">
        <Input value={value} onChange={(e) => onChange(e.target.value)} type={shown ? 'text' : 'password'} className="ltr flex-1" autoComplete="new-password" aria-label={label} />
        <Button variant="ghost" size="sm" onClick={() => setShown((s) => !s)}>{shown ? tr('پنهان') : tr('نمایش')}</Button>
        <Button variant="secondary" size="sm" onClick={() => { onChange(generatePassword()); setShown(true); }}>{tr('ساختن')}</Button>
      </div>
    </Field>
  );
}

function SetPassword({ user }: { user: EditableUser }) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await apiPost(`/users/${user.id}/password`, { password, mustChangePassword: mustChange });
      toast(tr('رمز عبور «{0}» تعیین شد؛ نشست‌هایش بسته شد.', user.fullName), 'success');
      setPassword('');
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <PasswordInput label={tr('رمز عبور تازه')} value={password} onChange={setPassword} />
      <Checkbox label={tr('در نخستین ورود، رمز تازه‌ای برای خودش بگذارد')} checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} />
      <p className="text-[12.5px] text-ink-500">{tr('رمز را خودتان و حضوری به او بدهید؛ در پیام و ایمیل نفرستید. با این کار همهٔ ورودهای فعلی او بسته می‌شود.')}</p>
      <div className="flex justify-end">
        <Button variant="primary" loading={busy} disabled={password.length < 12} onClick={() => void save()}>{tr('تعیین رمز')}</Button>
      </div>
    </div>
  );
}

function Account({ user, onClose, onSaved }: { user: EditableUser; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { user: me, actAs } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [removeReason, setRemoveReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const self = me?.id === user.id;
  const targetIsAdmin = (user.roles ?? []).some((r) => r.role.code === OVERSIGHT_GRANTOR_ROLE);
  const iAmAdmin = !!me?.roles.includes(OVERSIGHT_GRANTOR_ROLE) && !me.delegatedRoles?.[OVERSIGHT_GRANTOR_ROLE] && !me.actingAs;
  const removal = useQuery<{ hasHistory: boolean }>({
    queryKey: [`/users/${user.id}/removal`], queryFn: () => apiGet(`/users/${user.id}/removal`), enabled: confirming,
  });
  const run = async (key: string, work: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try { await work(); toast(done, 'success'); await onSaved(); onClose(); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(null); }
  };

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-center justify-between gap-2 rounded-lg p-3 ring-1 ring-inset ring-ink-200">
        <p className="text-sm">
          {tr('وضعیت حساب:')}{' '}
          {user.isActive === false ? <Badge tone="neutral">{tr('غیرفعال')}</Badge> : <Badge tone="success">{tr('فعال')}</Badge>}
        </p>
        {!self && (user.isActive === false
          ? <Button size="sm" variant="secondary" loading={busy === 'activate'} onClick={() => void run('activate', () => apiPost(`/users/${user.id}/activate`), tr('حساب «{0}» فعال شد.', user.fullName))}>{tr('فعال کردن')}</Button>
          : <Button size="sm" variant="secondary" loading={busy === 'deactivate'} onClick={() => void run('deactivate', () => apiPost(`/users/${user.id}/deactivate`), tr('حساب «{0}» غیرفعال شد.', user.fullName))}>{tr('غیرفعال کردن')}</Button>)}
      </section>

      {iAmAdmin && !self && !targetIsAdmin && user.isActive !== false && (
        <section className="space-y-2 rounded-lg p-3 ring-1 ring-inset ring-amber-300" data-testid="act-as">
          <h3 className="text-sm font-bold">{tr('کار در حساب این نفر')}</h3>
          <p className="text-[12.5px] text-ink-600">{tr('آنچه او می‌بیند می‌بینید و به جای او کار می‌کنید — تا نیم ساعت. او باخبر می‌شود و هر کار با نام شما در سابقه می‌ماند. رمز، امضا و گفت‌وگوهای خصوصی او از این راه در دسترس نیست.')}</p>
          <Field label={tr('دلیل')}><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tr('مثلاً: تأیید فرم‌های مانده در مرخصی او')} /></Field>
          <div className="flex justify-end">
            <Button variant="primary" loading={busy === 'act'} disabled={reason.trim().length < 3}
              onClick={() => { setBusy('act'); void actAs(user.id, reason.trim()).then(() => { onClose(); navigate('/'); }, (e) => toast((e as Error).message, 'danger')).finally(() => setBusy(null)); }}>
              {tr('ورود به حساب {0}', user.fullName)}
            </Button>
          </div>
        </section>
      )}

      {!self && (
        <section className="space-y-2 rounded-lg p-3 ring-1 ring-inset ring-red-200" data-testid="remove-user">
          <h3 className="text-sm font-bold text-red-800">{tr('حذف کاربر')}</h3>
          {!confirming ? (
            <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>{tr('حذف «{0}»…', user.fullName)}</Button>
          ) : removal.isLoading ? <LoadingBlock /> : (
            <>
              <p className="text-[12.5px] text-ink-700">
                {removal.data?.hasHistory
                  ? tr('این نفر در سامانه سابقه دارد. حذف می‌شود — دیگر وارد نمی‌شود و در فهرست‌ها نیست — ولی نامش در سابقه‌ها می‌ماند. کارهای باز او را به دیگری بسپارید.')
                  : tr('این نفر سابقه‌ای ندارد و به‌طور کامل حذف می‌شود.')}
              </p>
              <Field label={tr('دلیل (اختیاری)')}><Input value={removeReason} onChange={(e) => setRemoveReason(e.target.value)} /></Field>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>{tr('انصراف')}</Button>
                <Button size="sm" variant="danger" loading={busy === 'remove'}
                  onClick={() => void run('remove', () => api(`/users/${user.id}`, { method: 'DELETE', body: { reason: removeReason.trim() || undefined } }), tr('«{0}» حذف شد.', user.fullName))}>
                  {tr('بله، حذف شود')}
                </Button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}

/** A new person, with the user name and password they sign in with (owner's report, 2026-10-23). */
export function NewUser({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<unknown> }) {
  const toast = useToast();
  const { data: roles } = useQuery<RoleOption[]>({ queryKey: ['/roles'], queryFn: () => apiGet('/roles') });
  const { data: units } = useUnits();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [unit, setUnit] = useState<string>(DEPARTMENT_CODES[0]!);
  const [picked, setPicked] = useState<string[]>([]);
  const [mustChange, setMustChange] = useState(true);
  const [busy, setBusy] = useState(false);
  const ready = fullName.trim().length >= 2 && /\S+@\S+\.\S+/.test(email) && password.length >= 12 && picked.length > 0;
  const save = async () => {
    setBusy(true);
    try {
      await apiPost('/users', { fullName: fullName.trim(), email: email.trim(), password, departmentCode: unit, roleCodes: picked, mustChangePassword: mustChange });
      toast(tr('«{0}» ساخته شد و با نام کاربری {1} وارد می‌شود.', fullName.trim(), email.trim()), 'success');
      await onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open wide title={tr('کاربر تازه')} onClose={onClose}>
      <div className="space-y-3" data-testid="new-user">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr('نام و نام خانوادگی')} required><Input value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
          <Field label={tr('نام کاربری (ایمیل)')} required><Input value={email} onChange={(e) => setEmail(e.target.value)} className="ltr" type="email" autoComplete="off" /></Field>
          <PasswordInput label={tr('رمز عبور')} value={password} onChange={setPassword} />
          <Field label={tr('واحد')}>
            <Select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label={tr('واحد')}>
              {DEPARTMENT_CODES.map((c) => {
                const named = units?.find((u) => u.code === c);
                return <option key={c} value={c}>{named ? loc(named, 'name') : pair(DEPARTMENT_LABELS[c as DepartmentCode])}</option>;
              })}
            </Select>
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1 text-xs font-bold text-ink-700">{tr('نقش‌ها')}</legend>
          <div className="grid max-h-56 gap-1 overflow-y-auto sm:grid-cols-2">
            {(roles ?? []).map((r) => (
              <Checkbox key={r.code} label={loc(r, 'name')} checked={picked.includes(r.code)}
                onChange={(e) => setPicked((now) => e.target.checked ? [...now, r.code] : now.filter((x) => x !== r.code))} />
            ))}
          </div>
        </fieldset>
        <Checkbox label={tr('در نخستین ورود، رمز تازه‌ای برای خودش بگذارد')} checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} />
        <p className="text-[12.5px] text-ink-500">{tr('دسترسی‌های جدا از نقش، رمز، و حذف یا غیرفعال کردن را پس از ساختن، از «مدیریت» همین نفر تعیین کنید.')}</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{tr('انصراف')}</Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void save()}>{tr('ساختن کاربر')}</Button>
        </div>
      </div>
    </Modal>
  );
}
