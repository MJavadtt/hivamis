import { describe, it, expect } from 'vitest';
import { hivaSvg, brandFrame, HIVA_TAGLINE, HIVA_WORDMARK } from '@hiva/contracts';
import { docHeader } from '../src/pdf/sections.js';
import { slaBreachMail } from '../src/mail/templates.js';

/**
 * The owner's logo (2026-10-16) on what leaves the screen: the printed masthead carries it as vector;
 * a mail carries it as a PNG on the installation's own address, with alt text for a client that holds
 * images back.
 */
describe('The Hiva logo on documents and mail', () => {
  it('is one SVG source, in any colour and size', () => {
    const svg = hivaSvg('logo', { color: '#0f172a', height: 40 });
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 1484 748"[^>]*height="40" width="79"/);
    expect(svg).toContain('fill="#0f172a"');
    const word = brandFrame('wordmark');
    expect(word.pieces).toEqual([HIVA_WORDMARK, HIVA_TAGLINE]);
    expect(word.y + word.h).toBe(HIVA_TAGLINE.y + HIVA_TAGLINE.h);
  });

  it('heads every printed document', () => {
    const head = docHeader({ title: 'پروپوزال', code: 'PRP-000001' });
    expect(head).toContain('<span class="logo"><svg');
    expect(head).toContain('aria-label="Hiva"');
    expect(head).toContain('هیوامیس — سامانه عملیات سازمانی');
  });

  it('heads every mail, as an image a mail client shows, with words when it does not', () => {
    const mail = slaBreachMail({ policyFa: 'QC واحد', entityFa: 'خروجی', code: 'DLV-000001', url: 'https://hivamis.example/x' });
    expect(mail.html).toMatch(/<img src="[^"]+\/brand\/hiva-logo-email\.png" alt="Hiva"/);
    expect(mail.text).not.toContain('<img');
  });
});
