import { Link } from 'react-router-dom';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { DEPARTMENT_LABELS, type DepartmentCode } from '@hiva/contracts';
import { apiGet, type Page } from '../lib/api';
import { formatDate, formatRelative, localDigits } from '../lib/format';
import { type Transition } from '../lib/plain';
import { PageBody, PageHeader } from '../components/Shell';
import { WorkflowActions } from '../components/common';
import { ReturnNote, StagePill } from '../components/WorkCard';
import { EmptyState, LoadingBlock } from '../components/ui';
import { isEnglish, tr } from '../i18n';
import { nextFor } from './AccountJourney';

/**
 * Operations' one place (the owner's brief, 2026-11-02): what the units have handed in and wait to
 * have accepted or sent back, the questions they asked, the orders they have not yet taken, how much
 * each unit has in hand, and the proposals being put together from their parts. Across every project,
 * each with the decision the reader may take on it — the server says which, the engine decides.
 */

interface Order {
  id: string; code: string; title: string; state: string; targetDepartmentCode: DepartmentCode; proposalId: string | null;
  deadline: string | null; createdAt: string; updatedAt?: string; owner: { fullName: string } | null;
  project: { id: string; code: string; name: string } | null; availableTransitions: Transition[];
}
interface ProposalRow { id: string; code: string; title: string; state: string; brief: { id: string; title: string; opportunity?: { company?: { legalName: string } | null } | null } | null }

const unitName = (code: string) => {
  const l = DEPARTMENT_LABELS[code as DepartmentCode];
  return l ? (isEnglish() ? l.en : l.fa) : code;
};
const ORDER_STATES = ['SUBMITTED', 'CLARIFICATION_REQUESTED', 'ISSUED', 'PENDING_ACCEPTANCE', 'ACCEPTED', 'IN_PROGRESS'] as const;
const PROPOSAL_STATES = ['DRAFT', 'AWAITING_UNIT_OUTPUTS', 'INTEGRATION', 'PRICING', 'UNIT_APPROVAL', 'FINAL_QC', 'APPROVED'] as const;

