import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PORTAL_USER_STATUS_LABELS } from '@hiva/contracts';
import { apiGet, apiPatch, apiPost, apiUpload, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, EmptyState, Select, Textarea, useToast } from './ui';
import { formatDate, formatDateTime, toPersianDigits } from '../lib/format';

/* Roadmap #34 — Account's side of the client portal. */

const STATUS_TONE: Record<string, 'success' | 'info' | 'neutral'> = { ACTIVE: 'success', INVITED: 'info', DISABLED: 'neutral' };

function LinkOnce({ link }: { link: string }) {
  return (
    <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="portal-invite-link">
      <p className="font-medium">ایمیل سازمان پیکربندی نشده است؛ این پیوند دعوت را خودتان به مشتری برسانید. فقط همین یک بار نمایش داده می‌شود.</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="ltr block flex-1 truncate rounded bg-white px-2 py-1 text-[11px]">{link}</code>
        <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(link)}>رونوشت</Button>
      </div>
    </div>
  );
}

/** On the client's page: who may sign in to the portal, and inviting more. */
export function PortalUsersCard({ companyId, contacts }: { companyId: string; contacts: { id: string; fullName: string; email?: string | null }[] }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [contactId, setContactId] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const { data: users } = useQuery<any[]>({ queryKey: ['/portal-users', companyId], queryFn: () => apiGet('/portal-users', { companyId }), enabled: can('portal.manage') });
  if (!can('portal.manage') || !users) return null;
  const invitable = contacts.filter((c) => c.email && !users.some((u) => u.contactId === c.id));
  const chosen = contactId || invitable[0]?.id || '';
  const run = async (fn: () => Promise<{ link?: string | null } | unknown>, done: string) => {
    try {
      const r = (await fn()) as { link?: string | null };
      toast(r?.link ? `${done} پیوند را به مشتری برسانید.` : done);
      setLink(r?.link ?? null);
      await qc.invalidateQueries({ queryKey: ['/portal-users', companyId] });
    } catch (e: any) { toast(e?.message ?? 'انجام نشد.', 'danger'); }
  };
  return (
    <Card title="پورتال مشتری" subtitle="مخاطبانی که با حساب خود پیشرفت پروژه‌ها، خروجی‌ها، گزارش‌ها و فایل‌های مشترک را می‌بینند.">
      <div className="space-y-3 px-4 py-3" data-testid="portal-users">
        {link && <LinkOnce link={link} />}
        {!users.length ? <p className="text-xs text-ink-500">هنوز کسی از این مشتری به پورتال دعوت نشده است.</p> : (
          <ul className="divide-y divide-ink-100 text-sm">
            {users.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="flex-1">{u.contact?.fullName} <span className="ltr text-xs text-ink-400">{u.email}</span></span>
                <Badge tone={STATUS_TONE[u.status] ?? 'neutral'}>{PORTAL_USER_STATUS_LABELS[u.status] ?? u.status}</Badge>
                <span className="text-[11px] text-ink-400">{u.lastLoginAt ? `آخرین ورود ${formatDateTime(u.lastLoginAt)}` : `دعوت ${formatDate(u.createdAt)}`}</span>
                <Button size="sm" variant="ghost" onClick={() => void run(() => apiPost(`/portal-users/${u.id}/reinvite`), 'دعوت تازه ساخته شد؛ رمز پیشین دیگر کار نمی‌کند.')}>دعوت دوباره</Button>
                {u.status !== 'DISABLED' && <Button size="sm" variant="ghost" onClick={() => void run(() => apiPost(`/portal-users/${u.id}/disable`), 'دسترسی به پورتال بسته شد.')}>غیرفعال</Button>}
              </li>
            ))}
          </ul>
        )}
        {invitable.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={chosen} onChange={(e) => setContactId(e.target.value)} aria-label="مخاطب برای دعوت" className="max-w-xs">
              {invitable.map((c) => <option key={c.id} value={c.id}>{c.fullName} ({c.email})</option>)}
            </Select>
            <Button size="sm" variant="primary" disabled={!chosen} onClick={() => void run(() => apiPost('/portal-users', { contactId: chosen }), 'دعوت‌نامه ساخته شد.')}>دعوت به پورتال</Button>
          </div>
        ) : <p className="text-[11px] text-ink-500">برای دعوت، مخاطب باید ایمیل داشته باشد.</p>}
      </div>
    </Card>
  );
}

