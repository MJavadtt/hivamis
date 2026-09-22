import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { Badge, Card, EmptyState, ProgressBar, StatTile, Table, Td, Th, Tr } from './ui';
import { formatDate, toPersianDigits } from '../lib/format';

interface Prediction {
  clockId: string; policyCode: string; policyFa: string; entityType: string; entityId: string;
  departmentCode: string | null; budgetHours: number; consumedHours: number; ratio: number;
  probability: number; risk: 'LOW' | 'WATCH' | 'LIKELY' | 'CRITICAL';
  basis: { source: string; samples: number; survivors: number; breachRate: number | null; medianHours: number | null; p85Hours: number | null };
  expectedFinish: string | null; expectedOverrunHours: number | null; loadFactor: number;
  beatsWarnAt: boolean; becauseFa: string[];
}
const TONE = { CRITICAL: 'danger', LIKELY: 'warning', WATCH: 'info', LOW: 'neutral' } as const;
const RISK_FA = { CRITICAL: 'بسیار محتمل', LIKELY: 'محتمل', WATCH: 'قابل پایش', LOW: 'کم' } as const;

/**
 * Deadlines that are going to be missed, before the fixed threshold notices (roadmap #8).
 * Every row carries its own evidence — how many comparable deadlines, how many of them went
 * over — because a probability without a reason is a machine guessing.
 */
export function BreachRisk({ mine }: { mine?: boolean }) {
  const { data, isLoading } = useQuery<{ counts: { total: number; critical: number; likely: number; earlierThanThreshold: number }; model: string; predictions: Prediction[] }>({
    queryKey: ['/sla-clocks/predictions', mine ? 'mine' : 'all'],
    queryFn: () => apiGet('/sla-clocks/predictions', { minProbability: '0.25', ...(mine ? { mine: 'true' } : {}) }),
  });
  if (isLoading || !data) return null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="مهلت‌های در معرض خطر" value={toPersianDigits(data.counts.total)} tone={data.counts.total ? 'warning' : 'success'} />
        <StatTile label="بسیار محتمل" value={toPersianDigits(data.counts.critical)} tone={data.counts.critical ? 'danger' : 'success'} hint="احتمال نقض ۷۵٪ یا بیشتر" />
        <StatTile label="محتمل" value={toPersianDigits(data.counts.likely)} tone={data.counts.likely ? 'warning' : 'neutral'} />
        <StatTile label="زودتر از آستانهٔ ثابت" value={toPersianDigits(data.counts.earlierThanThreshold)} tone="info"
          hint="هشدار ثابت هنوز خاموش است — این‌ها را فقط پیش‌بینی می‌بیند" />
      </div>
      <Card title="پیش‌بینی نقض SLA" subtitle={data.model}>
        {!data.predictions.length ? <EmptyState title="مهلتی در معرض خطر نیست" description="هر مهلت باز با مهلت‌های مشابه گذشته سنجیده می‌شود؛ هیچ‌کدام فعلاً نگران‌کننده نیست." /> : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr><Th>سیاست</Th><Th>رکورد</Th><Th>احتمال نقض</Th><Th>مصرف‌شده</Th><Th>پایان محتمل</Th><Th>بر چه پایه‌ای</Th></tr>
            </thead>
            <tbody>
              {data.predictions.map((p) => (
                <Tr key={p.clockId}>
                  <Td>
                    <p className="text-sm">{p.policyFa}</p>
                    {p.departmentCode && <p className="text-[11px] text-ink-400">واحد {p.departmentCode}</p>}
                  </Td>
                  <Td className="text-xs">
                    <Link to={`/${p.entityType}s/${p.entityId}`} className="text-brand-600 hover:underline">
                      {p.entityType}
                    </Link>
                  </Td>
                  <Td>
                    <div className="w-24">
                      <ProgressBar value={p.probability * 100} tone={TONE[p.risk]} />
                      <span className="nums text-[11px] text-ink-600">
                        {toPersianDigits(Math.round(p.probability * 100))}٪ — {RISK_FA[p.risk]}
                      </span>
                    </div>
                    {p.beatsWarnAt && <Badge tone="info" className="mt-1">پیش از آستانهٔ ثابت</Badge>}
                  </Td>
                  <Td className="nums text-xs">
                    {toPersianDigits(p.consumedHours)} از {toPersianDigits(p.budgetHours)} س
                    <span className="block text-[11px] text-ink-400">{toPersianDigits(Math.round(p.ratio * 100))}٪ مهلت</span>
                  </Td>
                  <Td className="text-xs">
                    {p.expectedFinish ? formatDate(p.expectedFinish) : '—'}
                    {p.expectedOverrunHours != null && p.expectedOverrunHours > 0 && (
                      <span className="block text-[11px] text-rose-600">{toPersianDigits(p.expectedOverrunHours)} س فراتر از مهلت</span>
                    )}
                  </Td>
                  <Td className="max-w-xs text-[11px] text-ink-500">
                    <ul className="space-y-0.5">{p.becauseFa.map((b, i) => <li key={i}>· {b}</li>)}</ul>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
