import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost } from '../lib/api';
import { Badge, Button, Card, Input, Modal, useToast } from './ui';
import { formatDateTime, localDigits } from '../lib/format';
import { tr } from '../i18n';

/* Roadmap #40 — notifications and approvals in the messenger. */

const MODE_FA: Record<string, string> = {
  sandbox: tr('گفت‌وگوی آزمایشی درون هیوامیس — به پیام‌رسانی وصل نیست'),
  bale: tr('ربات بله'), telegram: tr('ربات تلگرام'), off: tr('خاموش'),
};

interface Status { mode: string; linked: boolean; link: { username: string | null; linkedAt: string } | null; bot: string | null; miniAppSignIn?: boolean }
interface Chat { id: string; direction: 'IN' | 'OUT'; text: string; buttons: { text: string; action?: string; url?: string }[][] | null; at: string }

/** The sidebar entry: opens the person's own messenger settings. */
export function MessengerMenuItem() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className="mb-1 block w-full rounded-md px-2 py-1.5 text-start text-xs text-ink-600 hover:bg-ink-50 hover:text-ink-800">{tr('پیام‌رسان')}</button>
      {open && <MessengerModal onClose={() => setOpen(false)} />}
    </>
  );
}

export function MessengerModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: s } = useQuery<Status>({ queryKey: ['/messenger/me'], queryFn: () => apiGet('/messenger/me') });
  const [code, setCode] = useState<{ code: string; expiresAt: string; deepLink: string | null; bot: string | null } | null>(null);
  if (!s) return null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['/messenger/me'] });
  const link = async () => {
    try { setCode(await apiPost('/messenger/link')); } catch (e: any) { toast(e?.message ?? tr('انجام نشد.'), 'danger'); }
  };
  const unlink = async () => {
    try { await apiDelete('/messenger/link'); setCode(null); toast(tr('پیام‌رسان جدا شد.')); await refresh(); } catch (e: any) { toast(e?.message ?? tr('انجام نشد.'), 'danger'); }
  };
  return (
    <Modal open wide title={tr('پیام‌رسان')} onClose={onClose} footer={<Button variant="ghost" onClick={onClose}>{tr('بستن')}</Button>}>
      <div className="space-y-4" data-testid="messenger">
        <p className="text-xs text-ink-500">{MODE_FA[s.mode] ?? s.mode}</p>
        {s.mode === 'off' ? <p className="text-sm text-ink-700">{tr('پیام‌رسان در این نصب خاموش است؛ اعلان‌ها در سامانه و ایمیل می‌رسند.')}</p> : (
          <>
            <p className="text-sm text-ink-700">{tr('اعلان‌های مهم — نقض یا نزدیک‌شدن مهلت SLA، درخواست تأیید فرم، پیام مشتری، امضای قرارداد — به پیام‌رسان شما هم می‌رسد، و درخواست تأیید فرم را همان‌جا با «تأیید» یا «رد» تصمیم می‌گیرید؛ همان قاعده‌ها و همان ثبت حسابرسی که در سامانه.')}</p>
            {s.linked ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900" data-testid="messenger-linked">
                <span className="flex-1">{tr('وصل است')}{s.link?.username ? <> — <span className="ltr">@{s.link.username}</span></> : ''} · {formatDateTime(s.link?.linkedAt)}</span>
                <Button size="sm" variant="ghost" onClick={() => void unlink()}>{tr('جدا کردن')}</Button>
                {s.miniAppSignIn && <p className="basis-full text-[12.5px]" data-testid="messenger-mini-app">{tr('برنامهٔ هیوامیس درون تلگرام هم با همین حساب باز می‌شود.')}</p>}
              </div>
            ) : code ? (
              <div className="space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="messenger-code">
                <p>{s.mode === 'sandbox' ? tr('این کد را در گفت‌وگوی آزمایشی زیر بفرستید:') : <>{tr('این کد را برای ربات')}{' '}{code.bot ? <span className="ltr">@{code.bot}</span> : tr('سازمان')}{' '}{tr('بفرستید:')}</>}</p>
                <p className="ltr text-center text-xl font-semibold tracking-widest whitespace-nowrap">{code.code}</p>
                {code.deepLink && <p><a href={code.deepLink} target="_blank" rel="noreferrer" className="text-brand-700 underline">{tr('باز کردن ربات')}</a></p>}
                <p className="text-[12.5px]">{tr('تا {0} معتبر است و فقط یک بار.', formatDateTime(code.expiresAt))}</p>
              </div>
            ) : <Button variant="primary" onClick={() => void link()}>{tr('اتصال پیام‌رسان')}</Button>}
            {s.mode === 'sandbox' && <SandboxChat onLinked={() => void refresh()} />}
          </>
        )}
      </div>
    </Modal>
  );
}

