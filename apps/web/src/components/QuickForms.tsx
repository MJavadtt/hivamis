import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { OpenForm, useSuggestions, type Suggestion } from './SuggestedForms';
import { loc, tr } from '../i18n';

/**
 * «+» in the top bar (Hivamis task 4b): the forms this person sends most — or, before they have sent
 * any, the ones that start something — one click from anywhere.
 */
export function QuickForms() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Suggestion | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const { data } = useSuggestions(undefined, undefined, 8);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  if (!can('form.read')) return null;
  return (
    <div ref={box} data-tour="quick-forms" className="relative">
      <button
        type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={tr('فرم تازه')} title={tr('فرم تازه')}
        className="btn-accent grid size-8 place-items-center rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
      >
        <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 5v14M5 12h14" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <div role="menu" aria-label={tr('فرم تازه')} className="bg-panel absolute end-0 top-10 z-40 w-72 rounded-xl py-2 shadow-glass ring-1 ring-edge" data-testid="quick-forms">
          <p className="px-3 pb-1 text-[12.5px] font-medium text-ink-500">{tr('فرم‌هایی که بیشتر می‌فرستید')}</p>
          {(data?.forms ?? []).map((f) => (
            <button key={f.code} type="button" role="menuitem" onClick={() => { setOpen(false); setForm(f); }}
              className="block w-full px-3 py-2 text-start text-sm text-ink-800 hover:bg-ink-50">
              {loc(f, 'name')}
            </button>
          ))}
          <Link to="/forms" role="menuitem" onClick={() => setOpen(false)} className="mt-1 block border-t border-ink-100 px-3 pt-2 text-xs text-brand-700 hover:underline">
            {tr('همهٔ فرم‌ها')}
          </Link>
        </div>
      )}
      <OpenForm suggestion={form} onClose={() => setForm(null)} />
    </div>
  );
}
