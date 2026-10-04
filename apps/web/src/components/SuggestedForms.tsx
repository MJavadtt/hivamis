import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate } from '../lib/format';
import { cx } from './ui';
import { loc, tr } from '../i18n';

/**
 * The forms a record's page offers, one click from filled (Hivamis task 4b): those its stage calls
 * for first, each opening with the record — and its project, client, contract — already in it.
 */

export interface Suggestion {
  code: string; nameFa: string; nameEn: string; category: string;
  prefill: Record<string, string>; fitsStage: boolean; unitUses: number; lastForRecord: string | null;
}

const FormByCode = lazy(() => import('../pages/Forms').then((m) => ({ default: m.FormByCode })));

export function useSuggestions(entity?: string, id?: string, limit = 6) {
  const { can } = useAuth();
  return useQuery<{ state: string | null; total: number | null; forms: Suggestion[] }>({
    queryKey: ['/forms/suggest', entity ?? null, id ?? null, limit],
    queryFn: () => apiGet('/forms/suggest', { entity, id, limit: String(limit) }),
    enabled: can('form.read') && (!entity || !!id),
    staleTime: 60_000,
  });
}

/** Opens a suggested form; mounted only while one is open. */
export function OpenForm({ suggestion, onClose }: { suggestion: Suggestion | null; onClose: () => void }) {
  if (!suggestion) return null;
  return (
    <Suspense fallback={null}>
      <FormByCode code={suggestion.code} initial={suggestion.prefill} onClose={onClose} />
    </Suspense>
  );
}

export function SuggestedForms({ entity, id }: { entity: string; id: string | undefined }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<Suggestion | null>(null);
  const { data } = useSuggestions(entity, id, all ? 30 : 6);
  if (!data?.forms?.length) return null;
  return (
    <div className="mx-5 mt-3 flex flex-wrap items-center gap-2" data-testid="suggested-forms">
      <span className="text-xs font-medium text-ink-500">{tr('فرم‌های مرتبط:')}</span>
      {data.forms.map((f) => (
        <button
          key={f.code} type="button" onClick={() => setOpen(f)}
          title={f.lastForRecord ? tr('آخرین بار برای همین رکورد: {0}', formatDate(f.lastForRecord)) : undefined}
          className={cx('rounded-full px-3 py-1 text-xs ring-1 ring-inset transition hover:bg-brand-50 hover:text-brand-800',
            f.fitsStage ? 'bg-brand-50/60 text-brand-800 ring-brand-200' : 'bg-surface text-ink-700 ring-ink-200')}
        >
          {loc(f, 'name')}
          {f.lastForRecord && <span aria-hidden className="ms-1 text-[10px] text-ink-400">✓</span>}
        </button>
      ))}
      {(data.total ?? 0) > data.forms.length && (
        <button type="button" onClick={() => setAll(true)} className="text-xs text-brand-700 underline">{tr('همهٔ فرم‌های مرتبط ({0})', String(data.total))}</button>
      )}
      <OpenForm suggestion={open} onClose={() => setOpen(null)} />
    </div>
  );
}
