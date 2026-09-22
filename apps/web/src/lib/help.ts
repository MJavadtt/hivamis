// Imported at build time from the single source in docs/, so the in-app help and the written
// guide cannot drift. Editing docs/user-guide.md updates both.
import guideSource from '../../../../docs/user-guide.md?raw';

export interface HelpSection {
  /** The `##` heading, used as the section id and title. */
  title: string;
  body: string;
}

/** Split the guide on its level-2 headings; the preamble before the first one is dropped. */
export const HELP_SECTIONS: HelpSection[] = guideSource
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

/** Persian headings for the sections, since the guide itself is written in English. */
export const SECTION_TITLE_FA: Record<string, string> = {
  'Signing in': 'ورود به سامانه',
  'Your queue — «کارهای من»': 'کارهای من',
  Sales: 'فروش',
  Account: 'اکانت',
  'Execution units (Strategy, Creative, Media, Digital)': 'واحدهای اجرایی',
  Finance: 'مالی',
  Legal: 'حقوقی',
  'PMO / Operations': 'عملیات / PMO',
  Management: 'مدیریت',
  Forms: 'فرم‌ها',
  'Organisational memory': 'حافظهٔ سازمان',
  'The AI assistant': 'دستیار هوشمند',
  'When the system blocks you': 'وقتی سامانه مانع می‌شود',
};
