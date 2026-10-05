import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet } from '../lib/api';
import { useAuth } from '../lib/auth';
import { streamChat, type ChatAction } from '../lib/chat';
import { formatDateTime } from '../lib/format';
import { Button, cx, Spinner } from './ui';
import { ChatText } from './Markdown';
import { OpenForm, type Suggestion } from './SuggestedForms';
import { tr } from '../i18n';
import { useFocusTrap } from '../hooks/useDismissable';
import { assistantBus } from '../lib/guide';
import { OwlSvg } from './owl/Owl';

/**
 * The assistant (Hivamis task 5): a conversation with the organisation's own local model, free and
 * without a quota. It knows the page it is opened from — "this project" means the one on screen — and
 * looks things up as the person would. It changes nothing: what it can do is offer a form, ready to
 * fill, or a page, for the person to open.
 */

interface Message { role: 'user' | 'assistant'; content: string; actions: ChatAction[]; tools: string[] }
interface Status { mode: string; ready: boolean; model: string | null; reachable: boolean; modelPresent: boolean; busy: number; waiting: number }

const TOOL_FA: Record<string, string> = {
  search_records: tr('جستجوی پرونده‌ها…'), get_record: tr('خواندن پرونده…'), my_work: tr('دیدن کارهای شما…'),
  ask_numbers: tr('پرسیدن از عددها…'), search_memory: tr('جستجو در حافظهٔ سازمان…'), related_forms: tr('یافتن فرم‌های مرتبط…'),
};

const PAGES: [RegExp, string][] = [
  [/^\/projects\/([\w-]{36})/, 'project'], [/^\/opportunities\/([\w-]{36})/, 'opportunity'], [/^\/companies\/([\w-]{36})/, 'company'],
  [/^\/briefs\/([\w-]{36})/, 'brief'], [/^\/proposals\/([\w-]{36})/, 'proposal'], [/^\/contracts\/([\w-]{36})/, 'contract'],
  [/^\/work-orders\/([\w-]{36})/, 'work_order'], [/^\/tasks\/([\w-]{36})/, 'task'], [/^\/changes\/([\w-]{36})/, 'change_request'],
];

/** Where the person is, for the assistant: the page, and the record on it. */
function usePageContext() {
  const { pathname } = useLocation();
  return useMemo(() => {
    for (const [re, entity] of PAGES) {
      const m = re.exec(pathname);
      if (m) return { path: pathname, entity, id: m[1]! };
    }
    return { path: pathname, entity: null, id: null };
  }, [pathname]);
}
/** The record's heading, read when the question is asked — by then the page has loaded. */
const heading = () => document.querySelector('main h1')?.textContent?.trim().slice(0, 200) || null;

export function AssistantButton() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState<string | undefined>();
  // The owl hands over what its guide cannot answer (Hivamis task 8).
  useEffect(() => assistantBus.on((q) => { setQuestion(q); setOpen(true); }), []);
  if (!can('ai.chat')) return null;
  return (
    <>
      <button type="button" data-tour="assistant" onClick={() => { setQuestion(undefined); setOpen(true); }} aria-label={tr('دستیار')} title={tr('دستیار')}
        className="grid size-8 place-items-center rounded-lg text-ink-600 hover:bg-ink-50 hover:text-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500">
        <svg aria-hidden viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3z" strokeLinejoin="round" /><path d="M18.5 14.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <AssistantChat initialQuestion={question} onClose={() => setOpen(false)} />}
    </>
  );
}

