import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { stateLabelFa } from '@hiva/contracts';
import { useList, type Transition } from '../hooks/queries';
import {
  Button, Card, EmptyState, ErrorBlock, Input, LoadingBlock, Modal, Pagination, Select,
  StateBadge, Table, Td, Textarea, Th, Tr, useToast, cx, Field, IconSearch, IconRefresh,
} from './ui';
import { formatRelative, toPersianDigits } from '../lib/format';

/* ── Workflow action bar ───────────────────────────────────────────────── */

/**
 * Renders exactly the transitions the API says this user may perform right now.
 * The available-action list is computed server-side from the workflow definition plus the
 * caller's permissions, so the UI can never offer a move the engine would reject on authority.
 */
export function WorkflowActions({
  entity, id, transitions, onDone, size = 'sm',
}: {
  entity: string;
  id: string;
  transitions: Transition[] | undefined;
  onDone?: () => void;
  size?: 'sm' | 'md';
}) {
  const [pending, setPending] = useState<Transition | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();

  if (!transitions?.length) return null;

  const run = async (t: Transition, why?: string) => {
    setBusy(true);
    try {
      const result = await apiPost<{ toState?: string }>(
        `/workflow/${entity}/${id}/transitions`, { action: t.action, reason: why },
      );
      // Name the state it landed in, not just the action taken — the engine returns it.
      toast(result?.toState
        ? `«${t.labelFa}» انجام شد — وضعیت: ${stateLabelFa(result.toState)}`
        : `«${t.labelFa}» انجام شد.`);
      setPending(null);
      setReason('');
      await qc.invalidateQueries();
      onDone?.();
    } catch (e: any) {
      // A governance rejection names the Doc_H clause; show it rather than a generic failure.
      toast(e?.rule ? `${e.message} (${e.rule})` : (e?.message ?? 'عملیات ناموفق بود.'), 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {transitions.map((t) => (
          <Button
            key={t.action}
            size={size}
            variant={destructive(t.action) ? 'danger' : primary(t.action) ? 'primary' : 'secondary'}
            onClick={() => (t.requiresReason ? setPending(t) : void run(t))}
            disabled={busy}
          >
            {t.labelFa}
          </Button>
        ))}
      </div>

      <Modal
        open={!!pending}
        onClose={() => { setPending(null); setReason(''); }}
        title={pending?.labelFa ?? ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setPending(null); setReason(''); }}>انصراف</Button>
            <Button
              variant={destructive(pending?.action ?? '') ? 'danger' : 'primary'}
              loading={busy}
              disabled={reason.trim().length < 3}
              onClick={() => pending && void run(pending, reason.trim())}
            >
              ثبت و ادامه
            </Button>
          </>
        }
      >
        <Field label="دلیل" required hint="ثبت دلیل برای این اقدام طبق قوانین حاکم بر فرآیند الزامی است.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} autoFocus />
        </Field>
      </Modal>
    </>
  );
}

const destructive = (action: string) =>
  /reject|cancel|lose|disqualify|terminate|return|withdraw|hold|block/.test(action);
const primary = (action: string) =>
  /approve|accept|authorize|activate|submit|issue|close|complete|register|sign|win|convert|deliver/.test(action);

/* ── Generic list page ─────────────────────────────────────────────────── */

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  className?: string;
}

export interface FilterDef {
  key: string;
  label: string;
  options: { value: string; label: string }[];
}

