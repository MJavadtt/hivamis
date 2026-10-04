import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { OutboxBadge } from './Outbox';
import { useAuth } from '../lib/auth';
import { useTheme, type ThemePreference } from '../lib/theme';
import { useLocale, type Locale } from '../lib/locale';
import { HelpDrawer } from './HelpDrawer';
import { useDismissable, useFocusTrap } from '../hooks/useDismissable';
import { formatRelative, localDigits } from '../lib/format';
import { fallbackInterval, useLiveStatus, useLiveUpdates } from '../lib/live';
import { MessengerMenuItem } from './Messenger';
import {
  Badge, Button, Spinner, cx,
  IconAlert, IconBell, IconBriefcase, IconChart, IconCheckCircle, IconClipboard,
  IconClose, IconDashboard, IconFile, IconLogout, IconMoney, IconSearch,
  IconSettings, IconShield, IconSpark, IconTraffic, IconUsers, IconLayers,
} from './ui';
import { loc, tr, trx } from '../i18n';
import { Avatar } from './Avatar';
import { QuickForms } from './QuickForms';
import { AssistantButton } from './AssistantChat';

interface NavItem {
  to: string;
  label: string;
  icon: (p: { className?: string }) => ReactNode;
  /** The permission that makes this destination meaningful for the signed-in user. */
  permission?: string;
  /** Or any one of these — a page whose parts are each someone's (Hivamis task 6). */
  anyOf?: string[];
}

interface NavGroup { label: string; items: NavItem[] }

/**
 * Navigation mirrors the ten Doc_H ERP modules rather than the database tables,
 * so the sidebar reads as the organisation's own operating model.
 */
/** Any part of the administration page is a reason to see it; each tab shows only to its holders. */
export const ADMIN_PERMISSIONS = ['admin.audit', 'admin.users', 'admin.roles', 'admin.settings', 'admin.keys'];

const NAV: NavGroup[] = [
  {
    label: tr('کار من'),
    items: [
      { to: '/', label: tr('داشبورد'), icon: IconDashboard },
      { to: '/my-work', label: tr('کارهای من'), icon: IconCheckCircle },
      { to: '/tasks', label: tr('وظایف'), icon: IconCheckCircle, permission: 'task.read' },
      { to: '/forms', label: tr('فرم‌ها'), icon: IconFile, permission: 'form.read' },
      // No permission of its own: every colleague's page is open to everyone signed in (Hivamis task 4).
      { to: '/people', label: tr('همکاران'), icon: IconUsers },
    ],
  },
  {
    label: tr('CRM و فروش'),
    items: [
      { to: '/leads', label: tr('سرنخ‌ها'), icon: IconUsers, permission: 'crm.lead.read' },
      { to: '/opportunities', label: tr('فرصت‌های فروش'), icon: IconBriefcase, permission: 'crm.opportunity.read' },
      { to: '/companies', label: tr('مشتریان'), icon: IconUsers, permission: 'crm.company.read' },
    ],
  },
  {
    label: tr('اکانت و پروپوزال'),
    items: [
      { to: '/briefs', label: tr('بریف‌ها'), icon: IconClipboard, permission: 'brief.read' },
      { to: '/proposals', label: tr('پروپوزال‌ها'), icon: IconFile, permission: 'proposal.read' },
    ],
  },
  {
    label: tr('اجرا و کنترل'),
    items: [
      { to: '/projects', label: tr('پروژه‌ها'), icon: IconLayers, permission: 'project.read' },
      { to: '/work-orders', label: tr('سفارش‌های کار'), icon: IconClipboard, permission: 'workorder.read' },
      { to: '/qc', label: tr('کنترل کیفیت'), icon: IconShield, permission: 'qc.read' },
      { to: '/changes', label: tr('درخواست‌های تغییر'), icon: IconAlert, permission: 'change.read' },
      { to: '/traffic', label: tr('ترافیک و ظرفیت'), icon: IconTraffic, permission: 'traffic.read' },
      { to: '/suppliers', label: tr('تأمین‌کنندگان'), icon: IconUsers, permission: 'supplier.read' },
    ],
  },
  {
    label: tr('تجاری و مالی'),
    items: [
      { to: '/contracts', label: tr('قراردادها'), icon: IconFile, permission: 'contract.read' },
      { to: '/finance', label: tr('مالی'), icon: IconMoney, permission: 'finance.read' },
    ],
  },
  {
    label: tr('تحلیل و مدیریت'),
    items: [
      { to: '/reports', label: tr('گزارش‌ها'), icon: IconChart, permission: 'report.read' },
      // No permission of its own: memory only ever searches what the caller may already read.
      { to: '/memory', label: tr('حافظهٔ سازمان'), icon: IconSearch },
      { to: '/ai', label: tr('دستیار هوشمند'), icon: IconSpark, permission: 'ai.use' },
      // No permission of its own: the rules are for everyone they bind to read (roadmap #47).
      { to: '/rules', label: tr('قوانین سازمان'), icon: IconShield },
      { to: '/onboarding', label: tr('راه‌اندازی سازمان'), icon: IconClipboard, permission: 'admin.settings' },
      { to: '/admin', label: tr('مدیریت سیستم'), icon: IconSettings, anyOf: ADMIN_PERMISSIONS },
    ],
  },
];

