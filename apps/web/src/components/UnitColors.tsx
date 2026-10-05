import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DEFAULT_UNIT_COLORS, textOn } from '@hiva/contracts';
import { apiPatch } from '../lib/api';
import { Card, EmptyState, ErrorBlock, LoadingBlock, cx, useToast } from './ui';
import { UnitTag, useUnits, type Unit } from './UnitTag';
import { loc, tr } from '../i18n';

/**
 * Each unit's tag colour (Hivamis task 9) — the system administrator's choice, one click per unit.
 * The swatches are the ten defaults and a few more; any other colour can be picked by hand. The tag
 * everywhere in the system changes with it, and the change is recorded in the audit trail.
 */

const SWATCHES = [...new Set([...Object.values(DEFAULT_UNIT_COLORS), '#dc2626', '#9333ea', '#65a30d', '#b45309', '#1d4ed8', '#0f766e'])];

export function UnitColors() {
  const { data, isLoading, error, refetch } = useUnits();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const choose = async (unit: Unit, color: string | null) => {
    setBusy(unit.code);
    try {
      await apiPatch(`/departments/${unit.code}/color`, { color });
      await qc.invalidateQueries({ queryKey: ['/departments'] });
      toast(color ? tr('رنگ برچسب «{0}» ثبت شد.', loc(unit, 'name')) : tr('رنگ برچسب «{0}» به پیش‌فرض برگشت.', loc(unit, 'name')));
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(null); }
  };

  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  return (
    <Card title={tr('رنگ برچسب واحدها')} subtitle={tr('هر واحد در همهٔ صفحه‌ها با همین رنگ دیده می‌شود. متن برچسب خودبه‌خود سیاه یا سفید می‌شود تا خوانا بماند.')}>
      {!data?.length ? <EmptyState title={tr('واحدی تعریف نشده')} /> : (
        <ul className="divide-y divide-ink-100" data-testid="unit-colors">
          {data.map((u) => (
            <li key={u.code} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="w-56 min-w-0">
                <UnitTag code={u.code} />
                <p className="mt-1 text-[12.5px] text-ink-500">
                  <span className="ltr font-mono">{u.code}</span>{' · '}{u.tagColor ? tr('انتخاب مدیر سیستم') : tr('پیش‌فرض')}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={tr('رنگ برچسب «{0}»', loc(u, 'name'))}>
                {SWATCHES.map((c) => (
                  <button
                    key={c} type="button" role="radio" aria-checked={u.color === c} aria-label={c}
                    disabled={busy === u.code}
                    onClick={() => u.color !== c && void choose(u, c)}
                    className={cx('size-6 rounded-full ring-offset-2 ring-offset-surface transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 disabled:opacity-50',
                      u.color === c ? 'ring-2 ring-ink-800' : 'hover:scale-110')}
                    style={{ backgroundColor: c, color: textOn(c) }}
                  >
                    {u.color === c && <span aria-hidden className="text-[12.5px] font-bold">✓</span>}
                  </button>
                ))}
                <CustomColor unit={u} disabled={busy === u.code} onPick={(c) => void choose(u, c)} />
                {u.tagColor && (
                  <button type="button" disabled={busy === u.code} onClick={() => void choose(u, null)} className="ms-2 text-[12.5px] text-brand-700 underline disabled:opacity-50">
                    {tr('پیش‌فرض')}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * Any colour, by hand. The browser's picker reports every shade it passes through while dragging,
 * so the choice is saved once it has rested for a moment, not on each of them.
 */
function CustomColor({ unit, disabled, onPick }: { unit: Unit; disabled: boolean; onPick: (color: string) => void }) {
  const [draft, setDraft] = useState(unit.color);
  const pick = useRef(onPick);
  pick.current = onPick;
  useEffect(() => { setDraft(unit.color); }, [unit.color]);
  useEffect(() => {
    if (draft.toLowerCase() === unit.color.toLowerCase()) return;
    const timer = setTimeout(() => pick.current(draft.toLowerCase()), 600);
    return () => clearTimeout(timer);
  }, [draft, unit.color]);
  return (
    <label className="relative ms-1 inline-flex cursor-pointer items-center gap-1 text-[12.5px] text-ink-600" title={tr('رنگ دلخواه')}>
      <input
        type="color" value={draft} disabled={disabled} aria-label={tr('رنگ دلخواه برای «{0}»', loc(unit, 'name'))}
        onChange={(e) => setDraft(e.target.value)}
        className="size-6 cursor-pointer rounded border border-ink-200 bg-transparent p-0"
      />
      {tr('دلخواه')}
    </label>
  );
}
