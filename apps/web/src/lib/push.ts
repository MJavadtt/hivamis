import { apiDelete, apiGet, apiPost, api } from './api';
import { tr } from '../i18n';

/**
 * Web Push on this browser (roadmap #49). The service worker receives the notice and shows it; the
 * server only ever holds this browser's endpoint and public keys, so what it sends is readable here
 * and nowhere on the way.
 */

export type PushState =
  | 'unsupported'   // no service worker, Push API or notifications in this browser
  | 'needs-install' // iPhone/iPad: Web Push only from the app added to the home screen
  | 'server-off'    // this installation sends no pushes (PUSH_DELIVERY=off)
  | 'denied'        // the person, or the browser, said no — only the browser's settings undo it
  | 'off'
  | 'on';

export interface PushKey { publicKey: string; delivery: 'on' | 'off' }

const isAppleMobile = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The worker is what receives a push. In production it is already registered; in development, now. */
async function worker(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

async function existingSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

const sameKey = (sub: PushSubscription, key: Uint8Array) => {
  const k = sub.options?.applicationServerKey;
  if (!k) return true; // not every browser reports it; the server will say if it refuses
  const a = new Uint8Array(k);
  return a.length === key.length && a.every((x, i) => x === key[i]);
};

export async function pushState(key: PushKey | undefined): Promise<PushState> {
  if (!pushSupported()) return isAppleMobile() && !isStandalone() ? 'needs-install' : 'unsupported';
  if (key?.delivery === 'off') return 'server-off';
  if (Notification.permission === 'denied') return 'denied';
  return (await existingSubscription()) && Notification.permission === 'granted' ? 'on' : 'off';
}

function announce(sub: PushSubscription) {
  const json = sub.toJSON();
  return apiPost('/push/subscriptions', { endpoint: json.endpoint, keys: json.keys, userAgent: navigator.userAgent.slice(0, 300) });
}

/** A failure from the browser, in words the person can act on. */
export function pushErrorFa(e: unknown): string {
  const name = (e as { name?: string })?.name ?? '';
  const message = (e as { message?: string })?.message ?? '';
  if (name === 'NotAllowedError' || (typeof Notification !== 'undefined' && Notification.permission === 'denied')) {
    return tr('اجازهٔ اعلان داده نشد. اگر پیش‌تر «مسدود» زده‌اید، از تنظیمات سایت در مرورگر باز کنید.');
  }
  if (name === 'AbortError' || /push service/i.test(message)) {
    return tr('این مرورگر به سرویس اعلان خود دسترسی ندارد؛ برخی مرورگرها و شبکه‌ها Web Push را نمی‌رسانند. پیام‌رسان (بخش اتصال پیام‌رسان) راه دیگر است.');
  }
  return message || tr('روشن کردن اعلان ممکن نشد.');
}

/** Ask, subscribe, and tell the server where this browser is. */
export async function enablePush(): Promise<void> {
  const key = await apiGet<PushKey>('/push/key');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw Object.assign(new Error('permission'), { name: 'NotAllowedError' });
  const reg = await worker();
  const applicationServerKey = keyBytes(key.publicKey);
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for another server key would be refused by the push service.
  if (sub && !sameKey(sub, applicationServerKey)) { await sub.unsubscribe(); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  await announce(sub);
}

export async function disablePush(): Promise<void> {
  const sub = await existingSubscription();
  if (!sub) return;
  await api('/push/subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}

/**
 * On every visit: the browser may have renewed its subscription, or the server may have forgotten
 * it (a subscription the service reported gone). Announcing it again costs one request.
 */
export async function reannouncePush(key: PushKey): Promise<void> {
  if (!pushSupported() || key.delivery === 'off' || Notification.permission !== 'granted') return;
  const sub = await existingSubscription();
  if (!sub) return;
  if (!sameKey(sub, keyBytes(key.publicKey))) { await sub.unsubscribe().catch(() => undefined); return; }
  await announce(sub).catch(() => undefined);
}

/**
 * Signing out: this browser stops receiving the person's notices — the next one to sign in on a
 * shared phone must not see them. Never allowed to hold up the sign-out itself.
 */
export async function forgetPushOnSignOut(): Promise<void> {
  if (!pushSupported()) return;
  await Promise.race([disablePush(), new Promise((r) => setTimeout(r, 1500))]).catch(() => undefined);
}

export const removeSubscription = (id: string) => apiDelete(`/push/subscriptions/${id}`);
