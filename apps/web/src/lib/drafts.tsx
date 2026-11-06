import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';
import { apiDelete, apiGet, apiPut, onMutation } from './api';
import { tr } from '../i18n';

/**
 * Whatever a person types is kept as a draft (the owner, 2026-11-06, ADR-122), on the server and for
 * them alone, until the form is really saved or they delete it. Closing a dialog, going elsewhere or
 * losing the tab keeps it.
 *
 * It lives in the shared form controls, not in each form: a control inside a labelled field or a dialog
 * binds itself to the place it is in — the page, or the dialog on it — so every form has drafts, new
 * ones included. Coming back, each field is given what was typed, through its own `onChange`, one at a
 * time, because many forms build their next state from the last one.
 *
 * What is never kept: passwords, codes and keys, search boxes, and the sections where it has no place.
 */

export interface DraftField { label: string; value: unknown; base?: unknown }
export interface DraftRow { id?: string; key: string; title: string; path: string; fields: Record<string, DraftField>; updatedAt?: string }

interface Bound {
  name: string; label: string; base: unknown; dirty: boolean;
  current: () => unknown; apply: (value: unknown) => void; el: () => Element | null;
}

const SAVE_AFTER_MS = 800;
/** A click this recent is what a successful save came from. */
const ACT_WINDOW_MS = 20_000;
/** Sections where a draft has no place: conversations, the assistant, and system configuration and setup. */
const NOT_HERE = /^\/(chat|ai|admin|install|onboarding|rules)(\/|$)/;
/** Fields never kept, whatever their type says. */
const SECRET = /رمز|گذرواژه|توکن|کد تأیید|کد پیامک|کد یک‌بار|کد یکبار|کلید(?!\s?واژه)|password|passcode|secret|token|api.?key|private.?key|otp/i;
const SEARCH = /^(جستجو|جست‌وجو|search)/i;
/** Calls that are not a form being saved. */
const NOT_A_SAVE = /^\/(me\/drafts|auth\/|notifications|documents|ai\/|assistant|guide|push)/;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');
const blank = (v: unknown) => v === '' || v === null || v === undefined || v === false || (Array.isArray(v) && !v.length);
const tick = () => new Promise<void>((done) => { setTimeout(done, 0); });

class DraftStore {
  rows = new Map<string, DraftRow>();
  private bound = new Map<string, Map<string, Bound>>();
  private applied = new Map<string, Set<string>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private restoring = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<() => void>();
  private meta = new Map<string, { title: string; path: string }>();
  private restored = new Set<string>();
  version = 0;

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  private changed() { this.version += 1; this.listeners.forEach((l) => l()); }

  async load() {
    const rows = await apiGet<DraftRow[]>('/me/drafts').catch(() => null);
    if (!Array.isArray(rows)) return;
    for (const r of rows) if (!this.rows.has(r.key)) this.rows.set(r.key, r);
    this.changed();
    for (const scope of this.bound.keys()) this.scheduleRestore(scope);
  }

  describe(scope: string, title: string, path: string) { this.meta.set(scope, { title, path }); }

  /** Binds one control to its place; `name` is made unique among the place's controls. */
  bind(scope: string, field: Omit<Bound, 'dirty'>) {
    const fields = this.bound.get(scope) ?? new Map<string, Bound>();
    this.bound.set(scope, fields);
    let name = field.name;
    for (let n = 2; fields.has(name); n += 1) name = `${field.name}#${n}`;
    const entry: Bound = { ...field, name, dirty: false };
    fields.set(name, entry);
    this.scheduleRestore(scope);
    return {
      entry,
      unbind: () => {
        fields.delete(name);
        if (!fields.size) { this.bound.delete(scope); this.applied.delete(scope); this.restored.delete(scope); }
      },
    };
  }

  private scheduleRestore(scope: string) {
    clearTimeout(this.restoring.get(scope));
    this.restoring.set(scope, setTimeout(() => { void this.restore(scope); }, 0));
  }

