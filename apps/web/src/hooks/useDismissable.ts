import { useEffect, useRef } from 'react';

/**
 * Escape, click-outside and focus restoration for an overlay — one implementation so the three
 * that exist (global search, notifications, modal) behave identically rather than each getting
 * a different subset. Before this, search handled Escape but not focus return, notifications
 * handled neither, and the mobile sidebar stayed in the accessibility tree while closed.
 *
 * Returns the ref to put on the overlay's outermost element.
 */
export function useDismissable<T extends HTMLElement = HTMLDivElement>({
  open, onClose, restoreFocus = true,
}: {
  open: boolean;
  onClose: () => void;
  /** Return focus to whatever opened it. Disable only when the caller moves focus itself. */
  restoreFocus?: boolean;
}) {
  const ref = useRef<T>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    // mousedown, not click: a click that starts inside and ends outside should not dismiss.
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      // Only take focus back if it is still loose inside the overlay we are closing; a caller
      // that deliberately moved focus elsewhere must not have it yanked away.
      if (restoreFocus && opener.current?.isConnected) {
        const active = document.activeElement;
        if (!active || active === document.body || ref.current?.contains(active)) {
          opener.current.focus();
        }
      }
    };
  }, [open, onClose, restoreFocus]);

  return ref;
}

/**
 * Keeps Tab inside an overlay while it is open. Used by the modal and the mobile sidebar, where
 * tabbing out to the page behind leaves the keyboard user somewhere they cannot see.
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
  ref: React.RefObject<T | null>, active: boolean,
) {
  useEffect(() => {
    if (!active || !ref.current) return;
    const root = ref.current;

    // Visibility is checked by attribute rather than by layout: offsetParent is always null
    // under jsdom, which silently emptied this list and left the trap doing nothing in tests.
    const focusables = () => [...root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
      'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((el) =>
      !el.hasAttribute('hidden') &&
      el.getAttribute('aria-hidden') !== 'true' &&
      !el.closest('[inert]'));

    // Move focus in on open, so the first Tab lands inside rather than on the page behind.
    queueMicrotask(() => {
      if (!root.contains(document.activeElement)) focusables()[0]?.focus();
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    root.addEventListener('keydown', onKey);
    return () => root.removeEventListener('keydown', onKey);
  }, [ref, active]);
}
