import { forwardRef } from 'react';
import { createPortal } from 'react-dom';
import { useDismissable, useFocusTrap } from '../hooks/useDismissable';
import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { localDigits } from '../lib/format';
import { STATE_LABELS } from '@hiva/contracts';
import { pair, tr } from '../i18n';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

/* ── Status vocabulary ─────────────────────────────────────────────────────
   One colour scale for every state in the platform, so a colour always carries
   the same meaning: neutral = inert, blue = in flight, amber = needs attention,
   green = satisfied, red = blocked or breached. */

export type Tone = 'neutral' | 'info' | 'progress' | 'warning' | 'success' | 'danger';

// In the dark these read as tints, not pale fills: the status palettes are tokens too (index.css).
const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-ink-100 text-ink-600 ring-ink-200',
  info: 'bg-sky-50 text-sky-700 ring-sky-200',
  progress: 'bg-brand-50 text-brand-700 ring-brand-200',
  warning: 'bg-amber-50 text-amber-700 ring-amber-200',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  danger: 'bg-rose-50 text-rose-700 ring-rose-200',
};

/** State → (Persian label, tone). Every workflow state in the platform is covered. */
/**
 * Re-exported from @hiva/contracts, where the table now lives: it was duplicated against
 * STATE_FA in the API's PDF layer and the two had drifted apart. Kept exported here so the
 * components that already import it from the UI module do not all have to change.
 */
export const STATE_META = STATE_LABELS;

export function StateBadge({ state, className }: { state: string; className?: string }) {
  const meta = STATE_META[state] ?? { fa: state, tone: 'neutral' as Tone };
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset whitespace-nowrap',
        TONE_CLASSES[meta.tone],
        className,
      )}
    >
      {pair(meta)}
    </span>
  );
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span className={cx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset', TONE_CLASSES[tone], className)}>
      {children}
    </span>
  );
}

/* ── Buttons ───────────────────────────────────────────────────────────── */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';

/* The kit's button set — one main action, the rest outlined or bare — in the glass look: the main
   action is the violet-to-blue gradient with white text; the outlined one is glass with an edge. */
const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'btn-accent focus-visible:outline-brand-600',
  secondary: 'bg-surface text-ink-700 ring-1 ring-inset ring-ink-200 shadow-sm hover:bg-panel hover:text-ink-900 focus-visible:outline-brand-600',
  ghost: 'text-ink-600 hover:bg-ink-50 hover:text-ink-900 focus-visible:outline-brand-600',
  danger: 'bg-rose-600 text-white hover:bg-rose-500 focus-visible:outline-rose-600 shadow-sm',
  subtle: 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-100 hover:bg-brand-100 focus-visible:outline-brand-600',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
}

export function Button({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-[color,background-color,box-shadow,filter]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        'disabled:opacity-50 disabled:pointer-events-none',
        size === 'sm' ? 'px-2.5 py-1 text-xs leading-5' : 'px-3 py-1.5 text-[14px] leading-5',
        BUTTON_VARIANTS[variant],
        className,
      )}
    >
      {loading && (
        <svg className="size-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
          <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        </svg>
      )}
      {children}
    </button>
  );
}

/* ── Surfaces ──────────────────────────────────────────────────────────── */

export function Card({ children, className, title, action, subtitle, footer, tour }: {
  children: ReactNode; className?: string; title?: ReactNode; subtitle?: ReactNode; action?: ReactNode;
  /** The kit's card footer: «View more» and the like, under a hairline. */
  footer?: ReactNode;
  /** Where the guide's tour may point (Hivamis task 8). */
  tour?: string;
}) {
  return (
    <section data-tour={tour} className={cx('flex flex-col rounded-xl bg-surface ring-1 ring-edge shadow-glass', className)}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 border-b border-ink-200/70 px-5 py-3.5">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-bold text-ink-800">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs font-medium text-ink-500">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
      {footer && <footer className="mt-auto flex items-center justify-between gap-3 border-t border-ink-200/70 px-5 py-3 text-xs font-semibold text-ink-600">{footer}</footer>}
    </section>
  );
}

