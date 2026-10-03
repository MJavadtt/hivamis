import { describe, it, expect } from 'vitest';
import { HELP_SECTIONS, findSection, sectionForRoles, sectionTitle } from '../src/lib/help';

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

  it('has a Persian heading for every section', () => {
    // In Persian, a section with no Persian heading would show its English one.
    const missing = HELP_SECTIONS.filter((s) => sectionTitle(s.title) === s.title).map((s) => s.title);
    expect(missing, `sections without a Persian heading: ${missing.join(', ')}`).toEqual([]);
  });

  it('exposes the sections the contextual links point at', () => {
    expect(findSection('Forms')).toBeTruthy();
    expect(findSection('When the system blocks you')).toBeTruthy();
  });
});
