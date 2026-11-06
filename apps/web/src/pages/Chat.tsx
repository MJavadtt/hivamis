import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CHAT_ATTACHMENTS_MAX, OVERSIGHT_NOTICE, isViewableImage, type ChatNotify } from '@hiva/contracts';
import { apiBlob, apiDelete, apiGet, apiPatch, apiPost, apiUpload, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, formatRelative, localDigits } from '../lib/format';
import {
  initial, pieces, type ConversationDetail, type ConversationSummary, type MessagePage, type MessageView, type RecordRef,
} from '../lib/teamChat';
import {
  Badge, Button, EmptyState, ErrorBlock, Field, IconArrow, IconClose, IconFile, IconPlus, IconSearch, IconSettings, IconUsers,
  Input, LoadingBlock, Modal, Select, Spinner, Tabs, Textarea, cx, useToast,
} from '../components/ui';
import { isEnglish, tr } from '../i18n';
import { Avatar } from '../components/Avatar';

/**
 * Team chat (audit F-5): conversations on the left, the one open on the right — on a phone, one or
 * the other. New messages arrive over the live stream; the conversation is marked read while it is
 * on screen. What everyone is told about oversight stands under the list, in the owner's words.
 */

const KIND_LABEL = { DIRECT: () => tr('دونفره'), GROUP: () => tr('گروه'), CHANNEL: () => tr('کانال') } as const;
const NOTIFY_LABEL: Record<ChatNotify, () => string> = {
  ALL: () => tr('همهٔ پیام‌ها'), MENTIONS: () => tr('فقط وقتی نامم برده شود'), NONE: () => tr('هیچ‌کدام'),
};
const notice = () => (isEnglish() ? OVERSIGHT_NOTICE.en : OVERSIGHT_NOTICE.fa);

/** A person's photo (audit F-6), or a conversation's first letter. */
function Mark({ name, src, className }: { name: string; src?: string | null; className?: string }) {
  if (src) return <Avatar name={name} src={src} className={cx('size-9', className)} />;
  return <span aria-hidden className={cx('grid size-9 shrink-0 place-items-center rounded-full bg-brand-100 text-sm font-semibold text-brand-800', className)}>{initial(name)}</span>;
}

export default function Chat() {
  const { id } = useParams();
  return (
    <div className="flex h-[calc(100dvh-4.5rem)] min-h-[26rem] gap-0 px-3 py-3 sm:px-5 lg:h-[calc(100dvh-6.5rem)] lg:gap-4 lg:px-0 lg:py-0" data-testid="chat">
      <section className={cx('bg-panel w-full flex-col overflow-hidden rounded-xl ring-1 ring-edge lg:flex lg:w-80 lg:shrink-0', id ? 'hidden' : 'flex')} aria-label={tr('گفت‌وگوها')}>
        <ConversationList activeId={id} />
      </section>
      <section className={cx('bg-panel min-w-0 flex-1 flex-col overflow-hidden rounded-xl ring-1 ring-edge', id ? 'flex' : 'hidden lg:flex')}>
        {id ? <Conversation key={id} id={id} /> : (
          <div className="grid flex-1 place-items-center p-6">
            <EmptyState title={tr('گفت‌وگویی را باز کنید')} description={tr('یا با «گفت‌وگوی تازه» با همکاری صحبت کنید.')} />
          </div>
        )}
      </section>
    </div>
  );
}

/* ── The list ─────────────────────────────────────────────────────────────────────────────── */