export function StatTile({ label, value, hint, tone = 'neutral', icon }: {
  label: string; value: ReactNode; hint?: ReactNode; tone?: Tone; icon?: ReactNode;
}) {
  const accent: Record<Tone, string> = {
    neutral: 'text-ink-900', info: 'text-sky-700', progress: 'text-brand-700',
    warning: 'text-amber-700', success: 'text-emerald-700', danger: 'text-rose-700',
  };
  // Each tone has its own pastel tile behind the icon; a neutral figure takes the accent's.
  const tile: Record<Tone, string> = {
    neutral: 'bg-brand-100 text-brand-700', info: 'bg-sky-100 text-sky-700', progress: 'bg-brand-100 text-brand-700',
    warning: 'bg-amber-100 text-amber-700', success: 'bg-emerald-100 text-emerald-700', danger: 'bg-rose-100 text-rose-700',
  };
  // The kit's metric card: the icon, a small bold label, the figure — and the hint in a footer row
  // under a hairline, as the kit sets its trend line.
  return (
    <div className="flex h-full flex-col rounded-xl bg-surface ring-1 ring-edge shadow-glass">
      <div className="flex flex-1 items-start gap-4 p-5">
        {icon && <span className={cx('grid size-11 shrink-0 place-items-center rounded-lg shadow-sm [&>svg]:size-5', tile[tone])}>{icon}</span>}
        <div className="min-w-0">
          <p className="text-xs font-bold text-ink-500">{label}</p>
          <p className={cx('mt-1 text-2xl font-bold nums', accent[tone])}>{value}</p>
        </div>
      </div>
      {hint && <p className="border-t border-ink-200/70 px-5 py-2.5 text-xs font-semibold text-ink-500">{hint}</p>}
    </div>
  );
}

/* ── Feedback ──────────────────────────────────────────────────────────── */

