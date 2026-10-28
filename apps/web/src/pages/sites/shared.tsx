import { useMemo, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  OBLIGATION_KIND_LABELS, SITE_OPTION_LIST_LABELS, type ObligationKind, type SiteOptionList, type SiteSettings,
} from '@hiva/contracts';
import { apiGet } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { exactCurrency, formatCurrency, formatNumber, localDigits, toLatinDigits } from '../../lib/format';
import { Badge, Input, ProgressBar, cx, type Tone } from '../../components/ui';
import { isEnglish, tr } from '../../i18n';

/**
 * What the venues module's screens share (ADR-103): the organisation's own lists read as labels, sums
 * in their own currency, the module's sub-navigation, and the small pieces every page draws.
 */

export interface SiteOption { id: string; list: SiteOptionList; code: string; labelFa: string; labelEn: string | null; sortOrder: number; isActive: boolean; meta: { requiresContract?: boolean; isCheque?: boolean } }

/** The organisation's lists: the active ones to choose from, every one (the retired too) to read a record by. */
export function useSiteOptions() {
  const { data, isLoading } = useQuery<SiteOption[]>({ queryKey: ['/site-options'], queryFn: () => apiGet('/site-options'), staleTime: 60_000 });
  return useMemo(() => {
    const all = data ?? [];
    const of = (list: SiteOptionList, activeOnly = true) => all.filter((o) => o.list === list && (!activeOnly || o.isActive));
    const label = (list: SiteOptionList, code: string | null | undefined) => {
      if (!code) return '—';
      const o = all.find((x) => x.list === list && x.code === code);
      return o ? (isEnglish() ? o.labelEn || o.labelFa : o.labelFa) : code;
    };
    const choices = (list: SiteOptionList) => of(list).map((o) => ({ value: o.code, label: isEnglish() ? o.labelEn || o.labelFa : o.labelFa }));
    return { all, of, label, choices, isLoading };
  }, [data, isLoading]);
}

export function useSiteSettings() {
  return useQuery<SiteSettings>({ queryKey: ['/site-settings'], queryFn: () => apiGet('/site-settings'), staleTime: 60_000 });
}

export const listLabel = (list: SiteOptionList) => (isEnglish() ? SITE_OPTION_LIST_LABELS[list].en : SITE_OPTION_LIST_LABELS[list].fa);
export const kindLabel = (k: string) => (isEnglish() ? OBLIGATION_KIND_LABELS[k as ObligationKind]?.en : OBLIGATION_KIND_LABELS[k as ObligationKind]?.fa) ?? k;
export const pairLabel = (m: Record<string, { fa: string; en: string }>, k: string | null | undefined) => (k ? (isEnglish() ? m[k]?.en : m[k]?.fa) ?? k : '—');

/** A sum in its own currency: Rials as the rest of the app writes them, any other with its code. */
export function money(value: string | number | null | undefined, currency = 'IRR', exact = false): string {
  if (value === null || value === undefined || value === '') return '—';
  if (currency === 'IRR') return exact ? exactCurrency(value) : formatCurrency(value);
  return `${formatNumber(value, 2)} ${currency}`;
}

export function Money({ value, currency, exact, tone }: { value: string | number | null | undefined; currency?: string; exact?: boolean; tone?: 'danger' | 'success' | 'muted' }) {
  return (
    <span className={cx('nums whitespace-nowrap', tone === 'danger' && 'font-semibold text-rose-700', tone === 'success' && 'text-emerald-700', tone === 'muted' && 'text-ink-500')} title={money(value, currency, true)}>
      {money(value, currency, exact)}
    </span>
  );
}

/** Several currencies side by side, never added together. */
export const MoneyList = ({ rows, empty = '—' }: { rows: { currency: string; amount: string }[] | undefined; empty?: string }) =>
  !rows?.length || rows.every((r) => Number(r.amount) === 0)
    ? <span className="text-ink-400">{empty}</span>
    : <span className="flex flex-col">{rows.filter((r) => Number(r.amount) !== 0).map((r) => <Money key={r.currency} value={r.amount} currency={r.currency} />)}</span>;

/**
 * A sum typed as people type it — Persian digits, thousands separators — kept as the decimal string the
 * API takes, never a float. Shows its grouping as it is typed.
 */
