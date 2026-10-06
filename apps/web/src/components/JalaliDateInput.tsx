import { useEffect, useMemo, useRef, useState } from 'react';
import {
  JALALI_MONTHS, JALALI_WEEKDAYS, formatJalaliInput, isoToJalaliParts, jalaliDaysInMonth,
  jalaliFirstWeekday, jalaliPartsToValue, parseJalaliInput, todayJalaliParts, toPersianDigits,
  type JalaliParts,
} from '../lib/format';
import { Input, cx } from './ui';
import { isEnglish, tr } from '../i18n';

type DateInputProps = {
  value: string | null | undefined;
  onChange: (next: string) => void;
  mode?: 'date' | 'datetime';
  disabled?: boolean;
  id?: string;
  invalid?: boolean;
  /** Its name for a screen reader, where no <label> stands beside it (Hivamis task 10). */
  label?: string;
};

/**
 * Date entry in the reader's calendar: Solar Hijri in Persian, the browser's own Gregorian picker in
 * English (Hivamis task 7). Both emit the same value — `YYYY-MM-DD`, or a UTC instant for a
 * datetime — so nothing behind the field knows which calendar it was typed in.
 */
export function JalaliDateInput(props: DateInputProps) {
  return isEnglish() ? <GregorianDateInput {...props} /> : <JalaliEntry {...props} />;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** A stored instant as the `datetime-local` input wants it: the reader's local wall clock. */
function toLocalInput(value: string | null | undefined, mode: 'date' | 'datetime'): string {
  if (!value) return '';
  if (mode === 'date') return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function GregorianDateInput({ value, onChange, mode = 'date', disabled, id, invalid, label }: DateInputProps) {
  return (
    <Input
      id={id}
      aria-label={label}
      type={mode === 'date' ? 'date' : 'datetime-local'}
      value={toLocalInput(value, mode)}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      onChange={(e) => {
        const v = e.target.value;
        if (!v) { onChange(''); return; }
        // A datetime is an instant: the local wall clock goes out as UTC, as the Solar Hijri entry does.
        onChange(mode === 'date' ? v : new Date(v).toISOString());
      }}
      className="ltr"
    />
  );
}

/**
 * Jalali date entry.
 *
 * Every date in the app already *displays* as Jalali, but entry was a native <input type="date">,
 * which is Gregorian in practice — so a user read «مهلت: ۱۴۰۵/۰۶/۳۱» and had to type 2026-09-22.
 *
 * Typing works on its own: the field is a plain text input that accepts Persian, Arabic-Indic or
 * Latin digits with `/`, `-` or `.` between them. The calendar is an accelerator, not the only
 * way in, so the control stays usable from the keyboard without opening anything.
 *
 * The value emitted is unchanged from the native input: `YYYY-MM-DD` for a date, and a UTC
 * instant for a datetime. No API contract moves.
 */
function JalaliEntry({ value, onChange, mode = 'date', disabled, id, invalid, label }: DateInputProps) {
  const parts = useMemo(() => isoToJalaliParts(value), [value]);
  const [text, setText] = useState(() => formatJalaliInput(parts, mode));
  const [open, setOpen] = useState(false);
  const [badInput, setBadInput] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  // Re-sync when the value changes underneath us (a form reset, or a sibling field driving it),
  // but never while the user is mid-edit or the caret jumps.
  useEffect(() => {
    if (document.activeElement !== fieldRef.current) {
      setText(formatJalaliInput(parts, mode));
      setBadInput(false);
    }
  }, [parts, mode]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); fieldRef.current?.focus(); }
    };
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const commit = (raw: string) => {
    if (!raw.trim()) { setBadInput(false); onChange(''); return; }
    const p = parseJalaliInput(raw, mode);
    if (!p) { setBadInput(true); return; }
    setBadInput(false);
    setText(formatJalaliInput(p, mode));
    onChange(jalaliPartsToValue(p, mode));
  };

  const pick = (p: JalaliParts) => {
    setText(formatJalaliInput(p, mode));
    setBadInput(false);
    onChange(jalaliPartsToValue(p, mode));
    setOpen(false);
    fieldRef.current?.focus();
  };

  return (
    <div ref={boxRef} className="relative">
      <Input
        id={id}
        aria-label={label}
        ref={fieldRef}
        value={text}
        disabled={disabled}
        inputMode="numeric"
        autoComplete="off"
        aria-invalid={invalid || badInput || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        placeholder={mode === 'date' ? tr('۱۴۰۵/۰۶/۳۱') : tr('۱۴۰۵/۰۶/۳۱ ۱۴:۳۰')}
        onChange={(e) => { setText(e.target.value); setBadInput(false); }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(text); }
          if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); }
        }}
        className={cx('ltr text-center', badInput && 'border-rose-400 focus-visible:outline-rose-400')}
      />

      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        aria-label={tr('انتخاب از تقویم')}
        onClick={() => setOpen((o) => !o)}
        className="absolute inset-y-0 start-0 flex items-center px-2.5 text-ink-400 hover:text-brand-600
                   disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M8 3v4M16 3v4M3 10h18" strokeLinecap="round" />
        </svg>
      </button>

      {badInput && (
        <p className="mt-1 text-[12.5px] text-rose-600">{tr('تاریخ نامعتبر است — قالب درست: {0}', mode === 'date' ? tr('۱۴۰۵/۰۶/۳۱') : tr('۱۴۰۵/۰۶/۳۱ ۱۴:۳۰'))}</p>
      )}

      {open && !disabled && (
        <CalendarPopover
          selected={parts}
          mode={mode}
          onPick={pick}
          onClose={() => { setOpen(false); fieldRef.current?.focus(); }}
        />
      )}
    </div>
  );
}