export function EntityList<T extends { id: string }>({
  path, columns, filters, searchPlaceholder, rowHref, emptyTitle, emptyDescription, actions, extraQuery,
}: {
  path: string;
  columns: Column<T>[];
  filters?: FilterDef[];
  searchPlaceholder?: string;
  rowHref?: (row: T) => string;
  emptyTitle?: string;
  emptyDescription?: string;
  actions?: ReactNode;
  extraQuery?: Record<string, string | undefined>;
}) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const navigate = useNavigate();

  const { data, isLoading, error, refetch, isFetching } = useList<T>(path, {
    page, pageSize: 25, q: search || undefined, ...filterValues, ...extraQuery,
  });

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(q);
    setPage(1);
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 p-3">
        <form onSubmit={submitSearch} className="relative flex-1 basis-56 max-w-sm">
          <IconSearch className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-ink-400" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchPlaceholder ?? 'جستجو…'}
            className="ps-9"
          />
        </form>
        {/* Selects carry `w-full` from the shared control style, so the sizing lives on a wrapper. */}
        {filters?.map((f) => (
          <div key={f.key} className="w-44 shrink-0">
            <Select
              value={filterValues[f.key] ?? ''}
              onChange={(e) => {
                setFilterValues((v) => ({ ...v, [f.key]: e.target.value }));
                setPage(1);
              }}
              aria-label={f.label}
            >
              <option value="">{f.label} — همه</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={() => void refetch()} aria-label="به‌روزرسانی">
          <IconRefresh className={cx('size-4', isFetching && 'animate-spin')} />
        </Button>
        {actions}
      </div>

      {isLoading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorBlock error={error} onRetry={() => void refetch()} />
      ) : !data?.items.length ? (
        <EmptyState title={emptyTitle ?? 'رکوردی یافت نشد'} description={emptyDescription} />
      ) : (
        <>
          <Table>
            <thead className="bg-ink-50/60">
              <tr>{columns.map((c) => <Th key={c.key} className={c.className}>{c.header}</Th>)}</tr>
            </thead>
            <tbody>
              {data.items.map((row) => (
                <Tr key={row.id} onClick={rowHref ? () => navigate(rowHref(row)) : undefined}>
                  {columns.map((c) => <Td key={c.key} className={c.className}>{c.render(row)}</Td>)}
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={data.page} pageCount={data.pageCount} total={data.total} onChange={setPage} />
        </>
      )}
    </Card>
  );
}

/* ── Small presentational helpers ──────────────────────────────────────── */

export const Code = ({ children }: { children: ReactNode }) => (
  <span className="ltr rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] text-ink-600">{children}</span>
);

export const StateCell = ({ state }: { state: string }) => <StateBadge state={state} />;

export function MetricRow({ items }: { items: { label: string; value: ReactNode; tone?: string }[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 sm:grid-cols-4">
      {items.map((i) => (
        <div key={i.label} className="border-b border-ink-100 py-2">
          <dt className="text-xs text-ink-500">{i.label}</dt>
          <dd className="mt-0.5 text-sm font-medium text-ink-800 nums">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Compact health indicator used in project lists and dashboards. */
export function HealthDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    GREEN: 'bg-emerald-500', AMBER: 'bg-amber-500', RED: 'bg-rose-500',
  };
  const label: Record<string, string> = { GREEN: 'سالم', AMBER: 'نیازمند توجه', RED: 'بحرانی' };
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-600">
      <span className={cx('size-2 rounded-full', map[status] ?? 'bg-ink-300')} />
      {label[status] ?? status}
    </span>
  );
}

export const Count = ({ value }: { value: number | null | undefined }) => (
  <span className="nums">{value == null ? '—' : toPersianDigits(value)}</span>
);

/**
 * A record's lifecycle, read from the workflow engine's own transition log.
 *
 * The endpoint is gated by the entity's read permission (a transition's `reason` says why a
 * proposal was rejected or a brief returned), so a caller without it gets 403 — rendered here
 * as a quiet absence rather than an error, since the surrounding page is still perfectly usable.
 */
interface StateTransitionRow {
  id: string;
  fromState: string;
  toState: string;
  reason: string | null;
  createdAt: string;
  actor: { fullName: string } | null;
}

export function StateHistory({ entity, id }: { entity: string; id: string }) {
  const { data, isLoading, error } = useQuery<StateTransitionRow[]>({
    queryKey: [`/workflow/${entity}/${id}/history`],
    queryFn: () => apiGet(`/workflow/${entity}/${id}/history`),
    enabled: !!id,
    retry: false,
  });

  if (isLoading || error || !data?.length) return null;

  return (
    <Card title="تاریخچه وضعیت" subtitle={`${toPersianDigits(data.length)} تغییر`}>
      <ol className="divide-y divide-ink-100">
        {data.map((t) => (
          <li key={t.id} className="px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <StateBadge state={t.fromState} />
              <span className="text-ink-400">←</span>
              <StateBadge state={t.toState} />
              <span className="ms-auto text-ink-400">{formatRelative(t.createdAt)}</span>
            </div>
            <p className="mt-1 text-[11px] text-ink-500">
              {t.actor?.fullName ?? '—'}
              {t.reason ? <span className="text-ink-700"> — {t.reason}</span> : null}
            </p>
          </li>
        ))}
      </ol>
    </Card>
  );
}