function ConversationList({ activeId }: { activeId?: string }) {
  const { can } = useAuth();
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState('');
  const [making, setMaking] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const { data, isLoading, error, refetch } = useQuery<ConversationSummary[]>({
    queryKey: ['/chat/conversations', archived], queryFn: () => apiGet('/chat/conversations', { archived: archived ? 'true' : undefined }),
  });
  const shown = useMemo(() => (data ?? []).filter((c) => !q.trim() || c.title.toLowerCase().includes(q.trim().toLowerCase())), [data, q]);

  return (
    <>
      <header className="space-y-2 border-b border-ink-200/70 p-3">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-base font-bold text-ink-900">{tr('گفت‌وگو')}</h1>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setBrowsing(true)}>{tr('کانال‌ها')}</Button>
            <Button size="sm" variant="primary" onClick={() => setMaking(true)}><IconPlus className="size-4" />{tr('گفت‌وگوی تازه')}</Button>
          </div>
        </div>
        <div className="relative">
          <IconSearch className="pointer-events-none absolute start-2.5 top-2.5 size-4 text-ink-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('جستجو در گفت‌وگوها')} aria-label={tr('جستجو در گفت‌وگوها')} className="ps-8" />
        </div>
      </header>
      <div className="flex-1 overflow-y-auto">
        {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={refetch} /> : !shown.length ? (
          <p className="px-4 py-8 text-center text-sm text-ink-500">{archived ? tr('گفت‌وگوی بایگانی‌شده‌ای نیست.') : tr('هنوز گفت‌وگویی ندارید.')}</p>
        ) : (
          <ul data-testid="chat-list">
            {shown.map((c) => (
              <li key={c.id}>
                <Link to={`/chat/${c.id}`} aria-current={c.id === activeId ? 'page' : undefined}
                  className={cx('flex items-start gap-3 border-b border-ink-100 px-3 py-2.5 hover:bg-ink-50', c.id === activeId && 'bg-brand-50')}>
                  <Mark name={c.title} src={c.peer?.avatarUrl} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className={cx('truncate text-sm', c.unread ? 'font-bold text-ink-900' : 'font-medium text-ink-800')}>{c.title}</span>
                      {c.lastMessage && <span className="shrink-0 text-[12px] text-ink-400">{formatRelative(c.lastMessage.at)}</span>}
                    </span>
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-ink-500">
                        {c.kind !== 'DIRECT' && <span className="text-ink-400">{KIND_LABEL[c.kind]()} · </span>}
                        {c.lastMessage ? `${c.lastMessage.authorName}: ${c.lastMessage.body || tr('فایل')}` : tr('بدون پیام')}
                      </span>
                      {c.unread > 0 && (
                        <span className={cx('min-w-5 shrink-0 rounded-full px-1.5 text-center text-[12px] font-semibold', c.muted ? 'bg-ink-200 text-ink-600' : 'bg-rose-600 text-white')}>
                          {localDigits(c.unread)}
                        </span>
                      )}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <footer className="space-y-2 border-t border-ink-200/70 p-3 text-[12.5px] leading-5 text-ink-500">
        <button type="button" className="text-brand-700 underline" onClick={() => setArchived((a) => !a)}>
          {archived ? tr('گفت‌وگوهای جاری') : tr('بایگانی‌شده‌ها')}
        </button>
        {can('chat.oversight') && <Link to="/chat/oversight" className="ms-3 text-brand-700 underline">{tr('بازبینی گفت‌وگوها')}</Link>}
        {/* The owner's words, for everyone who chats (the fix prompt's ⛔ ASK, answered 2026-10-14). */}
        <p data-testid="oversight-notice">{notice()}</p>
      </footer>
      {making && <NewConversation onClose={() => setMaking(false)} />}
      {browsing && <Channels onClose={() => setBrowsing(false)} />}
    </>
  );
}

/* ── One conversation ─────────────────────────────────────────────────────────────────────── */

function Conversation({ id }: { id: string }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const detail = useQuery<ConversationDetail>({ queryKey: ['/chat/conversations', id, 'detail'], queryFn: () => apiGet(`/chat/conversations/${id}`) });
  const latest = useQuery<MessagePage>({ queryKey: ['/chat/conversations', id, 'messages'], queryFn: () => apiGet(`/chat/conversations/${id}/messages`) });
  const [older, setOlder] = useState<MessagePage | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [replyTo, setReplyTo] = useState<MessageView | null>(null);
  const [members, setMembers] = useState(false);
  const [settings, setSettings] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const seen = new Set<string>();
    return [...(older?.items ?? []), ...(latest.data?.items ?? [])].filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  }, [older, latest.data]);
  const records = { ...older?.records, ...latest.data?.records } as Record<string, RecordRef>;
  const names = useMemo(() => (detail.data?.members ?? []).map((m) => m.fullName), [detail.data]);
  const lastId = latest.data?.items.at(-1)?.id;

  // Read while on screen: when it opens, and as messages arrive.
  useEffect(() => {
    if (!lastId || document.visibilityState === 'hidden') return;
    void apiPost(`/chat/conversations/${id}/read`).then(() => {
      void qc.invalidateQueries({ queryKey: ['/chat/unread'] });
      void qc.invalidateQueries({ queryKey: ['/chat/conversations', false] });
    }).catch(() => undefined);
  }, [id, lastId, qc]);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [lastId]);

  const loadOlder = async () => {
    const first = items[0];
    if (!first) return;
    setLoadingOlder(true);
    try {
      const page = await apiGet<MessagePage>(`/chat/conversations/${id}/messages`, { before: first.createdAt });
      setOlder((o) => ({ items: [...page.items, ...(o?.items ?? [])], hasMore: page.hasMore, records: { ...o?.records, ...page.records } }));
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setLoadingOlder(false); }
  };
  const hasMore = older ? older.hasMore : latest.data?.hasMore;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['/chat/conversations', id] }); void qc.invalidateQueries({ queryKey: ['/chat/conversations', false] }); };

  if (detail.isLoading) return <LoadingBlock />;
  if (detail.error || !detail.data) return <div className="p-4"><ErrorBlock error={detail.error} onRetry={detail.refetch} /></div>;
  const c = detail.data;
  const manager = c.me.role === 'OWNER' || c.me.role === 'ADMIN';

  return (
    <>
      <header className="flex items-center gap-2 border-b border-ink-200/70 px-3 py-2.5">
        <Link to="/chat" className="rounded p-1 text-ink-500 hover:bg-ink-100 lg:hidden" aria-label={tr('بازگشت به گفت‌وگوها')}>
          <IconArrow className="size-5 rtl:rotate-180" />
        </Link>
        <Mark name={c.title} src={c.kind === 'DIRECT' ? c.members.find((m) => m.id !== user?.id)?.avatarUrl : null} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-bold text-ink-900">{c.title}</h2>
          <p className="truncate text-xs text-ink-500">
            {c.kind === 'DIRECT' ? (c.members.find((m) => m.id !== user?.id)?.jobTitle ?? tr('گفت‌وگوی دونفره'))
              : [KIND_LABEL[c.kind](), tr('{0} عضو', localDigits(c.members.length)), c.topic].filter(Boolean).join(' · ')}
            {c.me.muted && <Badge className="ms-2">{tr('بی‌صدا')}</Badge>}
          </p>
        </div>
        {c.kind !== 'DIRECT' && (
          <button type="button" onClick={() => setMembers(true)} className="rounded p-1.5 text-ink-500 hover:bg-ink-100" aria-label={tr('اعضا')} title={tr('اعضا')}>
            <IconUsers className="size-5" />
          </button>
        )}
        <button type="button" onClick={() => setSettings(true)} className="rounded p-1.5 text-ink-500 hover:bg-ink-100" aria-label={tr('تنظیمات گفت‌وگو')} title={tr('تنظیمات گفت‌وگو')}>
          <IconSettings className="size-5" />
        </button>
      </header>

      <div className="flex-1 space-y-1 overflow-y-auto px-3 py-3" aria-live="polite" data-testid="chat-messages">
        {hasMore && (
          <div className="pb-2 text-center">
            <Button size="sm" variant="ghost" loading={loadingOlder} onClick={() => void loadOlder()}>{tr('پیام‌های قدیمی‌تر')}</Button>
          </div>
        )}
        {latest.isLoading ? <LoadingBlock /> : latest.error ? <ErrorBlock error={latest.error} onRetry={latest.refetch} /> : !items.length ? (
          <p className="py-10 text-center text-sm text-ink-500">{tr('هنوز پیامی نیست. اولین پیام را بنویسید.')}</p>
        ) : items.map((m, i) => (
          <Message key={m.id} m={m} records={records} names={names} mine={m.author.id === user?.id} canModerate={manager && c.kind !== 'DIRECT'}
            grouped={i > 0 && items[i - 1]!.author.id === m.author.id && Date.parse(m.createdAt) - Date.parse(items[i - 1]!.createdAt) < 5 * 60_000}
            onReply={() => setReplyTo(m)} onChanged={() => void latest.refetch()} />
        ))}
        <div ref={end} />
      </div>

      {c.archived ? (
        <p className="border-t border-ink-200/70 p-3 text-center text-xs text-ink-500">{tr('این گفت‌وگو بایگانی شده است.')}</p>
      ) : (
        <Composer id={id} members={c.members.filter((m) => m.id !== user?.id)} replyTo={replyTo} onReplyDone={() => setReplyTo(null)}
          onSent={() => { void latest.refetch(); void qc.invalidateQueries({ queryKey: ['/chat/conversations', false] }); }} />
      )}

      {members && <Members c={c} manager={manager} onClose={() => setMembers(false)} onChanged={refresh} />}
      {settings && <Settings c={c} manager={manager} onClose={() => setSettings(false)} onChanged={refresh} onLeft={() => { refresh(); navigate('/chat'); }} />}
    </>
  );
}

