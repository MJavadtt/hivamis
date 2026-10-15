/**
 * The page's offline copy (audit F-7): what a person reads in the field — their work, their tasks,
 * their projects, who they are — kept on the device so the app still opens without a connection.
 *
 * - Encrypted with AES-GCM under a key derived from this sign-in (`offlineKey`, from /auth/me),
 *   held as a key the page cannot read back out. A new sign-in has another key, and the copy the
 *   old one left is dropped rather than read.
 * - Per person: one device's copies of two people never mix.
 * - Wiped on sign-out, and when the server says the sign-in is over.
 *
 * IndexedDB where the browser has it; memory otherwise (a private window, a test) — the app then
 * simply has no copy once the tab is closed.
 */

interface Sealed { id: string; iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer; savedAt: number }
interface KeyRow { userId: string; tag: string; key: CryptoKey }
interface Backend {
  getKey(userId: string): Promise<KeyRow | undefined>;
  putKey(row: KeyRow): Promise<void>;
  get(id: string): Promise<Sealed | undefined>;
  put(row: Sealed): Promise<void>;
  dropUser(userId: string): Promise<void>;
  last(): Promise<string | undefined>;
  setLast(userId: string): Promise<void>;
  wipe(): Promise<void>;
}

const DB = 'hiva.vault';

function idbBackend(): Backend | null {
  if (typeof indexedDB === 'undefined') return null;
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('keys', { keyPath: 'userId' });
      db.createObjectStore('data', { keyPath: 'id' });
      db.createObjectStore('meta', { keyPath: 'name' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async <T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      if (req) { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }
      tx.oncomplete = () => { db.close(); if (!req) resolve(undefined as T); };
      tx.onerror = () => reject(tx.error);
    });
  };
  return {
    getKey: (userId) => run('keys', 'readonly', (s) => s.get(userId) as IDBRequest<KeyRow | undefined>),
    putKey: async (row) => { await run('keys', 'readwrite', (s) => s.put(row)); },
    get: (id) => run('data', 'readonly', (s) => s.get(id) as IDBRequest<Sealed | undefined>),
    put: async (row) => { await run('data', 'readwrite', (s) => s.put(row)); },
    dropUser: async (userId) => {
      await run('data', 'readwrite', (s) => { s.delete(IDBKeyRange.bound(`${userId}:`, `${userId}:￿`)); });
      await run('keys', 'readwrite', (s) => { s.delete(userId); });
    },
    last: async () => (await run('meta', 'readonly', (s) => s.get('last') as IDBRequest<{ userId: string } | undefined>))?.userId,
    setLast: async (userId) => { await run('meta', 'readwrite', (s) => s.put({ name: 'last', userId })); },
    wipe: () => new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    }),
  };
}

function memoryBackend(): Backend {
  const keys = new Map<string, KeyRow>();
  const data = new Map<string, Sealed>();
  let lastUser: string | undefined;
  return {
    getKey: async (u) => keys.get(u),
    putKey: async (r) => { keys.set(r.userId, r); },
    get: async (id) => data.get(id),
    put: async (r) => { data.set(r.id, r); },
    dropUser: async (u) => { for (const id of [...data.keys()]) if (id.startsWith(`${u}:`)) data.delete(id); keys.delete(u); },
    last: async () => lastUser,
    setLast: async (u) => { lastUser = u; },
    wipe: async () => { keys.clear(); data.clear(); lastUser = undefined; },
  };
}

let backend: Backend | null = null;
const store = (): Backend => (backend ??= idbBackend() ?? memoryBackend());
let current: { userId: string; key: CryptoKey } | null = null;

const subtle = () => (typeof crypto !== 'undefined' ? crypto.subtle : undefined);
const fromB64url = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Opens this person's copy under this sign-in's key; a copy from another sign-in is dropped first. */
export async function openVault(userId: string, offlineKey: string | null | undefined): Promise<boolean> {
  const s = subtle();
  if (!s || !offlineKey) { current = null; return false; }
  try {
    const raw = fromB64url(offlineKey);
    const tag = hex(await s.digest('SHA-256', raw)).slice(0, 16);
    const db = store();
    const known = await db.getKey(userId);
    let key = known?.tag === tag ? known.key : null;
    if (!key) {
      if (known) await db.dropUser(userId);
      key = await s.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
      await db.putKey({ userId, tag, key });
    }
    await db.setLast(userId);
    current = { userId, key };
    return true;
  } catch {
    current = null;
    return false;
  }
}

/** Offline at start-up: the copy of whoever used this device last, if its key is still here. */
export async function resumeVault(): Promise<string | null> {
  try {
    const db = store();
    const userId = await db.last();
    const row = userId ? await db.getKey(userId) : undefined;
    if (!userId || !row) return null;
    current = { userId, key: row.key };
    return userId;
  } catch { return null; }
}

export async function vaultPut(name: string, value: unknown): Promise<void> {
  const s = subtle();
  if (!s || !current) return;
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await s.encrypt({ name: 'AES-GCM', iv }, current.key, new TextEncoder().encode(JSON.stringify(value)));
    await store().put({ id: `${current.userId}:${name}`, iv, data, savedAt: Date.now() });
  } catch { /* a copy not kept is a copy not shown offline; the page works on */ }
}

export async function vaultGet<T>(name: string): Promise<{ value: T; savedAt: number } | null> {
  const s = subtle();
  if (!s || !current) return null;
  try {
    const row = await store().get(`${current.userId}:${name}`);
    if (!row) return null;
    const plain = await s.decrypt({ name: 'AES-GCM', iv: row.iv }, current.key, row.data);
    return { value: JSON.parse(new TextDecoder().decode(plain)) as T, savedAt: row.savedAt };
  } catch { return null; }
}

/** Sign-out, or a sign-in the server ended: nothing of it stays on the device. */
export async function wipeVault(): Promise<void> {
  current = null;
  try { await store().wipe(); } catch { /* nothing to wipe */ }
  backend = null;
}

/** Whose copy is open — for the outbox, which sends only a person's own queue. */
export const vaultUser = () => current?.userId ?? null;
