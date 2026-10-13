import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { PORTAL_DELIVERABLE_STATUS, CLIENT_APPROVAL_STATUS_LABELS, type ClientApprovalStatus } from '@hiva/contracts';
import { Badge, Button, Field, Input, Textarea } from '../components/ui';
import { formatDate, formatDateTime, formatNumber, localDigits } from '../lib/format';
import { ApprovalDecision, type ApprovalApi, type Receipt, type View } from './ApprovePublic';
import { loc, locale, tr, trx } from '../i18n';
import { fallbackMessage } from '../lib/api';

/*
 * Roadmap #34 — the client portal. A separate little app under /portal: its own sign-in, its own
 * token (kept for the tab only), and no code path into the staff interface.
 */

const KEY = 'hiva.portal';
const tokenGet = () => { try { return sessionStorage.getItem(KEY); } catch { return null; } };
const tokenSet = (t: string | null) => { try { if (t) sessionStorage.setItem(KEY, t); else sessionStorage.removeItem(KEY); } catch { /* private mode */ } };

class PortalError extends Error { constructor(message: string, readonly status: number) { super(message); } }

async function raw(path: string, init: RequestInit = {}) {
  const token = tokenGet();
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { 'accept-language': locale(), ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (res.status === 401 && token) { tokenSet(null); window.location.assign('/portal/login'); }
  return res;
}
async function papi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await raw(path, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new PortalError(trx(body?.error?.message) || fallbackMessage(res.status), res.status);
  return body as T;
}
async function save(path: string, fallback: string) {
  const res = await raw(path);
  if (!res.ok) { const b = await res.json().catch(() => null); throw new Error(trx(b?.error?.message) || fallbackMessage(res.status)); }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1];
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href; a.download = name ? decodeURIComponent(name) : fallback;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => papi<T>(path).then(setData).catch((e) => setError(e.message));
  useEffect(() => { void reload(); }, [path]);
  return { data, error, reload };
}

export default function PortalApp() {
  return (
    <div className="min-h-full" dir="rtl">
      <Routes>
        <Route path="/portal/login" element={<SignIn />} />
        <Route path="/portal/invite/:token" element={<AcceptInvite />} />
        <Route path="/portal" element={<Signed><Home /></Signed>} />
        <Route path="/portal/projects/:id" element={<Signed><ProjectPage /></Signed>} />
        <Route path="/portal/approvals/:id" element={<Signed><ApprovalPage /></Signed>} />
        <Route path="*" element={<Navigate to="/portal" replace />} />
      </Routes>
    </div>
  );
}

function Signed({ children }: { children: React.ReactNode }) {
  if (!tokenGet()) return <Navigate to="/portal/login" replace />;
  return (
    <>
      <header className="border-b border-ink-200 bg-surface">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3">
          <Link to="/portal" className="text-sm font-semibold text-brand-700">{tr('پورتال مشتری')}</Link>
          <Button size="sm" variant="ghost" onClick={() => { tokenSet(null); window.location.assign('/portal/login'); }}>{tr('خروج')}</Button>
        </div>
      </header>
      <main className="mx-auto max-w-4xl space-y-5 px-4 py-6">{children}</main>
    </>
  );
}

function Box({ title, children, testid }: { title?: string; children: React.ReactNode; testid?: string }) {
  return (
    <section className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-ink-200 sm:p-5" data-testid={testid}>
      {title && <h2 className="mb-3 text-sm font-semibold text-ink-800">{title}</h2>}
      {children}
    </section>
  );
}

function Centered({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-12">
      <div className="mx-auto max-w-sm space-y-4 rounded-xl bg-surface p-6 shadow-sm ring-1 ring-ink-200">
        <h1 className="text-base font-semibold text-ink-900">{title}</h1>
        {children}
      </div>
    </div>
  );
}

function SignIn() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setError(null);
    try { const r = await papi<{ token: string }>('/portal/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); tokenSet(r.token); nav('/portal'); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Centered title={tr('ورود به پورتال مشتری')}>
      <Field label={tr('ایمیل')}><Input value={email} onChange={(e) => setEmail(e.target.value)} className="ltr" type="email" autoComplete="username" aria-label={tr('ایمیل')} /></Field>
      <Field label={tr('رمز عبور')}><Input value={password} onChange={(e) => setPassword(e.target.value)} className="ltr" type="password" autoComplete="current-password" aria-label={tr('رمز عبور')} /></Field>
      {error && <p className="text-xs text-rose-700" data-testid="portal-error">{error}</p>}
      <Button variant="primary" loading={busy} disabled={!email || !password} onClick={() => void go()}>{tr('ورود')}</Button>
      <p className="text-[12.5px] text-ink-500">{tr('حساب پورتال را مدیر اکانت شما می‌سازد؛ اگر رمز را فراموش کرده‌اید، دعوت تازه بخواهید.')}</p>
    </Centered>
  );
}