/** On a project: its files, which of them the client sees, and a place to add one. */
export function ClientFilesCard({ projectId }: { projectId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const key = [`/projects/${projectId}/client-files`];
  const { data: files } = useQuery<any[]>({ queryKey: key, queryFn: () => apiGet(`/projects/${projectId}/client-files`) });
  if (!files) return null;
  const toggle = async (id: string, clientVisible: boolean) => {
    try { await apiPatch(`/documents/${id}/client-visibility`, { clientVisible }); await qc.invalidateQueries({ queryKey: key }); }
    catch (e: any) { toast(e?.message ?? 'انجام نشد.', 'danger'); }
  };
  const add = async (file: File) => {
    const form = new FormData();
    form.append('projectId', projectId);
    form.append('file', file);
    try { await apiUpload('/documents', form); await qc.invalidateQueries({ queryKey: key }); }
    catch (e: any) { toast(e?.message ?? 'بارگذاری ناموفق بود.', 'danger'); }
  };
  return (
    <Card title="فایل‌های پروژه" subtitle="هر فایل تا وقتی کسی از اکانت آن را «نمایش در پورتال» نکند، از دید مشتری پنهان است."
      action={can('document.write') ? <>
        <input ref={input} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void add(f); e.target.value = ''; }} />
        <Button size="sm" variant="secondary" onClick={() => input.current?.click()}>بارگذاری</Button>
      </> : undefined}>
      {!files.length ? <EmptyState title="فایلی برای این پروژه نیست" /> : (
        <ul className="divide-y divide-ink-100 px-4 text-sm" data-testid="client-files">
          {files.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1 truncate">{f.fileName}{f.deliverable && <span className="text-xs text-ink-400"> — {f.deliverable.name}</span>}</span>
              <span className="text-[11px] text-ink-400">{toPersianDigits(Math.ceil(f.sizeBytes / 1024))} KB · {formatDate(f.createdAt)}</span>
              <Button size="sm" variant="ghost" onClick={() => void downloadFile(`/documents/${f.id}/download`, f.fileName)}>دریافت</Button>
              {can('portal.manage') ? (
                <label className="flex items-center gap-1 text-xs text-ink-600">
                  <input type="checkbox" checked={f.clientVisible} onChange={(e) => void toggle(f.id, e.target.checked)} aria-label={`نمایش ${f.fileName} در پورتال`} /> نمایش در پورتال
                </label>
              ) : f.clientVisible && <Badge tone="info">در پورتال</Badge>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** On a project: the conversation with the client from the portal. */
export function PortalMessagesCard({ projectId }: { projectId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const key = [`/projects/${projectId}/portal-messages`];
  const { data } = useQuery<{ portalUsers: number; messages: { id: string; body: string; createdAt: string; fromClient: boolean; author: string }[] }>({
    queryKey: key, queryFn: () => apiGet(`/projects/${projectId}/portal-messages`),
  });
  if (!data) return null;
  const send = async () => {
    try { await apiPost(`/projects/${projectId}/portal-messages`, { body: text }); setText(''); await qc.invalidateQueries({ queryKey: key }); }
    catch (e: any) { toast(e?.message ?? 'فرستادن ناموفق بود.', 'danger'); }
  };
  return (
    <Card title="گفت‌وگو با مشتری" subtitle={data.portalUsers ? `${toPersianDigits(data.portalUsers)} نفر از مشتری در پورتال این گفت‌وگو را می‌بینند.` : 'هنوز کسی از این مشتری حساب پورتال فعال ندارد.'}>
      <div className="space-y-2 px-4 py-3" data-testid="portal-thread">
        {!data.messages.length && <p className="text-xs text-ink-500">پیامی نیست.</p>}
        {data.messages.map((m) => (
          <div key={m.id} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.fromClient ? 'bg-brand-50' : 'ms-auto bg-ink-50'}`}>
            <p className="whitespace-pre-line">{m.body}</p>
            <p className="mt-1 text-[10px] text-ink-500">{m.fromClient ? `مشتری — ${m.author}` : m.author} · {formatDateTime(m.createdAt)}</p>
          </div>
        ))}
        {can('portal.manage') && (
          <div className="pt-2">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label="پاسخ به مشتری" placeholder="پاسخ به مشتری…" />
            <Button size="sm" variant="primary" className="mt-2" disabled={!text.trim()} onClick={() => void send()}>فرستادن</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
