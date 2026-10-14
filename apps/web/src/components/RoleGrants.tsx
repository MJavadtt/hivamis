import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { OVERSIGHT_GRANTOR_ROLE, OVERSIGHT_PERMISSIONS, PERMISSIONS, PERMISSION_GROUPS, permissionGroup, type Permission } from '@hiva/contracts';
import { apiGet, apiPut } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, localDigits } from '../lib/format';
import { Badge, Button, Card, ErrorBlock, Input, LoadingBlock, cx, useToast } from './ui';
import { loc, pair, tr, trx } from '../i18n';
import { DeleteRole, RoleForm, RoleHolders } from './RoleEditor';

/**
 * Who may do what (Hivamis task 6). The managing director, deputy, system administrator and account
 * manager hold the whole system; every other role holds what the administrator ticks here — and
 * whatever is not ticked, its holders do not see. A save is the administrator's grant: recorded
 * with their name, a new version of the rules, in force at once.
 */

interface RoleRow {
  id: string; code: string; nameFa: string; nameEn: string; userCount: number; fullAccess: boolean;
  /** The organisation's own (audit F-3): renamed, recoloured, deleted here. */
  custom: boolean; color: string | null; description: string | null;
  permissions: string[]; defaults: string[]; differsFromDefault: boolean;
  review: { at: string; note: string | null; grantedBy: { id: string; fullName: string } | null } | null;
}
interface GrantHistory { id: string; permissions: string[]; note: string | null; createdAt: string; supersededAt: string | null; grantedBy: { fullName: string } | null }

const GROUPED = PERMISSION_GROUPS.map((g) => ({
  ...g, permissions: (Object.keys(PERMISSIONS) as Permission[]).filter((p) => permissionGroup(p) === g.key),
})).filter((g) => g.permissions.length);

function status(r: RoleRow): { tone: 'success' | 'warning' | 'info'; text: string } {
  if (r.fullAccess) return { tone: 'info', text: tr('دسترسی کامل') };
  if (r.custom) return { tone: 'success', text: tr('نقش سازمان') };
  if (!r.review) return { tone: 'warning', text: tr('پیش‌فرض — بازبینی نشده') };
  return { tone: 'success', text: tr('تأیید {0}', r.review.grantedBy?.fullName ?? tr('مدیر سیستم')) };
}

