import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { Badge, Card, ProgressBar } from './ui';
import { Code } from './common';
import { localDigits } from '../lib/format';
import { loc, tr } from '../i18n';

interface Field { key: string; labelFa: string; weight: number; score: number; words: number; findingsFa: string[] }
interface Payload {
  completeness: { score: number; missing: string[] };
  quality: {
    score: number; band: 'STRONG' | 'ADEQUATE' | 'WEAK' | 'INCOMPLETE'; bandFa: string;
    fields: Field[]; fixFirst: { key: string; labelFa: string; lostPoints: number } | null;
  };
  benchmark: {
    briefs: number; enoughHistory: boolean; noteFa: string;
    winners: { count: number; meanScore: number | null; medianWords: Record<string, number> };
    returnRateByBand: { band: string; briefs: number; returned: number; rate: number | null }[];
  };
  example: null | {
    id: string; code: string; title: string; similarity: number;
    businessObjective: string | null; targetAudience: string | null; scope: string | null;
    expectedDeliverables: string | null; successCriteria: string | null;
  };
}
const TONE = { STRONG: 'success', ADEQUATE: 'info', WEAK: 'warning', INCOMPLETE: 'danger' } as const;
const BAND_FA: Record<string, string> = { STRONG: tr('قوی'), ADEQUATE: tr('قابل قبول'), WEAK: tr('ضعیف'), INCOMPLETE: tr('ناقص') };

/**
 * How specific the brief is, not merely whether it is filled (roadmap #25). Doc_H's cycle 1 —
 * the brief sent back to Sales — is mostly vague briefs, not empty ones; this shows where the
 * vagueness is, quotes it, and says what to fix first. Beside it, the organisation's own
 * evidence: what briefs that won looked like, and whether a low score here really does predict
 * a return.
 */
export function BriefQuality({ briefId }: { briefId: string }) {
  const { data } = useQuery<Payload>({ queryKey: ['/briefs', briefId, 'quality'], queryFn: () => apiGet(`/briefs/${briefId}/quality`) });
  if (!data) return null;
  const { quality, benchmark, example } = data;

  return (
    <Card
      title={tr('کیفیت بریف')}
      subtitle={tr('نه فقط پر بودن فیلدها — اینکه هر فیلد به‌قدر کافی مشخص است تا پروپوزال بر پایه‌اش نوشته شود')}
      action={<Badge tone={TONE[quality.band]}>{tr('{0} — {1} از ۱۰۰', quality.bandFa, localDigits(quality.score))}</Badge>}
    >
      <div className="grid gap-4 px-4 py-3 lg:grid-cols-2">
        <div>
          {quality.fixFirst && (
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="fix-first">{tr('اول «{0}» را دقیق کنید — {1} امتیاز همین‌جا از دست رفته است.', quality.fixFirst.labelFa, localDigits(quality.fixFirst.lostPoints))}</p>
          )}
          <ul className="space-y-2.5" data-testid="quality-fields">
            {quality.fields.map((f) => (
              <li key={f.key}>
                <div className="flex items-center gap-2 text-xs">
                  <span className="w-32 shrink-0 text-ink-700">{loc(f, 'label')}</span>
                  <span className="flex-1"><ProgressBar value={f.score} tone={f.score >= 80 ? 'success' : f.score >= 50 ? 'warning' : 'danger'} /></span>
                  <span className="nums w-8 text-end text-[11px] text-ink-500">{localDigits(f.score)}</span>
                </div>
                {f.findingsFa.length > 0 && (
                  <ul className="mt-0.5 space-y-0.5 ps-3 text-[11px] leading-5 text-ink-500">
                    {f.findingsFa.map((x, i) => <li key={i}>· {x}</li>)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-3 text-xs">
          <div className="rounded-lg bg-ink-50/70 p-3" data-testid="quality-history">
            <p className="font-medium text-ink-700">{tr('تاریخچهٔ همین سازمان')}</p>
            <p className="mt-1 text-ink-500">{loc(benchmark, 'note')}</p>
            {benchmark.winners.meanScore != null && benchmark.enoughHistory && (
              <p className="mt-1 text-ink-600">{tr('میانگین امتیاز بریف‌هایی که به قرارداد رسیدند:')}{' '}<span className="nums font-medium">{localDigits(benchmark.winners.meanScore)}</span>
              </p>
            )}
            <table className="mt-2 w-full text-[11px]">
              <thead><tr className="text-ink-400"><th className="text-start font-normal">{tr('سطح')}</th><th className="text-start font-normal">{tr('بریف')}</th><th className="text-start font-normal">{tr('بازگشت‌خورده')}</th></tr></thead>
              <tbody>
                {benchmark.returnRateByBand.map((r) => (
                  <tr key={r.band} className={r.band === quality.band ? 'font-medium text-ink-800' : 'text-ink-600'}>
                    <td>{BAND_FA[r.band]}</td>
                    <td className="nums">{localDigits(r.briefs)}</td>
                    <td className="nums">{r.rate == null ? tr('{0} (کم‌داده)', localDigits(r.returned)) : tr('{0}٪', localDigits(Math.round(r.rate * 100)))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {example && (
            <div className="rounded-lg bg-emerald-50/70 p-3" data-testid="quality-example">
              <p className="font-medium text-emerald-900">{tr('نمونه‌ای مشابه که به قرارداد رسید')}</p>
              <p className="mt-0.5 text-[11px] text-emerald-800">
                <Link to={`/briefs/${example.id}`} className="hover:underline">{example.title}</Link> <Code>{example.code}</Code>
              </p>
              {quality.fixFirst && (example as Record<string, unknown>)[quality.fixFirst.key] ? (
                <p className="mt-1 leading-6 text-emerald-900">{tr('«{0}» در آن بریف: {1}', quality.fixFirst.labelFa, String((example as Record<string, unknown>)[quality.fixFirst.key]))}</p>
              ) : (
                <p className="mt-1 leading-6 text-emerald-900">{example.successCriteria ?? example.businessObjective}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
