import { Link } from 'react-router-dom';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { apiGet, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatCurrency, formatDate, localDigits } from '../lib/format';
import { forwardMove, type Transition } from '../lib/plain';
import { PageBody, PageHeader } from '../components/Shell';
import { WorkflowActions } from '../components/common';
import { StagePill } from '../components/WorkCard';
import { EmptyState, LoadingBlock } from '../components/ui';
import { tr } from '../i18n';

/**
 * Contracts and money, by what each waits for (the owner's brief, 2026-11-02: "keep the financial and
 * legal functionality; simplify contract preparation, invoice requests, proformas, final approvals,
 * document collection"). Sales contracts on their road, invoices from draft to paid, projects waiting
 * for their go-ahead — a contract or not — and purchases from outside waiting for a decision. Each row
 * says in one sentence what is next; the buttons are the moves the server offers the reader.
 */

interface ContractRow { id: string; code: string; title: string; state: string; contractNumber: string | null; company: { legalName: string } | null; availableTransitions: Transition[] }
interface InvoiceRow { id: string; kind: string; number: string; total: string; paidAmount: string; state: string; dueDate: string | null; company: { legalName: string } | null; project: { name: string } | null }
interface ProjectRow { id: string; code: string; name: string; state: string; company: { legalName: string } | null }
interface PurchaseRow { id: string; code: string; kind: string; scopeOfWork: string; estimatedCost: string; neededBy: string; state: string; proposedSupplierName: string | null; supplier: { name: string } | null; project: { name: string } | null; availableTransitions: Transition[] }

const CONTRACT_STATES = ['REQUESTED', 'DRAFTING', 'REVISION_REQUESTED', 'LEGAL_REVIEW', 'INTERNAL_APPROVED', 'PENDING_SIGNATURE', 'SIGNED'] as const;
const INVOICE_STATES = ['DRAFT', 'ISSUED', 'SENT', 'PARTIALLY_PAID'] as const;
const PURCHASE_STATES = ['UNIT_MANAGER_REVIEW', 'MANAGEMENT_REVIEW', 'APPROVED'] as const;

/** What a sales contract waits for, in one sentence. */
export function contractNext(state: string): string {
  switch (state) {
    case 'REQUESTED': return tr('درخواست قرارداد رسیده است؛ تهیهٔ آن را شروع کنید.');
    case 'DRAFTING': return tr('در دست تهیه است؛ وقتی آماده شد برای بررسی حقوقی و مالی بفرستید.');
    case 'REVISION_REQUESTED': return tr('برای اصلاح برگشته است؛ اصلاح کنید و دوباره به بررسی بفرستید.');
    case 'LEGAL_REVIEW': return tr('در بررسی حقوقی و مالی است؛ تأیید کنید یا با توضیح برای اصلاح برگردانید.');
    case 'INTERNAL_APPROVED': return tr('تأیید داخلی شده است؛ آن را برای امضای مشتری بفرستید.');
    case 'PENDING_SIGNATURE': return tr('نزد مشتری برای امضاست؛ پس از امضای نسخهٔ اصل، امضا را ثبت کنید.');
    case 'SIGNED': return tr('امضا شده است؛ آن را ثبت کنید و مدارک مالی را به مالی و اکانت برسانید.');
    default: return tr('آن را باز کنید و گام بعد را بردارید.');
  }
}

/** What an invoice or proforma waits for. */
export function invoiceNext(i: { state: string; dueDate: string | null }, now = Date.now()): string {
  if (i.state === 'DRAFT') return tr('پیش‌نویس است؛ بازبینی و صادر کنید.');
  if (i.state === 'ISSUED') return tr('صادر شده است؛ آن را برای مشتری بفرستید.');
  const late = i.dueDate && new Date(i.dueDate).getTime() < now;
  if (i.state === 'PARTIALLY_PAID') return late ? tr('بخشی پرداخت شده و سررسید گذشته است؛ مانده را پیگیری کنید.') : tr('بخشی پرداخت شده است؛ منتظر مانده.');
  return late ? tr('سررسید گذشته و پرداخت نشده است؛ پیگیری کنید.') : tr('نزد مشتری است؛ منتظر پرداخت.');
}

