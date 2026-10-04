import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { Badge, Card, EmptyState, ProgressBar, StatTile, Table, Td, Th, Tr } from './ui';
import { formatDate, localDigits } from '../lib/format';
import { loc, tr, trx } from '../i18n';
import { UnitTag } from './UnitTag';

interface Prediction {
  clockId: string; policyCode: string; policyFa: string; entityType: string; entityId: string;
  departmentCode: string | null; budgetHours: number; consumedHours: number; ratio: number;
  probability: number; risk: 'LOW' | 'WATCH' | 'LIKELY' | 'CRITICAL';
  basis: { source: string; samples: number; survivors: number; breachRate: number | null; medianHours: number | null; p85Hours: number | null };
  expectedFinish: string | null; expectedOverrunHours: number | null; loadFactor: number;
  beatsWarnAt: boolean; becauseFa: string[];
}
const TONE = { CRITICAL: 'danger', LIKELY: 'warning', WATCH: 'info', LOW: 'neutral' } as const;
const RISK_FA = { CRITICAL: tr('بسیار محتمل'), LIKELY: tr('محتمل'), WATCH: tr('قابل پایش'), LOW: tr('کم') } as const;

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
        <StatTile label={tr('مهلت‌های در معرض خطر')} value={localDigits(data.counts.total)} tone={data.counts.total ? 'warning' : 'success'} />
        <StatTile label={tr('بسیار محتمل')} value={localDigits(data.counts.critical)} tone={data.counts.critical ? 'danger' : 'success'} hint={tr('احتمال نقض ۷۵٪ یا بیشتر')} />
        <StatTile label={tr('محتمل')} value={localDigits(data.counts.likely)} tone={data.counts.likely ? 'warning' : 'neutral'} />
        <StatTile label={tr('زودتر از آستانهٔ ثابت')} value={localDigits(data.counts.earlierThanThreshold)} tone="info"
          hint={tr('هشدار ثابت هنوز خاموش است — این‌ها را فقط پیش‌بینی می‌بیند')} />
      </div>
      <Card title={tr('پیش‌بینی نقض SLA')} subtitle={trx(data.model)}>
        {!data.predictions.length ? <EmptyState title={tr('مهلتی در معرض خطر نیست')} description={tr('هر مهلت باز با مهلت‌های مشابه گذشته سنجیده می‌شود؛ هیچ‌کدام فعلاً نگران‌کننده نیست.')} /> : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr><Th>{tr('سیاست')}</Th><Th>{tr('رکورد')}</Th><Th>{tr('احتمال نقض')}</Th><Th>{tr('مصرف‌شده')}</Th><Th>{tr('پایان محتمل')}</Th><Th>{tr('بر چه پایه‌ای')}</Th></tr>
            </thead>
            <tbody>
              {data.predictions.map((p) => (
                <Tr key={p.clockId}>
                  <Td>
                    <p className="text-sm">{loc(p, 'policy')}</p>
                    {p.departmentCode && <p className="mt-0.5"><UnitTag code={p.departmentCode} /></p>}
                  </Td>
                  <Td className="text-xs">
                    <Link to={`/${p.entityType}s/${p.entityId}`} className="text-brand-600 hover:underline">
                      {p.entityType}
                    </Link>
                  </Td>
                  <Td>
                    <div className="w-24">
                      <ProgressBar value={p.probability * 100} tone={TONE[p.risk]} />
                      <span className="nums text-[11px] text-ink-600">{tr('{0}٪ — {1}', localDigits(Math.round(p.probability * 100)), RISK_FA[p.risk])}</span>
                    </div>
                    {p.beatsWarnAt && <Badge tone="info" className="mt-1">{tr('پیش از آستانهٔ ثابت')}</Badge>}
                  </Td>
                  <Td className="nums text-xs">{tr('{0} از {1} س', localDigits(p.consumedHours), localDigits(p.budgetHours))}<span className="block text-[11px] text-ink-400">{tr('{0}٪ مهلت', localDigits(Math.round(p.ratio * 100)))}</span>
                  </Td>
                  <Td className="text-xs">
                    {p.expectedFinish ? formatDate(p.expectedFinish) : '—'}
                    {p.expectedOverrunHours != null && p.expectedOverrunHours > 0 && (
                      <span className="block text-[11px] text-rose-600">{tr('{0} س فراتر از مهلت', localDigits(p.expectedOverrunHours))}</span>
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
