import { useLocation, useNavigate } from 'react-router-dom';
import { isEnglish, tr } from '../i18n';

/**
 * «بازگشت» on every page (the owner, 2026-11-06). It goes where the person came from; a page opened
 * straight from a link or a notification has nowhere behind it, so it goes up to the page above.
 */

/** The page above this one; none for the workspace, which is the top. */
export function parentOf(pathname: string, root = '/'): string | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === root.replace(/\/+$/, '') || path === '/') return null;
  const journey = /^\/sales\/journey\/([^/]+)$/.exec(path);
  if (journey) return `/companies/${journey[1]}`;
  if (path === '/sales/new') return '/leads';
  if (/^\/account\/journey\/[^/]+$/.test(path)) return '/account';
  return path.slice(0, path.lastIndexOf('/')) || root;
}

export function BackButton({ className, root }: { className?: string; root?: string }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const parent = parentOf(pathname, root);
  if (!parent) return null;
  // The router numbers its own entries: above zero, the page before this one is ours.
  const back = () => ((window.history.state?.idx ?? 0) > 0 ? navigate(-1) : navigate(parent));
  return (
    <div className={className}>
      <button type="button" onClick={back} data-testid="back-button"
        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-900">
        <span aria-hidden>{isEnglish() ? '←' : '→'}</span>{tr('بازگشت')}
      </button>
    </div>
  );
}