  /** Gives each field of this place what was typed, once, one field at a time. */
  private async restore(scope: string) {
    const row = this.rows.get(scope);
    const fields = this.bound.get(scope);
    if (!row || !fields) return;
    const done = this.applied.get(scope) ?? new Set<string>();
    this.applied.set(scope, done);
    // The same dialog on another record: a field that started from something else says so.
    const another = Object.entries(row.fields).some(([k, f]) => { const b = fields.get(k); return !!b && !b.dirty && !done.has(k) && !same(b.base, f.base); });
    if (another) return;
    for (const [k, f] of Object.entries(row.fields)) {
      // Thrown away while it was coming back: what is left stays out.
      if (this.rows.get(scope) !== row) return;
      const b = fields.get(k);
      if (!b || done.has(k) || b.dirty) continue;
      done.add(k);
      if (same(b.current(), f.value)) continue;
      b.dirty = true;
      b.apply(f.value);
      this.restored.add(scope);
      await tick();
    }
    this.changed();
  }

  /** The person changed something here: the draft becomes what is on the screen. */
  touched(scope: string) {
    const fields = this.bound.get(scope);
    if (!fields) return;
    const old = this.rows.get(scope);
    const next: Record<string, DraftField> = {};
    for (const [k, f] of Object.entries(old?.fields ?? {})) if (!fields.has(k)) next[k] = f;
    for (const b of fields.values()) {
      const value = b.current();
      if (!same(value, b.base) && !(blank(value) && blank(b.base))) next[b.name] = { label: b.label, value, base: b.base };
    }
    if (!Object.keys(next).length) { this.forget(scope); return; }
    const about = this.meta.get(scope);
    this.rows.set(scope, { ...old, key: scope, title: about?.title ?? old?.title ?? '', path: about?.path ?? old?.path ?? scope.split('#')[0]!, fields: next });
    this.queueSave(scope);
    this.changed();
  }

  private queueSave(scope: string, after = SAVE_AFTER_MS) {
    clearTimeout(this.timers.get(scope));
    this.timers.set(scope, setTimeout(() => { void this.save(scope); }, after));
  }

  private async save(scope: string) {
    const row = this.rows.get(scope);
    if (!row) return;
    try {
      const saved = await apiPut<{ id: string; updatedAt: string }>('/me/drafts', { key: row.key, title: row.title, path: row.path, fields: row.fields });
      const now = this.rows.get(scope);
      if (now) { now.id = saved?.id; now.updatedAt = saved?.updatedAt; this.changed(); }
      // Deleted while the save was on its way: the server has it now, so it goes there too.
      else if (saved?.id) void apiDelete(`/me/drafts/${saved.id}`).catch(() => undefined);
    } catch {
      // The network went: what was typed stays here and goes when it can.
      this.queueSave(scope, 15_000);
    }
  }

  private forget(scope: string) {
    clearTimeout(this.timers.get(scope));
    const row = this.rows.get(scope);
    this.rows.delete(scope);
    this.restored.delete(scope);
    if (row?.id) void apiDelete(`/me/drafts/${row.id}`).catch(() => undefined);
    this.changed();
  }

  /** The form was saved: nothing is left to keep. The screen's fields stay as they are. */
  saved(scope: string) {
    for (const b of this.bound.get(scope)?.values() ?? []) { b.base = b.current(); b.dirty = false; }
    this.forget(scope);
  }

  /** The person threw it away: the draft goes, and the fields go back to what they held. */
  async discard(scope: string) {
    this.forget(scope);
    for (const b of this.bound.get(scope)?.values() ?? []) {
      if (!same(b.current(), b.base)) { b.apply(b.base); await tick(); }
      b.dirty = false;
    }
  }

  /** By its list row: it may belong to no form open now. */
  remove(key: string) { void this.discard(key); }

  wasRestored = (scope: string) => this.restored.has(scope);

  /** A save succeeded right after a click: the form that click was in is done. */
  mutated(from: Element | null) {
    if (!from) return;
    const dialog = from.closest('[role="dialog"]');
    const part = dialog ?? from.closest('section[aria-label], form, [data-draft-scope]');
    const header = from.closest('[data-tour="page-header"], header, nav, aside');
    const area = part ?? (header ? null : from.closest('main'));
    if (!area) return;
    for (const [scope, fields] of [...this.bound]) {
      const inside = [...fields.values()].filter((b) => { const el = b.el(); return !!el && area.contains(el); });
      if (!inside.length) continue;
      if (inside.length === fields.size || dialog) { this.saved(scope); continue; }
      for (const b of inside) { b.base = b.current(); b.dirty = false; }
      this.touched(scope);
    }
  }
}