function CalendarPopover({
  selected, mode, onPick, onClose,
}: {
  selected: JalaliParts | null;
  mode: 'date' | 'datetime';
  onPick: (p: JalaliParts) => void;
  onClose: () => void;
}) {
  const today = useMemo(todayJalaliParts, []);
  const base = selected ?? today;
  const [view, setView] = useState({ jy: base.jy, jm: base.jm });
  const [time, setTime] = useState({ hh: base.hh, mm: base.mm });

  const days = jalaliDaysInMonth(view.jy, view.jm);
  const lead = jalaliFirstWeekday(view.jy, view.jm);

  const step = (delta: number) => setView((v) => {
    const n = v.jm + delta;
    if (n < 1) return { jy: v.jy - 1, jm: 12 };
    if (n > 12) return { jy: v.jy + 1, jm: 1 };
    return { ...v, jm: n };
  });

  return (
    <div
      role="dialog"
      aria-label={tr('تقویم')}
      className="bg-panel absolute z-30 mt-1 w-[17.5rem] rounded-xl p-3 shadow-glass ring-1 ring-edge"
    >
      <div className="mb-2 flex items-center justify-between">
        {/* In RTL the "previous month" control sits on the right, so the arrows are mirrored. */}
        <button type="button" onClick={() => step(1)} aria-label={tr('ماه بعد')}
          className="rounded-md px-2 py-1 text-ink-500 hover:bg-ink-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500">‹</button>
        <span className="text-sm font-medium text-ink-800">
          {JALALI_MONTHS[view.jm - 1]} {toPersianDigits(view.jy)}
        </span>
        <button type="button" onClick={() => step(-1)} aria-label={tr('ماه قبل')}
          className="rounded-md px-2 py-1 text-ink-500 hover:bg-ink-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500">›</button>
      </div>

      <div className="grid grid-cols-7 gap-0.5 text-center">
        {JALALI_WEEKDAYS.map((d, i) => (
          <span key={i} className="py-1 text-[12.5px] text-ink-400">{d}</span>
        ))}
        {Array.from({ length: lead }, (_, i) => <span key={`pad${i}`} />)}
        {Array.from({ length: days }, (_, i) => {
          const jd = i + 1;
          const isSelected = selected?.jy === view.jy && selected?.jm === view.jm && selected?.jd === jd;
          const isToday = today.jy === view.jy && today.jm === view.jm && today.jd === jd;
          return (
            <button
              key={jd}
              type="button"
              aria-current={isToday ? 'date' : undefined}
              aria-pressed={isSelected}
              onClick={() => onPick({ jy: view.jy, jm: view.jm, jd, hh: time.hh, mm: time.mm })}
              className={cx(
                'rounded-md py-1 text-xs tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500',
                isSelected ? 'bg-brand-600 font-medium text-white'
                  : isToday ? 'bg-brand-50 text-brand-700' : 'text-ink-700 hover:bg-ink-50',
              )}
            >
              {toPersianDigits(jd)}
            </button>
          );
        })}
      </div>

      {mode === 'datetime' && (
        <div className="mt-2 flex items-center gap-2 border-t border-ink-100 pt-2">
          <label className="text-[12.5px] text-ink-500" htmlFor="jdi-time">{tr('ساعت')}</label>
          <input
            id="jdi-time"
            type="time"
            value={`${String(time.hh).padStart(2, '0')}:${String(time.mm).padStart(2, '0')}`}
            onChange={(e) => {
              const [hh, mm] = e.target.value.split(':').map(Number);
              setTime({ hh: hh ?? 0, mm: mm ?? 0 });
            }}
            className="ltr rounded-md border border-ink-200 px-2 py-1 text-xs
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
          />
        </div>
      )}

      <div className="mt-2 flex justify-between border-t border-ink-100 pt-2">
        <button type="button" onClick={() => onPick({ ...today, hh: time.hh, mm: time.mm })}
          className="text-[12.5px] text-brand-600 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500">{tr('امروز')}</button>
        <button type="button" onClick={onClose}
          className="text-[12.5px] text-ink-500 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500">{tr('بستن')}</button>
      </div>
    </div>
  );
}
