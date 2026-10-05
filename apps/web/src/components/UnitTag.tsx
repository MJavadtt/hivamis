import { useQuery } from '@tanstack/react-query';
import { DEPARTMENT_LABELS, textOn, unitColor, type DepartmentCode } from '@hiva/contracts';
import { apiGet } from '../lib/api';
import { cx } from './ui';
import { loc, pair } from '../i18n';

/**
 * A unit as a coloured tag (Hivamis task 9). The colour is the one the organisation's system
 * administrator chose for the unit (Administration → Units), else the unit's default; the text is
 * black or white, whichever reads better on it, so every choice stays legible.
 */

export interface Unit {
  id: string; code: string; nameFa: string; nameEn: string;
  /** What the unit is shown in. */
  color: string;
  /** The administrator's choice, or null for the default. */
  tagColor: string | null;
}

/** The organisation's units — the same list the calendar and form pages read, kept five minutes. */
export function useUnits() {
  return useQuery<Unit[]>({ queryKey: ['/departments'], queryFn: () => apiGet('/departments'), staleTime: 300_000 });
}

export function UnitTag({ code, className }: { code: string | null | undefined; className?: string }) {
  const { data } = useUnits();
  if (!code) return <span className="text-ink-400">—</span>;
  const unit = data?.find((u) => u.code === code);
  const color = unit?.color ?? unitColor(code);
  const name = (unit ? loc(unit, 'name') : pair(DEPARTMENT_LABELS[code as DepartmentCode])) || code;
  return (
    <span
      className={cx('inline-flex max-w-[11rem] items-center rounded-md px-1.5 py-0.5 text-[12.5px] font-medium leading-4', className)}
      style={{ backgroundColor: color, color: textOn(color) }}
      title={`${name} (${code})`}
      data-unit={code}
    >
      <span className="truncate">{name}</span>
    </span>
  );
}
