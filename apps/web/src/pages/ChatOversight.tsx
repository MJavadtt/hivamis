import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { OVERSIGHT_NOTICE } from '@hiva/contracts';
import { apiGet, apiPost, postDownload } from '../lib/api';
import { formatDateTime, formatRelative, localDigits } from '../lib/format';
import type { MessageView } from '../lib/teamChat';
import { PageBody, PageHeader } from '../components/Shell';
import { Badge, Button, Card, ErrorBlock, Field, IconFile, Input, LoadingBlock, Modal, Textarea, useToast } from '../components/ui';
import { isEnglish, tr } from '../i18n';

/**
 * Reviewing conversations (audit F-5), for whoever the system administrator gave `chat.oversight`.
 * Read-only. Every search and every look is recorded — who, which, when, and for a look, why — and
 * the record cannot be deleted; the page says so before anything is opened, and after.
 */

interface Row { id: string; kind: 'DIRECT' | 'GROUP' | 'CHANNEL'; title: string | null; lastMessageAt: string | null; archived: boolean; messageCount: number; members: { id: string; fullName: string }[] }
type Reviewed = MessageView & { deletedAt: string | null; edits: { body: string; editedAt: string }[] };
interface View {
  conversation: { id: string; kind: Row['kind']; title: string | null; topic: string | null; members: { id: string; fullName: string; role: string; joinedAt: string; leftAt: string | null }[] };
  items: Reviewed[];
  hasMore: boolean;
}

const KIND = { DIRECT: () => tr('دونفره'), GROUP: () => tr('گروه'), CHANNEL: () => tr('کانال') } as const;
const nameOf = (r: Pick<Row, 'kind' | 'title' | 'members'>) => (r.kind === 'DIRECT' || !r.title ? r.members.map((m) => m.fullName).join(tr('، ')) : r.title);

