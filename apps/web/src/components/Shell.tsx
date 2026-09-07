import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatRelative, toPersianDigits } from '../lib/format';
import {
  Badge, Button, Spinner, cx,
  IconAlert, IconBell, IconBriefcase, IconChart, IconCheckCircle, IconClipboard,
  IconClose, IconDashboard, IconFile, IconLogout, IconMoney, IconSearch,
  IconSettings, IconShield, IconSpark, IconTraffic, IconUsers, IconLayers,
} from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: (p: { className?: string }) => ReactNode;
  /** The permission that makes this destination meaningful for the signed-in user. */
  permission?: string;
}

interface NavGroup { label: string; items: NavItem[] }

/**
 * Navigation mirrors the ten Doc_H ERP modules rather than the database tables,
 * so the sidebar reads as the organisation's own operating model.
 */
const NAV: NavGroup[] = [
  {
    label: 'کار من',
    items: [
      { to: '/', label: 'داشبورد', icon: IconDashboard },
      { to: '/tasks', label: 'وظایف', icon: IconCheckCircle, permission: 'task.read' },
      { to: '/forms', label: 'فرم‌ها', icon: IconFile, permission: 'form.read' },
    ],
  },
  {
    label: 'CRM و فروش',
    items: [
      { to: '/leads', label: 'سرنخ‌ها', icon: IconUsers, permission: 'crm.lead.read' },
      { to: '/opportunities', label: 'فرصت‌های فروش', icon: IconBriefcase, permission: 'crm.opportunity.read' },
      { to: '/companies', label: 'مشتریان', icon: IconUsers, permission: 'crm.company.read' },
    ],
  },
  {
    label: 'اکانت و پروپوزال',
    items: [
      { to: '/briefs', label: 'بریف‌ها', icon: IconClipboard, permission: 'brief.read' },
      { to: '/proposals', label: 'پروپوزال‌ها', icon: IconFile, permission: 'proposal.read' },
    ],
  },
  {
    label: 'اجرا و کنترل',
    items: [
      { to: '/projects', label: 'پروژه‌ها', icon: IconLayers, permission: 'project.read' },
      { to: '/work-orders', label: 'سفارش‌های کار', icon: IconClipboard, permission: 'workorder.read' },
      { to: '/qc', label: 'کنترل کیفیت', icon: IconShield, permission: 'qc.read' },
      { to: '/changes', label: 'درخواست‌های تغییر', icon: IconAlert, permission: 'change.read' },
      { to: '/traffic', label: 'ترافیک و ظرفیت', icon: IconTraffic, permission: 'traffic.read' },
    ],
  },
  {
    label: 'تجاری و مالی',
    items: [
      { to: '/contracts', label: 'قراردادها', icon: IconFile, permission: 'contract.read' },
      { to: '/finance', label: 'مالی', icon: IconMoney, permission: 'finance.read' },
    ],
  },
  {
    label: 'تحلیل و مدیریت',
    items: [
      { to: '/reports', label: 'گزارش‌ها', icon: IconChart, permission: 'report.read' },
      { to: '/ai', label: 'دستیار هوشمند', icon: IconSpark, permission: 'ai.use' },
      { to: '/admin', label: 'مدیریت سیستم', icon: IconSettings, permission: 'admin.audit' },
    ],
  },
];

export function Shell({ children }: { children: ReactNode }) {
  const { user, signOut, can } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setMobileOpen(false), [location.pathname]);

  const visibleGroups = NAV
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.permission || can(i.permission)) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="flex h-full">
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-ink-900/40 lg:hidden" onClick={() => setMobileOpen(false)} aria-hidden />
      )}

      <aside
        className={cx(
          'fixed inset-y-0 right-0 z-40 flex w-64 flex-col border-s border-ink-200 bg-white transition-transform lg:static lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0',
        )}
      >
        <div className="flex h-14 items-center justify-between gap-2 border-b border-ink-100 px-4">
          <Link to="/" className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">ه</span>
            <span className="text-sm font-semibold text-ink-800">هیوا او‌اس</span>
          </Link>
          <button className="rounded p-1 text-ink-400 lg:hidden" onClick={() => setMobileOpen(false)} aria-label="بستن منو">
            <IconClose className="size-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {visibleGroups.map((group) => (
            <div key={group.label} className="mb-4">
              <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                {group.label}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.to === '/'}
                      className={({ isActive }) =>
                        cx(
                          'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                          isActive
                            ? 'bg-brand-50 font-medium text-brand-700'
                            : 'text-ink-600 hover:bg-ink-100 hover:text-ink-800',
                        )
                      }
                    >
                      <item.icon className="size-4 shrink-0" />
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-ink-100 p-3">
          <div className="mb-2 px-1">
            <p className="truncate text-sm font-medium text-ink-800">{user?.fullName}</p>
            <p className="truncate text-xs text-ink-500">
              {user?.jobTitle}
              {user?.department && ` — ${user.department.nameFa}`}
            </p>
          </div>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => void signOut()}>
            <IconLogout className="size-4" /> خروج
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setMobileOpen(true)} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-ink-200 bg-white px-4">
      <button className="rounded p-1.5 text-ink-500 hover:bg-ink-100 lg:hidden" onClick={onMenu} aria-label="منو">
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
        </svg>
      </button>
      <GlobalSearch />
      <div className="flex items-center gap-1">
        <Notifications />
      </div>
    </header>
  );
}

