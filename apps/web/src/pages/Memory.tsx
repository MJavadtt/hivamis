import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { PageBody, PageHeader } from '../components/Shell';
import { Badge, Button, Card, EmptyState, Input, LoadingBlock, ProgressBar, StatTile, cx } from '../components/ui';
import { formatDateTime, localDigits } from '../lib/format';
import { loc, tr } from '../i18n';

interface Hit {
  entityType: string; entityId: string; titleFa: string; kindFa: string; projectId: string | null;
  href: string; score: number; semantic: number; lexical: number; snippetFa: string;
  indexedAt: string; model: string;
}
interface SearchResult {
  query: string; hits: Hit[]; model: string; usedService: boolean; candidates: number;
  basisFa: string; kinds: { key: string; labelFa: string }[];
}
interface Status {
  serviceConfigured: boolean; localModel: string; total: number;
  byKind: { key: string; labelFa: string; count: number; models: string[]; lastIndexedAt: string | null }[];
}

const EXAMPLES = [
  tr('برای مشتری صنایع غذایی چه استراتژی‌هایی داده‌ایم؟'),
  tr('کجا تدوین ویدئو باعث تأخیر شد؟'),
  tr('بازخورد مشتری‌ها دربارهٔ کیفیت گرافیک'),
];

/**
 * The organisation's memory (roadmap #21). Doc_H's closure ritual — lessons learned, case
 * studies, feedback — exists so the next project is better than the last; this is the page that
 * makes those records findable by what they are about rather than by remembering they exist.
 *
 * Each result shows both halves of its score, and the page says which embedder answered. A
 * local word-based vector is not a language model, and the difference is the user's to know.
 */
export default function Memory() {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<string[]>([]);

  const { data: status } = useQuery<Status>({ queryKey: ['/memory/status'], queryFn: () => apiGet('/memory/status') });
  const { data, isFetching } = useQuery<SearchResult>({
    queryKey: ['/memory/search', query, kinds.join(',')],
    queryFn: () => apiGet('/memory/search', { q: query, limit: '15', ...(kinds.length ? { kinds: kinds.join(',') } : {}) }),
    enabled: query.trim().length > 1,
  });

  const toggle = (key: string) => setKinds((k) => (k.includes(key) ? k.filter((x) => x !== key) : [...k, key]));

  return (
    <>
      <PageHeader
        title={tr('حافظهٔ سازمان')}
        subtitle={tr('جستجو در بریف‌ها، پروپوزال‌ها، صورتجلسه‌ها، درس‌های آموخته و بازخورد مشتری — بر پایهٔ معنا، نه فقط کلمه')}
      />
      <PageBody className="space-y-5">
        <Card title={tr('چه چیزی را به یاد بیاوریم؟')}>
          <form
            className="flex flex-wrap items-end gap-2 px-4 py-3"
            onSubmit={(e) => { e.preventDefault(); setQuery(draft); }}
          >
            <label className="min-w-64 flex-1 text-xs text-ink-600">
              <span className="mb-1 block">{tr('پرسش')}</span>
              <Input data-tour="memory-ask" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={tr('مثلاً: برای مشتری صنایع غذایی چه استراتژی‌هایی داده‌ایم؟')} aria-label={tr('پرسش')} />
            </label>
            <Button type="submit" variant="primary" loading={isFetching} disabled={draft.trim().length < 2}>{tr('جستجو')}</Button>
          </form>
          <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
            {(data?.kinds ?? status?.byKind ?? []).map((k) => (
              <Button key={k.key} size="sm" variant={kinds.includes(k.key) ? 'primary' : 'secondary'} onClick={() => toggle(k.key)}>
                {loc(k, 'label')}
              </Button>
            ))}
            {kinds.length > 0 && <Button size="sm" variant="ghost" onClick={() => setKinds([])}>{tr('همه')}</Button>}
          </div>
          {!query && (
            <div className="flex flex-wrap gap-1.5 px-4 pb-4">
              {EXAMPLES.map((e) => (
                <button key={e} type="button" className="rounded-full bg-ink-100 px-3 py-1 text-[12.5px] text-ink-600 hover:bg-ink-200"
                  onClick={() => { setDraft(e); setQuery(e); }}>
                  {e}
                </button>
              ))}
            </div>
          )}
        </Card>

        {status && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label={tr('سند در حافظه')} value={localDigits(status.total)} />
            <StatTile label={tr('سرویس embedding')} value={status.serviceConfigured ? tr('پیکربندی‌شده') : tr('محلی')}
              tone={status.serviceConfigured ? 'success' : 'warning'}
              hint={status.serviceConfigured ? tr('بردارها از سرویس می‌آیند') : tr('{0} — واژه‌محور', status.localModel)} />
            <StatTile label={tr('درس‌های آموخته')} value={localDigits(status.byKind.find((k) => k.key === 'lessonLearned')?.count ?? 0)} />
            <StatTile label={tr('آخرین نمایه‌سازی')}
              value={status.byKind.map((k) => k.lastIndexedAt).filter(Boolean).sort().at(-1)
                ? formatDateTime(status.byKind.map((k) => k.lastIndexedAt).filter(Boolean).sort().at(-1)!)
                : '—'} />
          </div>
        )}

        {query && (isFetching && !data ? <LoadingBlock /> : (
          <Card
            title={tr('نتایج برای «{0}»', query)}
            subtitle={data ? tr('{0} یافته از {1} سند بررسی‌شده — {2}', localDigits(data.hits.length), localDigits(data.candidates), data.basisFa) : undefined}
          >
            {!data?.hits.length ? (
              <EmptyState title={tr('چیزی پیدا نشد')} description={tr('شاید هنوز چنین چیزی ثبت نشده، یا با واژه‌های دیگری ثبت شده است.')} />
            ) : (
              <ul className="divide-y divide-ink-100" data-testid="memory-hits">
                {data.hits.map((h) => (
                  <li key={`${h.entityType}:${h.entityId}`} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">{loc(h, 'kind')}</Badge>
                      <Link to={h.href} className="text-sm font-medium text-brand-700 hover:underline">{loc(h, 'title')}</Link>
                      <span className="ms-auto flex items-center gap-2">
                        <span className="w-20"><ProgressBar value={h.score * 100} tone={h.score > 0.5 ? 'success' : h.score > 0.25 ? 'info' : 'neutral'} /></span>
                        <span className="nums text-[12.5px] text-ink-500">{tr('{0}٪', localDigits(Math.round(h.score * 100)))}</span>
                      </span>
                    </div>
                    <p className={cx('mt-1 text-xs leading-6 text-ink-600')}>{loc(h, 'snippet')}</p>
                    <p className="mt-1 text-[12.5px] text-ink-400">{tr('شباهت معنایی {0}٪ · شباهت متنی {1}٪ · بردار: {2}', localDigits(Math.round(h.semantic * 100)), localDigits(Math.round(h.lexical * 100)), h.model)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))}
      </PageBody>
    </>
  );
}
