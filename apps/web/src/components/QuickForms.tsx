import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, useSystemAdmin } from '../lib/auth';
import { QuickCreateForm, RECORD_KINDS, type RecordKind } from './QuickCreate';
import { OpenForm, useSuggestions, type Suggestion } from './SuggestedForms';
import { loc, tr } from '../i18n';

/**
 * «+» in the top bar (Hivamis task 4b): the forms this person sends most — or, before they have sent
 * any, the ones that start something — one click from anywhere.
 */
export function QuickForms() {
  const { can } = useAuth();
  const systemAdmin = useSystemAdmin();
  const [creating, setCreating] = useState<RecordKind | null>(null);
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

  if (!can('form.read') && !systemAdmin) return null;
  const sections = [...new Set(RECORD_KINDS.map((k) => k.section))];
  return (
    <div ref={box} data-tour="quick-forms" className="relative">
      <button
        type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={tr('فرم تازه')} title={tr('فرم تازه')}
        className="btn-accent grid size-8 place-items-center rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
      >
        <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 5v14M5 12h14" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <div role="menu" aria-label={tr('فرم تازه')} className="bg-panel absolute end-0 top-10 z-40 max-h-[80vh] w-72 overflow-y-auto rounded-xl py-2 shadow-glass ring-1 ring-edge" data-testid="quick-forms">
          {/* Anything, from anywhere — the system administrator's, without the steps before it (2026-10-28). */}
          {systemAdmin && (
            <div className="mb-1 border-b border-ink-100 pb-1" data-testid="quick-create">
              <p className="px-3 pb-1 text-[12.5px] font-medium text-ink-500">{tr('افزودن مستقیم')}</p>
              {sections.map((sec) => (
                <div key={sec}>
                  <p className="px-3 pt-1 text-xs text-ink-400">{sec}</p>
                  {RECORD_KINDS.filter((k) => k.section === sec).map((k) => (
                    <button key={k.key} type="button" role="menuitem" onClick={() => { setOpen(false); setCreating(k); }}
                      className="block w-full px-3 py-1.5 text-start text-sm text-ink-800 hover:bg-ink-50">{k.label}</button>
                  ))}
                </div>
              ))}
              <p className="px-3 pt-1 text-xs text-ink-400">{tr('مکان‌ها و اجاره‌داری')}</p>
              <Link to="/sites/venues?new=1" role="menuitem" onClick={() => setOpen(false)} className="block px-3 py-1.5 text-sm text-ink-800 hover:bg-ink-50">{tr('مکان')}</Link>
              <Link to="/sites/projects?new=1" role="menuitem" onClick={() => setOpen(false)} className="block px-3 py-1.5 text-sm text-ink-800 hover:bg-ink-50">{tr('پروژهٔ استقرار')}</Link>
            </div>
          )}
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
      {creating && <QuickCreateForm kind={creating} onClose={() => setCreating(null)} />}
    </div>
  );
}