export function AssistantChat({ onClose, initialQuestion }: { onClose: () => void; initialQuestion?: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const page = usePageContext();
  const { data: status } = useQuery<Status>({ queryKey: ['/ai/chat/status'], queryFn: () => apiGet('/ai/chat/status'), staleTime: 15_000 });
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [form, setForm] = useState<Suggestion | null>(null);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const panel = useRef<HTMLElement>(null);
  useFocusTrap(panel, !form);

  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [messages]);
  // Closing the drawer stops the answer; nothing else does — not a re-render of the page behind it.
  useEffect(() => () => abort.current?.abort(), []);
  const asked = useRef(false);
  useEffect(() => {
    if (initialQuestion && !asked.current) { asked.current = true; void send(initialQuestion); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);
  useEffect(() => {
    if (form) return; // Escape then belongs to the form on top.
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose, form]);

  const update = (fn: (last: Message) => Message) => setMessages((m) => [...m.slice(0, -1), fn(m[m.length - 1]!)]);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setDraft(''); setError(null); setBusy(true); setQueue(null);
    setMessages((m) => [...m, { role: 'user', content: message, actions: [], tools: [] }, { role: 'assistant', content: '', actions: [], tools: [] }]);
    abort.current = new AbortController();
    try {
      await streamChat({ conversationId, message, context: { ...page, title: page.entity ? heading() : null } }, (e) => {
        switch (e.event) {
          case 'meta': setConversationId(e.data.conversationId); break;
          case 'queue': setQueue(e.data.position); break;
          case 'tool': setQueue(null); update((l) => ({ ...l, tools: [...l.tools, e.data.name] })); break;
          case 'delta': setQueue(null); update((l) => ({ ...l, content: l.content + e.data.text })); break;
          case 'action': update((l) => ({ ...l, actions: [...l.actions, e.data] })); break;
          case 'error': setError(e.data.message); break;
          case 'done': void qc.invalidateQueries({ queryKey: ['/ai/conversations'] }); break;
        }
      }, abort.current.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setBusy(false); setQueue(null);
    }
  };

  const open = async (id: string) => {
    const c = await apiGet<{ id: string; messages: { role: 'user' | 'assistant'; content: string; actions: ChatAction[] }[] }>(`/ai/conversations/${id}`);
    setConversationId(c.id);
    setMessages(c.messages.map((m) => ({ role: m.role, content: m.content, actions: m.actions ?? [], tools: [] })));
    setHistory(false);
  };
  const fresh = () => { abort.current?.abort(); setConversationId(null); setMessages([]); setError(null); setHistory(false); };

  const act = (a: ChatAction) => {
    if (a.type === 'link' && a.path) { navigate(a.path); onClose(); return; }
    if (a.type === 'form' && a.code) setForm({ code: a.code, nameFa: a.label, nameEn: a.label, category: '', prefill: a.prefill ?? {}, fitsStage: false, unitUses: 0, lastForRecord: null });
  };

  const starters = [
    tr('کارهای امروز من چیست و کدام عقب افتاده است؟'),
    ...(page.entity ? [tr('وضعیت همین پرونده را خلاصه کن و بگو گام بعدی چیست.'), tr('برای همین پرونده چه فرمی را باید پر کنم؟')] : []),
    tr('حاشیهٔ سود پروژه‌های بسته‌شدهٔ این فصل چقدر بوده است؟'),
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink-900/30" role="dialog" aria-modal="true" aria-label={tr('دستیار')} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section ref={panel} className="flex h-full w-full max-w-md flex-col bg-surface shadow-xl" data-testid="assistant">
        <header className="flex items-center gap-2 border-b border-ink-200 px-4 py-3">
          <OwlSvg size={30} mood={busy ? 'think' : 'idle'} />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ink-900">{tr('دستیار')}</h2>
            <p className="flex items-center gap-1.5 text-[11px] text-ink-500">
              <span className={cx('size-1.5 rounded-full', status?.ready ? 'bg-emerald-500' : 'bg-ink-300')} />
              {status?.ready ? tr('مدل محلی {0} — رایگان و بی‌سقف', status.model ?? '') : tr('مدل محلی در دسترس نیست')}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setHistory((h) => !h)}>{tr('گفت‌وگوهای پیشین')}</Button>
          <Button size="sm" variant="ghost" onClick={fresh}>{tr('گفت‌وگوی تازه')}</Button>
          <button type="button" onClick={onClose} aria-label={tr('بستن')} className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700">✕</button>
        </header>

        {history ? <History onOpen={(id) => void open(id)} onDeleted={(id) => { if (id === conversationId) fresh(); }} /> : (
          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
            {status && !status.ready && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-900 ring-1 ring-inset ring-amber-200" data-testid="assistant-offline">
                {status.mode === 'off' ? tr('دستیار در این نصب خاموش است.')
                  : can('admin.settings')
                  ? tr('مدل محلی روی سرور اجرا نیست. روی سرور Ollama را اجرا کنید ({0}) و مدل {1} را دریافت کنید ({2}).', 'ollama serve', status.model ?? 'qwen3:14b', `ollama pull ${status.model ?? 'qwen3:14b'}`)
                  : tr('دستیار فعلاً در دسترس نیست؛ مدیر سیستم را باخبر کنید.')}
              </p>
            )}
            {!messages.length && (
              <div className="space-y-2">
                <p className="text-sm text-ink-600">{tr('سلام! از کارها، پرونده‌ها، عددها یا حافظهٔ سازمان بپرسید. هرچه شما می‌بینید، من هم می‌بینم — نه بیشتر.')}</p>
                {starters.map((s) => (
                  <button key={s} type="button" disabled={busy || !status?.ready} onClick={() => void send(s)}
                    className="block w-full rounded-lg bg-ink-50 px-3 py-2 text-start text-sm text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-brand-50 hover:text-brand-800 disabled:opacity-50">
                    {s}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={cx('flex', m.role === 'user' ? 'justify-start' : 'justify-end')}>
                <div className={cx('max-w-[85%] rounded-2xl px-3.5 py-2.5', m.role === 'user' ? 'bg-brand-600 text-white' : 'bg-ink-50 text-ink-800 ring-1 ring-inset ring-ink-200')}>
                  {m.tools.length > 0 && (
                    <div className="mb-1.5 flex flex-wrap gap-1">
                      {[...new Set(m.tools)].filter((t) => TOOL_FA[t]).map((t) => <span key={t} className="rounded-full bg-surface px-2 py-0.5 text-[10px] text-ink-500 ring-1 ring-inset ring-ink-200">{TOOL_FA[t]}</span>)}
                    </div>
                  )}
                  {m.role === 'user' ? <p dir="auto" className="whitespace-pre-wrap text-sm leading-7">{m.content}</p>
                    : m.content ? <ChatText source={m.content} />
                    : busy && i === messages.length - 1 ? <span className="flex items-center gap-2 text-xs text-ink-500"><Spinner className="size-3.5" />{queue ? tr('در صف — نفر {0}', String(queue)) : tr('در حال فکر کردن…')}</span>
                    : null}
                  {m.actions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {m.actions.map((a, j) => (
                        <Button key={j} size="sm" variant={a.type === 'form' ? 'primary' : 'secondary'} onClick={() => act(a)}>
                          {a.type === 'form' ? tr('باز کردن «{0}»', a.label) : a.label}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800 ring-1 ring-inset ring-rose-200">{error}</p>}
            <div ref={end} />
          </div>
        )}

        <form className="flex items-end gap-2 border-t border-ink-200 p-3" onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
          <textarea
            value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} dir="auto" maxLength={4000}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draft); } }}
            placeholder={page.entity ? tr('دربارهٔ همین پرونده یا هر چیز دیگری بپرسید…') : tr('بپرسید…')} aria-label={tr('پیام به دستیار')}
            className="min-h-10 flex-1 resize-none rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-800 focus:border-brand-400 focus:outline-none"
          />
          {busy
            ? <Button type="button" variant="secondary" onClick={() => abort.current?.abort()}>{tr('توقف')}</Button>
            : <Button type="submit" variant="primary" disabled={!draft.trim() || !status?.ready}>{tr('فرستادن')}</Button>}
        </form>
      </section>
      <OpenForm suggestion={form} onClose={() => setForm(null)} />
    </div>
  );
}

function History({ onOpen, onDeleted }: { onOpen: (id: string) => void; onDeleted: (id: string) => void }) {
  const qc = useQueryClient();
  const { data } = useQuery<{ id: string; title: string; updatedAt: string }[]>({ queryKey: ['/ai/conversations'], queryFn: () => apiGet('/ai/conversations') });
  if (!data?.length) return <p className="flex-1 px-4 py-6 text-center text-sm text-ink-500">{tr('هنوز گفت‌وگویی نیست.')}</p>;
  return (
    <ul className="flex-1 divide-y divide-ink-100 overflow-y-auto" data-testid="assistant-history">
      {data.map((c) => (
        <li key={c.id} className="flex items-center gap-2 px-4 py-2.5">
          <button type="button" onClick={() => onOpen(c.id)} className="min-w-0 flex-1 text-start">
            <span dir="auto" className="block truncate text-sm text-ink-800">{c.title}</span>
            <span className="text-[11px] text-ink-400">{formatDateTime(c.updatedAt)}</span>
          </button>
          <button type="button" aria-label={tr('پاک کردن این گفت‌وگو')} className="rounded p-1 text-xs text-ink-400 hover:bg-rose-50 hover:text-rose-700"
            onClick={async () => { await apiDelete(`/ai/conversations/${c.id}`); await qc.invalidateQueries({ queryKey: ['/ai/conversations'] }); onDeleted(c.id); }}>✕</button>
        </li>
      ))}
    </ul>
  );
}
