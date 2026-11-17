import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { METRO_BOOKING_LABELS, METRO_SPACE_LABELS, type MetroBookingState, type MetroSpaceKind } from '@hiva/contracts';
import { useAuth } from '../../lib/auth';
import { Badge, cx } from '../../components/ui';
import { pair, tr } from '../../i18n';

/** Metro advertising (ADR-135): what its pages share. */

export interface Line { id: string; number: number; nameFa: string; nameEn: string; city: string; color: string; notes: string | null; isActive: boolean; stations: number; trains: number }
export interface Space { id: string; kind: MetroSpaceKind; label: string | null; quantity: number; widthCm: number | null; heightCm: number | null; monthlyPrice: number; isActive: boolean; notes: string | null; takenToday?: number }
export interface Wagon { id: string; number: number; notes: string | null; spaces: Space[] }
export interface Train { id: string; code: string; notes: string | null; isActive: boolean; wagons: Wagon[] }
export interface Station { id: string; nameFa: string; nameEn: string; order: number; branch: string | null; isInterchange: boolean; underConstruction: boolean; notes: string | null }

export const kindFa = (k: string) => (METRO_SPACE_LABELS[k as MetroSpaceKind] ? pair(METRO_SPACE_LABELS[k as MetroSpaceKind]) : k);
export const stateFa = (s: string) => (METRO_BOOKING_LABELS[s as MetroBookingState] ? pair(METRO_BOOKING_LABELS[s as MetroBookingState]) : s);
const STATE_TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = { HOLD: 'warning', CONFIRMED: 'info', ACTIVE: 'success', ENDED: 'neutral', CANCELLED: 'danger' };
export const BookingState = ({ state }: { state: string }) => <Badge tone={STATE_TONE[state] ?? 'neutral'}>{stateFa(state)}</Badge>;

export const LineChip = ({ line, children }: { line: { number: number; color: string; nameFa?: string }; children?: ReactNode }) => (
  <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-semibold text-ink-800">
    <span className="grid size-6 place-items-center rounded-full text-[12px] font-bold text-white" style={{ backgroundColor: line.color }}>{line.number}</span>
    {children ?? line.nameFa}
  </span>
);

export const today = () => new Date().toISOString().slice(0, 10);
export const plusDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

export function MetroNav() {
  const { can } = useAuth();
  const items = [
    { to: '/metro', label: tr('داشبورد مترو'), show: can('metro.read'), end: true },
    { to: '/metro/bookings', label: tr('رزروها'), show: can('metro.read') },
    { to: '/metro/reports', label: tr('گزارش‌ها'), show: can('metro.read') },
  ].filter((i) => i.show);
  return (
    <nav aria-label={tr('بخش‌های تبلیغات مترو')} className="mb-4 flex gap-1 overflow-x-auto rounded-xl bg-surface p-1.5 ring-1 ring-edge">
      {items.map((i) => (
        <NavLink key={i.to} to={i.to} end={i.end}
          className={({ isActive }) => cx('whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-semibold', isActive ? 'bg-brand-50 text-brand-800 ring-1 ring-brand-200' : 'text-ink-600 hover:bg-ink-50')}>
          {i.label}
        </NavLink>
      ))}
    </nav>
  );
}