export default function ChatOversight() {
  const toast = useToast();
  const [term, setTerm] = useState('');
  const [q, setQ] = useState('');
  const [asking, setAsking] = useState<Row | null>(null);
  const [reason, setReason] = useState('');
  const [view, setView] = useState<{ row: Row; reason: string; data: View } | null>(null);
  const [busy, setBusy] = useState(false);
  // Each search is itself recorded: asked for, not re-asked when the window regains focus.
  const list = useQuery<Row[]>({
    queryKey: ['/chat/oversight/conversations', q], queryFn: () => apiGet('/chat/oversight/conversations', { q: q || undefined }),
    staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });

  const open = async (row: Row, why: string, before?: string) => {
    setBusy(true);
    try {
      const data = await apiPost<View>(`/chat/oversight/conversations/${row.id}/view`, { reason: why, ...(before ? { before } : {}) });
      setView((v) => (before && v ? { ...v, data: { ...data, items: [...data.items, ...v.data.items] } } : { row, reason: why, data }));
      setAsking(null);
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader title={tr('بازبینی گفت‌وگوها')} subtitle={tr('فقط خواندنی. هر جستجو و هر بازبینی با نام شما و زمانش ثبت می‌شود؛ بازبینی دلیل هم می‌خواهد. این ثبت‌ها پاک‌شدنی نیستند.')}
        actions={<Link to="/chat" className="text-sm text-brand-700 underline">{tr('بازگشت به گفت‌وگو')}</Link>} />
      <PageBody className="space-y-4">
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-900 ring-1 ring-inset ring-amber-200" data-testid="oversight-notice">
          {tr('آنچه همه می‌دانند:')} {isEnglish() ? OVERSIGHT_NOTICE.en : OVERSIGHT_NOTICE.fa}
        </p>
        {view ? (
          <Transcript view={view} busy={busy} onBack={() => setView(null)} onOlder={() => void open(view.row, view.reason, view.data.items[0]?.createdAt)} />
        ) : (
          <Card title={tr('گفت‌وگوهای سازمان')} subtitle={tr('چه کسانی و کِی — نه آنچه گفته‌اند، تا با دلیل باز شود.')}>
            <form className="flex gap-2 px-4 pt-3" onSubmit={(e) => { e.preventDefault(); setQ(term.trim()); }}>
              <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder={tr('نام گفت‌وگو یا همکار')} aria-label={tr('جستجو')} />
              <Button type="submit">{tr('جستجو')}</Button>
            </form>
            {list.isLoading ? <LoadingBlock /> : list.error ? <div className="p-4"><ErrorBlock error={list.error} /></div> : !list.data?.length ? (
              <p className="px-4 py-6 text-sm text-ink-500">{tr('گفت‌وگویی پیدا نشد.')}</p>
            ) : (
              <ul className="divide-y divide-ink-100" data-testid="oversight-list">
                {list.data.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink-800">{nameOf(r)}</span>
                      <span className="block text-xs text-ink-500">
                        {KIND[r.kind]()} · {tr('{0} پیام', localDigits(r.messageCount))} · {tr('{0} عضو', localDigits(r.members.length))}
                        {r.lastMessageAt && <> · {formatRelative(r.lastMessageAt)}</>}
                        {r.archived && <Badge className="ms-2">{tr('بایگانی')}</Badge>}
                      </span>
                    </span>
                    <Button size="sm" onClick={() => { setAsking(r); setReason(''); }}>{tr('بازبینی…')}</Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </PageBody>
      {asking && (
        <Modal open onClose={() => setAsking(null)} title={tr('چرا این گفت‌وگو را می‌خوانید؟')}
          footer={<><Button variant="ghost" onClick={() => setAsking(null)}>{tr('انصراف')}</Button><Button variant="primary" loading={busy} disabled={reason.trim().length < 10} onClick={() => void open(asking, reason.trim())}>{tr('ثبت دلیل و خواندن')}</Button></>}>
          <div className="space-y-3">
            <p className="text-sm text-ink-700">{nameOf(asking)}</p>
            <Field label={tr('دلیل')} required hint={tr('دلیلی که دیگری بتواند بخواند و بسنجد — مثلاً شمارهٔ شکایت یا درخواست حقوقی. با نام شما و زمان، برای همیشه ثبت می‌شود.')}>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} />
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}

function Transcript({ view, busy, onBack, onOlder }: { view: { row: Row; reason: string; data: View }; busy: boolean; onBack: () => void; onOlder: () => void }) {
  const toast = useToast();
  const c = view.data.conversation;
  const file = (a: MessageView['attachments'][number]) =>
    void postDownload(`/chat/oversight/files/${a.id}`, { reason: view.reason }, a.fileName).catch((e) => toast((e as Error).message, 'danger'));
  return (
    <Card title={nameOf({ kind: c.kind, title: c.title, members: c.members })} subtitle={c.members.map((m) => m.fullName + (m.leftAt ? ` (${tr('رفته')})` : '')).join(tr('، '))}
      action={<Button size="sm" variant="ghost" onClick={onBack}>{tr('بازگشت به فهرست')}</Button>}>
      <p className="mx-4 mt-3 rounded-lg bg-brand-50 px-3 py-2 text-xs leading-6 text-brand-900" role="status" data-testid="oversight-recorded">
        {tr('این بازبینی با نام شما، زمان و دلیل «{0}» در سابقهٔ حسابرسی ثبت شد و پاک‌شدنی نیست.', view.reason)}
      </p>
      <div className="space-y-3 px-4 py-3" data-testid="oversight-transcript">
        {view.data.hasMore && <div className="text-center"><Button size="sm" variant="ghost" loading={busy} onClick={onOlder}>{tr('پیام‌های قدیمی‌تر (با همان دلیل، ثبت دوباره)')}</Button></div>}
        {!view.data.items.length && <p className="text-sm text-ink-500">{tr('پیامی در این گفت‌وگو نیست.')}</p>}
        {view.data.items.map((m) => (
          <article key={m.id} className="rounded-lg px-3 py-2 ring-1 ring-inset ring-ink-200">
            <p className="flex flex-wrap items-baseline gap-2 text-xs text-ink-500">
              <span className="text-sm font-semibold text-ink-900">{m.author.fullName}</span>
              <time dateTime={m.createdAt}>{formatDateTime(m.createdAt)}</time>
              {m.deletedAt && <Badge tone="danger">{tr('برداشته‌شده در {0}', formatDateTime(m.deletedAt))}</Badge>}
              {m.editedAt && <Badge tone="warning">{tr('ویرایش‌شده')}</Badge>}
            </p>
            {m.replyTo && <p className="mt-1 border-s-2 border-ink-300 ps-2 text-xs text-ink-500">{m.replyTo.authorName}: {m.replyTo.body}</p>}
            {m.body && <p dir="auto" className="mt-1 whitespace-pre-wrap break-words text-sm leading-7 text-ink-800">{m.body}</p>}
            {m.edits.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs text-ink-500">
                {m.edits.map((e, i) => <li key={i} dir="auto">{tr('پیش از ویرایش ({0}):', formatDateTime(e.editedAt))} {e.body}</li>)}
              </ul>
            )}
            {m.attachments.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-2">
                {m.attachments.map((a) => (
                  <button key={a.id} type="button" onClick={() => file(a)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50" title={tr('باز کردن فایل هم با همین دلیل ثبت می‌شود')}>
                    <IconFile className="size-4 text-ink-400" /><span dir="auto">{a.fileName}</span>
                  </button>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    </Card>
  );
}