function Body({ text, records, names }: { text: string; records: Record<string, RecordRef>; names: string[] }) {
  return (
    <p dir="auto" className="whitespace-pre-wrap break-words text-sm leading-7 text-ink-800">
      {pieces(text, records, names).map((p, i) => p.kind === 'record'
        ? <Link key={i} to={p.path} title={p.title} className="ltr font-mono text-[13px] text-brand-700 underline">{p.text}</Link>
        : p.kind === 'person' ? <strong key={i} className="font-semibold text-brand-800">{p.text}</strong>
        : <span key={i}>{p.text}</span>)}
    </p>
  );
}

function Message({ m, records, names, mine, canModerate, grouped, onReply, onChanged }: {
  m: MessageView; records: Record<string, RecordRef>; names: string[]; mine: boolean; canModerate: boolean; grouped: boolean;
  onReply: () => void; onChanged: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.body);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try { await apiPatch(`/chat/messages/${m.id}`, { body: draft }); setEditing(false); onChanged(); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm(tr('این پیام از گفت‌وگو برداشته شود؟'))) return;
    try { await apiDelete(`/chat/messages/${m.id}`); onChanged(); } catch (e) { toast((e as Error).message, 'danger'); }
  };

  return (
    // Focusable, so a tap on a phone — where nothing hovers — brings up its actions.
    <article tabIndex={0} className={cx('group relative flex gap-2.5 rounded-lg px-1.5 py-1 outline-none hover:bg-ink-50/70 focus-within:bg-ink-50/70', !grouped && 'mt-2')} data-testid="chat-message">
      {grouped ? <span className="w-9 shrink-0" /> : <Mark name={m.author.fullName} src={m.author.avatarUrl} />}
      <div className="min-w-0 flex-1">
        {!grouped && (
          <p className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-ink-900">{m.author.fullName}</span>
            <time className="text-[12px] text-ink-400" dateTime={m.createdAt}>{formatDateTime(m.createdAt)}</time>
          </p>
        )}
        {m.replyTo && (
          <p className="mb-1 border-s-2 border-brand-300 ps-2 text-xs text-ink-500">
            <span className="font-medium">{m.replyTo.authorName}</span>: {m.replyTo.body || tr('پیامی که برداشته شد')}
          </p>
        )}
        {m.deleted ? <p className="text-sm italic text-ink-400">{tr('این پیام برداشته شد.')}</p>
          : editing ? (
            <div className="space-y-1.5">
              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} dir="auto" aria-label={tr('ویرایش پیام')} />
              <div className="flex gap-1.5">
                <Button size="sm" variant="primary" loading={busy} disabled={!draft.trim()} onClick={() => void save()}>{tr('ذخیره')}</Button>
                <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraft(m.body); }}>{tr('انصراف')}</Button>
              </div>
            </div>
          ) : m.body ? <Body text={m.body} records={records} names={names} /> : null}
        {!m.deleted && m.attachments.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-2">{m.attachments.map((a) => <Attachment key={a.id} a={a} />)}</div>
        )}
        {m.editedAt && !m.deleted && <p className="text-[12px] text-ink-400">{tr('ویرایش‌شده')}</p>}
      </div>
      {!m.deleted && !editing && (
        // Over the message's corner, not beside it: on a phone a column of buttons would halve the text.
        <div className="bg-panel pointer-events-none absolute -top-3 end-2 flex gap-0.5 rounded-lg px-0.5 opacity-0 shadow ring-1 ring-edge transition group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
          <button type="button" className="rounded px-1.5 py-0.5 text-[12px] text-ink-500 hover:bg-ink-100" onClick={onReply}>{tr('پاسخ')}</button>
          {mine && <button type="button" className="rounded px-1.5 py-0.5 text-[12px] text-ink-500 hover:bg-ink-100" onClick={() => setEditing(true)}>{tr('ویرایش')}</button>}
          {(mine || canModerate) && <button type="button" className="rounded px-1.5 py-0.5 text-[12px] text-rose-700 hover:bg-rose-50" onClick={() => void remove()}>{tr('برداشتن')}</button>}
        </div>
      )}
    </article>
  );
}