function AcceptInvite() {
  const { token = '' } = useParams();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const strong = password.length >= 12 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password);
  const go = async () => {
    setBusy(true); setError(null);
    try { const r = await papi<{ token: string }>('/portal/auth/accept', { method: 'POST', body: JSON.stringify({ token, password }) }); tokenSet(r.token); nav('/portal'); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Centered title={tr('تعیین رمز عبور پورتال')}>
      <Field label={tr('رمز عبور')} hint={tr('دست‌کم ۱۲ نویسه، با حرف کوچک و بزرگ لاتین و عدد')}>
        <Input value={password} onChange={(e) => setPassword(e.target.value)} className="ltr" type="password" autoComplete="new-password" aria-label={tr('رمز عبور')} />
      </Field>
      <Field label={tr('تکرار رمز عبور')}><Input value={again} onChange={(e) => setAgain(e.target.value)} className="ltr" type="password" autoComplete="new-password" aria-label={tr('تکرار رمز عبور')} /></Field>
      {again && again !== password && <p className="text-xs text-amber-800">{tr('دو رمز یکی نیستند.')}</p>}
      {error && <p className="text-xs text-rose-700" data-testid="portal-error">{error}</p>}
      <Button variant="primary" loading={busy} disabled={!strong || password !== again} onClick={() => void go()}>{tr('ذخیره و ورود')}</Button>
    </Centered>
  );
}

interface HomeData {
  me: { name: string; email: string; company: string };
  projects: { id: string; code: string; name: string; stateFa: string; plannedStart: string | null; plannedEnd: string | null; milestones: { done: number; total: number } }[];
  approvals: { id: string; code: string; subjectType: string; title: string; expiresAt: string; forMe: boolean }[];
  invoices: { id: string; number: string; issueDate: string; dueDate: string | null; total: string; paidAmount: string; state: string; currency: string; originalTotal: string | null }[];
}

