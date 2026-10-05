import { textOn, unitColor } from '@hiva/contracts';
import { cx } from './ui';

/**
 * A person's initials on their unit's colour (Hivamis tasks 4 and 9) — the same colour as the unit's
 * tag, so a face and a unit read together across the system.
 */
export function Avatar({ name, unit, color, size = 'md', className }: {
  name: string; unit?: string | null; color?: string | null; size?: 'sm' | 'md' | 'lg'; className?: string;
}) {
  const bg = color ?? unitColor(unit ?? '');
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('');
  return (
    <span
      aria-hidden
      className={cx('inline-grid shrink-0 place-items-center rounded-full font-semibold',
        size === 'sm' ? 'size-7 text-[12.5px]' : size === 'lg' ? 'size-16 text-xl' : 'size-10 text-sm', className)}
      style={{ backgroundColor: bg, color: textOn(bg) }}
    >
      {initials}
    </span>
  );
}