export function OperationsDesk() {
  const qc = useQueryClient();
  const orderQs = useQueries({
    queries: ORDER_STATES.map((state) => ({
      queryKey: ['/work-orders', 'ops', state], queryFn: () => apiGet<Page<Order>>('/work-orders', { state, pageSize: '200' }),
    })),
  });
  const proposalQs = useQueries({
    queries: PROPOSAL_STATES.map((state) => ({
      queryKey: ['/proposals', 'ops', state], queryFn: () => apiGet<Page<ProposalRow>>('/proposals', { state, pageSize: '200' }),
    })),
  });
  if ([...orderQs, ...proposalQs].some((q) => q.isLoading)) return <PageBody><LoadingBlock /></PageBody>;
  const of = (state: (typeof ORDER_STATES)[number]) => orderQs[ORDER_STATES.indexOf(state)]?.data?.items ?? [];
  const handedIn = of('SUBMITTED');
  const asked = of('CLARIFICATION_REQUESTED');
  const notTaken = [...of('ISSUED'), ...of('PENDING_ACCEPTANCE')].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const inHand = [...of('ACCEPTED'), ...of('IN_PROGRESS')];
  const proposals = proposalQs.flatMap((q) => q.data?.items ?? []);
  const refresh = () => void qc.invalidateQueries();
  // Each unit's load: what it has yet to take, has in hand, and has handed in.
  const units = [...new Set([...notTaken, ...inHand, ...handedIn, ...asked].map((o) => o.targetDepartmentCode))];

  return (
    <>
      <PageHeader title={tr('میز عملیات')} subtitle={tr('آنچه واحدها تحویل داده‌اند، پرسیده‌اند یا هنوز نپذیرفته‌اند، و پروپوزال‌هایی که از کار آن‌ها کنار هم گذاشته می‌شوند.')} />
      <PageBody className="space-y-4">
        <p className="text-sm text-ink-700" data-tour="ops-summary" data-testid="ops-summary">
          {tr('{0} خروجی منتظر بررسی، {1} سؤال از واحدها، {2} سفارش هنوز پذیرفته نشده، {3} پروپوزال در حال آماده شدن.',
            localDigits(handedIn.length), localDigits(asked.length), localDigits(notTaken.length), localDigits(proposals.length))}
        </p>

        <Section title={tr('خروجی‌های رسیده برای بررسی')} tour="ops-handed-in"
          hint={tr('واحد کارش را تحویل داده است. آن را باز کنید و ببینید؛ بپذیرید، یا با توضیح روشن برای اصلاح برگردانید.')}>
          {!handedIn.length ? <Empty text={tr('خروجی‌ای منتظر بررسی نیست.')} /> : handedIn.map((o) => (
            <OrderCard key={o.id} order={o}>
              <WorkflowActions minimal entity="workOrder" id={o.id} transitions={o.availableTransitions} onDone={refresh} />
            </OrderCard>
          ))}
        </Section>

        <Section title={tr('سؤال‌های واحدها')} tour="ops-questions" hint={tr('واحد پیش از پذیرفتن سفارش چیزی پرسیده است. پاسخ را در سفارش بنویسید و ابهام را برطرف کنید.')}>
          {!asked.length ? <Empty text={tr('سؤالی بی‌پاسخ نمانده است.')} /> : asked.map((o) => (
            <OrderCard key={o.id} order={o}>
              <ReturnNote entity="workOrder" id={o.id} state={o.state} />
              <WorkflowActions minimal entity="workOrder" id={o.id} transitions={o.availableTransitions} onDone={refresh} />
            </OrderCard>
          ))}
        </Section>

        <Section title={tr('سفارش‌های هنوز پذیرفته‌نشده')} tour="ops-not-taken" hint={tr('سفارش به واحد رسیده و هنوز پذیرفته نشده است؛ قدیمی‌ترین بالا.')}>
          {!notTaken.length ? <Empty text={tr('همهٔ سفارش‌ها پذیرفته شده‌اند.')} /> : notTaken.map((o) => (
            <OrderCard key={o.id} order={o} note={tr('از {0} منتظر پذیرش واحد', formatRelative(o.createdAt))} />
          ))}
        </Section>

        <Section title={tr('کار در دست هر واحد')} tour="ops-units">
          {!units.length ? <Empty text={tr('سفارش بازی نزد واحدها نیست.')} /> : (
            <table className="w-full text-sm" data-testid="unit-load">
              <thead><tr className="text-start text-xs text-ink-500">
                <th className="py-1 text-start font-medium">{tr('واحد')}</th><th className="py-1 font-medium">{tr('نپذیرفته')}</th><th className="py-1 font-medium">{tr('در دست کار')}</th><th className="py-1 font-medium">{tr('تحویل‌شده')}</th>
              </tr></thead>
              <tbody className="divide-y divide-ink-100">
                {units.map((u) => (
                  <tr key={u}>
                    <td className="py-1.5">{unitName(u)}</td>
                    {[notTaken, inHand, handedIn].map((list, i) => <td key={i} className="py-1.5 text-center nums">{localDigits(list.filter((o) => o.targetDepartmentCode === u).length)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title={tr('پروپوزال‌های در حال آماده شدن')} tour="ops-proposals" hint={tr('خروجی واحدها در این پروپوزال‌ها کنار هم گذاشته می‌شود. هر کدام را باز کنید تا گام بعدش را ببینید.')}>
          {!proposals.length ? <Empty text={tr('پروپوزالی در دست نیست.')} /> : (
            <ul className="divide-y divide-ink-100">
              {proposals.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5" data-testid="ops-proposal">
                  <div className="min-w-0">
                    <Link to={p.brief ? `/account/journey/${p.brief.id}` : `/proposals/${p.id}`} className="font-medium text-brand-700 hover:underline">{p.title}</Link>
                    <span className="ms-2 text-xs text-ink-500">{p.brief?.opportunity?.company?.legalName}</span>
                    <p className="text-sm text-ink-700">{nextFor({ state: 'APPROVED' }, p)}</p>
                  </div>
                  <StagePill state={p.state} entity="proposal" />
                </li>
              ))}
            </ul>
          )}
        </Section>
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

const Empty = ({ text }: { text: string }) => <EmptyState title={text} />;

function OrderCard({ order: o, note, children }: { order: Order; note?: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-ink-50/60 p-3 text-sm" data-testid="ops-order">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="font-bold text-ink-800">{unitName(o.targetDepartmentCode)}</span>{' — '}
          <Link to={`/work-orders/${o.id}`} className="text-brand-700 hover:underline">{o.title}</Link>{' '}<StagePill state={o.state} entity="workOrder" />
        </span>
        <span className="text-xs text-ink-500">{[o.project?.name, o.owner?.fullName, o.deadline && tr('تا {0}', formatDate(o.deadline))].filter(Boolean).join(' · ')}</span>
      </div>
      {note && <p className="mt-1 text-xs text-amber-700">{note}</p>}
      {children && <div className="mt-2 space-y-2">{children}</div>}
    </div>
  );
}
