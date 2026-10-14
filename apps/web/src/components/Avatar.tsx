import { useState } from 'react';
import { textOn, unitColor } from '@hiva/contracts';
import { cx } from './ui';

/**
 * A person: their photo where they have one (audit F-6), else their initials on their unit's colour
 * (Hivamis tasks 4 and 9) — the same colour as the unit's tag, so a face and a unit read together
 * across the system. A photo that fails to load falls back to the initials.
 */
export function Avatar({ name, unit, color, src, size = 'md', className }: {
  name: string; unit?: string | null; color?: string | null; src?: string | null; size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'; className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const bg = color ?? unitColor(unit ?? '');
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('');
  const box = size === 'xs' ? 'size-6 text-[12px]' : size === 'sm' ? 'size-7 text-[12.5px]' : size === 'lg' ? 'size-16 text-xl' : size === 'xl' ? 'size-24 text-3xl' : 'size-10 text-sm';
  if (src && failed !== src) {
    // Decorative: the name is always written beside it.
    return <img src={src} alt="" aria-hidden onError={() => setFailed(src)} className={cx('shrink-0 rounded-full object-cover ring-1 ring-edge', box, className)} />;
  }
  return (
    <span aria-hidden className={cx('inline-grid shrink-0 place-items-center rounded-full font-semibold', box, className)} style={{ backgroundColor: bg, color: textOn(bg) }}>
      {initials}
    </span>
  );
}
