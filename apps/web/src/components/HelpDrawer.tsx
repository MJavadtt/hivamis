import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { useDismissable, useFocusTrap } from '../hooks/useDismissable';
import {
  HELP_SECTIONS, SECTION_TITLE_FA, findSection, sectionForRoles, type HelpSection,
} from '../lib/help';
import { cx } from './ui';

/**
 * The written guide, surfaced where people are rather than in a file nobody opens.
 *
 * Content comes from docs/user-guide.md at build time, so there is one source: editing the
 * guide updates the drawer. It opens on the section matching the signed-in user's role.
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

  return (
    <div className="fixed inset-0 z-50 flex justify-start bg-ink-900/40 backdrop-blur-[2px]">
      <div className="absolute inset-0" aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="راهنمای کاربری"
        className="animate-in relative flex h-full w-full max-w-xl flex-col bg-surface shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-ink-100 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-ink-800">راهنمای کاربری</h2>
          <button
            onClick={onClose}
            aria-label="بستن راهنما"
            className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-600
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
          >
            ✕
          </button>
        </header>

        <nav aria-label="بخش‌های راهنما" className="shrink-0 border-b border-ink-100 px-3 py-2">
          <ul className="flex flex-wrap gap-1">
            {HELP_SECTIONS.map((s) => (
              <li key={s.title}>
                <button
                  onClick={() => setActive(s)}
                  aria-current={active?.title === s.title ? 'true' : undefined}
                  className={cx(
                    'rounded-lg px-2.5 py-1 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500',
                    active?.title === s.title
                      ? 'bg-brand-600 font-medium text-white'
                      : 'text-ink-600 hover:bg-ink-100',
                  )}
                >
                  {SECTION_TITLE_FA[s.title] ?? s.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {active && (
            <>
              <h3 className="mb-3 text-sm font-semibold text-ink-800">
                {SECTION_TITLE_FA[active.title] ?? active.title}
              </h3>
              <Markdown source={active.body} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Renders the small subset of markdown the guide actually uses: headings, ordered and unordered
 * lists, bold, inline code and paragraphs. A full parser would be a dependency for four constructs.
 */
function Markdown({ source }: { source: string }) {
  const blocks = source.split(/\n{2,}/);
  return (
    <div className="ltr space-y-3 text-left text-[13px] leading-7 text-ink-700">
      {blocks.map((block, i) => {
        const lines = block.split('\n');

        if (block.startsWith('### ')) {
          return <h4 key={i} className="pt-1 text-[13px] font-semibold text-ink-800">{inline(block.slice(4))}</h4>;
        }
        if (/^\d+\.\s/.test(block)) {
          return (
            <ol key={i} className="list-decimal space-y-1.5 ps-5">
              {splitItems(lines, /^\d+\.\s/).map((item, j) => <li key={j}>{inline(item)}</li>)}
            </ol>
          );
        }
        if (block.startsWith('- ')) {
          return (
            <ul key={i} className="list-disc space-y-1.5 ps-5">
              {splitItems(lines, /^-\s/).map((item, j) => <li key={j}>{inline(item)}</li>)}
            </ul>
          );
        }
        return <p key={i}>{inline(block.replace(/\n/g, ' '))}</p>;
      })}
    </div>
  );
}

/** Joins continuation lines back onto their list item — the guide wraps at 100 columns. */
function splitItems(lines: string[], marker: RegExp): string[] {
  const items: string[] = [];
  for (const line of lines) {
    if (marker.test(line.trim())) items.push(line.trim().replace(marker, ''));
    else if (items.length) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

function inline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="font-semibold text-ink-800">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="rounded bg-ink-100 px-1 py-0.5 text-[11px]">{part.slice(1, -1)}</code>;
    }
    return part;
  });
}