export function RoleGrants() {
  const { can, user } = useAuth();
  const editable = can('admin.roles');
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery<RoleRow[]>({ queryKey: ['/roles'], queryFn: () => apiGet('/roles') });
  const [code, setCode] = useState<string | null>(null);
  const role = data?.find((r) => r.code === code) ?? data?.find((r) => !r.fullAccess) ?? data?.[0];
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [dialog, setDialog] = useState<'new' | 'edit' | 'delete' | null>(null);
  const [showHolders, setShowHolders] = useState(false);
  useEffect(() => { if (role) { setPicked(new Set(role.permissions)); setNote(''); setShowHistory(false); setShowHolders(false); } }, [role?.code, role?.permissions.join(',')]);

  const history = useQuery<GrantHistory[]>({
    queryKey: [`/roles/${role?.code}/grants`], queryFn: () => apiGet(`/roles/${role!.code}/grants`), enabled: !!role && showHistory && editable,
  });

  const changes = useMemo(() => {
    if (!role) return { added: [] as string[], removed: [] as string[] };
    const was = new Set(role.permissions);
    return { added: [...picked].filter((p) => !was.has(p)), removed: role.permissions.filter((p) => !picked.has(p)) };
  }, [picked, role]);

  if (isLoading) return <LoadingBlock />;
  if (error || !data || !role) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  const locked = role.fullAccess || !editable;
  // Audit F-5: oversight is given by the system administrator in their own right, and only by them.
  const watched = (p: string) => (OVERSIGHT_PERMISSIONS as readonly string[]).includes(p);
  const grantsOversight = !!user?.roles.includes(OVERSIGHT_GRANTOR_ROLE) && !user?.delegatedRoles?.[OVERSIGHT_GRANTOR_ROLE];
  const toggle = (p: string) => setPicked((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  // "All" never reaches for oversight: that is a choice of its own (audit F-5).
  const toggleGroup = (ps: string[], on: boolean) => setPicked((s) => { const n = new Set(s); for (const p of ps) { if (on && !watched(p)) n.add(p); else if (!on) n.delete(p); } return n; });

  const save = async () => {
    setBusy(true);
    try {
      const r = await apiPut<{ added: string[]; removed: string[] }>(`/roles/${role.code}/permissions`, { permissions: [...picked], note: note.trim() || undefined });
      toast(tr('دسترسی «{0}» ثبت شد — {1} داده، {2} گرفته.', role.nameFa, localDigits(r.added.length), localDigits(r.removed.length)));
      await qc.invalidateQueries({ queryKey: ['/roles'] });
      await qc.invalidateQueries({ queryKey: [`/roles/${role.code}/grants`] });
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4" data-testid="role-grants">
      <p className="rounded-lg bg-ink-50 px-4 py-3 text-xs leading-6 text-ink-600">{tr('مدیرعامل، قائم‌مقام، مدیر سیستم و مدیر اکانت به همهٔ سامانه دسترسی دارند. دسترسی هر نقش دیگر را مدیر سیستم همین‌جا می‌دهد؛ هر بخشی که به نقشی داده نشود، دارندگانش حتی آن را نمی‌بینند. قوانین فرآیند (Doc_H) برای همه برقرار می‌ماند — دسترسی، کسی را از قانون معاف نمی‌کند.')}</p>
      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <Card title={tr('نقش‌ها')} action={editable ? <Button size="sm" variant="secondary" onClick={() => setDialog('new')} data-testid="new-role">{tr('نقش تازه')}</Button> : undefined}>
          <ul className="divide-y divide-ink-100" role="listbox" aria-label={tr('نقش‌ها')}>
            {data.map((r) => {
              const st = status(r);
              return (
                <li key={r.code}>
                  <button role="option" aria-selected={r.code === role.code} onClick={() => setCode(r.code)}
                    className={cx('flex w-full items-center justify-between gap-2 px-4 py-2.5 text-start', r.code === role.code ? 'bg-brand-50' : 'hover:bg-ink-50')}>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 truncate text-sm font-medium text-ink-800">
                        {r.color && <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: r.color }} aria-hidden />}
                        {loc(r, 'name')}
                      </span>
                      <span className="text-[12.5px] text-ink-500">{tr('{0} نفر', localDigits(r.userCount))}</span>
                    </span>
                    <Badge tone={st.tone} className="shrink-0">{st.text}</Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card
          title={loc(role, 'name')}
          subtitle={role.fullAccess ? tr('به همهٔ سامانه دسترسی دارد؛ ثابت است.')
            : role.review ? tr('آخرین تأیید: {0}، {1}{2}', role.review.grantedBy?.fullName ?? '—', formatDateTime(role.review.at), role.review.note ? ` — ${role.review.note}` : '')
            : tr('هنوز بازبینی نشده؛ دسترسی پیش‌فرض Doc_H برقرار است تا مدیر سیستم آن را تأیید یا تغییر دهد.')}
          action={editable && !role.fullAccess ? (
            <span className="flex flex-wrap items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => setShowHolders((v) => !v)}>{showHolders ? tr('بستن دارندگان') : tr('دارندگان')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setShowHistory((v) => !v)}>{showHistory ? tr('بستن سابقه') : tr('سابقه')}</Button>
              {role.custom && <Button size="sm" variant="ghost" onClick={() => setDialog('edit')}>{tr('ویرایش')}</Button>}
              {role.custom && <Button size="sm" variant="ghost" onClick={() => setDialog('delete')}>{tr('حذف')}</Button>}
            </span>
          ) : undefined}
        >
          {role.description && <p className="border-b border-ink-100 px-4 py-2 text-xs text-ink-600">{role.description}</p>}
          {showHolders && <div className="border-b border-ink-100"><RoleHolders code={role.code} /></div>}
          {showHistory && (
            <div className="border-b border-ink-100 px-4 py-3 text-xs" data-testid="grant-history">
              {!history.data?.length ? <p className="text-ink-500">{tr('هنوز چیزی ثبت نشده است.')}</p> : (
                <ul className="space-y-1">
                  {history.data.map((h) => (
                    <li key={h.id}>{tr('{0} — {1}: {2} دسترسی{3}{4}', formatDateTime(h.createdAt), h.grantedBy?.fullName ?? '—', localDigits(h.permissions.length), h.note ? ` — ${h.note}` : '', h.supersededAt ? '' : tr(' (در حال اجرا)'))}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {GROUPED.map((g) => {
              const on = g.permissions.filter((p) => picked.has(p)).length;
              return (
                <fieldset key={g.key} className="rounded-lg p-3 ring-1 ring-inset ring-ink-200" disabled={locked}>
                  <legend className="flex w-full items-center justify-between gap-2 px-1 text-xs font-semibold text-ink-700">
                    <span>{pair(g)} <span className="font-normal text-ink-400">({localDigits(on)}/{localDigits(g.permissions.length)})</span></span>
                    {!locked && (
                      <button type="button" className="text-[12.5px] font-normal text-brand-700 underline" onClick={() => toggleGroup(g.permissions, on < g.permissions.length)}>
                        {on < g.permissions.length ? tr('همه') : tr('هیچ')}
                      </button>
                    )}
                  </legend>
                  <div className="mt-1 space-y-1">
                    {g.permissions.map((p) => (
                      <label key={p} className="flex cursor-pointer items-start gap-2 text-xs text-ink-700">
                        <input type="checkbox" className="mt-0.5 size-3.5" checked={picked.has(p)} onChange={() => toggle(p)} aria-label={trx(PERMISSIONS[p])}
                          disabled={watched(p) && !picked.has(p) && !grantsOversight} />
                        <span>{trx(PERMISSIONS[p])} <span className="ltr font-mono text-[12px] text-ink-400">{p}</span>
                          {!role.fullAccess && !role.defaults.includes(p) && picked.has(p) && <Badge tone="info" className="ms-1">{tr('بیش از پیش‌فرض')}</Badge>}
                          {watched(p) && (
                            <span className="mt-0.5 block text-[12px] leading-5 text-amber-800">
                              {tr('هیچ نقشی به‌طور پیش‌فرض این را ندارد و فقط مدیر سیستم آن را می‌دهد؛ هر بازبینی با دلیلش ثبت می‌شود.')}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              );
            })}
          </div>
          {!locked && (
            <div className="flex flex-wrap items-center gap-3 border-t border-ink-100 px-4 py-3">
              <span className="text-xs text-ink-600" data-testid="grant-changes">
                {changes.added.length || changes.removed.length
                  ? tr('{0} افزوده، {1} برداشته', localDigits(changes.added.length), localDigits(changes.removed.length))
                  : role.review ? tr('بدون تغییر') : tr('با «تأیید» همین دسترسی‌ها به نام شما ثبت می‌شود.')}
              </span>
              <div className="min-w-48 flex-1"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('یادداشت (اختیاری) — چرا؟')} aria-label={tr('یادداشت')} /></div>
              {!role.custom && <Button variant="ghost" onClick={() => setPicked(new Set(role.defaults))}>{tr('پیش‌فرض Doc_H')}</Button>}
              <Button variant="primary" loading={busy} disabled={!changes.added.length && !changes.removed.length && !!role.review} onClick={() => void save()}>
                {changes.added.length || changes.removed.length ? tr('ذخیره و تأیید') : tr('تأیید')}
              </Button>
            </div>
          )}
        </Card>
      </div>
      {dialog === 'new' && <RoleForm roles={data} copyFrom={role.code} onClose={() => setDialog(null)}
        onSaved={async (made) => { await qc.invalidateQueries({ queryKey: ['/roles'] }); setCode(made); }} />}
      {dialog === 'edit' && <RoleForm roles={data} editing={role} onClose={() => setDialog(null)} onSaved={() => qc.invalidateQueries({ queryKey: ['/roles'] })} />}
      {dialog === 'delete' && <DeleteRole role={role} onClose={() => setDialog(null)}
        onDeleted={async () => { setCode(null); await qc.invalidateQueries({ queryKey: ['/roles'] }); }} />}
    </div>
  );
}
