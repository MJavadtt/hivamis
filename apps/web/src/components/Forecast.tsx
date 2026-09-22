import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { Badge, Card, EmptyState, StatTile } from './ui';
import { formatDate, toPersianDigits } from '../lib/format';

interface Forecast {
  runs: number; openTasks: number; deterministicHours: number;
  percentiles: { p50: string; p85: string; p95: string; p50Hours: number; p85Hours: number; p95Hours: number };
  plannedEnd: string | null; probabilityOnTime: number | null;
  histogram: { fromHours: number; toHours: number; from: string; to: string; runs: number }[];
  samples: { departmentCode: string | null; count: number; source: 'department' | 'organisation' | 'default' }[];
}
const SOURCE: Record<string, string> = { department: 'سابقهٔ همان واحد', organisation: 'سابقهٔ کل سازمان', default: 'توزیع پیش‌فرض — سابقه‌ای نیست' };

/**
 * "50% by this date, 85% by that one" — a distribution Account can commit to without gambling.
 * The bars are where the runs landed; the three dates are what to promise, and to whom.
 */
export function Forecast({ projectId }: { projectId: string }) {
  const { data } = useQuery<Forecast>({ queryKey: ['/projects', projectId, 'forecast'], queryFn: () => apiGet(`/projects/${projectId}/forecast`) });
  if (!data) return null;
  if (!data.openTasks) return <Card title="پیش‌بینی احتمالاتی تحویل"><EmptyState title="وظیفهٔ بازی نمانده" /></Card>;
  const max = Math.max(1, ...data.histogram.map((h) => h.runs));
  const onTime = data.probabilityOnTime == null ? null : Math.round(data.probabilityOnTime * 100);
  return (
    <Card title="پیش‌بینی احتمالاتی تحویل" subtitle={`${toPersianDigits(data.runs)} بار شبیه‌سازی زنجیرهٔ وظایف با نسبت واقعی/برآورد وظایف تمام‌شده — ${data.samples.map((s) => `${s.departmentCode ?? 'همه'}: ${SOURCE[s.source]}${s.count ? ` (${toPersianDigits(s.count)})` : ''}`).join(' · ')}`}>
      <div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-4" data-testid="forecast-tiles">
        <StatTile label="۵۰٪ احتمال تا" value={formatDate(data.percentiles.p50)} hint={`${toPersianDigits(data.percentiles.p50Hours)} ساعت کاری`} />
        <StatTile label="۸۵٪ احتمال تا" value={formatDate(data.percentiles.p85)} hint={`${toPersianDigits(data.percentiles.p85Hours)} ساعت کاری — تعهد امن`} tone="info" />
        <StatTile label="۹۵٪ احتمال تا" value={formatDate(data.percentiles.p95)} hint={`${toPersianDigits(data.percentiles.p95Hours)} ساعت کاری`} />
        <StatTile label="احتمال رسیدن به برنامه" value={onTime == null ? '—' : `${toPersianDigits(onTime)}٪`} hint={data.plannedEnd ? `برنامه: ${formatDate(data.plannedEnd)} · یک عدد قطعی می‌گفت ${toPersianDigits(data.deterministicHours)} ساعت` : 'برنامه‌ای ثبت نشده'} tone={onTime == null ? 'neutral' : onTime >= 85 ? 'success' : onTime >= 50 ? 'warning' : 'danger'} />
      </div>
      <div className="px-4 pb-4">
        <div className="flex h-24 items-end gap-1" data-testid="forecast-histogram" dir="ltr">
          {data.histogram.map((h, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1" title={`${formatDate(h.from)} تا ${formatDate(h.to)}: ${toPersianDigits(h.runs)} اجرا`}>
              <div className="w-full rounded-t bg-brand-500/70" style={{ height: `${Math.max(2, (h.runs / max) * 80)}px` }} />
              <span className="text-[9px] text-ink-400">{toPersianDigits(Math.round(h.toHours))}</span>
            </div>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-ink-500">محور افقی: ساعت کاری از اکنون تا پایان · ارتفاع: تعداد اجراهایی که در آن بازه تمام شدند</p>
        {data.samples.some((s) => s.source === 'default') && <Badge tone="warning" className="mt-2">سابقهٔ کافی نیست — با ثبت زمان روی وظایف، پیش‌بینی دقیق‌تر می‌شود</Badge>}
      </div>
    </Card>
  );
}
