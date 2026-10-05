import { localDigits } from '../lib/format';

/**
 * The kit's "Progress Half Chart" (Hivamis task 3): a half circle that fills from the reader's
 * starting side, the figure in its middle and a legend of dots beneath. Plain SVG — no chart library
 * for one arc.
 */
export function HalfGauge({ value, total, label, legend }: {
  value: number;
  total: number;
  label: string;
  legend?: { label: string; value: number; tone: 'brand' | 'warning' | 'danger' | 'neutral' }[];
}) {
  const share = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
  const r = 80;
  const length = Math.PI * r;
  const dot = { brand: 'bg-brand-600', warning: 'bg-amber-500', danger: 'bg-rose-500', neutral: 'bg-ink-300' };
  return (
    <figure className="px-5 pb-4 pt-5" aria-label={`${label}: ${value} / ${total}`}>
      <div className="relative mx-auto w-full max-w-[220px]">
        <svg viewBox="0 0 200 110" className="w-full rtl:-scale-x-100" aria-hidden>
          <path d="M20 100 A80 80 0 0 1 180 100" fill="none" className="stroke-ink-100" strokeWidth="12" strokeLinecap="round" />
          <path d="M20 100 A80 80 0 0 1 180 100" fill="none" className="stroke-brand-600 transition-[stroke-dashoffset] duration-700" strokeWidth="12" strokeLinecap="round"
            strokeDasharray={length} strokeDashoffset={length * (1 - share)} />
        </svg>
        <figcaption className="absolute inset-x-0 bottom-1 text-center">
          <span className="block text-xl font-semibold text-ink-900 nums">{localDigits(value)}<span className="text-sm font-bold text-ink-400"> / {localDigits(total)}</span></span>
          <span className="block text-xs font-bold text-ink-500">{label}</span>
        </figcaption>
      </div>
      {legend && (
        <ul className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1">
          {legend.map((l) => (
            <li key={l.label} className="flex items-center gap-1.5 text-[12.5px] font-bold text-ink-600">
              <span className={`size-2 rounded-full ${dot[l.tone]}`} aria-hidden />
              {l.label} <span className="nums text-ink-400">{localDigits(l.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
