import { describe, it, expect } from 'vitest';
import { GUIDE_EN, GUIDE_FA, HELP_SECTIONS, findSection, sectionForRoles } from '../src/lib/help';

/**
 * The drawer's content is imported from docs/user-guide.md at build time, so these assert the
 * parse rather than a copy — if the guide is restructured, this fails instead of the UI quietly
 * rendering an empty panel.
 */
describe('In-app help', () => {
  it('parses the guide into sections with content', () => {
    expect(HELP_SECTIONS.length).toBeGreaterThanOrEqual(10);
    for (const s of HELP_SECTIONS) {
      expect(s.title.length, s.title).toBeGreaterThan(0);
      expect(s.body.length, `${s.title} has no body`).toBeGreaterThan(20);
      // The `---` separators are document layout, not content.
      expect(s.body.endsWith('---')).toBe(false);
    }
  });

  it('routes every role to a section that exists', () => {
    const roles = [
      'SALES_REP', 'SALES_MANAGER', 'ACCOUNT_MANAGER', 'ACCOUNT_EXEC',
      'UNIT_MANAGER', 'UNIT_MEMBER', 'FINANCE_MANAGER', 'LEGAL_MANAGER',
      'PMO_MANAGER', 'CEO', 'DEPUTY',
    ];
    for (const r of roles) {
      const title = sectionForRoles([r]);
      expect(title, `${r} has no section`).toBeTruthy();
      expect(findSection(title), `${r} → "${title}" not found in the guide`).toBeTruthy();
    }
  });

  it('leaves an unmapped role without a forced section', () => {
    // VIEWER and SUPER_ADMIN read across the guide; the drawer opens at the top for them.
    expect(sectionForRoles(['VIEWER'])).toBeUndefined();
    expect(findSection(undefined)).toBeUndefined();
  });

  it('reads the guide in Persian to a Persian reader, section for section', () => {
    // The Persian edition is paired with the English one by position: a section added to one and
    // not the other would shift every heading after it onto the wrong body.
    expect(GUIDE_FA.length, 'docs/user-guide.fa.md has a different number of sections').toBe(GUIDE_EN.length);
    for (const s of HELP_SECTIONS) {
      expect(s.heading, s.title).not.toBe(s.title);
      // A Persian reader gets Persian prose, not the English guide with Persian labels in it.
      const latin = (s.body.match(/[A-Za-z]/g) ?? []).length;
      const persian = (s.body.match(/[\u0600-\u06FF]/g) ?? []).length;
      expect(persian, `${s.heading} reads mostly in English`).toBeGreaterThan(latin * 4);
    }
    expect(findSection('Sales')?.heading).toBe('فروش');
  });

  it('keeps the two editions in step: lists, quotes and sub-headings in the same places', () => {
    for (const [i, en] of GUIDE_EN.entries()) {
      const fa = GUIDE_FA[i]!;
      const shape = (b: string) => ({
        numbered: (b.match(/^\d+\. /gm) ?? []).length,
        bullets: (b.match(/^- /gm) ?? []).length,
        quotes: (b.match(/^> /gm) ?? []).length,
        subheadings: (b.match(/^### /gm) ?? []).length,
      });
      expect(shape(fa.body), `${en.title} ↔ ${fa.title}`).toEqual(shape(en.body));
    }
  });

  it('exposes the sections the contextual links point at', () => {
    expect(findSection('Forms')).toBeTruthy();
    expect(findSection('When the system blocks you')).toBeTruthy();
  });
});
