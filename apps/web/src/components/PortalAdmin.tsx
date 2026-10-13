import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PORTAL_USER_STATUS_LABELS } from '@hiva/contracts';
import { apiGet, apiPatch, apiPost, apiUpload, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, EmptyState, Select, Textarea, useToast } from './ui';
import { formatDate, formatDateTime, localDigits } from '../lib/format';
import { NewVersionButton, VersionBadge, VersionsButton, metadataFa } from './Assets';
import { tr, trx } from '../i18n';
import { WriteAssist } from './WriteAssist';
import { ImageMaker } from './ImageMaker';

/* Roadmap #34 — Account's side of the client portal. */

const STATUS_TONE: Record<string, 'success' | 'info' | 'neutral'> = { ACTIVE: 'success', INVITED: 'info', DISABLED: 'neutral' };

function LinkOnce({ link }: { link: string }) {
  return (
    <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="portal-invite-link">
      <p className="font-medium">{tr('ایمیل سازمان پیکربندی نشده است؛ این پیوند دعوت را خودتان به مشتری برسانید. فقط همین یک بار نمایش داده می‌شود.')}</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="ltr block flex-1 truncate rounded bg-white px-2 py-1 text-[12.5px]">{link}</code>
        <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(link)}>{tr('رونوشت')}</Button>
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
      toast(r?.link ? tr('{0} پیوند را به مشتری برسانید.', done) : done);
      setLink(r?.link ?? null);
      await qc.invalidateQueries({ queryKey: ['/portal-users', companyId] });
    } catch (e: any) { toast(e?.message ?? tr('انجام نشد.'), 'danger'); }
  };
  return (
    <Card title={tr('پورتال مشتری')} subtitle={tr('مخاطبانی که با حساب خود پیشرفت پروژه‌ها، خروجی‌ها، گزارش‌ها و فایل‌های مشترک را می‌بینند.')}>
      <div className="space-y-3 px-4 py-3" data-testid="portal-users">
        {link && <LinkOnce link={link} />}
        {!users.length ? <p className="text-xs text-ink-500">{tr('هنوز کسی از این مشتری به پورتال دعوت نشده است.')}</p> : (
          <ul className="divide-y divide-ink-100 text-sm">
            {users.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="flex-1">{u.contact?.fullName} <span className="ltr text-xs text-ink-400">{u.email}</span></span>
                <Badge tone={STATUS_TONE[u.status] ?? 'neutral'}>{trx(PORTAL_USER_STATUS_LABELS[u.status] ?? u.status)}</Badge>
                <span className="text-[12.5px] text-ink-400">{u.lastLoginAt ? tr('آخرین ورود {0}', formatDateTime(u.lastLoginAt)) : tr('دعوت {0}', formatDate(u.createdAt))}</span>
                <Button size="sm" variant="ghost" onClick={() => void run(() => apiPost(`/portal-users/${u.id}/reinvite`), tr('دعوت تازه ساخته شد؛ رمز پیشین دیگر کار نمی‌کند.'))}>{tr('دعوت دوباره')}</Button>
                {u.status !== 'DISABLED' && <Button size="sm" variant="ghost" onClick={() => void run(() => apiPost(`/portal-users/${u.id}/disable`), tr('دسترسی به پورتال بسته شد.'))}>{tr('غیرفعال')}</Button>}
              </li>
            ))}
          </ul>
        )}
        {invitable.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={chosen} onChange={(e) => setContactId(e.target.value)} aria-label={tr('مخاطب برای دعوت')} className="max-w-xs">
              {invitable.map((c) => <option key={c.id} value={c.id}>{c.fullName} ({c.email})</option>)}
            </Select>
            <Button size="sm" variant="primary" disabled={!chosen} onClick={() => void run(() => apiPost('/portal-users', { contactId: chosen }), tr('دعوت‌نامه ساخته شد.'))}>{tr('دعوت به پورتال')}</Button>
          </div>
        ) : <p className="text-[12.5px] text-ink-500">{tr('برای دعوت، مخاطب باید ایمیل داشته باشد.')}</p>}
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
  // Files are document.read's (Hivamis task 6): without it, the card is not there at all.
  const { data: files } = useQuery<any[]>({ queryKey: key, queryFn: () => apiGet(`/projects/${projectId}/client-files`), enabled: can('document.read') });
  if (!files || !can('document.read')) return null;
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const toggle = async (id: string, clientVisible: boolean) => {
    try { await apiPatch(`/documents/${id}/client-visibility`, { clientVisible }); await qc.invalidateQueries({ queryKey: key }); }
    catch (e: any) { toast(e?.message ?? tr('انجام نشد.'), 'danger'); }
  };
  const add = async (file: File) => {
    const form = new FormData();
    form.append('projectId', projectId);
    form.append('file', file);
    try { await apiUpload('/documents', form); await qc.invalidateQueries({ queryKey: key }); }
    catch (e: any) { toast(e?.message ?? tr('بارگذاری ناموفق بود.'), 'danger'); }
  };
  return (
    <Card title={tr('فایل‌های پروژه')} subtitle={tr('هر فایل تا وقتی کسی از اکانت آن را «نمایش در پورتال» نکند، از دید مشتری پنهان است؛ نسخهٔ تازهٔ یک فایل هم تا نمایش داده نشود، مشتری همان نسخهٔ پیشین را می‌بیند.')}
      action={can('document.write') ? <span className="flex items-center gap-2">
        <input ref={input} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void add(f); e.target.value = ''; }} />
        <ImageMaker projectId={projectId} onDone={refresh} />
        <Button size="sm" variant="secondary" onClick={() => input.current?.click()}>{tr('بارگذاری')}</Button>
      </span> : undefined}>
      {!files.length ? <EmptyState title={tr('فایلی برای این پروژه نیست')} /> : (
        <ul className="divide-y divide-ink-100 px-4 text-sm" data-testid="client-files">
          {files.map((f) => (
            // Keyed by the file, not the version, so a history opened on it survives a new version.
            <li key={f.lineageId ?? f.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5"><span className="truncate">{f.fileName}</span><VersionBadge version={f.version} />{f.deliverable && <span className="text-xs text-ink-400"> — {f.deliverable.name}</span>}</span>
                {metadataFa(f.metadata) && <span className="block text-[12.5px] text-ink-500">{metadataFa(f.metadata)}</span>}
              </span>
              <span className="text-[12.5px] text-ink-400">{localDigits(Math.ceil(f.sizeBytes / 1024))} KB · {formatDate(f.createdAt)}</span>
              <Button size="sm" variant="ghost" onClick={() => void downloadFile(`/documents/${f.id}/download`, f.fileName)}>{tr('دریافت')}</Button>
              {f.version > 1 && <VersionsButton documentId={f.id} version={f.version} onChanged={refresh} />}
              <NewVersionButton documentId={f.id} onDone={refresh} />
              {can('portal.manage') ? (
                <label className="flex items-center gap-1 text-xs text-ink-600">
                  <input type="checkbox" checked={f.clientVisible} onChange={(e) => void toggle(f.id, e.target.checked)} aria-label={tr('نمایش {0} در پورتال', f.fileName)} />{' '}{tr('نمایش در پورتال')}</label>
              ) : f.clientVisible && <Badge tone="info">{tr('در پورتال')}</Badge>}
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
    catch (e: any) { toast(e?.message ?? tr('فرستادن ناموفق بود.'), 'danger'); }
  };
  return (
    <Card title={tr('گفت‌وگو با مشتری')} subtitle={data.portalUsers ? tr('{0} نفر از مشتری در پورتال این گفت‌وگو را می‌بینند.', localDigits(data.portalUsers)) : tr('هنوز کسی از این مشتری حساب پورتال فعال ندارد.')}>
      <div className="space-y-2 px-4 py-3" data-testid="portal-thread">
        {!data.messages.length && <p className="text-xs text-ink-500">{tr('پیامی نیست.')}</p>}
        {data.messages.map((m) => (
          <div key={m.id} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.fromClient ? 'bg-brand-50' : 'ms-auto bg-ink-50'}`}>
            <p className="whitespace-pre-line">{m.body}</p>
            <p className="mt-1 text-[12px] text-ink-500">{m.fromClient ? tr('مشتری — {0}', m.author) : m.author} · {formatDateTime(m.createdAt)}</p>
          </div>
        ))}
        {can('portal.manage') && (
          <div className="pt-2">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label={tr('پاسخ به مشتری')} placeholder={tr('پاسخ به مشتری…')} />
            <WriteAssist value={text} onUse={setText} kind="email" />
            <div><Button size="sm" variant="primary" className="mt-2" disabled={!text.trim()} onClick={() => void send()}>{tr('فرستادن')}</Button></div>
          </div>
        )}
      </div>
    </Card>
  );
}
