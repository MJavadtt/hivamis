import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { useAction } from '../hooks/queries';
import { Badge, Button, Card, EmptyState, Field, Select, StatTile, Textarea } from './ui';
import { formatDateTime, toPersianDigits } from '../lib/format';

interface Alert {
  id: string; kind: string; kindFa: string; severity: 'INFO' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: 'OPEN' | 'ACKNOWLEDGED' | 'DISMISSED'; messageFa: string; ipAddress: string | null;
  windowStart: string; windowEnd: string; createdAt: string; evidence: Record<string, unknown>;
  actor: { id: string; fullName: string; email: string; department: { code: string } | null } | null;
  reviewedBy: string | null; reviewedAt: string | null; reviewNote: string | null;
}
const TONE = { INFO: 'neutral', MEDIUM: 'warning', HIGH: 'danger', CRITICAL: 'danger' } as const;
const SEVERITY_FA = { INFO: 'اطلاع', MEDIUM: 'متوسط', HIGH: 'بالا', CRITICAL: 'بحرانی' } as const;
const STATUS_FA = { OPEN: 'باز', ACKNOWLEDGED: 'بررسی‌شده', DISMISSED: 'رد شده' } as const;

/**
 * The audit trail, read as it accumulates (roadmap #26). Each alert is a case with its evidence —
 * the person's own usual day beside today's count — for an administrator to judge. Nothing here
 * acts on its own, and a dismissal needs a reason, because "this was fine" is the decision most
 * worth being able to check later.
 */
export function SecurityAlerts() {
  const [status, setStatus] = useState('OPEN');
  const [reviewing, setReviewing] = useState<{ alert: Alert; status: 'ACKNOWLEDGED' | 'DISMISSED' } | null>(null);
  const [note, setNote] = useState('');
  const qc = useQueryClient();
  const { data } = useQuery<{ alerts: Alert[]; counts: { status: string; severity: string; count: number }[] }>({
    queryKey: ['/security/alerts', status], queryFn: () => apiGet('/security/alerts', { status }),
  });
  const scan = useAction(() => apiPost<{ created: number; updated: number }>('/security/scan'), 'پویش انجام شد.');
  const review = useAction(
    (input: { id: string; status: string; note: string }) => apiPost(`/security/alerts/${input.id}/review`, { status: input.status, note: input.note || undefined }),
    'ثبت شد.',
  );
  const refresh = () => qc.invalidateQueries({ queryKey: ['/security/alerts'] });
  const open = (data?.counts ?? []).filter((c) => c.status === 'OPEN');
  const count = (sev: string) => open.filter((c) => c.severity === sev).reduce((s, c) => s + c.count, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="باز" value={toPersianDigits(open.reduce((s, c) => s + c.count, 0))} />
        <StatTile label="بحرانی" value={toPersianDigits(count('CRITICAL'))} tone={count('CRITICAL') ? 'danger' : 'success'} />
        <StatTile label="بالا" value={toPersianDigits(count('HIGH'))} tone={count('HIGH') ? 'danger' : 'success'} />
        <StatTile label="متوسط" value={toPersianDigits(count('MEDIUM'))} tone={count('MEDIUM') ? 'warning' : 'neutral'} />
      </div>
      <Card
        title="هشدارهای امنیتی"
        subtitle="ناهنجاری‌های ردّ حسابرسی — هر فرد با روز معمول خودش سنجیده می‌شود. هیچ هشداری حسابی را خودکار قفل نمی‌کند."
        action={
          <div className="flex items-center gap-2">
            <div className="w-36">
              <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="وضعیت">
                <option value="OPEN">باز</option><option value="ACKNOWLEDGED">بررسی‌شده</option>
                <option value="DISMISSED">رد شده</option><option value="ALL">همه</option>
              </Select>
            </div>
            <Button size="sm" variant="secondary" loading={scan.isPending} onClick={() => scan.mutate(undefined, { onSuccess: () => void refresh() })}>پویش اکنون</Button>
          </div>
        }
      >
        {!data?.alerts.length ? <EmptyState title="هشداری در این وضعیت نیست" /> : (
          <ul className="divide-y divide-ink-100" data-testid="security-alerts">
            {data.alerts.map((a) => (
              <li key={a.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={TONE[a.severity]}>{SEVERITY_FA[a.severity]}</Badge>
                  <span className="text-sm font-medium text-ink-800">{a.kindFa}</span>
                  <span className="text-xs text-ink-500">
                    {a.actor ? `${a.actor.fullName}${a.actor.department ? ` (${a.actor.department.code})` : ''}` : a.ipAddress ? `نشانی ${a.ipAddress}` : ''}
                  </span>
                  <Badge tone="neutral" className="ms-auto">{STATUS_FA[a.status]}</Badge>
                </div>
                <p className="mt-1 text-xs text-ink-700">{a.messageFa}</p>
                <p className="mt-0.5 text-[11px] text-ink-400">
                  {formatDateTime(a.windowStart)} تا {formatDateTime(a.windowEnd)}{a.ipAddress && a.actor ? ` · آخرین نشانی ${a.ipAddress}` : ''}
                </p>
                <details className="mt-1 text-[11px] text-ink-500">
                  <summary className="cursor-pointer">شواهد</summary>
                  <pre className="mt-1 max-h-48 overflow-auto rounded bg-ink-50 p-2 text-[10px] ltr" dir="ltr">{JSON.stringify(a.evidence, null, 2)}</pre>
                </details>
                {a.reviewNote && <p className="mt-1 text-[11px] text-ink-500">{a.reviewedBy}: {a.reviewNote}</p>}
                {a.status === 'OPEN' && (
                  <div className="mt-2 flex gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => { setReviewing({ alert: a, status: 'ACKNOWLEDGED' }); setNote(''); }}>بررسی کردم</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setReviewing({ alert: a, status: 'DISMISSED' }); setNote(''); }}>مشکلی نبود</Button>
                  </div>
                )}
                {reviewing?.alert.id === a.id && (
                  <div className="mt-2 rounded-lg bg-ink-50/70 p-3" data-testid="alert-review">
                    <Field label="یادداشت" required={reviewing.status === 'DISMISSED'}
                      hint={reviewing.status === 'DISMISSED' ? 'رد یک هشدار دلیل می‌خواهد — «مشکلی نبود» تصمیمی است که بعداً باید قابل بررسی باشد.' : 'اختیاری — چه کردید؟'}>
                      <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} aria-label="یادداشت" />
                    </Field>
                    <div className="mt-2 flex gap-1.5">
                      <Button size="sm" variant="primary" loading={review.isPending}
                        disabled={reviewing.status === 'DISMISSED' && note.trim().length < 5}
                        onClick={() => review.mutate({ id: a.id, status: reviewing.status, note: note.trim() }, { onSuccess: () => { setReviewing(null); void refresh(); } })}>
                        ثبت
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setReviewing(null)}>انصراف</Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
