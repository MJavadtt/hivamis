import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { Badge, Card, EmptyState, StatTile } from './ui';
import { formatDate, localDigits } from '../lib/format';
import { tr } from '../i18n';

interface Forecast {
  runs: number; openTasks: number; deterministicHours: number;
  percentiles: { p50: string; p85: string; p95: string; p50Hours: number; p85Hours: number; p95Hours: number };
  plannedEnd: string | null; probabilityOnTime: number | null;
  histogram: { fromHours: number; toHours: number; from: string; to: string; runs: number }[];
  samples: { departmentCode: string | null; count: number; source: 'department' | 'organisation' | 'default' }[];
}
const SOURCE: Record<string, string> = { department: tr('سابقهٔ همان واحد'), organisation: tr('سابقهٔ کل سازمان'), default: tr('توزیع پیش‌فرض — سابقه‌ای نیست') };

/**
 * "50% by this date, 85% by that one" — a distribution Account can commit to without gambling.
 * The bars are where the runs landed; the three dates are what to promise, and to whom.
 */
export function Forecast({ projectId }: { projectId: string }) {
  const { data } = useQuery<Forecast>({ queryKey: ['/projects', projectId, 'forecast'], queryFn: () => apiGet(`/projects/${projectId}/forecast`) });
  if (!data) return null;
  if (!data.openTasks) return <Card title={tr('پیش‌بینی احتمالاتی تحویل')}><EmptyState title={tr('وظیفهٔ بازی نمانده')} /></Card>;
  const max = Math.max(1, ...data.histogram.map((h) => h.runs));
  const onTime = data.probabilityOnTime == null ? null : Math.round(data.probabilityOnTime * 100);
  return (
    <Card title={tr('پیش‌بینی احتمالاتی تحویل')} subtitle={tr('{0} بار شبیه‌سازی زنجیرهٔ وظایف با نسبت واقعی/برآورد وظایف تمام‌شده — {1}', localDigits(data.runs), data.samples.map((s) => `${s.departmentCode ?? tr('همه')}: ${SOURCE[s.source]}${s.count ? ` (${localDigits(s.count)})` : ''}`).join(' · '))}>
      <div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-4" data-testid="forecast-tiles">
        <StatTile label={tr('۵۰٪ احتمال تا')} value={formatDate(data.percentiles.p50)} hint={tr('{0} ساعت کاری', localDigits(data.percentiles.p50Hours))} />
        <StatTile label={tr('۸۵٪ احتمال تا')} value={formatDate(data.percentiles.p85)} hint={tr('{0} ساعت کاری — تعهد امن', localDigits(data.percentiles.p85Hours))} tone="info" />
        <StatTile label={tr('۹۵٪ احتمال تا')} value={formatDate(data.percentiles.p95)} hint={tr('{0} ساعت کاری', localDigits(data.percentiles.p95Hours))} />
        <StatTile label={tr('احتمال رسیدن به برنامه')} value={onTime == null ? '—' : tr('{0}٪', localDigits(onTime))} hint={data.plannedEnd ? tr('برنامه: {0} · یک عدد قطعی می‌گفت {1} ساعت', formatDate(data.plannedEnd), localDigits(data.deterministicHours)) : tr('برنامه‌ای ثبت نشده')} tone={onTime == null ? 'neutral' : onTime >= 85 ? 'success' : onTime >= 50 ? 'warning' : 'danger'} />
      </div>
      <div className="px-4 pb-4">
        <div className="flex h-24 items-end gap-1" data-testid="forecast-histogram" dir="ltr">
          {data.histogram.map((h, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1" title={tr('{0} تا {1}: {2} اجرا', formatDate(h.from), formatDate(h.to), localDigits(h.runs))}>
              <div className="w-full rounded-t bg-brand-500/70" style={{ height: `${Math.max(2, (h.runs / max) * 80)}px` }} />
              <span className="text-[9px] text-ink-400">{localDigits(Math.round(h.toHours))}</span>
            </div>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-ink-500">{tr('محور افقی: ساعت کاری از اکنون تا پایان · ارتفاع: تعداد اجراهایی که در آن بازه تمام شدند')}</p>
        {data.samples.some((s) => s.source === 'default') && <Badge tone="warning" className="mt-2">{tr('سابقهٔ کافی نیست — با ثبت زمان روی وظایف، پیش‌بینی دقیق‌تر می‌شود')}</Badge>}
      </div>
    </Card>
  );
}