export function Shell({ children }: { children: ReactNode }) {
  const { user, signOut, can, canAny } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  // One live stream for the signed-in tab (roadmap #39).
  useLiveUpdates(useQueryClient());

  /**
   * Whether the sidebar is a permanent column rather than a drawer. Tailwind's lg: breakpoint
   * is 1024px; matchMedia keeps the inert/trap behaviour in step with what is actually rendered.
   */
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const sidebarRef = useDismissable<HTMLElement>({
    open: mobileOpen && !isDesktop,
    onClose: () => setMobileOpen(false),
  });
  // Tabbing out of an open drawer lands on the page behind it, which the overlay hides.
  useFocusTrap(sidebarRef, mobileOpen && !isDesktop);
  const location = useLocation();

  useEffect(() => setMobileOpen(false), [location.pathname]);

  const visibleGroups = NAV
    .map((g) => ({ ...g, items: g.items.filter((i) => (!i.permission || can(i.permission)) && (!i.anyOf || canAny(...i.anyOf))) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="flex h-full">
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-ink-900/40 lg:hidden" onClick={() => setMobileOpen(false)} aria-hidden />
      )}

      {/*
        The closed drawer was only moved off-screen by a transform, so it stayed in the
        accessibility tree and in the tab order — a keyboard user tabbed into a menu they
        could not see. `inert` removes it from both; the lg: breakpoint keeps the desktop
        sidebar always available.
      */}
      <aside
        ref={sidebarRef}
        id="app-sidebar"
        aria-label={tr('منوی اصلی')}
        inert={!mobileOpen && !isDesktop ? true : undefined}
        className={cx(
          'fixed inset-y-0 right-0 z-40 flex w-64 flex-col border-s border-ink-200 bg-surface transition-transform lg:static lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0',
        )}
      >
        <div className="flex h-14 items-center justify-between gap-2 border-b border-ink-100 px-4">
          <Link to="/" className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">{tr('ه')}</span>
            <span className="text-sm font-semibold text-ink-800">{tr('هیوامیس')}</span>
          </Link>
          <button className="rounded p-1 text-ink-400 lg:hidden" onClick={() => setMobileOpen(false)} aria-label={tr('بستن منو')}>
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
          <Link to="/me" className="mb-2 flex items-center gap-2 rounded-md px-1 py-1 hover:bg-ink-50" title={tr('صفحهٔ من')}>
            {user && <Avatar name={user.fullName} unit={user.department?.code} size="sm" />}
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-ink-800">{user?.fullName}</span>
              <span className="block truncate text-xs text-ink-500">
                {[trx(user?.jobTitle), user?.department ? loc(user.department, 'name') : ''].filter(Boolean).join(' — ')}
              </span>
            </span>
          </Link>
          <Link to="/delegations" className="mb-1 block rounded-md px-2 py-1.5 text-xs text-ink-600 hover:bg-ink-50 hover:text-ink-800">{tr('تفویض اختیار')}{user?.delegated && Object.keys(user.delegated).length > 0 && <Badge tone="info" className="ms-2">{tr('به نمایندگی')}</Badge>}
          </Link>
          <MessengerMenuItem />
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => void signOut()}>
            <IconLogout className="size-4" />{' '}{tr('خروج')}</Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setMobileOpen(true)} menuOpen={mobileOpen} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

/** Says «آفلاین» only when the browser is sure — silence is the normal, connected case. */
function ConnectionState() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const mark = () => setOnline(navigator.onLine);
    window.addEventListener('online', mark);
    window.addEventListener('offline', mark);
    return () => { window.removeEventListener('online', mark); window.removeEventListener('offline', mark); };
  }, []);
  if (online) return null;
  return (
    <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800" role="status">{tr('آفلاین — فرم‌ها در صف می‌مانند')}</span>
  );
}

function TopBar({ onMenu, menuOpen }: { onMenu: () => void; menuOpen: boolean }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-ink-200 bg-surface px-4">
      <button className="rounded p-1.5 text-ink-500 hover:bg-ink-100 lg:hidden" onClick={onMenu} aria-label={tr('منو')}
          aria-controls="app-sidebar"
          aria-expanded={menuOpen}>
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
        </svg>
      </button>
      <GlobalSearch />
      <div className="flex items-center gap-1">
        <QuickForms />
        <AssistantButton />
        {/* What this device is still carrying, and whether it can send it (roadmap #19). */}
        <ConnectionState />
        <OutboxBadge />
        <HelpButton />
        <LocaleToggle />
        <ThemeToggle />
        <Notifications />
      </div>
    </header>
  );
}

