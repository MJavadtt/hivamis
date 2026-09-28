import { useQuery } from '@tanstack/react-query';
import { BRAND_CHECK_STATUS_LABELS } from '@hiva/contracts';
import { apiGet } from '../lib/api';
import { Badge, type Tone } from './ui';
import { toPersianDigits } from '../lib/format';

/*
 * Roadmap #43 — one file against its client's brand: the colours it is made of, the typefaces a
 * PDF uses, each named against the brand library. Advice for the reviewer, never a verdict.
 */

interface ColourVerdict { hex?: string; cmyk?: number[]; share: number; status: string; brand?: { name: string; hex: string }; distance?: number }
interface BrandCheck {
  kind: 'image' | 'pdf'; verdict: 'OK' | 'WARN' | 'NOT_CHECKED'; offShare: number; notesFa: string[];
  colours: ColourVerdict[];
  fonts: { name: string; share: number; status: string; brand?: string }[];
  spots: { name: string; share: number; status: string; brand?: string }[];
}
interface Response { supported: boolean; check: BrandCheck | null; noteFa: string | null; company: { legalName: string } | null }

const TONE: Record<string, Tone> = { BRAND: 'success', NEAR: 'warning', NEUTRAL: 'neutral', OFF: 'danger', UNCHECKED: 'neutral' };
const VERDICT: Record<BrandCheck['verdict'], { tone: Tone; fa: string }> = {
  OK: { tone: 'success', fa: 'با برند می‌خواند' },
  WARN: { tone: 'warning', fa: 'بیرون از برند' },
  NOT_CHECKED: { tone: 'neutral', fa: 'سنجیده نشد' },
};
export const shareFa = (share: number) => `${toPersianDigits(Math.round(share * 100))}٪`;

/** A CMYK colour shown on screen by the naive formula — for recognising it, not for proofing. */
export const inkToCss = ([c, m, y, k]: number[]) => {
  const ch = (v: number) => Math.round(255 * (1 - v! / 100) * (1 - k! / 100));
  return `rgb(${ch(c!)}, ${ch(m!)}, ${ch(y!)})`;
};

export function BrandCheckPanel({ documentId }: { documentId: string }) {
  const { data } = useQuery<Response>({ queryKey: [`/documents/${documentId}/brand-check`], queryFn: () => apiGet(`/documents/${documentId}/brand-check`) });
  if (!data) return <div className="h-16 animate-pulse rounded-lg bg-ink-100" />;
  const c = data.check;
  return (
    <section className="space-y-2 rounded-lg border border-ink-200 p-3 text-xs" data-testid="brand-check">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink-700">در برابر برند{data.company ? ` ${data.company.legalName}` : ''}</span>
        {c && <Badge tone={VERDICT[c.verdict].tone}>{VERDICT[c.verdict].fa}</Badge>}
        {c && c.offShare > 0 && <span className="text-ink-500">{shareFa(c.offShare)} {c.kind === 'image' ? 'از سطح' : 'از رنگ‌گذاری‌ها'} بیرون از پالت</span>}
      </div>
      {data.noteFa && <p className="text-ink-500">{data.noteFa}</p>}
      {c && c.colours.length > 0 && (
        <ul className="flex flex-wrap gap-2" data-testid="brand-colours">
          {c.colours.map((v, i) => (
            <li key={i} className="flex items-center gap-1.5 rounded-md border border-ink-200 px-1.5 py-1">
              <span className="size-5 shrink-0 rounded ring-1 ring-ink-200" style={{ background: v.hex ?? inkToCss(v.cmyk!) }} />
              <span className="ltr text-[11px] text-ink-700">{v.hex ?? `C${v.cmyk![0]} M${v.cmyk![1]} Y${v.cmyk![2]} K${v.cmyk![3]}`}</span>
              <span className="text-[10px] text-ink-400">{shareFa(v.share)}</span>
              <Badge tone={TONE[v.status] ?? 'neutral'}>
                {v.status === 'BRAND' || v.status === 'NEAR' ? `${BRAND_CHECK_STATUS_LABELS[v.status]}: ${v.brand!.name}` : BRAND_CHECK_STATUS_LABELS[v.status]}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {c && c.fonts.length > 0 && (
        <p data-testid="brand-fonts-used">
          <span className="text-ink-500">فونت‌ها: </span>
          {c.fonts.map((f, i) => (
            <span key={f.name} className={f.status === 'OFF' ? 'text-rose-700' : f.status === 'BRAND' ? 'text-emerald-700' : 'text-ink-600'}>
              {i > 0 && '، '}{f.name}{f.status === 'OFF' ? ' (بیرون از برند)' : f.status === 'BRAND' ? ' ✓' : ''}
            </span>
          ))}
        </p>
      )}
      {c && c.spots.length > 0 && (
        <p className="text-ink-600"><span className="text-ink-500">رنگ‌های اختصاصی: </span>{c.spots.map((s) => `${s.name}${s.status === 'BRAND' ? ' ✓' : ''}`).join('، ')}</p>
      )}
      {c && c.notesFa.length > 0 && <ul className="list-inside list-disc text-[11px] text-ink-400">{c.notesFa.map((n) => <li key={n}>{n}</li>)}</ul>}
    </section>
  );
}
