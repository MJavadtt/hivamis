import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { WORKFLOWS } from '@hiva/contracts';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatRelative } from '../lib/format';
import { pageOf } from '../lib/plain';
import { Button, Card, Field, Modal, Textarea, useToast } from './ui';
import { tr, trx } from '../i18n';

/**
 * Back one step to correct a mistake (the owner, 2026-11-14; ADR-128). Whoever works on a record may
 * ask to take it back to the state it came from; their unit's manager approves. A manager over the
 * record — and anyone above — takes it back at once. Every step back is written to the record's history.
 */

interface Person { id: string; fullName: string }
interface Pending {
  id: string; fromState: string; toState: string; reason: string; createdAt: string;
  requestedById: string; requestedBy: Person; approver: Person | null; mayDecide: boolean; toStateFa: string;
}
interface Info { state: string; toState: string | null; toStateFa: string | null; direct: boolean; pending: Pending | null }

export interface StepBackRow {
  id: string; entityType: string; entityId: string; entityFa: string; state: string;
  fromStateFa: string; toStateFa: string; reason: string; createdAt: string; decisionNote: string | null;
  requestedBy: Person; approver: Person | null; decidedBy: Person | null;
  record: Record<string, string | null> | null;
}

const errorText = (e: any) => e?.message ?? tr('عملیات ناموفق بود.');

/** On a record's own page, beside its moves: the way back, or the request that waits for it. */
export function StepBackBar({ entity, id, onDone }: { entity: string; id: string; onDone?: () => void }) {
  const known = !!WORKFLOWS[entity];
  const path = `/workflow/${entity}/${id}/step-back`;
  const { data } = useQuery<Info>({ queryKey: [path], queryFn: () => apiGet(path), enabled: known, retry: false });
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  if (!known || !data) return null;
  const done = async () => { await qc.invalidateQueries(); onDone?.(); };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); await done(); } catch (e) { toast(errorText(e), 'danger'); } finally { setBusy(false); }
  };

  if (data.pending) {
    const p = data.pending;
    const mine = p.requestedById === user?.id;
    return (
      <div role="status" className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900" data-testid="step-back-pending">
        <p>
          {mine
            ? tr('درخواست برگشت شما به «{0}» منتظر تأیید {1} است.', trx(p.toStateFa), p.approver?.fullName ?? tr('مدیر'))
            : tr('{0} خواسته است این رکورد به «{1}» برگردد.', p.requestedBy.fullName, trx(p.toStateFa))}
          {' '}<span className="text-amber-800">{tr('دلیل: {0}', p.reason)}</span>
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {p.mayDecide && (
            <>
              <Button size="sm" variant="primary" loading={busy}
                onClick={() => void act(() => apiPost(`/step-backs/${p.id}/decide`, { approve: true }), tr('برگشت به مرحلهٔ قبل انجام شد.'))}>{tr('تأیید و برگرداندن')}</Button>
              <Button size="sm" variant="secondary" disabled={busy}
                onClick={() => void act(() => apiPost(`/step-backs/${p.id}/decide`, { approve: false }), tr('درخواست رد شد.'))}>{tr('رد درخواست')}</Button>
            </>
          )}
          {mine && (
            <Button size="sm" variant="ghost" disabled={busy}
              onClick={() => void act(() => apiPost(`/step-backs/${p.id}/withdraw`, {}), tr('درخواست پس گرفته شد.'))}>{tr('پس گرفتن درخواست')}</Button>
          )}
        </div>
      </div>
    );
  }

  if (!data.toState) return null;
  const label = data.direct ? tr('بازگشت به مرحلهٔ قبل') : tr('درخواست بازگشت به مرحلهٔ قبل');
  return (
    <>
      <div className="mt-2">
        <Button size="sm" variant="ghost" onClick={() => { setReason(''); setAsking(true); }} data-testid="step-back">↶ {label}</Button>
      </div>
      <Modal
        open={asking}
        onClose={() => setAsking(false)}
        title={label}
        draftKey={`${entity}:${id}:step-back`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsking(false)}>{tr('انصراف')}</Button>
            <Button variant="primary" loading={busy} disabled={reason.trim().length < 5}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await apiPost<{ applied: boolean }>(path, { reason: reason.trim() });
                  toast(r.applied
                    ? tr('به «{0}» برگشت؛ اکنون ویرایشش کنید', trx(data.toStateFa ?? ''))
                    : tr('درخواست برای مدیرتان فرستاده شد؛ پس از تأیید، رکورد به «{0}» برمی‌گردد.', trx(data.toStateFa ?? '')));
                  setAsking(false);
                  await done();
                } catch (e) { toast(errorText(e), 'danger'); } finally { setBusy(false); }
              }}>{data.direct ? tr('برگرداندن') : tr('فرستادن درخواست')}</Button>
          </>
        }
      >
        <p className="mb-3 text-[13px] text-ink-700">
          {data.direct
            ? tr('رکورد به «{0}» برمی‌گردد تا اشتباه را اصلاح کنید، و این برگشت با نام شما در سابقه می‌ماند.', trx(data.toStateFa ?? ''))
            : tr('رکورد پس از تأیید مدیرتان به «{0}» برمی‌گردد تا اشتباه را اصلاح کنید.', trx(data.toStateFa ?? ''))}
        </p>
        <Field label={tr('چه چیزی اشتباه بود؟')} required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus />
        </Field>
      </Modal>
    </>
  );
}