interface SearchGroup {
  type: string;
  labelFa: string;
  items: { id: string; code?: string; legalName?: string; title?: string; name?: string; state?: string }[];
}

const SEARCH_ROUTES: Record<string, string> = {
  company: '/companies', opportunity: '/opportunities', project: '/projects',
  task: '/tasks', brief: '/briefs', proposal: '/proposals', contract: '/contracts',
};

function GlobalSearch() {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Ctrl/⌘+K focuses search from anywhere — the expected shortcut in this class of tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, []);

  const { data, isFetching } = useQuery<{ groups: SearchGroup[]; total: number }>({
    queryKey: ['search', term],
    queryFn: () => apiGet('/search', { q: term }),
    enabled: term.trim().length >= 2,
    staleTime: 10_000,
  });

  return (
    <div ref={boxRef} className="relative flex-1 max-w-xl">
      <div className="relative">
        <IconSearch className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-ink-400" />
        <input
          ref={inputRef}
          value={term}
          onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="جستجوی سراسری… (Ctrl+K)"
          className="w-full rounded-lg border-0 bg-ink-100 py-2 ps-9 pe-3 text-sm text-ink-800 placeholder:text-ink-400 focus:bg-white focus:ring-2 focus:ring-inset focus:ring-brand-600"
        />
        {isFetching && <Spinner className="absolute inset-y-0 end-3 my-auto size-4" />}
      </div>

      {open && term.trim().length >= 2 && (
        <div className="animate-in absolute inset-x-0 top-full z-50 mt-1 max-h-96 overflow-y-auto rounded-xl bg-white p-1.5 shadow-xl ring-1 ring-ink-200">
          {!data || data.total === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-ink-500">نتیجه‌ای یافت نشد.</p>
          ) : (
            data.groups.map((group) => (
              <div key={group.type} className="mb-1.5 last:mb-0">
                <p className="px-2.5 py-1 text-[11px] font-semibold text-ink-400">{group.labelFa}</p>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      navigate(`${SEARCH_ROUTES[group.type] ?? '/'}/${item.id}`);
                      setOpen(false);
                      setTerm('');
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-right text-sm hover:bg-ink-100"
                  >
                    <span className="truncate text-ink-700">
                      {item.legalName ?? item.title ?? item.name}
                    </span>
                    {item.code && <span className="ltr shrink-0 text-[11px] text-ink-400">{item.code}</span>}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface NotificationRow {
  id: string; kind: string; title: string; body: string | null;
  severity: string; readAt: string | null; createdAt: string;
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const boxRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery<{ items: NotificationRow[]; unread: number }>({
    queryKey: ['/notifications'],
    queryFn: () => apiGet('/notifications'),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const markAll = async () => {
    await apiPost('/notifications/read-all');
    await qc.invalidateQueries({ queryKey: ['/notifications'] });
  };

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-lg p-2 text-ink-500 hover:bg-ink-100"
        aria-label={`اعلان‌ها${data?.unread ? ` (${data.unread} خوانده‌نشده)` : ''}`}
      >
        <IconBell className="size-5" />
        {!!data?.unread && (
          <span className="absolute -end-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-medium text-white nums">
            {toPersianDigits(data.unread > 9 ? '۹+' : data.unread)}
          </span>
        )}
      </button>

      {open && (
        <div className="animate-in absolute end-0 top-full z-50 mt-1 w-80 rounded-xl bg-white shadow-xl ring-1 ring-ink-200">
          <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2">
            <p className="text-sm font-semibold text-ink-800">اعلان‌ها</p>
            {!!data?.unread && (
              <button onClick={() => void markAll()} className="text-xs text-brand-600 hover:underline">
                خوانده‌شدن همه
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {!data?.items.length ? (
              <p className="px-3 py-8 text-center text-sm text-ink-500">اعلانی وجود ندارد.</p>
            ) : (
              data.items.slice(0, 20).map((n) => (
                <div key={n.id} className={cx('border-b border-ink-100 px-3 py-2.5 last:border-0', !n.readAt && 'bg-brand-50/40')}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-ink-800">{n.title}</p>
                    {n.severity === 'CRITICAL' && <Badge tone="danger">بحرانی</Badge>}
                    {n.severity === 'WARNING' && <Badge tone="warning">هشدار</Badge>}
                  </div>
                  {n.body && <p className="mt-0.5 text-xs text-ink-500">{n.body}</p>}
                  <p className="mt-1 text-[11px] text-ink-400">{formatRelative(n.createdAt)}</p>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Page header used by every route, keeping title/breadcrumb/action placement consistent. */
export function PageHeader({ title, subtitle, actions, badge }: {
  title: string; subtitle?: ReactNode; actions?: ReactNode; badge?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-200 bg-white px-5 py-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-ink-900">{title}</h1>
          {badge}
        </div>
        {subtitle && <div className="mt-0.5 text-sm text-ink-500">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export const PageBody = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cx('p-5', className)}>{children}</div>
);
