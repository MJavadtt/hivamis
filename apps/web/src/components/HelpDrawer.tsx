import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../lib/auth';
import { useDismissable, useFocusTrap } from '../hooks/useDismissable';
import {
  HELP_SECTIONS, findSection, sectionForRoles, type HelpSection,
} from '../lib/help';
import { cx } from './ui';
import { tr } from '../i18n';
import { Markdown } from './Markdown';

/**
 * The written guide, surfaced where people are rather than in a file nobody opens.
 *
 * Content comes from docs/user-guide.md (and, for Persian readers, docs/user-guide.fa.md) at build
 * time, so there is one source per language: editing the guide updates the drawer. It opens on the section matching the signed-in user's role.
 */
export function HelpDrawer({
  open, onClose, initialSection,
}: {
  open: boolean;
  onClose: () => void;
  /** Overrides the role default — used by the contextual links on Forms and QC. */
  initialSection?: string;
}) {
  const { user } = useAuth();
  const roleSection = sectionForRoles(user?.roles ?? []);
  const [active, setActive] = useState<HelpSection | undefined>();

  useEffect(() => {
    if (!open) return;
    setActive(findSection(initialSection) ?? findSection(roleSection) ?? HELP_SECTIONS[0]);
  }, [open, initialSection, roleSection]);

  const panelRef = useDismissable<HTMLDivElement>({ open, onClose });
  useFocusTrap(panelRef, open);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  if (!open) return null;

  // At the root of the page: it is opened from inside cards, and a glass card is the containing box
  // of anything fixed inside it.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-start bg-ink-900/30 scrim">
      <div className="absolute inset-0" aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={tr('راهنمای کاربری')}
        className="bg-panel animate-in relative flex h-full w-full max-w-xl flex-col shadow-2xl ring-1 ring-edge"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-ink-100 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-ink-800">{tr('راهنمای کاربری')}</h2>
          <button
            onClick={onClose}
            aria-label={tr('بستن راهنما')}
            className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-600
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
          >
            ✕
          </button>
        </header>

        <nav aria-label={tr('بخش‌های راهنما')} className="shrink-0 border-b border-ink-100 px-3 py-2">
          <ul className="flex flex-wrap gap-1">
            {HELP_SECTIONS.map((s) => (
              <li key={s.title}>
                <button
                  onClick={() => setActive(s)}
                  aria-current={active?.title === s.title ? 'true' : undefined}
                  className={cx(
                    'rounded-lg px-2.5 py-1 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500',
                    active?.title === s.title
                      ? 'soft-selected font-semibold'
                      : 'text-ink-600 hover:bg-ink-100',
                  )}
                >
                  {s.heading}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {active && (
            <>
              <h3 className="mb-3 text-sm font-semibold text-ink-800">
                {active.heading}
              </h3>
              <Markdown source={active.body} />
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