const StoreContext = createContext<DraftStore | null>(null);
const ListContext = createContext<DraftStore | null>(null);
interface Scope { key: string; path: string; dialog: boolean }
const ScopeContext = createContext<Scope | null>(null);
/** The labelled field a control sits in. */
export const FieldContext = createContext<{ label: string; root: RefObject<HTMLElement | null> } | null>(null);

export function DraftProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new DraftStore());
  const { pathname } = useLocation();
  useEffect(() => { void store.load(); }, [store]);
  useEffect(() => {
    // What a save came from: the last thing pressed, by mouse or by Enter.
    let last: { el: Element; at: number } | null = null;
    const pressed = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Enter') return;
      if (e.target instanceof Element) last = { el: e.target, at: Date.now() };
    };
    document.addEventListener('click', pressed, true);
    document.addEventListener('keydown', pressed, true);
    const stop = onMutation((path) => {
      if (NOT_A_SAVE.test(path) || !last || Date.now() - last.at > ACT_WINDOW_MS) return;
      store.mutated(last.el);
    });
    return () => { document.removeEventListener('click', pressed, true); document.removeEventListener('keydown', pressed, true); stop(); };
  }, [store]);
  const page = useMemo<Scope>(() => ({ key: pathname, path: pathname, dialog: false }), [pathname]);
  return (
    <ListContext.Provider value={store}>
      <StoreContext.Provider value={NOT_HERE.test(pathname) ? null : store}>
        <ScopeContext.Provider value={page}>{children}</ScopeContext.Provider>
      </StoreContext.Provider>
    </ListContext.Provider>
  );
}

/** A dialog is a place of its own, named for what it does — or for the record it does it to. */
export function DraftScope({ title, draftKey, children }: { title: string; draftKey?: string; children: ReactNode }) {
  const store = useContext(StoreContext);
  const parent = useContext(ScopeContext);
  const scope = useMemo<Scope | null>(() => (parent ? { key: `${parent.path}#${draftKey ?? title}`, path: parent.path, dialog: true } : null), [parent, draftKey, title]);
  useEffect(() => { if (store && scope) store.describe(scope.key, title, scope.path); }, [store, scope, title]);
  return scope ? <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider> : <>{children}</>;
}

/** The page's own name, for its drafts in the list. */
export function useDraftTitle(title: string) {
  const store = useContext(StoreContext);
  const scope = useContext(ScopeContext);
  useEffect(() => { if (store && scope && !scope.dialog) store.describe(scope.key, title, scope.path); }, [store, scope, title]);
}

/**
 * Binds one value to the draft of the place it is in; returns what to call when the person changes it.
 * `apply` is how a draft gives it back.
 */