/** A shared file: a picture shown small, anything else by its name. Both open only for members. */
function Attachment({ a }: { a: MessageView['attachments'][number] }) {
  const toast = useToast();
  const [src, setSrc] = useState<string | null>(null);
  const image = isViewableImage(a.mimeType);
  useEffect(() => {
    if (!image) return;
    let url: string | null = null;
    void apiBlob(`/chat/files/${a.id}`).then((b) => { url = URL.createObjectURL(b); setSrc(url); }).catch(() => undefined);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [a.id, image]);
  const open = () => void downloadFile(`/chat/files/${a.id}`, a.fileName).catch((e) => toast((e as Error).message, 'danger'));
  return image && src ? (
    <button type="button" onClick={open} title={a.fileName} className="overflow-hidden rounded-lg ring-1 ring-ink-200">
      <img src={src} alt={a.fileName} className="max-h-40 max-w-56 object-cover" />
    </button>
  ) : (
    <button type="button" onClick={open} className="flex items-center gap-1.5 rounded-lg bg-surface px-2.5 py-1.5 text-xs text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50">
      <IconFile className="size-4 text-ink-400" /><span dir="auto" className="max-w-48 truncate">{a.fileName}</span>
    </button>
  );
}

/* ── Writing ──────────────────────────────────────────────────────────────────────────────── */

function Composer({ id, members, replyTo, onReplyDone, onSent }: {
  id: string; members: ConversationDetail['members']; replyTo: MessageView | null; onReplyDone: () => void; onSent: () => void;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<{ id: string; fileName: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [named, setNamed] = useState<Map<string, string>>(new Map());
  const picker = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // "@" and what follows it, at the cursor: whom to name.
  const asking = /(?:^|\s)@([^\s@]{0,30})$/.exec(text.slice(0, box.current?.selectionStart ?? text.length));
  const suggestions = asking ? members.filter((m) => m.fullName.includes(asking[1]!)).slice(0, 6) : [];
  const name = (m: { id: string; fullName: string }) => {
    const at = box.current?.selectionStart ?? text.length;
    const before = text.slice(0, at).replace(/@([^\s@]{0,30})$/, `@${m.fullName} `);
    setText(before + text.slice(at));
    setNamed((n) => new Map(n).set(m.id, m.fullName));
    box.current?.focus();
  };

  const attach = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const f of [...list].slice(0, CHAT_ATTACHMENTS_MAX - files.length)) {
        const form = new FormData();
        // The conversation first: the server decides, before reading the file, whose it is.
        form.append('chatConversationId', id);
        form.append('file', f);
        const doc = await apiUpload<{ id: string; fileName: string }>('/documents', form);
        setFiles((x) => [...x, { id: doc.id, fileName: doc.fileName }]);
      }
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setUploading(false); if (picker.current) picker.current.value = ''; }
  };

  const send = async () => {
    if (sending || (!text.trim() && !files.length)) return;
    setSending(true);
    try {
      const mentionIds = [...named].filter(([, n]) => text.includes(`@${n}`)).map(([uid]) => uid);
      await apiPost(`/chat/conversations/${id}/messages`, { body: text.trim(), attachmentIds: files.map((f) => f.id), mentionIds, ...(replyTo ? { replyToId: replyTo.id } : {}) });
      setText(''); setFiles([]); setNamed(new Map()); onReplyDone(); onSent();
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setSending(false); }
  };

  return (
    <div className="relative border-t border-ink-200/70 p-3 pe-[max(0.75rem,var(--owl-reserve,0px))]">
      {suggestions.length > 0 && (
        <ul className="bg-panel absolute bottom-full start-3 z-10 mb-1 w-64 overflow-hidden rounded-lg shadow-lg ring-1 ring-edge" role="listbox" aria-label={tr('نام بردن از همکار')}>
          {suggestions.map((m) => (
            <li key={m.id}><button type="button" role="option" aria-selected={false} className="block w-full px-3 py-2 text-start text-sm hover:bg-brand-50" onMouseDown={(e) => { e.preventDefault(); name(m); }}>{m.fullName}</button></li>
          ))}
        </ul>
      )}
      {replyTo && (
        <p className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-brand-50 px-2.5 py-1.5 text-xs text-ink-700">
          <span className="truncate">{tr('پاسخ به {0}', replyTo.author.fullName)}: {replyTo.body || tr('فایل')}</span>
          <button type="button" onClick={onReplyDone} aria-label={tr('لغو پاسخ')}><IconClose className="size-4" /></button>
        </p>
      )}
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {files.map((f) => (
            <span key={f.id} className="flex items-center gap-1 rounded-full bg-ink-100 px-2.5 py-1 text-xs text-ink-700">
              <span dir="auto" className="max-w-40 truncate">{f.fileName}</span>
              <button type="button" onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))} aria-label={tr('کنار گذاشتن {0}', f.fileName)}><IconClose className="size-3.5" /></button>
            </span>
          ))}
        </div>
      )}
      <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input ref={picker} type="file" multiple hidden onChange={(e) => void attach(e.target.files)} />
        <button type="button" onClick={() => picker.current?.click()} disabled={uploading || files.length >= CHAT_ATTACHMENTS_MAX}
          className="grid size-10 shrink-0 place-items-center rounded-full bg-surface text-ink-600 ring-1 ring-inset ring-ink-200 hover:text-brand-700 disabled:opacity-50" aria-label={tr('پیوست فایل')} title={tr('پیوست فایل')}>
          {uploading ? <Spinner className="size-4" /> : <IconPlus className="size-5" />}
        </button>
        <textarea ref={box} value={text} onChange={(e) => setText(e.target.value)} rows={2} dir="auto" maxLength={4000}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && suggestions.length) { e.preventDefault(); name(suggestions[0]!); return; }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
          placeholder={tr('پیام… (برای نام بردن از همکار @ بنویسید)')} aria-label={tr('متن پیام')}
          className="min-h-10 flex-1 resize-none rounded-lg bg-surface px-3 py-2 text-sm text-ink-800 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-brand-500" />
        <Button type="submit" variant="primary" loading={sending} disabled={!text.trim() && !files.length}>{tr('فرستادن')}</Button>
      </form>
    </div>
  );
}

