import { GUIDE, type GuideSection, type GuideText, type Permission } from '@hiva/contracts';
import { isEnglish } from '../i18n';

/**
 * The guide on the page (Hivamis task 8): which sections a person may open, the words in their
 * language, and the two signals the rest of the interface sends — open the guide (the ? in the top
 * bar), play a section's tour — and asks the assistant a question for it.
 */

export const gt = (text: GuideText): string => text[isEnglish() ? 'en' : 'fa'];
export const guideLocale = (): 'fa' | 'en' => (isEnglish() ? 'en' : 'fa');

export function sectionsFor(can: (p: Permission) => boolean, canAny: (...p: Permission[]) => boolean): GuideSection[] {
  return GUIDE.filter((s) => (!s.permission || can(s.permission)) && (!s.anyOf || canAny(...s.anyOf)));
}

/** How long a step stays on screen while the tour plays: time to read it, within reason. */
export const stepDuration = (body: string) => Math.min(14_000, Math.max(4_000, 1_500 + body.length * 60));

/* Per-viewer conveniences: losing them costs a greeting, nothing more. */
const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string | null) => {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private window */ }
};
export const owlPrefs = {
  hidden: () => read('hiva.owl') === 'hidden',
  setHidden: (hidden: boolean) => write('hiva.owl', hidden ? 'hidden' : null),
  greeted: () => read('hiva.owl.greeted') === '1',
  setGreeted: () => write('hiva.owl.greeted', '1'),
};

export type GuideSignal = { type: 'open' } | { type: 'tour'; sectionId: string; step?: number };
const guideTarget = new EventTarget();
export const guideBus = {
  emit: (signal: GuideSignal) => guideTarget.dispatchEvent(new CustomEvent('guide', { detail: signal })),
  on: (fn: (s: GuideSignal) => void) => {
    const h = (e: Event) => fn((e as CustomEvent<GuideSignal>).detail);
    guideTarget.addEventListener('guide', h);
    return () => guideTarget.removeEventListener('guide', h);
  },
};

const assistantTarget = new EventTarget();
export const assistantBus = {
  ask: (question: string) => assistantTarget.dispatchEvent(new CustomEvent('ask', { detail: question })),
  on: (fn: (question: string) => void) => {
    const h = (e: Event) => fn((e as CustomEvent<string>).detail);
    assistantTarget.addEventListener('ask', h);
    return () => assistantTarget.removeEventListener('ask', h);
  },
};
