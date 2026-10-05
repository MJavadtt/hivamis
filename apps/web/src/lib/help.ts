// Imported at build time from the single source in docs/, so the in-app help and the written
// guide cannot drift. Editing docs/user-guide.md (and its Persian edition, user-guide.fa.md, section
// for section) updates both.
import guideSource from '../../../../docs/user-guide.md?raw';
import guideSourceFa from '../../../../docs/user-guide.fa.md?raw';
import { isEnglish } from '../i18n';

export interface HelpSection {
  /** The English `##` heading: the section's id, whatever language it is read in. */
  title: string;
  /** The heading in the reader's language. */
  heading: string;
  body: string;
}

interface Chunk { title: string; body: string }

/** Split a guide on its level-2 headings; the preamble before the first one is dropped. */
export function parseGuide(source: string): Chunk[] {
  return source
    .split(/^## /m)
    .slice(1)
    .map((chunk) => {
      const nl = chunk.indexOf('\n');
      return {
        title: chunk.slice(0, nl).trim(),
        // Trailing `---` separators are layout for the document, not content for a drawer.
        body: chunk.slice(nl + 1).replace(/\n---\s*$/, '').trim(),
      };
    });
}

export const GUIDE_EN = parseGuide(guideSource);
export const GUIDE_FA = parseGuide(guideSourceFa);

/**
 * The guide in the reader's language. The Persian edition stands section for section with the
 * English one, so the two are paired by position; the English heading stays the id the role
 * defaults and the contextual links name.
 */
export const HELP_SECTIONS: HelpSection[] = GUIDE_EN.map((en, i) => {
  const fa = isEnglish() ? undefined : GUIDE_FA[i];
  return { title: en.title, heading: fa?.title ?? en.title.replace(/\s*—\s*«[^»]*»\s*$/, ''), body: fa?.body ?? en.body };
});

/**
 * Which section a role should land on. Roles not listed here open the guide at the top, which
 * is the right default for management, who read across all of it.
 */
const ROLE_SECTION: Record<string, string> = {
  SALES_MANAGER: 'Sales',
  SALES_REP: 'Sales',
  ACCOUNT_MANAGER: 'Account',
  ACCOUNT_EXEC: 'Account',
  UNIT_MANAGER: 'Execution units (Strategy, Creative, Media, Digital)',
  UNIT_MEMBER: 'Execution units (Strategy, Creative, Media, Digital)',
  FINANCE_MANAGER: 'Finance',
  FINANCE_SPECIALIST: 'Finance',
  LEGAL_MANAGER: 'Legal',
  LEGAL_SPECIALIST: 'Legal',
  PMO_MANAGER: 'PMO / Operations',
  PMO_SPECIALIST: 'PMO / Operations',
  CEO: 'Management',
  DEPUTY: 'Management',
};

export function sectionForRoles(roles: string[]): string | undefined {
  for (const r of roles) if (ROLE_SECTION[r]) return ROLE_SECTION[r];
  return undefined;
}

export function findSection(title: string | undefined): HelpSection | undefined {
  if (!title) return undefined;
  return HELP_SECTIONS.find((s) => s.title === title);
}
