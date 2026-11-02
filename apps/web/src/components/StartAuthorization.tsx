import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatCurrency, formatDate } from '../lib/format';
import { forwardMove, type Transition } from '../lib/plain';
import { WorkflowActions } from './common';
import { Button, Field, Input, Select, Textarea, useToast } from './ui';
import { tr, trx } from '../i18n';
import { stateLabelFa } from '@hiva/contracts';

/**
 * What lets the work start (the owner's brief, 2026-11-02: "support non-contractual work orders and
 * instructions to start work as separate processes; do not force every project through a contract").
 * Doc_H §13 accepts three: a signed contract, the client's official order, or an execution order tied to
 * a proforma or invoice. The person picks the one they have, in plain words; the server checks it.
 */

type Basis = 'CONTRACT' | 'OFFICIAL_ORDER' | 'INVOICED_EXECUTION_ORDER';
const BASES: { value: Basis; title: string; hint: string }[] = [
  { value: 'CONTRACT', title: tr('قرارداد امضاشده'), hint: tr('قرارداد با مشتری امضا یا ثبت شده است.') },
  { value: 'OFFICIAL_ORDER', title: tr('سفارش رسمی مشتری'), hint: tr('نامه یا سفارش کتبی مشتری؛ بی‌قرارداد.') },
  { value: 'INVOICED_EXECUTION_ORDER', title: tr('دستور اجرا با فاکتور'), hint: tr('کار با پیش‌فاکتور یا فاکتور شروع می‌شود؛ بی‌قرارداد.') },
];

interface ContractRow { id: string; code: string; title: string; state: string; contractNumber: string | null }
interface InvoiceRow { id: string; kind: string; number: string; total: string; state: string; issueDate: string }