/** The stand-in chat: what the bot would have said to you, with its buttons, and what you say back. */
function SandboxChat({ onLinked }: { onLinked: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const { data: chat } = useQuery<Chat[]>({ queryKey: ['/messenger/sandbox/chat'], queryFn: () => apiGet('/messenger/sandbox/chat'), refetchInterval: 5000 });
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [chat?.length]);
  const after = async () => { await qc.invalidateQueries({ queryKey: ['/messenger/sandbox/chat'] }); onLinked(); };
  const send = async () => {
    try { await apiPost('/messenger/sandbox/send', { text }); setText(''); await after(); } catch (e: any) { toast(e?.message ?? tr('انجام نشد.'), 'danger'); }
  };
  const press = async (action: string) => {
    try { const r = await apiPost<{ answer?: string }>('/messenger/sandbox/press', { action }); if (r.answer) toast(r.answer); await after(); await qc.invalidateQueries(); }
    catch (e: any) { toast(e?.message ?? tr('انجام نشد.'), 'danger'); }
  };
  return (
    <div className="rounded-lg border border-ink-200" data-testid="sandbox-chat">
      <p className="border-b border-ink-100 px-3 py-1.5 text-[12.5px] text-ink-500">{tr('گفت‌وگوی آزمایشی با ربات هیوامیس')}</p>
      <div className="max-h-80 space-y-2 overflow-y-auto px-3 py-2">
        {!chat?.length && <p className="text-xs text-ink-400">{tr('هنوز پیامی نیست.')}</p>}
        {chat?.map((m) => (
          <div key={m.id} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.direction === 'IN' ? 'ms-auto bg-brand-50' : 'bg-ink-50'}`}>
            <p className="whitespace-pre-line">{m.text}</p>
            {m.buttons?.map((row, i) => (
              <div key={i} className="mt-1.5 flex gap-1.5">
                {row.map((b) => b.url
                  ? <a key={b.text} href={b.url} className="flex-1 rounded border border-ink-200 px-2 py-1 text-center text-xs text-brand-700">{b.text}</a>
                  : <button key={b.text} onClick={() => void press(b.action!)} className="flex-1 rounded border border-ink-200 bg-surface px-2 py-1 text-xs">{b.text}</button>)}
              </div>
            ))}
            <p className="mt-1 text-[12px] text-ink-400">{formatDateTime(m.at)}</p>
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="flex gap-2 border-t border-ink-100 p-2">
        <Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) void send(); }} placeholder={tr('پیام…')} aria-label={tr('پیام به ربات')} />
        <Button size="sm" variant="primary" disabled={!text.trim()} onClick={() => void send()}>{tr('فرستادن')}</Button>
      </div>
    </div>
  );
}

/** Administration: which messenger, how many people are linked, and setting the bot's webhook. */
export function MessengerAdmin() {
  const toast = useToast();
  const { data } = useQuery<any>({ queryKey: ['/admin/messenger'], queryFn: () => apiGet('/admin/messenger') });
  if (!data) return null;
  const register = async () => {
    try { await apiPost('/admin/messenger/webhook'); toast(tr('وب‌هوک ربات ثبت شد.')); } catch (e: any) { toast(e?.message ?? tr('انجام نشد.'), 'danger'); }
  };
  return (
    <Card title={tr('پیام‌رسان')} subtitle={tr('اعلان‌های مهم و تصمیم درخواست‌های تأیید از داخل پیام‌رسان.')}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm" data-testid="messenger-admin">
        <Badge tone={data.mode === 'off' ? 'neutral' : data.configured ? 'success' : 'warning'}>{MODE_FA[data.mode] ?? data.mode}</Badge>
        {data.bot && <span className="ltr text-xs text-ink-500">@{data.bot}</span>}
        <span className="text-xs text-ink-600">{tr('{0} نفر وصل · ۲۴ ساعت گذشته: {1} پیام، {2} ناموفق · در صف {3}', localDigits(data.linked), localDigits(data.last24h.sent), localDigits(data.last24h.failed), localDigits(data.queued))}</span>
        {['bale', 'telegram'].includes(data.mode) && data.transport !== 'polling' && (
          <Button size="sm" variant="secondary" className="ms-auto" disabled={!data.configured || !data.webhookSecretSet} onClick={() => void register()}>{tr('ثبت وب‌هوک ربات')}</Button>
        )}
      </div>
      {data.transport === 'polling' && data.polling && (
        <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-600" data-testid="messenger-polling">
          {tr('ربات پیام‌ها را خودش می‌گیرد (polling)؛ وب‌هوک لازم نیست.')}{' '}
          {data.polling.stalled
            ? <Badge tone="danger">{tr('خاموش مانده')}</Badge>
            : <Badge tone="success">{tr('در حال گوش دادن')}</Badge>}{' '}
          {data.polling.lastPollAt ? tr('آخرین دریافت {0}', formatDateTime(data.polling.lastPollAt)) : tr('هنوز دریافتی نبوده است')}
          {data.polling.lastError && <span className="ltr ms-2 text-rose-700">{data.polling.lastError}</span>}
        </p>
      )}
    </Card>
  );
}