/** What a record is called in a list: its code and title, when it has them. */
function recordName(r: StepBackRow): string {
  const rec = r.record ?? {};
  return [rec.code ?? rec.number, rec.title ?? rec.name ?? rec.subject].filter(Boolean).join(' — ') || r.entityFa;
}

/** In «کارهای من»: requests to go back that wait on this manager, and the person's own. */
export function StepBackInbox() {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const { data: awaiting } = useQuery<StepBackRow[]>({ queryKey: ['/step-backs', 'awaiting'], queryFn: () => apiGet('/step-backs', { which: 'awaiting' }) });
  const { data: mine } = useQuery<StepBackRow[]>({ queryKey: ['/step-backs', 'mine'], queryFn: () => apiGet('/step-backs', { which: 'mine' }) });
  // Read as lists whatever comes back: the work page must not fall over for a side list.
  const waiting = Array.isArray(awaiting) ? awaiting : [];
  const open = (Array.isArray(mine) ? mine : []).filter((r) => r.state === 'PENDING');
  if (!waiting.length && !open.length) return null;

  const decide = async (r: StepBackRow, approve: boolean) => {
    setBusy(r.id);
    try {
      await apiPost(`/step-backs/${r.id}/decide`, { approve });
      toast(approve ? tr('برگشت به مرحلهٔ قبل انجام شد.') : tr('درخواست رد شد.'));
      await qc.invalidateQueries();
    } catch (e) { toast(errorText(e), 'danger'); } finally { setBusy(null); }
  };

  const link = (r: StepBackRow) => {
    const to = pageOf(r.entityType, r.entityId);
    const name = `${r.entityFa}: ${recordName(r)}`;
    return to ? <Link to={to} className="font-medium text-brand-700 hover:underline">{name}</Link> : <span className="font-medium">{name}</span>;
  };

  return (
    <section aria-label={tr('برگشت به مرحلهٔ قبل')} className="mb-6" data-testid="step-back-inbox">
      <h2 className="mb-2 text-sm font-bold text-ink-700">{tr('برگشت به مرحلهٔ قبل')}</h2>
      <div className="grid gap-3 lg:grid-cols-2">
        {waiting.map((r) => (
          <Card key={r.id}>
            <div className="space-y-1.5 p-3 text-[13px]">
              <p>{link(r)}</p>
              <p className="text-ink-700">{tr('{0} می‌خواهد از «{1}» به «{2}» برگردد.', r.requestedBy.fullName, trx(r.fromStateFa), trx(r.toStateFa))}</p>
              <p className="text-ink-600">{tr('دلیل: {0}', r.reason)} · {formatRelative(r.createdAt)}</p>
              <div className="flex flex-wrap gap-1.5 pt-1">
                <Button size="sm" variant="primary" loading={busy === r.id} onClick={() => void decide(r, true)}>{tr('تأیید و برگرداندن')}</Button>
                <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void decide(r, false)}>{tr('رد درخواست')}</Button>
              </div>
            </div>
          </Card>
        ))}
        {open.map((r) => (
          <Card key={r.id}>
            <div className="space-y-1.5 p-3 text-[13px]">
              <p>{link(r)}</p>
              <p className="text-ink-700">{tr('درخواست شما برای برگشت به «{0}» منتظر تأیید {1} است.', trx(r.toStateFa), r.approver?.fullName ?? tr('مدیر'))}</p>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