export function StartAuthorization({ projectId, companyId, transitions, recorded, onDone }: {
  projectId: string; companyId: string; transitions: Transition[];
  /** The basis already recorded, if any: then only the project's next move is left. */
  recorded?: { basis: string; referenceDocument: string } | null;
  onDone: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [basis, setBasis] = useState<Basis | null>(null);
  const [v, setV] = useState({ contractId: '', invoiceId: '', referenceDocument: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const may = can('project.authorize');
  const contracts = useQuery<Page<ContractRow>>({
    queryKey: ['/contracts', 'signed-of', companyId], queryFn: () => apiGet('/contracts', { companyId, pageSize: '100' }), enabled: may && basis === 'CONTRACT',
  });
  const invoices = useQuery<Page<InvoiceRow>>({
    queryKey: ['/invoices', 'of', companyId], queryFn: () => apiGet('/invoices', { companyId, pageSize: '100' }), enabled: may && basis === 'INVOICED_EXECUTION_ORDER' && can('finance.read'),
  });
  const signed = (contracts.data?.items ?? []).filter((c) => ['SIGNED', 'REGISTERED'].includes(c.state));
  const billed = (invoices.data?.items ?? []).filter((i) => i.state !== 'CANCELLED');
  const move = forwardMove(transitions.filter((t) => t.action === 'request_authorization' || t.action === 'authorize'));
  const ready = !!basis && v.referenceDocument.trim().length >= 1
    && (basis !== 'CONTRACT' || !!v.contractId) && (basis !== 'INVOICED_EXECUTION_ORDER' || !!v.invoiceId);

  const save = async () => {
    setBusy(true);
    try {
      await apiPost(`/projects/${projectId}/authorize`, {
        basis, referenceDocument: v.referenceDocument.trim(), notes: v.notes.trim() || undefined,
        contractId: basis === 'CONTRACT' ? v.contractId : undefined, invoiceId: basis === 'INVOICED_EXECUTION_ORDER' ? v.invoiceId : undefined,
      });
      toast(tr('مبنای شروع کار ثبت شد.'));
      await qc.invalidateQueries();
      onDone();
    } catch (e: any) { toast(e?.message ?? tr('ثبت ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };

  return (
    <section aria-label={tr('مجوز شروع کار')} className="mx-3 mt-3 rounded-xl bg-surface p-4 ring-1 ring-edge sm:mx-5" data-testid="start-authorization" data-tour="start-authorization">
      <h2 className="text-[15px] font-bold text-ink-900">{tr('مجوز شروع کار')}</h2>
      <p className="mt-1 text-sm leading-7 text-ink-500">{tr('کار بی‌مجوز شروع نمی‌شود، اما همه‌چیز قرارداد نمی‌خواهد: یکی از این سه کافی است.')}</p>
      {recorded ? (
        <p className="mt-2 text-sm text-emerald-700" data-testid="basis-recorded">{tr('مبنا ثبت شده است: {0} — {1}', BASES.find((b) => b.value === recorded.basis)?.title ?? recorded.basis, recorded.referenceDocument)}</p>
      ) : !may ? <p className="mt-2 text-sm text-ink-700">{tr('ثبت مجوز شروع با مدیر اکانت یا مدیریت است.')}</p> : (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={tr('مبنای شروع کار')}>
            {BASES.map((b) => (
              <button key={b.value} type="button" role="radio" aria-checked={basis === b.value} onClick={() => setBasis(b.value)}
                className={`rounded-lg px-3 py-2.5 text-start text-sm ring-1 ${basis === b.value ? 'bg-brand-50 text-brand-900 ring-brand-400' : 'bg-surface text-ink-800 ring-ink-200 hover:bg-ink-50'}`}>
                <span className="block font-bold">{b.title}</span>
                <span className="block text-[12.5px] text-ink-500">{b.hint}</span>
              </button>
            ))}
          </div>
          {basis && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {basis === 'CONTRACT' && (
                <Field label={tr('کدام قرارداد؟')} required hint={!contracts.isLoading && !signed.length ? tr('این مشتری قرارداد امضاشده‌ای ندارد.') : undefined}>
                  <Select value={v.contractId} onChange={(e) => setV({ ...v, contractId: e.target.value })} aria-label={tr('قرارداد')}>
                    <option value="">{tr('— برگزینید —')}</option>
                    {signed.map((c) => <option key={c.id} value={c.id}>{[c.title, c.contractNumber ?? c.code].join(' — ')}</option>)}
                  </Select>
                </Field>
              )}
              {basis === 'INVOICED_EXECUTION_ORDER' && (
                <Field label={tr('کدام پیش‌فاکتور یا فاکتور؟')} required hint={!invoices.isLoading && !billed.length ? tr('برای این مشتری پیش‌فاکتور یا فاکتوری صادر نشده است.') : undefined}>
                  <Select value={v.invoiceId} onChange={(e) => setV({ ...v, invoiceId: e.target.value })} aria-label={tr('فاکتور')}>
                    <option value="">{tr('— برگزینید —')}</option>
                    {billed.map((i) => <option key={i.id} value={i.id}>{[i.kind === 'PROFORMA' ? tr('پیش‌فاکتور') : tr('فاکتور'), i.number, formatCurrency(i.total), formatDate(i.issueDate), trx(stateLabelFa(i.state))].join(' — ')}</option>)}
                  </Select>
                </Field>
              )}
              <Field label={tr('شمارهٔ سند')} required hint={basis === 'OFFICIAL_ORDER' ? tr('شماره و تاریخ نامهٔ مشتری') : tr('شماره‌ای که سند با آن پیدا می‌شود')}>
                <Input value={v.referenceDocument} onChange={(e) => setV({ ...v, referenceDocument: e.target.value })} aria-label={tr('شمارهٔ سند')} />
              </Field>
              <div className="sm:col-span-2"><Field label={tr('یادداشت')}><Textarea value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} rows={2} aria-label={tr('یادداشت مجوز')} /></Field></div>
              <div className="sm:col-span-2 flex justify-end"><Button variant="primary" loading={busy} disabled={!ready} onClick={() => void save()}>{tr('ثبت مبنای شروع')}</Button></div>
            </div>
          )}
        </>
      )}
      {move && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 pt-3">
          <p className="text-sm text-ink-700">{tr('وقتی مبنا ثبت شد، پروژه را با این دکمه جلو ببرید.')}</p>
          <WorkflowActions minimal entity="project" id={projectId} transitions={[move]} onDone={onDone} />
        </div>
      )}
    </section>
  );
}
