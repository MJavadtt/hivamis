import { describe, it, expect, beforeEach } from 'vitest';
import { INTRO_LAST_DAY, shouldShowIntro } from '../src/pages/metro/Intro';

/** «هیواترو» (the owner, 2026-11-18): once a day for each person, for one month, then never. */
describe('The metro module\'s opening', () => {
  beforeEach(() => localStorage.clear());

  it('shows once a day for each person, counted in Tehran', () => {
    const morning = new Date('2026-11-20T05:00:00Z');
    expect(shouldShowIntro('u1', morning)).toBe(true);
    localStorage.setItem('hiva.metro.intro.u1', '2026-11-20');
    expect(shouldShowIntro('u1', morning)).toBe(false);
    expect(shouldShowIntro('u2', morning)).toBe(true);
    // 21:00 UTC is already the next day in Tehran.
    expect(shouldShowIntro('u1', new Date('2026-11-20T21:00:00Z'))).toBe(true);
  });

  it('is shown for a month and never after, and not to nobody', () => {
    expect(INTRO_LAST_DAY).toBe('2026-12-17');
    expect(shouldShowIntro('u1', new Date('2026-12-17T08:00:00Z'))).toBe(true);
    expect(shouldShowIntro('u1', new Date('2026-12-18T08:00:00Z'))).toBe(false);
    expect(shouldShowIntro(undefined, new Date('2026-11-20T08:00:00Z'))).toBe(false);
  });
});
