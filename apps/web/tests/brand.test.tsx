import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { HIVA_LOGO_SIZE, HIVA_MARK } from '@hiva/contracts';
import { HivaLogo, BrandLockup } from '../src/components/Brand';

/**
 * The owner's logo (2026-10-16), traced into paths: the mark alone, the wordmark with its line, or the
 * whole lockup — each in the text colour, so it is black on the light canvas and white on the dark.
 */
describe('The Hiva logo', () => {
  it('draws the mark, or the whole lockup, in the text colour and named for a screen reader', () => {
    const { container: mark } = render(<HivaLogo kind="mark" className="h-8" />);
    const svg = mark.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${HIVA_MARK.w} ${HIVA_MARK.h}`);
    expect(svg.querySelector('g')!.getAttribute('fill')).toBe('currentColor');
    expect(svg.getAttribute('aria-label')).toBe('Hiva');

    const { container: logo } = render(<HivaLogo />);
    const whole = logo.querySelector('svg')!;
    expect(whole.getAttribute('viewBox')).toBe(`0 0 ${HIVA_LOGO_SIZE.w} ${HIVA_LOGO_SIZE.h}`);
    expect(whole.querySelectorAll('path')).toHaveLength(3); // the mark, «Hiva», «Branding|Creativity»
  });

  it('stands beside the product’s name, and alone when the sidebar is folded', () => {
    expect(render(<BrandLockup />).container.textContent).toBe('هیوامیس');
    expect(render(<BrandLockup compact />).container.textContent).toBe('');
  });
});
