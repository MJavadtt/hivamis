import { brandFrame, type BrandKind } from '@hiva/contracts';
import { cx } from './ui';
import { tr } from '../i18n';

/**
 * The Hiva logo (the owner's artwork, traced into paths in @hiva/contracts): the mark, the wordmark
 * with its tagline, or the whole lockup. It takes the text colour, so it is black on the light canvas
 * and white on the dark, as the artwork shows both. Size it by height (`h-8`); the width follows.
 */
export function HivaLogo({ kind = 'logo', className, label }: { kind?: BrandKind; className?: string; label?: string }) {
  const f = brandFrame(kind);
  return (
    <svg
      viewBox={`${f.x} ${f.y} ${f.w} ${f.h}`}
      className={cx('w-auto shrink-0', className)}
      role="img"
      aria-label={label ?? 'Hiva'}
      focusable="false"
    >
      <g fill="currentColor" fillRule="evenodd">
        {f.pieces.map((p, i) => <path key={i} transform={`translate(${p.x} ${p.y})`} d={p.d} />)}
      </g>
    </svg>
  );
}

/**
 * The product's name beside the mark — the sidebar's, the phone bar's, a page head's. The mark takes
 * the ink colour; the name is read out once, by the link around it.
 */
export function BrandLockup({ compact, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={cx('flex min-w-0 items-center gap-2.5 text-ink-900', className)}>
      <HivaLogo kind="mark" className="h-8" label={tr('هیوامیس')} />
      {!compact && <span className="truncate text-[14px] font-bold">{tr('هیوامیس')}</span>}
    </span>
  );
}