/* ── Dialogs ──────────────────────────────────────────────────────────────────────────────── */

interface PersonRow { id: string; fullName: string; jobTitle: string | null; avatarUrl?: string | null }

/** Colleagues by name, to choose from. */
function People({ picked, onPick, single, exclude = [] }: { picked: PersonRow[]; onPick: (p: PersonRow[]) => void; single?: boolean; exclude?: string[] }) {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const { data, isLoading } = useQuery<PersonRow[]>({ queryKey: ['/people', q], queryFn: () => apiGet('/people', { q: q || undefined }) });
  const rows = (data ?? []).filter((p) => p.id !== user?.id && !exclude.includes(p.id));
  const toggle = (p: PersonRow) => onPick(single ? [p] : picked.some((x) => x.id === p.id) ? picked.filter((x) => x.id !== p.id) : [...picked, p]);
  return (
    <div className="space-y-2">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('نام همکار')} aria-label={tr('جستجوی همکار')} />
      {!single && picked.length > 0 && (
        <div className="flex flex-wrap gap-1.5">{picked.map((p) => <Badge key={p.id} tone="info">{p.fullName}</Badge>)}</div>
      )}
      <ul className="max-h-56 divide-y divide-ink-100 overflow-y-auto rounded-lg ring-1 ring-inset ring-ink-200" aria-label={tr('همکاران')}>
        {isLoading ? <li className="p-3"><Spinner className="size-4" /></li> : rows.slice(0, 50).map((p) => {
          const on = picked.some((x) => x.id === p.id);
          return (
            <li key={p.id}>
              <button type="button" onClick={() => toggle(p)} aria-pressed={on} className={cx('flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-ink-50', on && 'bg-brand-50')}>
                <Mark name={p.fullName} src={p.avatarUrl} className="size-7 text-xs" />
                <span className="min-w-0 flex-1"><span className="block truncate text-ink-800">{p.fullName}</span>{p.jobTitle && <span className="block truncate text-xs text-ink-500">{p.jobTitle}</span>}</span>
                {on && <span className="text-xs text-brand-700">✓</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function NewConversation({ onClose }: { onClose: () => void }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<'DIRECT' | 'GROUP' | 'CHANNEL'>('DIRECT');
  const [picked, setPicked] = useState<PersonRow[]>([]);
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = kind === 'DIRECT' ? picked.length === 1 : title.trim().length >= 2 && (kind === 'CHANNEL' || picked.length > 0);

  const make = async () => {
    setBusy(true);
    try {
      const body = kind === 'DIRECT' ? { kind, memberIds: [picked[0]!.id] } : { kind, title: title.trim(), topic: topic.trim() || undefined, memberIds: picked.map((p) => p.id) };
      const r = await apiPost<{ id: string }>('/chat/conversations', body);
      await qc.invalidateQueries({ queryKey: ['/chat/conversations'] });
      onClose();
      navigate(`/chat/${r.id}`);
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };

  const tabs = [{ key: 'DIRECT', label: tr('دونفره') }, { key: 'GROUP', label: tr('گروه') }, ...(can('chat.channel.create') ? [{ key: 'CHANNEL', label: tr('کانال') }] : [])];
  return (
    <Modal open onClose={onClose} title={tr('گفت‌وگوی تازه')}
      footer={<><Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" loading={busy} disabled={!ready} onClick={() => void make()}>{kind === 'DIRECT' ? tr('شروع گفت‌وگو') : tr('ساختن')}</Button></>}>
      <div className="space-y-3">
        <Tabs tabs={tabs} active={kind} onChange={(k) => { setKind(k as typeof kind); setPicked((p) => (k === 'DIRECT' ? p.slice(0, 1) : p)); }} />
        <p className="text-xs leading-5 text-ink-500">
          {kind === 'DIRECT' ? tr('با یک همکار؛ اگر پیش‌تر گفت‌وگو داشته‌اید، همان باز می‌شود.')
            : kind === 'GROUP' ? tr('گروهی خصوصی: فقط کسانی که اضافه می‌کنید آن را می‌بینند.')
            : tr('کانال برای همهٔ همکاران پیدا و پیوستنی است؛ اعضا فقط وقتی نامشان برده شود باخبر می‌شوند.')}
        </p>
        {kind !== 'DIRECT' && (
          <>
            <Field label={tr('نام')} required><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} /></Field>
            <Field label={tr('موضوع')}><Input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={300} /></Field>
          </>
        )}
        <Field label={kind === 'DIRECT' ? tr('همکار') : tr('اعضا')} required={kind !== 'CHANNEL'}>
          <People picked={picked} onPick={setPicked} single={kind === 'DIRECT'} />
        </Field>
      </div>
    </Modal>
  );
}

function Channels({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery<{ id: string; title: string; topic: string | null; memberCount: number; joined: boolean }[]>({ queryKey: ['/chat/channels'], queryFn: () => apiGet('/chat/channels') });
  const join = async (id: string) => {
    try {
      await apiPost(`/chat/conversations/${id}/join`);
      await qc.invalidateQueries({ queryKey: ['/chat/conversations'] });
      onClose(); navigate(`/chat/${id}`);
    } catch (e) { toast((e as Error).message, 'danger'); }
  };
  return (
    <Modal open onClose={onClose} title={tr('کانال‌ها')}>
      {isLoading ? <LoadingBlock /> : !data?.length ? <p className="text-sm text-ink-500">{tr('هنوز کانالی ساخته نشده است.')}</p> : (
        <ul className="divide-y divide-ink-100">
          {data.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-2.5">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-ink-800">{c.title}</span>
                <span className="block truncate text-xs text-ink-500">{[tr('{0} عضو', localDigits(c.memberCount)), c.topic].filter(Boolean).join(' · ')}</span>
              </span>
              {c.joined
                ? <Button size="sm" variant="ghost" onClick={() => { onClose(); navigate(`/chat/${c.id}`); }}>{tr('باز کردن')}</Button>
                : <Button size="sm" variant="primary" onClick={() => void join(c.id)}>{tr('پیوستن')}</Button>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function Members({ c, manager, onClose, onChanged }: { c: ConversationDetail; manager: boolean; onClose: () => void; onChanged: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const [adding, setAdding] = useState<PersonRow[]>([]);
  const act = async (work: () => Promise<unknown>) => { try { await work(); onChanged(); setAdding([]); } catch (e) { toast((e as Error).message, 'danger'); } };
  const ROLE: Record<string, string> = { OWNER: tr('مالک'), ADMIN: tr('مدیر'), MEMBER: tr('عضو') };
  return (
    <Modal open onClose={onClose} title={tr('اعضای «{0}»', c.title)}>
      <ul className="divide-y divide-ink-100">
        {c.members.map((m) => (
          <li key={m.id} className="flex items-center gap-2 py-2">
            <Mark name={m.fullName} src={m.avatarUrl} className="size-7 text-xs" />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm text-ink-800">{m.fullName}</span>{m.jobTitle && <span className="block truncate text-xs text-ink-500">{m.jobTitle}</span>}</span>
            {c.me.role === 'OWNER' && m.role !== 'OWNER' ? (
              <Select value={m.role} onChange={(e) => void act(() => apiPatch(`/chat/conversations/${c.id}/members/${m.id}`, { role: e.target.value }))} aria-label={tr('نقش {0}', m.fullName)} className="w-24">
                <option value="ADMIN">{ROLE.ADMIN}</option><option value="MEMBER">{ROLE.MEMBER}</option>
              </Select>
            ) : <Badge>{ROLE[m.role]}</Badge>}
            {manager && m.role !== 'OWNER' && m.id !== user?.id && (
              <button type="button" className="text-xs text-rose-700 underline" onClick={() => void act(() => apiDelete(`/chat/conversations/${c.id}/members/${m.id}`))}>{tr('بیرون کردن')}</button>
            )}
          </li>
        ))}
      </ul>
      {manager && (
        <div className="mt-4 space-y-2 border-t border-ink-100 pt-3">
          <p className="text-xs font-semibold text-ink-700">{tr('افزودن همکار')}</p>
          <People picked={adding} onPick={setAdding} exclude={c.members.map((m) => m.id)} />
          <Button size="sm" variant="primary" disabled={!adding.length} onClick={() => void act(() => apiPost(`/chat/conversations/${c.id}/members`, { userIds: adding.map((p) => p.id) }))}>
            {tr('افزودن {0} نفر', localDigits(adding.length))}
          </Button>
        </div>
      )}
    </Modal>
  );
}

function Settings({ c, manager, onClose, onChanged, onLeft }: { c: ConversationDetail; manager: boolean; onClose: () => void; onChanged: () => void; onLeft: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(c.title);
  const [topic, setTopic] = useState(c.topic ?? '');
  const act = async (work: () => Promise<unknown>, after = onChanged) => { try { await work(); after(); } catch (e) { toast((e as Error).message, 'danger'); } };
  const mine = (body: object) => act(() => apiPatch(`/chat/conversations/${c.id}/me`, body));
  return (
    <Modal open onClose={onClose} title={tr('تنظیمات گفت‌وگو')}>
      <div className="space-y-4">
        <Row label={tr('باخبر شدن بیرون از این صفحه')}>
          <Select value={c.me.notify} onChange={(e) => void mine({ notify: e.target.value })} aria-label={tr('باخبر شدن')}>
            {(['ALL', 'MENTIONS', 'NONE'] as ChatNotify[]).map((n) => <option key={n} value={n}>{NOTIFY_LABEL[n]()}</option>)}
          </Select>
        </Row>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" checked={c.me.muted} onChange={(e) => void mine({ muted: e.target.checked })} />
          {tr('بی‌صدا: نه اعلان، نه شمارهٔ خوانده‌نشده در منو')}
        </label>
        {manager && c.kind !== 'DIRECT' && (
          <div className="space-y-2 border-t border-ink-100 pt-3">
            <Field label={tr('نام')}><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} /></Field>
            <Field label={tr('موضوع')}><Input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={300} /></Field>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" disabled={title.trim().length < 2} onClick={() => void act(() => apiPatch(`/chat/conversations/${c.id}`, { title: title.trim(), topic: topic.trim() || null }))}>{tr('ذخیره')}</Button>
              <Button size="sm" variant="ghost" onClick={() => void act(() => apiPatch(`/chat/conversations/${c.id}`, { archived: !c.archived }))}>{c.archived ? tr('بیرون آوردن از بایگانی') : tr('بایگانی')}</Button>
            </div>
          </div>
        )}
        {c.kind !== 'DIRECT' && (
          <div className="border-t border-ink-100 pt-3">
            <Button size="sm" variant="ghost" className="text-rose-700" onClick={() => void act(() => apiPost(`/chat/conversations/${c.id}/leave`), onLeft)}>{tr('ترک گفت‌وگو')}</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="space-y-1"><p className="text-xs font-semibold text-ink-700">{label}</p>{children}</div>
);
