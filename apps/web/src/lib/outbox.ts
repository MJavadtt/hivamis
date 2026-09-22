/**
 * The offline outbox (roadmap #19).
 *
 * Production is on a film set and Media is at the client's office; the D forms (unit execution)
 * and E forms (quality control) are filled exactly where the signal is worst. A form typed into
 * a dead connection used to be a form lost, so people wrote on paper and typed it up later —
 * which is how a system stops being the record.
 *
 * A queued form is held in IndexedDB with a key generated on the device, and sent when the
 * network comes back. The key is what makes a retry safe: the server files it once however
 * many times the queue asks.
 *
 * What this deliberately does *not* do is pretend a queued form is an accepted one. A guard can
 * refuse it on arrival — a project may have been closed while the phone was in a pocket — and
 * the queue keeps the rejection, in Persian, next to the person's own data so they can fix it
 * or drop it knowingly.
 */
const DB_NAME = 'hiva.outbox';
const STORE = 'submissions';
const VERSION = 1;

export type OutboxState = 'QUEUED' | 'SENDING' | 'REJECTED' | 'SENT';

export interface OutboxItem {
  /** Also the idempotency key the server dedupes on. */
  id: string;
  formCode: string;
  formNameFa: string;
  data: Record<string, unknown>;
  asDraft: boolean;
  createdAt: number;
  attempts: number;
  state: OutboxState;
  /** The server's own words when it refused, kept for the person to act on. */
  errorFa?: string;
  errorCode?: string;
  /** The submission code the server gave it, once it lands. */
  submissionCode?: string;
  sentAt?: number;
}

export const newKey = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? `k${Date.now()}${Math.random().toString(36).slice(2, 10)}`);

/**
 * IndexedDB where it exists, localStorage where it does not, memory as a last resort.
 *
 * The fallback is not a test convenience: a phone in private mode, or a browser with site data
 * restricted, otherwise loses a form somebody typed standing in a warehouse. Smaller and less
 * private, but a queued form that survives is the point.
 */
interface Store {
  all(): Promise<OutboxItem[]>;
  put(item: OutboxItem): Promise<void>;
  get(id: string): Promise<OutboxItem | undefined>;
  remove(id: string): Promise<void>;
}

function idbStore(): Store | null {
  if (typeof indexedDB === 'undefined') return null;
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  };
  return {
    all: () => run<OutboxItem[]>('readonly', (s) => s.getAll() as IDBRequest<OutboxItem[]>),
    put: async (item) => { await run('readwrite', (s) => s.put(item) as IDBRequest<IDBValidKey>); },
    get: (id) => run<OutboxItem | undefined>('readonly', (s) => s.get(id) as IDBRequest<OutboxItem | undefined>),
    remove: async (id) => { await run('readwrite', (s) => s.delete(id) as IDBRequest<undefined>); },
  };
}

const memory = new Map<string, OutboxItem>();
function fallbackStore(): Store {
  const KEY = 'hiva.outbox.items';
  const read = (): OutboxItem[] => {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as OutboxItem[]) : [...memory.values()];
    } catch { return [...memory.values()]; }
  };
  const write = (items: OutboxItem[]) => {
    memory.clear();
    for (const i of items) memory.set(i.id, i);
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* memory keeps it */ }
  };
  return {
    all: async () => read(),
    put: async (item) => { const items = read().filter((i) => i.id !== item.id); write([...items, item]); },
    get: async (id) => read().find((i) => i.id === id),
    remove: async (id) => write(read().filter((i) => i.id !== id)),
  };
}

let cached: Store | null = null;
async function store(): Promise<Store> {
  if (cached) return cached;
  const idb = idbStore();
  if (idb) {
    try { await idb.all(); cached = idb; return cached; } catch { /* fall through */ }
  }
  cached = fallbackStore();
  return cached;
}

export async function listOutbox(): Promise<OutboxItem[]> {
  try {
    const all = await (await store()).all();
    return all.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    // Whatever the browser is refusing today, the page still has to render.
    return [];
  }
}

export async function enqueue(item: Omit<OutboxItem, 'id' | 'createdAt' | 'attempts' | 'state'> & { id?: string }): Promise<OutboxItem> {
  const row: OutboxItem = {
    id: item.id ?? newKey(),
    formCode: item.formCode, formNameFa: item.formNameFa, data: item.data, asDraft: item.asDraft,
    createdAt: Date.now(), attempts: 0, state: 'QUEUED',
  };
  await (await store()).put(row);
  announce();
  return row;
}

export async function updateItem(id: string, patch: Partial<OutboxItem>): Promise<void> {
  const s = await store();
  const current = await s.get(id);
  if (!current) return;
  await s.put({ ...current, ...patch });
  announce();
}

export async function removeItem(id: string): Promise<void> {
  await (await store()).remove(id);
  announce();
}

/** Tests and sign-out: forget which storage was chosen and start again. */
export function resetOutboxStore(): void { cached = null; memory.clear(); }

export async function clearSent(): Promise<void> {
  for (const item of await listOutbox()) if (item.state === 'SENT') await removeItem(item.id);
}

/** Whether the queue holds anything the person still has to think about. */
/**
 * The queue changed. A screen showing it should not have to poll to find out — and cannot rely
 * on a refetch interval, which browsers pause when the tab is not in front.
 */
export const OUTBOX_EVENT = 'hiva:outbox';
const announce = () => {
  try { window.dispatchEvent(new CustomEvent(OUTBOX_EVENT)); } catch { /* not a browser */ }
};

export const pendingCount = (items: OutboxItem[]) =>
  items.filter((i) => i.state === 'QUEUED' || i.state === 'SENDING' || i.state === 'REJECTED').length;