export function useDraftValue<T>({ label, value, apply, enabled = true, el }: {
  label: string | undefined; value: T; apply: (value: T) => void; enabled?: boolean; el?: () => Element | null;
}) {
  const store = useContext(StoreContext);
  const scope = useContext(ScopeContext);
  const field = useContext(FieldContext);
  const latest = useRef(value);
  const applyRef = useRef(apply);
  const elRef = useRef(el);
  const entry = useRef<Bound | null>(null);
  latest.current = value;
  applyRef.current = apply;
  elRef.current = el;
  const active = !!store && !!scope && enabled && !!label;
  const scopeKey = scope?.key;

  useEffect(() => {
    if (!active || !store || !scopeKey) return undefined;
    const at = () => field?.root.current ?? elRef.current?.() ?? null;
    const section = at()?.closest('section[aria-label]')?.getAttribute('aria-label');
    const bound = store.bind(scopeKey, {
      name: section ? `${section} / ${label}` : label!, label: label!, base: latest.current,
      current: () => latest.current, apply: (v) => { latest.current = v as T; applyRef.current(v as T); }, el: at,
    });
    entry.current = bound.entry;
    return () => { entry.current = null; bound.unbind(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, store, scopeKey, label]);

  // A form that fills itself in (a record loading) is not the person typing: that is where it starts from.
  useEffect(() => { if (entry.current && !entry.current.dirty) entry.current.base = value; }, [value]);

  return useCallback((next: T) => {
    latest.current = next;
    const bound = entry.current;
    if (!bound || !store || !scopeKey) return;
    bound.dirty = true;
    store.touched(scopeKey);
  }, [store, scopeKey]);
}

/** `useState` for a choice that is no input — a card picked, a list of rows — kept in the draft all the same. */
export function useDraftState<T>(label: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState(initial);
  const ref = useRef(value);
  ref.current = value;
  const record = useDraftValue<T>({ label, value, apply: setValue });
  const set = useCallback((next: T | ((prev: T) => T)) => {
    const v = typeof next === 'function' ? (next as (p: T) => T)(ref.current) : next;
    ref.current = v;
    setValue(v);
    record(v);
  }, [record]);
  return [value, set];
}

type ControlProps = { value?: unknown; checked?: unknown; disabled?: boolean; readOnly?: boolean; type?: string; role?: string; autoComplete?: string; name?: string; placeholder?: string; 'aria-label'?: string; onChange?: (e: any) => void };

/**
 * The shared controls' side of it: which of them are kept, and their `onChange`. A control outside a
 * labelled field or a dialog is a filter or a search, not a form — a text area always is one.
 */
export function useDraftControl<P extends ControlProps>(props: P, kind: 'input' | 'textarea' | 'select' | 'checkbox', own: { draft?: boolean; label?: unknown; el: () => Element | null }) {
  const field = useContext(FieldContext);
  const scope = useContext(ScopeContext);
  const text = typeof own.label === 'string' ? own.label : undefined;
  // In a labelled field the label names it; a second control there is told apart by its own name.
  const named = text ?? props['aria-label'];
  const label = field ? (named && named !== field.label ? `${field.label} — ${named}` : field.label) : named ?? props.placeholder;
  const checkbox = kind === 'checkbox';
  const said = `${label ?? ''} ${props.name ?? ''}`;
  const kept = own.draft !== false && (checkbox ? props.checked !== undefined : props.value !== undefined)
    && !props.disabled && !props.readOnly && !['password', 'file', 'hidden', 'search', 'submit', 'button'].includes(props.type ?? '')
    && props.role !== 'searchbox' && !/password|one-time-code/.test(props.autoComplete ?? '')
    && !SECRET.test(said) && !SEARCH.test(text ?? props['aria-label'] ?? props.placeholder ?? '')
    && (!!field || !!scope?.dialog || kind === 'textarea');
  const change = useRef(props.onChange);
  change.current = props.onChange;
  const record = useDraftValue<unknown>({
    label, enabled: kept, el: own.el, value: checkbox ? !!props.checked : props.value,
    apply: (v) => change.current?.({ target: checkbox ? { checked: v, name: props.name } : { value: v, name: props.name }, currentTarget: { value: v, checked: v, name: props.name } }),
  });
  return (e: { target: { value: unknown; checked?: boolean } }) => {
    props.onChange?.(e);
    record(checkbox ? e.target.checked : e.target.value);
  };
}

/** How many drafts this person has, for the menu. */
export function useDraftList(): { rows: DraftRow[]; remove: (key: string) => void } {
  const store = useContext(ListContext);
  useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.snapshot ?? zero);
  return { rows: store ? [...store.rows.values()].sort((a, b) => (b.updatedAt ?? '9').localeCompare(a.updatedAt ?? '9')) : [], remove: (key) => store?.remove(key) };
}
const noSubscribe = () => () => undefined;
const zero = () => 0;

/** The strip that says a draft is being kept here, with the way to throw it away. */
export function DraftNotice({ className }: { className?: string }) {
  const store = useContext(StoreContext);
  const scope = useContext(ScopeContext);
  useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.snapshot ?? zero);
  if (!store || !scope || !store.rows.get(scope.key)) return null;
  return (
    <div className={className} data-testid="draft-notice">
      <p className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-brand-50/70 px-3 py-1.5 text-[12.5px] text-ink-700 ring-1 ring-inset ring-brand-100" role="status">
        <span>{store.wasRestored(scope.key) ? tr('پیش‌نویس قبلی شما برگردانده شد؛ تا ثبت نهایی ذخیره می‌ماند.') : tr('پیش‌نویس خودکار ذخیره می‌شود.')}</span>
        <button type="button" onClick={() => void store.discard(scope.key)} className="font-medium text-rose-700 hover:underline">{tr('حذف پیش‌نویس')}</button>
      </p>
    </div>
  );
}