interface SearchItem {
  id: string; code?: string; legalName?: string; title?: string; name?: string; state?: string;
}

interface SearchGroup {
  type: string;
  labelFa: string;
  items: SearchItem[];
}

const SEARCH_ROUTES: Record<string, string> = {
  company: '/companies', opportunity: '/opportunities', project: '/projects',
  task: '/tasks', brief: '/briefs', proposal: '/proposals', contract: '/contracts',
};

function GlobalSearch() {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const boxRef = useDismissable<HTMLDivElement>({
    open,
    onClose: () => setOpen(false),
    // The input is inside the overlay and keeps focus on its own; pulling it back would fight it.
    restoreFocus: false,
  });

  // Ctrl/⌘+K focuses search from anywhere — the expected shortcut in this class of tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const { data, isFetching } = useQuery<{ groups: SearchGroup[]; total: number }>({
    queryKey: ['search', term],
    queryFn: () => apiGet('/search', { q: term }),
    enabled: term.trim().length >= 2,
    staleTime: 10_000,
  });

  // Flattened across groups, because arrow keys move through results, not through headings.
  const flat = useMemo(
    () => (data?.groups ?? []).flatMap((g) => g.items.map((item) => ({ group: g.type, item }))),
    [data],
  );
  useEffect(() => { setActive(0); }, [term, data]);

  const go = (entry: { group: string; item: SearchItem }) => {
    navigate(`${SEARCH_ROUTES[entry.group] ?? '/'}/${entry.item.id}`);
    setOpen(false);
    setTerm('');
  };

  const showing = open && term.trim().length >= 2;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showing || flat.length === 0) return;
    // In RTL the list still runs top-to-bottom, so Up/Down are the right keys — not Left/Right,
    // which a mirrored reading of "next" would suggest.
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % flat.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + flat.length) % flat.length); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(flat.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); const hit = flat[active]; if (hit) go(hit); }
  };

  const optionId = (i: number) => `search-option-${i}`;

  return (
    <div ref={boxRef} className="relative flex-1 max-w-xl">
      <div
        className="relative"
        role="combobox"
        aria-expanded={showing}
        aria-haspopup="listbox"
        aria-owns="search-results"
      >
        <IconSearch className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-ink-400" />
        <input
          ref={inputRef}
          value={term}
          role="searchbox"
          autoComplete="off"
          aria-controls="search-results"
          aria-activedescendant={showing && flat.length ? optionId(active) : undefined}
          onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={tr('جستجوی سراسری… (Ctrl+K)')}
          className="w-full rounded-lg border-0 bg-ink-100 py-2 ps-9 pe-3 text-sm text-ink-800 placeholder:text-ink-400 focus:bg-surface focus:ring-2 focus:ring-inset focus:ring-brand-600"
        />
        {isFetching && <Spinner className="absolute inset-y-0 end-3 my-auto size-4" />}
      </div>

      {showing && (
        <div
          id="search-results"
          role="listbox"
          aria-label={tr('نتایج جستجو')}
          className="animate-in absolute inset-x-0 top-full z-50 mt-1 max-h-96 overflow-y-auto rounded-xl bg-surface p-1.5 shadow-xl ring-1 ring-ink-200"
        >
          {!data || data.total === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-ink-500" role="status">{tr('نتیجه‌ای یافت نشد.')}</p>
          ) : (
            data.groups.map((group) => (
              <div key={group.type} role="group" aria-label={loc(group, 'label')} className="mb-1.5 last:mb-0">
                <p className="px-2.5 py-1 text-[11px] font-semibold text-ink-400">{loc(group, 'label')}</p>
                {group.items.map((item) => {
                  const i = flat.findIndex((f) => f.item.id === item.id && f.group === group.type);
                  const isActive = i === active;
                  return (
                    <button
                      key={item.id}
                      id={optionId(i)}
                      role="option"
                      aria-selected={isActive}
                      tabIndex={-1}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => go({ group: group.type, item })}
                      className={cx(
                        'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-right text-sm',
                        isActive ? 'bg-brand-50 text-brand-800' : 'hover:bg-ink-100',
                      )}
                    >
                      <span className="truncate text-ink-700">
                        {item.legalName ?? item.title ?? item.name}
                      </span>
                      {item.code && <span className="ltr shrink-0 text-[11px] text-ink-400">{item.code}</span>}
                    </button>
                  );
                })}
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

/** Opens the written guide at the section for the signed-in user's role. */
function HelpButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={tr('راهنمای کاربری')}
        title={tr('راهنمای کاربری')}
        className="rounded-lg p-2 text-ink-500 hover:bg-ink-100
                   focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
      >
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9a2.5 2.5 0 113.5 2.3c-.6.3-1 .9-1 1.7M12 17h.01" strokeLinecap="round" />
        </svg>
      </button>
      <HelpDrawer open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Persian ⇄ English: saves the choice and reloads the page in the other language. */
function LocaleToggle() {
  const { locale, setLocale } = useLocale();
  const other: Locale = locale === 'fa' ? 'en' : 'fa';
  return (
    <button
      onClick={() => void setLocale(other)}
      title={locale === 'fa' ? 'Switch to English' : tr('تغییر به فارسی')}
      aria-label={locale === 'fa' ? 'Switch interface language to English' : tr('تغییر زبان رابط به فارسی')}
      className="rounded-lg px-2 py-1.5 text-xs font-medium text-ink-500 hover:bg-ink-100
                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
    >
      {locale === 'fa' ? 'EN' : tr('فا')}
    </button>
  );
}

/** Cycles light → dark → system. Three states, because "follow the OS" is a real preference. */
function ThemeToggle() {
  const { preference, resolved, setPreference } = useTheme();
  const next: Record<ThemePreference, ThemePreference> = {
    light: 'dark', dark: 'system', system: 'light',
  };
  const labels: Record<ThemePreference, string> = {
    light: tr('روشن'), dark: tr('تیره'), system: tr('هماهنگ با سیستم'),
  };

  return (
    <button
      onClick={() => setPreference(next[preference])}
      title={tr('نمایش: {0}', labels[preference])}
      aria-label={tr('حالت نمایش: {0} — برای تغییر کلیک کنید', labels[preference])}
      className="rounded-lg p-2 text-ink-500 hover:bg-ink-100
                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
    >
      {preference === 'system' ? (
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8M12 17v4" strokeLinecap="round" />
        </svg>
      ) : resolved === 'dark' ? (
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  // Escape and focus return, which this panel had neither of.
  const boxRef = useDismissable<HTMLDivElement>({ open, onClose: () => setOpen(false) });

  const live = useLiveStatus();
  const { data } = useQuery<{ items: NotificationRow[]; unread: number }>({
    queryKey: ['/notifications'],
    queryFn: () => apiGet('/notifications'),
    // Pushed while the live stream is up; polled as before while it is not.
    refetchInterval: fallbackInterval(live),
  });

  const markAll = async () => {
    await apiPost('/notifications/read-all');
    await qc.invalidateQueries({ queryKey: ['/notifications'] });
  };

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-lg p-2 text-ink-500 hover:bg-ink-100"
        aria-label={tr('اعلان‌ها{0}', data?.unread ? tr(' ({0} خوانده‌نشده)', data.unread) : '')}
      >
        <IconBell className="size-5" />
        <span
          className={`absolute -bottom-0.5 -start-0.5 size-2 rounded-full ring-2 ring-surface ${live === 'live' ? 'bg-emerald-500' : live === 'connecting' ? 'bg-amber-400' : 'bg-ink-300'}`}
          title={live === 'live' ? tr('به‌روزرسانی زنده') : live === 'connecting' ? tr('در حال اتصال زنده…') : tr('اتصال زنده برقرار نیست؛ هر دقیقه به‌روزرسانی می‌شود')}
          data-testid="live-status" data-status={live}
        />
        {!!data?.unread && (
          <span className="absolute -end-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-medium text-white nums">
            {localDigits(data.unread > 9 ? tr('۹+') : data.unread)}
          </span>
        )}
      </button>

      {open && (
        <div className="animate-in absolute end-0 top-full z-50 mt-1 w-80 rounded-xl bg-surface shadow-xl ring-1 ring-ink-200">
          <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2">
            <p className="text-sm font-semibold text-ink-800">{tr('اعلان‌ها')}</p>
            {!!data?.unread && (
              <button onClick={() => void markAll()} className="text-xs text-brand-600 hover:underline">{tr('خوانده‌شدن همه')}</button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {!data?.items.length ? (
              <p className="px-3 py-8 text-center text-sm text-ink-500">{tr('اعلانی وجود ندارد.')}</p>
            ) : (
              data.items.slice(0, 20).map((n) => (
                <div key={n.id} className={cx('border-b border-ink-100 px-3 py-2.5 last:border-0', !n.readAt && 'bg-brand-50/40')}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-ink-800">{n.title}</p>
                    {n.severity === 'CRITICAL' && <Badge tone="danger">{tr('بحرانی')}</Badge>}
                    {n.severity === 'WARNING' && <Badge tone="warning">{tr('هشدار')}</Badge>}
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
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-200 bg-surface px-5 py-4">
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