export function AmountInput({ value, onChange, placeholder, id, invalid, ...rest }: { value: string | null | undefined; onChange: (v: string) => void; placeholder?: string; id?: string; invalid?: boolean; 'aria-label'?: string }) {
  const shown = value ? localDigits(value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')) : '';
  return (
    <Input
      id={id} inputMode="decimal" dir="ltr" className={cx('nums text-end', invalid && 'ring-rose-400')} placeholder={placeholder ?? '0'}
      value={shown} aria-label={rest['aria-label']}
      onChange={(e) => onChange(toLatinDigits(e.target.value).replace(/[^\d.]/g, '').replace(/^(\d*\.\d{0,2}).*$/, '$1'))}
    />
  );
}

export function Completeness({ score, missing }: { score: number; missing?: string[] }) {
  const tone: Tone = score >= 100 ? 'success' : score >= 60 ? 'warning' : 'danger';
  return (
    <div className="min-w-24" title={missing?.length ? tr('ناقص: {0}', missing.map(fieldLabel).join('، ')) : tr('کامل')}>
      <div className="mb-0.5 flex justify-between text-xs text-ink-500"><span>{tr('کامل بودن')}</span><span className="nums">{tr('{0}٪', localDigits(score))}</span></div>
      <ProgressBar value={score} tone={tone} />
    </div>
  );
}

const FIELD_LABELS: Record<string, () => string> = {
  address: () => tr('آدرس'), phone: () => tr('تلفن'), gradeCode: () => tr('گرید'), audienceCodes: () => tr('مخاطبان'), contacts: () => tr('مخاطب'), photos: () => tr('عکس'),
};
export const fieldLabel = (f: string) => FIELD_LABELS[f]?.() ?? f;

export const ObligationStatus = ({ status, overdue }: { status: string; overdue?: boolean }) => {
  const meta: Record<string, [string, Tone]> = {
    OPEN: [tr('باز'), 'info'], PARTIAL: [tr('بخشی پرداخت‌شده'), 'warning'], SETTLED: [tr('تسویه‌شده'), 'success'], WAIVED: [tr('بخشوده'), 'neutral'], VOID: [tr('باطل'), 'neutral'],
  };
  const [label, tone] = meta[status] ?? [status, 'neutral' as Tone];
  return <Badge tone={overdue ? 'danger' : tone}>{overdue ? tr('سررسید گذشته') : label}</Badge>;
};

/** The module's own sections, each shown to whoever may use it. */
export function SitesNav() {
  const { canAny, can } = useAuth();
  const items = [
    { to: '/sites', label: tr('داشبورد'), show: canAny('venue.read', 'site.read', 'rental.read'), end: true },
    { to: '/sites/venues', label: tr('بانک مکان‌ها'), show: can('venue.read') },
    { to: '/sites/projects', label: tr('پروژه‌های استقرار'), show: can('site.read') },
    { to: '/sites/rentals', label: tr('اجاره‌داری'), show: can('rental.read') },
    { to: '/sites/reminders', label: tr('یادآوری و پیامک'), show: canAny('rental.read', 'site.configure', 'venue.sms') },
    { to: '/sites/reports', label: tr('گزارش‌ها'), show: canAny('venue.read', 'site.read', 'rental.read') },
    { to: '/sites/excel', label: tr('اکسل'), show: canAny('venue.read', 'site.read', 'rental.read') },
    { to: '/sites/settings', label: tr('تنظیمات'), show: can('site.configure') },
  ].filter((i) => i.show);
  return (
    <nav aria-label={tr('بخش‌های مکان‌ها و اجاره‌داری')} className="mb-4 flex gap-1 overflow-x-auto rounded-xl bg-surface p-1.5 ring-1 ring-edge">
      {items.map((i) => (
        <NavLink key={i.to} to={i.to} end={i.end}
          className={({ isActive }) => cx('whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-semibold', isActive ? 'bg-brand-50 text-brand-800 ring-1 ring-brand-200' : 'text-ink-600 hover:bg-ink-50')}>
          {i.label}
        </NavLink>
      ))}
    </nav>
  );
}

export const Section = ({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) => (
  <div className="space-y-2">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-bold text-ink-800">{title}</h3>{action}</div>
    {children}
  </div>
);

/** A fresh id for a payment, so the same click sent twice is recorded once. */
export const clientKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** The empty value of a select: none chosen. */
export const blank = (v: string) => (v === '' ? null : v);