function Home() {
  const { data, error } = useLoad<HomeData>('/portal/home');
  if (error) return <p className="text-sm text-rose-700">{error}</p>;
  if (!data) return <p className="text-sm text-ink-500">{tr('در حال بارگذاری…')}</p>;
  return (
    <>
      <div>
        <h1 className="text-lg font-semibold text-ink-900">{data.me.company}</h1>
        <p className="text-xs text-ink-500">{data.me.name} · <span className="ltr">{data.me.email}</span></p>
      </div>
      {data.approvals.length > 0 && (
        <Box title={tr('منتظر نظر شما')} testid="portal-approvals">
          <ul className="space-y-2">
            {data.approvals.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="flex-1">{a.subjectType === 'DELIVERABLE' ? tr('خروجی') : tr('پروپوزال')} «{a.title}» <span className="text-xs text-ink-400">{tr('تا {0}', formatDate(a.expiresAt))}</span></span>
                <Link to={`/portal/approvals/${a.id}`}><Button size="sm" variant={a.forMe ? 'primary' : 'ghost'}>{a.forMe ? tr('بررسی و تصمیم') : tr('مشاهده')}</Button></Link>
              </li>
            ))}
          </ul>
        </Box>
      )}
      <Box title={tr('پروژه‌ها')} testid="portal-projects">
        {!data.projects.length ? <p className="text-sm text-ink-500">{tr('پروژهٔ فعالی نیست.')}</p> : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {data.projects.map((p) => (
              <li key={p.id}>
                <Link to={`/portal/projects/${p.id}`} className="block rounded-lg border border-ink-200 p-3 hover:border-brand-300">
                  <p className="text-sm font-medium text-ink-900">{p.name}</p>
                  <p className="mt-1 text-xs text-ink-500">{loc(p, 'state')}{p.plannedEnd ? tr(' · پایان برنامه‌ریزی‌شده {0}', formatDate(p.plannedEnd)) : ''}</p>
                  {p.milestones.total > 0 && <Progress done={p.milestones.done} total={p.milestones.total} label={tr('نقطه‌های عطف')} />}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Box>
      {data.invoices.length > 0 && (
        <Box title={tr('صورت‌حساب‌ها')} testid="portal-invoices">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-ink-500"><tr><th className="py-1 text-start">{tr('شماره')}</th><th className="text-start">{tr('تاریخ')}</th><th className="text-start">{tr('سررسید')}</th><th className="text-start">{tr('مبلغ')}</th><th className="text-start">{tr('پرداخت‌شده')}</th></tr></thead>
              <tbody>
                {data.invoices.map((i) => (
                  <tr key={i.id} className="border-t border-ink-100">
                    <td className="py-1.5"><span className="ltr whitespace-nowrap">{i.number}</span></td><td>{formatDate(i.issueDate)}</td><td>{formatDate(i.dueDate)}</td>
                    <td>{tr('{0} ریال', formatNumber(Number(i.total)))}</td><td>{tr('{0} ریال', formatNumber(Number(i.paidAmount)))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Box>
      )}
    </>
  );
}

function Progress({ done, total, label }: { done: number; total: number; label: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="mt-2">
      <div className="h-1.5 rounded-full bg-ink-100"><div className="h-1.5 rounded-full bg-brand-600" style={{ width: `${pct}%` }} /></div>
      <p className="mt-1 text-[12.5px] text-ink-500">{tr('{0}: {1} از {2}', label, localDigits(done), localDigits(total))}</p>
    </div>
  );
}

interface ProjectData {
  project: { id: string; code: string; name: string; objective: string | null; stateFa: string; plannedStart: string | null; plannedEnd: string | null };
  milestones: { id: string; name: string; description: string | null; dueDate: string; completedAt: string | null }[];
  deliverables: { id: string; code: string; name: string; version: string; clientState: string; dueDate: string | null; deliveredAt: string | null }[];
  reports: { id: string; code: string; period: string; createdAt: string }[];
  documents: { id: string; fileName: string; sizeBytes: number; createdAt: string }[];
  approvals: { id: string; code: string; subjectId: string; status: string; forMe: boolean; contactName: string; decidedAt: string | null }[];
  messages: { id: string; body: string; createdAt: string; fromClient: boolean; author: string }[];
}

function ProjectPage() {
  const { id = '' } = useParams();
  const { data, error, reload } = useLoad<ProjectData>(`/portal/projects/${id}`);
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  if (error) return <p className="text-sm text-rose-700">{error}</p>;
  if (!data) return <p className="text-sm text-ink-500">{tr('در حال بارگذاری…')}</p>;
  const p = data.project;
  const approvalOf = (deliverableId: string) => data.approvals.find((a) => a.subjectId === deliverableId);
  const send = async () => {
    try { await papi(`/portal/projects/${id}/messages`, { method: 'POST', body: JSON.stringify({ body: text }) }); setText(''); await reload(); }
    catch (e: any) { setNote(e.message); }
  };
  const download = (path: string, name: string) => void save(path, name).catch((e) => setNote(e.message));
  return (
    <>
      <div>
        <Link to="/portal" className="text-xs text-brand-700">{tr('← پروژه‌ها')}</Link>
        <h1 className="mt-1 text-lg font-semibold text-ink-900">{p.name}</h1>
        <p className="text-xs text-ink-500"><span className="ltr whitespace-nowrap">{p.code}</span> · {loc(p, 'state')}{p.plannedStart ? tr(' · {0} تا {1}', formatDate(p.plannedStart), formatDate(p.plannedEnd)) : ''}</p>
        {p.objective && <p className="mt-2 text-sm text-ink-700">{p.objective}</p>}
      </div>
      {note && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{note}</p>}

      {data.milestones.length > 0 && (
        <Box title={tr('نقطه‌های عطف')} testid="portal-milestones">
          <Progress done={data.milestones.filter((m) => m.completedAt).length} total={data.milestones.length} label={tr('انجام‌شده')} />
          <ul className="mt-3 space-y-1.5 text-sm">
            {data.milestones.map((m) => (
              <li key={m.id} className="flex items-center gap-2">
                <span className={m.completedAt ? 'text-emerald-700' : 'text-ink-300'}>{m.completedAt ? '✓' : '○'}</span>
                <span className="flex-1">{m.name}</span>
                <span className="text-xs text-ink-500">{m.completedAt ? tr('انجام شد {0}', formatDate(m.completedAt)) : formatDate(m.dueDate)}</span>
              </li>
            ))}
          </ul>
        </Box>
      )}

      <Box title={tr('خروجی‌ها')} testid="portal-deliverables">
        {!data.deliverables.length ? <p className="text-sm text-ink-500">{tr('هنوز خروجی‌ای تعریف نشده است.')}</p> : (
          <ul className="space-y-2 text-sm">
            {data.deliverables.map((d) => {
              const a = approvalOf(d.id);
              return (
                <li key={d.id} className="flex flex-wrap items-center gap-2 border-b border-ink-100 pb-2 last:border-0">
                  <span className="flex-1">{d.name} <span className="ltr text-xs text-ink-400">{d.version}</span></span>
                  <Badge tone={d.clientState === 'ACCEPTED' ? 'success' : d.clientState === 'DELIVERED' ? 'info' : 'neutral'}>{PORTAL_DELIVERABLE_STATUS[d.clientState] ?? tr('در حال تهیه')}</Badge>
                  {a && <Link to={`/portal/approvals/${a.id}`}><Button size="sm" variant={a.status === 'PENDING' && a.forMe ? 'primary' : 'ghost'}>{trx(a.status === 'PENDING' && a.forMe ? tr('بررسی و تصمیم') : CLIENT_APPROVAL_STATUS_LABELS[a.status as ClientApprovalStatus] ?? a.status)}</Button></Link>}
                </li>
              );
            })}
          </ul>
        )}
      </Box>

      <div className="grid gap-5 sm:grid-cols-2">
        <Box title={tr('گزارش‌های وضعیت')} testid="portal-reports">
          {!data.reports.length ? <p className="text-sm text-ink-500">{tr('هنوز گزارشی نیست.')}</p> : (
            <ul className="space-y-1.5 text-sm">
              {data.reports.map((r) => (
                <li key={r.id} className="flex items-center gap-2"><span className="flex-1">{r.period}</span>
                  <Button size="sm" variant="ghost" onClick={() => download(`/portal/status-reports/${r.id}`, `${r.code}.pdf`)}>PDF</Button></li>
              ))}
            </ul>
          )}
        </Box>
        <Box title={tr('فایل‌ها')} testid="portal-documents">
          {!data.documents.length ? <p className="text-sm text-ink-500">{tr('فایلی به اشتراک گذاشته نشده است.')}</p> : (
            <ul className="space-y-1.5 text-sm">
              {data.documents.map((d) => (
                <li key={d.id} className="flex items-center gap-2"><span className="flex-1 truncate">{d.fileName} <span className="text-xs text-ink-400">({localDigits(Math.ceil(d.sizeBytes / 1024))} KB)</span></span>
                  <Button size="sm" variant="ghost" onClick={() => download(`/portal/documents/${d.id}`, d.fileName)}>{tr('دریافت')}</Button></li>
              ))}
            </ul>
          )}
        </Box>
      </div>

      <Box title={tr('گفت‌وگو با مدیر اکانت')} testid="portal-messages">
        <ul className="mb-3 space-y-2">
          {data.messages.map((m) => (
            <li key={m.id} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.fromClient ? 'ms-auto bg-brand-50 text-ink-800' : 'bg-ink-50 text-ink-800'}`}>
              <p className="whitespace-pre-line">{m.body}</p>
              <p className="mt-1 text-[12px] text-ink-500">{m.author} · {formatDateTime(m.createdAt)}</p>
            </li>
          ))}
        </ul>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label={tr('پیام شما')} placeholder={tr('پیام شما…')} />
        <Button size="sm" variant="primary" className="mt-2" disabled={!text.trim()} onClick={() => void send()}>{tr('فرستادن')}</Button>
      </Box>
    </>
  );
}

function ApprovalPage() {
  const { id = '' } = useParams();
  const api = useMemo<ApprovalApi>(() => ({
    load: () => papi<View>(`/portal/approvals/${id}`),
    file: (doc) => raw(`/portal/approvals/${id}/files/${doc}`),
    code: () => Promise.reject(new Error(tr('در پورتال کدی لازم نیست.'))),
    decide: (body) => papi<Receipt>(`/portal/approvals/${id}/decision`, { method: 'POST', body: JSON.stringify(body) }),
  }), [id]);
  return (
    <>
      <Link to="/portal" className="text-xs text-brand-700">{tr('← بازگشت')}</Link>
      <Box><ApprovalDecision api={api} embedded /></Box>
    </>
  );
}