export function EmptyState({ title, description, action, icon }: {
  title: string; description?: string; action?: ReactNode; icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 text-ink-300">{icon ?? <IconInbox className="size-10" />}</div>
      <p className="text-sm font-medium text-ink-700">{title}</p>
      {description && <p className="mt-1 max-w-sm text-xs text-ink-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx('animate-spin text-brand-600', className ?? 'size-5')} viewBox="0 0 24 24" fill="none" aria-label={tr('در حال بارگذاری')}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
      <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

export function LoadingBlock({ label = tr('در حال بارگذاری…') }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-ink-500">
      <Spinner className="size-4" /> {label}
    </div>
  );
}

/** Renders an API failure, surfacing the Doc_H rule when a governance guard rejected the action. */
export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const err = error as { message?: string; rule?: string; issues?: { path: string; message: string }[]; status?: number };
  return (
    <div className="m-4 rounded-lg bg-rose-50 p-4 ring-1 ring-inset ring-rose-200">
      <div className="flex items-start gap-2">
        <IconAlert className="mt-0.5 size-4 shrink-0 text-rose-600" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-rose-800">{err?.message ?? tr('خطایی رخ داد.')}</p>
          {err?.rule && (
            <p className="mt-1 text-xs text-rose-700">{tr('قانون حاکم:')}{' '}<span className="font-medium">{err.rule}</span>
            </p>
          )}
          {err?.issues && err.issues.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-rose-700">
              {err.issues.map((i) => (
                <li key={i.path}>• {i.message}</li>
              ))}
            </ul>
          )}
          {onRetry && (
            <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}>{tr('تلاش دوباره')}</Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Toasts ────────────────────────────────────────────────────────────── */

interface Toast { id: number; message: string; tone: Tone }
const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = (message: string, tone: Tone = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  };
  return (
    <ToastContext.Provider value={push}>
      {children}
      {/* Raised while the guide's owl sits in this corner (Hivamis task 8). */}
      <div className="pointer-events-none fixed bottom-[var(--toast-offset,1rem)] left-4 z-[80] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cx(
              'bg-panel animate-in pointer-events-auto rounded-lg px-3.5 py-2.5 text-sm font-semibold shadow-glass ring-1 ring-inset',
              TONE_CLASSES[t.tone],
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ── Form controls ─────────────────────────────────────────────────────── */

export function Field({ label, required, hint, error, children }: {
  label: string; required?: boolean; hint?: string; error?: string; children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1 text-xs font-bold text-ink-700">
        {label}
        {required && <span className="text-rose-500">*</span>}
      </span>
      {children}
      {hint && !error && <span className="mt-1 block text-[12.5px] text-ink-500">{hint}</span>}
      {error && <span className="mt-1 block text-[12.5px] text-rose-600">{error}</span>}
    </label>
  );
}

const CONTROL = 'w-full rounded-lg border-0 bg-surface px-3 py-2 text-[14px] leading-5 text-ink-800 shadow-sm ring-1 ring-inset ring-ink-200 placeholder:text-ink-400 focus:bg-panel focus:ring-2 focus:ring-inset focus:ring-brand-500 disabled:bg-ink-50 disabled:text-ink-500';

/** Forwards its ref so a caller can focus or measure the field — JalaliDateInput needs both. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...rest }, ref) => <input {...rest} ref={ref} className={cx(CONTROL, className)} />,
);
Input.displayName = 'Input';

export const Textarea = ({ className, rows = 3, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...rest} rows={rows} className={cx(CONTROL, 'resize-y', className)} />
);

export const Select = ({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...rest} className={cx(CONTROL, 'pe-8', className)}>
    {children}
  </select>
);

export function Checkbox({ label, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-2 text-sm text-ink-700">
      <input
        id={id}
        type="checkbox"
        {...rest}
        className="mt-0.5 size-4 shrink-0 rounded-md border-ink-300 text-brand-600 accent-brand-600 focus:ring-brand-600"
      />
      <span>{label}</span>
    </label>
  );
}

/* ── Tables ────────────────────────────────────────────────────────────── */

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={cx('w-full min-w-[640px] text-start text-sm', className)}>{children}</table>
    </div>
  );
}

export const Th = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <th scope="col" className={cx('whitespace-nowrap px-4 py-2.5 text-xs font-bold text-ink-600', className)}>
    {children}
  </th>
);

export const Td = ({ children, className, title }: { children?: ReactNode; className?: string; title?: string }) => (
  <td title={title} className={cx('px-4 py-3 align-middle text-[14px] text-ink-700', className)}>{children}</td>
);

export const Tr = ({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) => (
  <tr
    onClick={onClick}
    className={cx('border-t border-ink-200/70', onClick && 'cursor-pointer hover:bg-brand-50/60', className)}
  >
    {children}
  </tr>
);

export function Pagination({ page, pageCount, total, onChange }: {
  page: number; pageCount: number; total: number; onChange: (p: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-ink-200 px-4 py-2.5 text-xs font-semibold text-ink-500">
      <span className="nums">{tr('{0} رکورد — صفحه {1} از {2}', localDigits(total), localDigits(page), localDigits(pageCount))}</span>
      <div className="flex gap-1.5">
        <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onChange(page - 1)}>{tr('قبلی')}</Button>
        <Button size="sm" variant="secondary" disabled={page >= pageCount} onClick={() => onChange(page + 1)}>{tr('بعدی')}</Button>
      </div>
    </div>
  );
}

/* ── Overlays ──────────────────────────────────────────────────────────── */

export function Modal({ open, onClose, title, children, footer, wide }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  // Escape, outside-click and focus restoration come from the shared hook, so this behaves
  // identically to the other two overlays rather than implementing its own subset.
  const dialogRef = useDismissable<HTMLDivElement>({ open, onClose });
  // Without a trap, Tab walks out of the dialog and onto the page the backdrop is covering.
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  if (!open) return null;
  // Rendered at the root of the page: a dialog opened from inside a transformed container (the
  // sidebar slides on a transform) was otherwise confined to that container's box — the messenger
  // opened 200px wide inside the menu (Hivamis, the second sweep). Above drawers, below toasts.
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-ink-900/30 p-4 pt-12 backdrop-blur-sm">
      {/* Visual scrim only; dismissal is the hook's outside-click, so there is one path. */}
      <div className="absolute inset-0" aria-hidden />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx('bg-panel animate-in relative w-full rounded-xl shadow-2xl ring-1 ring-edge', wide ? 'max-w-3xl' : 'max-w-lg')}
      >
        <header className="flex items-center justify-between border-b border-ink-200/70 px-5 py-4">
          <h2 className="text-sm font-bold text-ink-800">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-600" aria-label={tr('بستن')}>
            <IconClose className="size-4" />
          </button>
        </header>
        <div className="max-h-[65vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-ink-200/70 px-5 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function Tabs({ tabs, active, onChange }: {
  tabs: { key: string; label: string; count?: number }[];
  active: string;
  onChange: (k: string) => void;
}) {
  // A link can open a tab that sits beyond the visible strip; bring it into view so the page
  // says where it is.
  // Only the strip scrolls, sideways: scrollIntoView would also move the page, and a dashboard whose
  // tabs sit near the bottom of the screen opened scrolled down.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const s = strip.current;
    const el = s?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!s || !el) return;
    const sr = s.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    if (er.left < sr.left) s.scrollLeft -= sr.left - er.left;
    else if (er.right > sr.right) s.scrollLeft += er.right - sr.right;
  }, [active]);
  return (
    // The kit's tab group: bold grey labels; the chosen one sits in a soft wash of the accent.
    <div ref={strip} data-tour="tabs" className="flex gap-1 overflow-x-auto border-b border-ink-200/70 px-1 py-2" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={active === t.key}
          onClick={() => onChange(t.key)}
          className={cx(
            'whitespace-nowrap rounded-lg px-3 py-1.5 text-[14px] font-bold transition-colors',
            active === t.key ? 'soft-selected' : 'text-ink-500 hover:bg-surface hover:text-ink-800',
          )}
        >
          {t.label}
          {t.count !== undefined && t.count > 0 && (
            <span className="ms-1.5 rounded-full bg-surface px-1.5 py-0.5 text-[12.5px] nums text-ink-600 ring-1 ring-inset ring-ink-200">
              {localDigits(t.count)}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function ProgressBar({ value, tone = 'progress' }: { value: number; tone?: Tone }) {
  const fill: Record<Tone, string> = {
    neutral: 'bg-ink-400', info: 'bg-sky-500', progress: 'bg-linear-to-l from-brand-500 to-sky-400',
    warning: 'bg-amber-500', success: 'bg-emerald-500', danger: 'bg-rose-500',
  };
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-ink-200/70" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full rounded-full transition-[width]', fill[tone])} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

/** Definition row used across the 360 views. */
export const DescRow = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-start justify-between gap-4 border-b border-ink-200/60 py-2 last:border-0">
    <dt className="shrink-0 text-xs text-ink-500">{label}</dt>
    <dd className="min-w-0 text-end text-sm text-ink-800">{children}</dd>
  </div>
);

/* ── Icons (inline, no icon dependency) ────────────────────────────────── */

const ico = (path: ReactNode) => ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className ?? 'size-5'} aria-hidden>
    {path}
  </svg>
);

export const IconDashboard = ico(<><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>);
export const IconUsers = ico(<><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" /></>);
export const IconBriefcase = ico(<><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" /></>);
export const IconClipboard = ico(<><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" /></>);
export const IconCheckCircle = ico(<><path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><path d="M22 4L12 14.01l-3-3" /></>);
export const IconFile = ico(<><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /></>);
export const IconChart = ico(<><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></>);
export const IconMoney = ico(<><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6 12h.01M18 12h.01" /></>);
export const IconTraffic = ico(<><path d="M3 12h4l3 8 4-16 3 8h4" /></>);
export const IconShield = ico(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></>);
export const IconSearch = ico(<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>);
export const IconBell = ico(<><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 01-3.4 0" /></>);
export const IconClose = ico(<><path d="M18 6L6 18M6 6l12 12" /></>);
export const IconInbox = ico(<><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" /></>);
export const IconAlert = ico(<><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></>);
export const IconSpark = ico(<><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" /><path d="M18 15l.9 2.1 2.1.9-2.1.9L18 21l-.9-2.1-2.1-.9 2.1-.9z" /></>);
export const IconLogout = ico(<><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><path d="M16 17l5-5-5-5M21 12H9" /></>);
export const IconSettings = ico(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9c.14.63.68 1.1 1.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" /></>);
export const IconRefresh = ico(<><path d="M3 12a9 9 0 0115.5-6.4L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 01-15.5 6.4L3 16" /><path d="M3 21v-5h5" /></>);
export const IconPlus = ico(<><path d="M12 5v14M5 12h14" /></>);
export const IconArrow = ico(<><path d="M19 12H5M12 19l-7-7 7-7" /></>);
export const IconClock = ico(<><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>);
export const IconFold = ico(<><path d="M5 5v14" /><path d="M18 7l-5 5 5 5" /></>);
export const IconLayers = ico(<><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5M2 12l10 5 10-5" /></>);
