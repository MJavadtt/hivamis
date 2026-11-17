import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { METRO_BOOKING_STATES } from '@hiva/contracts';
import { apiGet, downloadFile } from '../../lib/api';
import { formatDate, localDigits } from '../../lib/format';
import { PageBody, PageHeader } from '../../components/Shell';
import { JalaliDateInput } from '../../components/JalaliDateInput';
import { Button, Card, EmptyState, ErrorBlock, Field, LoadingBlock, Select, Table, Td, Th, Tr, useToast } from '../../components/ui';
import { Money } from '../sites/shared';
import { tr } from '../../i18n';
import { BookingState, LineChip, MetroNav, kindFa, plusDays, stateFa, today, type Line } from './shared';

interface Report {
  period: { from: string; to: string; days: number };
  occupancy: { line: { id: string; number: number; nameFa: string; color: string }; kinds: { kind: string; capacity: number; sold: number; rate: number }[] }[];
  totals: { bookings: number; billed: number; paidInPeriod: number; outstanding: number; byState: Record<string, number> };
  clients: { client: string; bookings: number; amount: number }[];
  bookings: { id: string; code: string; title: string | null; client: string | null; state: string; startDate: string; endDate: string; amount: number; paid: number }[];
}

/** Occupancy and money over a period, by line and kind; the period's bookings as a CSV (ADR-135). */
export default function MetroReports() {
  const toast = useToast();
  const [from, setFrom] = useState(plusDays(today(), -30));
  const [to, setTo] = useState(today());
  const [lineId, setLineId] = useState('');
  const lines = useQuery<Line[]>({ queryKey: ['/metro/lines'], queryFn: () => apiGet('/metro/lines') });
  const { data, isLoading, error, refetch } = useQuery<Report>({ queryKey: ['/metro/reports', from, to, lineId], queryFn: () => apiGet('/metro/reports', { from, to, lineId: lineId || undefined }), enabled: to >= from });
  const csv = () => void downloadFile(`/metro/reports.csv?from=${from}&to=${to}${lineId ? `&lineId=${lineId}` : ''}`, `metro-${from}-${to}.csv`).catch((e) => toast(e?.message ?? tr('دریافت ناموفق بود.'), 'danger'));
  return (
    <>
      <PageHeader title={tr('گزارش‌های مترو')} subtitle={tr('اشغال فضاها و مبلغ رزروها در یک بازه')} actions={<Button variant="secondary" onClick={csv}>{tr('خروجی CSV')}</Button>} />
      <PageBody>
        <MetroNav />
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <Field label={tr('از')}><JalaliDateInput value={from} onChange={setFrom} label={tr('از')} /></Field>
          <Field label={tr('تا')}><JalaliDateInput value={to} onChange={setTo} label={tr('تا')} /></Field>
          <Field label={tr('خط')}><Select value={lineId} onChange={(e) => setLineId(e.target.value)}><option value="">{tr('همهٔ خطوط')}</option>{(lines.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.nameFa}</option>)}</Select></Field>
        </div>
        {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={() => void refetch()} /> : data && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Card><div className="p-4"><p className="text-xs text-ink-500">{tr('رزروها')}</p><p className="text-2xl font-bold nums">{localDigits(data.totals.bookings)}</p></div></Card>
              <Card><div className="p-4"><p className="text-xs text-ink-500">{tr('مبلغ رزروها')}</p><Money value={data.totals.billed} /></div></Card>
              <Card><div className="p-4"><p className="text-xs text-ink-500">{tr('دریافتی در بازه')}</p><Money value={data.totals.paidInPeriod} tone="success" /></div></Card>
              <Card><div className="p-4"><p className="text-xs text-ink-500">{tr('مانده')}</p><Money value={data.totals.outstanding} tone="danger" /></div></Card>
            </div>
            <Card title={tr('اشغال فضاها ({0} روز)', localDigits(data.period.days))}>
              <Table>
                <thead className="bg-ink-50/60"><tr><Th>{tr('خط')}</Th>{['BODY', 'KATIBEH', 'HANDLE'].map((k) => <Th key={k}>{kindFa(k)}</Th>)}</tr></thead>
                <tbody>
                  {data.occupancy.map((o) => (
                    <Tr key={o.line.id}>
                      <Td><LineChip line={o.line} /></Td>
                      {o.kinds.map((k) => <Td key={k.kind} className="text-xs nums">{k.capacity ? tr('{0}٪ ({1} از {2} واحد‌روز)', localDigits(Math.round(k.rate * 100)), localDigits(k.sold), localDigits(k.capacity)) : '—'}</Td>)}
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
            <div className="grid gap-3 lg:grid-cols-2">
              <Card title={tr('رزروها بر پایهٔ وضعیت')}>
                <ul className="divide-y divide-ink-100 text-sm">{METRO_BOOKING_STATES.map((s) => <li key={s} className="flex justify-between px-4 py-1.5"><span>{stateFa(s)}</span><span className="nums">{localDigits(data.totals.byState[s] ?? 0)}</span></li>)}</ul>
              </Card>
              <Card title={tr('مشتریان')}>
                {!data.clients.length ? <EmptyState title={tr('رزروی در این بازه نیست')} /> : (
                  <ul className="divide-y divide-ink-100 text-sm">{data.clients.map((c) => <li key={c.client} className="flex items-center gap-2 px-4 py-1.5"><span>{c.client}</span><span className="text-xs text-ink-500">{tr('{0} رزرو', localDigits(c.bookings))}</span><span className="ms-auto"><Money value={c.amount} /></span></li>)}</ul>
                )}
              </Card>
            </div>
            <Card title={tr('رزروهای بازه')}>
              {!data.bookings.length ? <EmptyState title={tr('رزروی در این بازه نیست')} /> : (
                <Table>
                  <thead className="bg-ink-50/60"><tr><Th>{tr('کد')}</Th><Th>{tr('مشتری')}</Th><Th>{tr('تاریخ')}</Th><Th>{tr('مبلغ')}</Th><Th>{tr('پرداخت‌شده')}</Th><Th>{tr('وضعیت')}</Th></tr></thead>
                  <tbody>{data.bookings.map((b) => (
                    <Tr key={b.id}><Td><Link to={`/metro/bookings/${b.id}`} className="text-brand-700 hover:underline">{b.code}</Link></Td><Td>{b.client ?? '—'}</Td><Td className="text-xs">{formatDate(b.startDate)} — {formatDate(b.endDate)}</Td><Td><Money value={b.amount} /></Td><Td><Money value={b.paid} /></Td><Td><BookingState state={b.state} /></Td></Tr>
                  ))}</tbody>
                </Table>
              )}
            </Card>
          </div>
        )}
      </PageBody>
    </>
  );
}