export function CommercialDesk() {
  const { can, user } = useAuth();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries();
  const contracts = useQueries({ queries: CONTRACT_STATES.map((state) => ({
    queryKey: ['/contracts', 'desk', state], queryFn: () => apiGet<Page<ContractRow>>('/contracts', { state, pageSize: '200' }), enabled: can('contract.read'),
  })) });
  const invoices = useQueries({ queries: INVOICE_STATES.map((state) => ({
    queryKey: ['/invoices', 'desk', state], queryFn: () => apiGet<Page<InvoiceRow>>('/invoices', { state, pageSize: '200' }), enabled: can('finance.read'),
  })) });
  const purchases = useQueries({ queries: PURCHASE_STATES.map((state) => ({
    queryKey: ['/outsource-requests', 'desk', state], queryFn: () => apiGet<Page<PurchaseRow>>('/outsource-requests', { state, pageSize: '200' }), enabled: can('supplier.read'),
  })) });
  const [goAhead] = useQueries({ queries: [{
    queryKey: ['/projects', 'desk', 'PENDING_AUTHORIZATION'], queryFn: () => apiGet<Page<ProjectRow>>('/projects', { state: 'PENDING_AUTHORIZATION', pageSize: '200' }), enabled: can('project.read'),
  }] });
  // The queries wait for the person's permissions; until those are known there is nothing to count.
  if (!user || [...contracts, ...invoices, ...purchases, goAhead!].some((q) => q.isLoading)) return <PageBody><LoadingBlock /></PageBody>;

  const contractRows = contracts.flatMap((q) => q.data?.items ?? []);
  const invoiceRows = invoices.flatMap((q) => q.data?.items ?? []);
  const purchaseRows = purchases.flatMap((q) => q.data?.items ?? []);
  const waiting = goAhead?.data?.items ?? [];
  const late = invoiceRows.filter((i) => ['SENT', 'PARTIALLY_PAID'].includes(i.state) && i.dueDate && new Date(i.dueDate) < new Date());

  return (
    <>
      <PageHeader title={tr('میز قرارداد و مالی')} subtitle={tr('قراردادهای فروش، پیش‌فاکتورها و فاکتورها، مجوز شروع پروژه‌ها و درخواست‌های خرید — هر کدام با آنچه منتظرش است.')} />
      <PageBody className="space-y-4">
        <p className="text-sm text-ink-700" data-testid="commercial-summary" data-tour="commercial-summary">
          {tr('{0} قرارداد در جریان، {1} پیش‌فاکتور یا فاکتور باز ({2} سررسیدگذشته)، {3} پروژه منتظر مجوز شروع، {4} درخواست خرید.',
            localDigits(contractRows.length), localDigits(invoiceRows.length), localDigits(late.length), localDigits(waiting.length), localDigits(purchaseRows.length))}
        </p>

        {can('contract.read') && (
          <Section title={tr('قراردادهای فروش')} tour="commercial-contracts"
            hint={tr('درخواست ← تهیه ← بررسی حقوقی و مالی ← تأیید داخلی ← امضای مشتری ← ثبت و تحویل مدارک.')}>
            {!contractRows.length ? <EmptyState title={tr('قراردادی در جریان نیست.')} /> : contractRows.map((c) => {
              // In review both ways are offered: approve, or send back with the reason.
              const moves = c.state === 'LEGAL_REVIEW' ? c.availableTransitions : [forwardMove(c.availableTransitions)].filter((m): m is Transition => !!m);
              return (
                <Row key={c.id} title={c.title} href={`/contracts/${c.id}`} who={[c.company?.legalName, c.contractNumber].filter(Boolean).join(' · ')}
                  state={<StagePill state={c.state} entity="contract" />} next={contractNext(c.state)}>
                  {!!moves.length && <WorkflowActions minimal entity="contract" id={c.id} transitions={moves} onDone={refresh} />}
                </Row>
              );
            })}
          </Section>
        )}

        {can('finance.read') && (
          <Section title={tr('پیش‌فاکتورها و فاکتورها')} tour="commercial-invoices" hint={tr('پیش‌نویس ← صدور ← ارسال به مشتری ← پرداخت. صدور و ثبت پرداخت در صفحهٔ مالی است.')}>
            {!invoiceRows.length ? <EmptyState title={tr('سند مالی بازی نیست.')} /> : invoiceRows.map((i) => (
              <Row key={i.id} title={`${i.kind === 'PROFORMA' ? tr('پیش‌فاکتور') : tr('فاکتور')} ${i.number}`} href="/finance"
                who={[i.company?.legalName, i.project?.name, formatCurrency(i.total), i.dueDate && tr('سررسید {0}', formatDate(i.dueDate))].filter(Boolean).join(' · ')}
                state={<StagePill state={i.state} entity="invoice" />} next={invoiceNext(i)} warn={late.includes(i)} />
            ))}
          </Section>
        )}

        {can('project.read') && (
          <Section title={tr('پروژه‌های منتظر مجوز شروع')} tour="commercial-go-ahead"
            hint={tr('هر پروژه با یکی از سه مبنا شروع می‌شود: قرارداد امضاشده، سفارش رسمی مشتری، یا دستور اجرا با فاکتور. لازم نیست هر کاری قرارداد داشته باشد.')}>
            {!waiting.length ? <EmptyState title={tr('پروژه‌ای منتظر مجوز نیست.')} /> : waiting.map((p) => (
              <Row key={p.id} title={p.name} href={`/projects/${p.id}`} who={p.company?.legalName ?? ''} state={<StagePill state={p.state} entity="project" />}
                next={tr('مبنای شروع را در صفحهٔ پروژه ثبت کنید و مجوز را صادر کنید.')} />
            ))}
          </Section>
        )}

        {can('supplier.read') && (
          <Section title={tr('درخواست‌های خرید و تأمین بیرونی')} tour="commercial-purchases" hint={tr('درخواست ← بررسی مدیر واحد ← (در صورت نیاز) مدیریت ← تأیید ← تأمین.')}>
            {!purchaseRows.length ? <EmptyState title={tr('درخواست خریدی منتظر نیست.')} /> : purchaseRows.map((r) => (
              <Row key={r.id} title={r.scopeOfWork} href="/suppliers"
                who={[r.project?.name, r.supplier?.name ?? r.proposedSupplierName, formatCurrency(r.estimatedCost), tr('تا {0}', formatDate(r.neededBy))].filter(Boolean).join(' · ')}
                state={<StagePill state={r.state} />} next={r.state === 'APPROVED' ? tr('تأیید شده است؛ وقتی تأمین شد، آن را ثبت کنید.') : tr('منتظر تصمیم است: تأیید، رد، یا ارجاع به مدیریت.')}>
                {!!r.availableTransitions.length && <WorkflowActions minimal entity="outsourceRequest" id={r.id} transitions={r.availableTransitions} onDone={refresh} />}
              </Row>
            ))}
          </Section>
        )}
      </PageBody>
    </>
  );
}

function Section({ title, hint, tour, children }: { title: string; hint?: string; tour: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} data-tour={tour} className="rounded-xl bg-surface p-4 ring-1 ring-edge">
      <h2 className="text-[15px] font-bold text-ink-900">{title}</h2>
      {hint && <p className="mt-1 text-sm leading-7 text-ink-500">{hint}</p>}
      <div className="mt-3 space-y-2">{children}</div>
    </section>
  );
}

function Row({ title, href, who, state, next, warn, children }: { title: string; href: string; who: string; state: React.ReactNode; next: string; warn?: boolean; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-ink-50/60 p-3 text-sm" data-testid="desk-item">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0"><Link to={href} className="font-medium text-brand-700 hover:underline">{title}</Link>{' '}{state}</span>
        <span className="text-xs text-ink-500">{who}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <p className={warn ? 'text-rose-700' : 'text-ink-700'}>{next}</p>
        {children}
      </div>
    </div>
  );
}
