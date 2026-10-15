import { useSyncExternalStore } from 'react';

/**
 * Installing the app (audit F-8). Chrome, Edge and Android offer an install prompt once, early — the
 * page keeps it (captured in boot.tsx) so the Install page can offer one click. Safari and Firefox
 * never offer it; for them the page shows the browser's own steps.
 */

interface InstallPrompt extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

let deferred: InstallPrompt | null = null;
let installed = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/** Called once at start-up. */
export function captureInstallPrompt() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    // Kept for the Install page's button rather than shown at a moment nobody chose.
    e.preventDefault();
    deferred = e as InstallPrompt;
    changed();
  });
  window.addEventListener('appinstalled', () => { installed = true; deferred = null; changed(); });
}

export const runningInstalled = () =>
  typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

export type Platform = 'android' | 'ios' | 'windows' | 'mac' | 'linux' | 'other';

/** The platform the steps are for, guessed from the browser; the person can choose another. */
export function platformOf(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent, touchPoints = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints): Platform {
  if (/Android/i.test(ua)) return 'android';
  // An iPad asks for the desktop site and reads as a Mac — with a touch screen.
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && touchPoints > 1)) return 'ios';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/Linux|CrOS/i.test(ua)) return 'linux';
  return 'other';
}

export function useInstall() {
  const snapshot = () => `${!!deferred}:${installed || runningInstalled()}`;
  const state = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, snapshot, () => 'false:false');
  const [canPrompt, isInstalled] = state.split(':').map((x) => x === 'true');
  return {
    canPrompt: !!canPrompt,
    installed: !!isInstalled,
    /** The browser's own dialog; true when the person accepted. */
    prompt: async (): Promise<boolean> => {
      const p = deferred;
      if (!p) return false;
      deferred = null;
      changed();
      await p.prompt();
      return (await p.userChoice).outcome === 'accepted';
    },
  };
}
