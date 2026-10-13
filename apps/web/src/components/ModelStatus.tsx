import { useQuery } from '@tanstack/react-query';
import type { ChatModelStatus } from '@hiva/contracts';
import { apiGet } from '../lib/api';
import { localDigits } from '../lib/format';
import { Badge, Card } from './ui';
import { tr } from '../i18n';

/** The assistant's model as it stands (audit F-1): what it is, where it sits in memory, and the queue. */
export function ModelCard() {
  const { data: s } = useQuery<ChatModelStatus>({ queryKey: ['/ai/chat/status'], queryFn: () => apiGet('/ai/chat/status'), refetchInterval: 15_000, retry: false });
  if (!s) return null;
  const gb = (b: number | null) => (b == null ? '—' : tr('{0} گیگابایت', localDigits((b / 1024 ** 3).toFixed(1))));
  const where = !s.loaded ? tr('بارگذاری نشده — پرسش بعدی چند ثانیه بیشتر طول می‌کشد')
    : s.vramBytes && s.sizeBytes && s.vramBytes >= s.sizeBytes * 0.95 ? tr('کامل روی GPU')
    : s.vramBytes ? tr('بخشی روی GPU ({0})', gb(s.vramBytes)) : tr('روی CPU');
  const state = s.ready ? <Badge tone="success">{tr('آماده')}</Badge>
    : <Badge tone="danger">{s.mode === 'off' ? tr('خاموش') : !s.reachable ? tr('سرور مدل پاسخ نمی‌دهد') : tr('مدل روی سرور نیست')}</Badge>;
  return (
    <div className="mb-4">
      <Card title={tr('مدل دستیار')} subtitle={tr('روی سرور خود سازمان اجرا می‌شود؛ هزینه‌ای برای هر پرسش ندارد و سرعتش به سخت‌افزار همین سرور بستگی دارد')}>
        <dl className="grid gap-4 p-4 text-sm sm:grid-cols-3" data-testid="model-card">
          <div><dt className="text-ink-500">{tr('مدل')}</dt><dd className="ltr mt-1 font-medium text-ink-800">{s.model ?? '—'}</dd></div>
          <div><dt className="text-ink-500">{tr('وضعیت')}</dt><dd className="mt-1">{state}</dd></div>
          <div><dt className="text-ink-500">{tr('اندازه')}</dt><dd className="mt-1 text-ink-800"><span className="ltr">{[s.parameterSize, s.quantization].filter(Boolean).join(' · ') || '—'}</span> · {gb(s.sizeBytes)}</dd></div>
          <div><dt className="text-ink-500">{tr('در حافظه')}</dt><dd className="mt-1 text-ink-800">{where}</dd></div>
          <div><dt className="text-ink-500">{tr('در حال پاسخ')}</dt><dd className="nums mt-1 text-ink-800">{localDigits(s.busy)}</dd></div>
          <div><dt className="text-ink-500">{tr('در صف')}</dt><dd className="nums mt-1 text-ink-800">{localDigits(s.waiting)}</dd></div>
        </dl>
      </Card>
    </div>
  );
}

