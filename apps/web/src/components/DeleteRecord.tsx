import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { WORKFLOWS } from '@hiva/contracts';
import { api, apiGet } from '../lib/api';
import { useAuth } from '../lib/auth';
import { localDigits } from '../lib/format';
import { Button, Field, LoadingBlock, Modal, Textarea, useToast } from './ui';
import { tr, trx } from '../i18n';

/**
 * «حذف کامل» (the owner, 2026-11-16; ADR-132): a manager deletes a record for good — a lead entered
 * twice, a client made by mistake — with everything that hangs off it. What it takes along is said
 * before the person confirms; the history keeps who deleted what, and why.
 */

/** The kinds the server deletes (src/lib/purge.ts), by the path their records are edited at. */
const KIND_OF: Record<string, string> = {
  '/leads': 'lead', '/companies': 'company', '/contacts': 'contact', '/opportunities': 'opportunity', '/briefs': 'brief',
  '/proposals': 'proposal', '/projects': 'project', '/tasks': 'task', '/work-orders': 'workOrder', '/deliverables': 'deliverable',
  '/contracts': 'contract', '/change-requests': 'changeRequest', '/revisions': 'revision', '/risks': 'risk', '/issues': 'issue',
  '/decisions': 'decision', '/status-reports': 'statusReport', '/outsource-requests': 'outsourceRequest', '/suppliers': 'supplier',
};
export const deletableKind = (pathOrKind: string): string | null => KIND_OF[pathOrKind] ?? (Object.values(KIND_OF).includes(pathOrKind) ? pathOrKind : null);

const NAMES: Record<string, string> = {
  Contact: 'مخاطب', Company: 'مشتری', Lead: 'سرنخ', Opportunity: 'فرصت فروش', Brief: 'بریف', Proposal: 'پروپوزال', Project: 'پروژه',
  Task: 'وظیفه', WorkOrder: 'سفارش کار', Deliverable: 'خروجی', Contract: 'قرارداد', Invoice: 'فاکتور', Payment: 'پرداخت',
  Document: 'فایل', Comment: 'یادداشت', Activity: 'فعالیت', Meeting: 'جلسه', Milestone: 'مایلستون', TimeEntry: 'ثبت زمان',
};
const nameOfModel = (model: string) => {
  const camel = model[0]!.toLowerCase() + model.slice(1);
  return NAMES[model] ? trx(NAMES[model]!) : WORKFLOWS[camel] ? trx(WORKFLOWS[camel]!.labelFa) : null;
};

interface Plan { kind: string; id: string; name: string; takes: Record<string, number>; files: number }

export function DeleteRecordButton({ kind, id, compact, onDone }: { kind: string; id: string; compact?: boolean; onDone?: () => void }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const path = `/records/${kind}/${id}/deletion`;
  const { data: plan, error, isLoading } = useQuery<Plan>({ queryKey: [path], queryFn: () => apiGet(path), enabled: open, retry: false });
  if (!can('record.delete')) return null;

  // The kinds people know, by name; the rest — clocks, notices, lines — as one count.
  const named = Object.entries(plan?.takes ?? {}).map(([m, n]) => [nameOfModel(m), n] as const);
  const known = named.filter(([l]) => l);
  const rest = named.filter(([l]) => !l).reduce((s, [, n]) => s + n, 0);

  const run = async () => {
    setBusy(true);
    try {
      await api(`/records/${kind}/${id}`, { method: 'DELETE', body: { reason: reason.trim() || undefined } });
      toast(tr('حذف شد.'));
      setOpen(false);
      // On the record's own page there is nothing left to show; in a list, the list simply re-reads.
      if (onDone) onDone(); else if (window.location.pathname.includes(id)) navigate(-1);
      await qc.invalidateQueries();
    } catch (e: any) {
      toast(e?.message ?? tr('حذف ناموفق بود.'), 'danger');
    } finally { setBusy(false); }
  };

  return (
    <span onClick={(e) => e.stopPropagation()}>
      {compact
        ? <Button size="sm" variant="ghost" aria-label={tr('حذف کامل')} title={tr('حذف کامل')} data-testid="delete-record" onClick={() => setOpen(true)}><span aria-hidden className="text-rose-600">🗑</span></Button>
        : <Button size="sm" variant="ghost" data-testid="delete-record" onClick={() => setOpen(true)}><span className="text-rose-700">{tr('حذف کامل')}</span></Button>}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={tr('حذف کامل')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>{tr('انصراف')}</Button>
            <Button variant="danger" loading={busy} disabled={!plan} onClick={() => void run()}>{tr('برای همیشه حذف شود')}</Button>
          </>
        }
      >
        {isLoading ? <LoadingBlock /> : error ? <p className="text-sm text-rose-700">{(error as any)?.message ?? tr('این رکورد حذف‌شدنی نیست.')}</p> : plan && (
          <div className="space-y-3 text-[13.5px] text-ink-800">
            <p>{tr('«{0}» برای همیشه حذف می‌شود و برگشتی ندارد.', plan.name || tr('این رکورد'))}</p>
            {(known.length > 0 || rest > 0 || plan.files > 0) && (
              <div className="rounded-lg bg-rose-50 px-3 py-2 text-rose-900" data-testid="delete-takes">
                <p className="mb-1 font-medium">{tr('همراه آن این‌ها هم حذف می‌شوند:')}</p>
                <ul className="list-inside list-disc space-y-0.5">
                  {known.map(([l, n]) => <li key={l}>{localDigits(n)} {l}</li>)}
                  {rest > 0 && <li>{tr('{0} مورد وابستهٔ دیگر (یادآورها، اعلان‌ها، ردیف‌ها)', localDigits(rest))}</li>}
                </ul>
              </div>
            )}
            <p className="text-ink-600">{tr('سابقهٔ این حذف، با نام شما، در تاریخچهٔ سازمان می‌ماند.')}</p>
            <Field label={tr('دلیل (اختیاری)')}><Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} /></Field>
          </div>
        )}
      </Modal>
    </span>
  );
}
