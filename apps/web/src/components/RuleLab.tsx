import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ALL_PERMISSIONS, PERMISSIONS, ROLE_CODES, ROLE_LABELS, WORKFLOWS, stateLabelFa } from '@hiva/contracts';
import { apiGet, apiPost } from '../lib/api';
import { Code } from './common';
import { Badge, Button, Card, EmptyState, Field, Select, StatTile, useToast } from './ui';
import { formatDateTime, toPersianDigits } from '../lib/format';

interface Finding { entity: string; entityId: string; action: string; at: string; because: string; detail: string }
interface Result {
  replayed: number; blockedAttempts: number; wouldBlock: Finding[]; wouldAllow: Finding[];
  summary: { wouldBlock: number; wouldAllow: number; byEntity: Record<string, { wouldBlock: number; wouldAllow: number }> };
  assumptions: string[]; invalid: string[];
}
const BECAUSE: Record<string, string> = { ILLEGAL: 'انتقال حذف‌شده', PERMISSION: 'دسترسی', GUARD_ADDED: 'قانون تازه', GUARD_REMOVED: 'قانون حذف‌شده' };

/**
 * Change a rule here, not in the code, and see what it would have done to the last N moves —
 * regression testing for policy. Nothing is written; the result is a list with names on it.
 */
export function RuleLab() {
  const toast = useToast();
  const { data: vocab } = useQuery<{ guards: { id: string; labelFa: string }[] }>({ queryKey: ['/rules/lab/vocabulary'], queryFn: () => apiGet('/rules/lab/vocabulary') });
  const [mode, setMode] = useState<'transition' | 'role'>('transition');
  const [entity, setEntity] = useState('proposal');
  const [action, setAction] = useState('approve');
  const [guards, setGuards] = useState<string[] | null>(null);
  const [permission, setPermission] = useState<string | null | undefined>(undefined);
  const [role, setRole] = useState<string>('SALES_REP');
  const [add, setAdd] = useState<string[]>([]);
  const [remove, setRemove] = useState<string[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  const wf = WORKFLOWS[entity]!;
  const def = wf.transitions.find((t) => t.action === action) ?? wf.transitions[0]!;
  const effectiveGuards = guards ?? [...(def.guards ?? [])];
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const run = async () => {
    setBusy(true);
    try {
      const edits = mode === 'transition'
        ? [{ kind: 'transition', entity, action: def.action, ...(guards ? { guards } : {}), ...(permission !== undefined ? { permission } : {}) }]
        : [{ kind: 'role', role, add, remove }];
      setResult(await apiPost<Result>('/rules/lab', { edits }));
    } catch (e: any) { toast(e?.message ?? 'شبیه‌سازی ناموفق بود.', 'danger'); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <Card title="آزمایشگاه قانون" subtitle="قانون را اینجا تغییر دهید، نه در کد — و ببینید با تاریخچه چه می‌کرد. چیزی ثبت نمی‌شود.">
        <div className="space-y-3 px-4 py-3">
          <div className="flex gap-2">
            <Button size="sm" variant={mode === 'transition' ? 'primary' : 'secondary'} onClick={() => setMode('transition')}>یک انتقال</Button>
            <Button size="sm" variant={mode === 'role' ? 'primary' : 'secondary'} onClick={() => setMode('role')}>یک نقش</Button>
          </div>
          {mode === 'transition' ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="موجودیت">
                  <Select value={entity} onChange={(e) => { setEntity(e.target.value); setAction(WORKFLOWS[e.target.value]!.transitions[0]!.action); setGuards(null); setPermission(undefined); }} aria-label="موجودیت">
                    {Object.entries(WORKFLOWS).map(([k, w]) => <option key={k} value={k}>{w.labelFa}</option>)}
                  </Select>
                </Field>
                <Field label="انتقال">
                  <Select value={def.action} onChange={(e) => { setAction(e.target.value); setGuards(null); setPermission(undefined); }} aria-label="انتقال">
                    {wf.transitions.map((t) => <option key={t.action} value={t.action}>{t.labelFa} ({t.from.map(stateLabelFa).join('/')} ← {stateLabelFa(t.to)})</option>)}
                  </Select>
                </Field>
              </div>
              <Field label="قوانین کنترلی" hint="آنچه تیک دارد در قانون پیشنهادی هست؛ تیک برداشته یعنی حذف‌شده">
                <div className="grid max-h-40 grid-cols-1 gap-1 overflow-auto rounded-lg bg-ink-50/60 p-2 text-xs sm:grid-cols-2" data-testid="lab-guards">
                  {(vocab?.guards ?? []).filter((g) => g.id.startsWith(`${entity}.`) || (def.guards ?? []).includes(g.id)).map((g) => (
                    <label key={g.id} className="flex cursor-pointer items-center gap-2">
                      <input type="checkbox" checked={effectiveGuards.includes(g.id)} onChange={() => toggle(effectiveGuards, setGuards, g.id)} aria-label={g.id} />
                      <span>{g.labelFa}</span>
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="دسترسی لازم" hint={`فعلی: ${def.permission ? (PERMISSIONS as Record<string, string>)[def.permission] : 'هیچ'}`}>
                <Select value={permission === undefined ? (def.permission ?? '') : (permission ?? '')} onChange={(e) => setPermission(e.target.value || null)} aria-label="دسترسی">
                  <option value="">— بدون دسترسی —</option>
                  {ALL_PERMISSIONS.map((p) => <option key={p} value={p}>{(PERMISSIONS as Record<string, string>)[p]}</option>)}
                </Select>
              </Field>
            </>
          ) : (
            <>
              <Field label="نقش">
                <Select value={role} onChange={(e) => { setRole(e.target.value); setAdd([]); setRemove([]); }} aria-label="نقش">
                  {ROLE_CODES.map((r) => <option key={r} value={r}>{(ROLE_LABELS as Record<string, { fa: string }>)[r]?.fa ?? r}</option>)}
                </Select>
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="افزودن دسترسی">
                  <Select value="" onChange={(e) => e.target.value && toggle(add, setAdd, e.target.value)} aria-label="افزودن">
                    <option value="">— انتخاب —</option>
                    {ALL_PERMISSIONS.map((p) => <option key={p} value={p}>{(PERMISSIONS as Record<string, string>)[p]}</option>)}
                  </Select>
                  <p className="mt-1 text-xs text-ink-600">{add.map((p) => (PERMISSIONS as Record<string, string>)[p]).join('، ') || '—'}</p>
                </Field>
                <Field label="حذف دسترسی">
                  <Select value="" onChange={(e) => e.target.value && toggle(remove, setRemove, e.target.value)} aria-label="حذف">
                    <option value="">— انتخاب —</option>
                    {ALL_PERMISSIONS.map((p) => <option key={p} value={p}>{(PERMISSIONS as Record<string, string>)[p]}</option>)}
                  </Select>
                  <p className="mt-1 text-xs text-ink-600">{remove.map((p) => (PERMISSIONS as Record<string, string>)[p]).join('، ') || '—'}</p>
                </Field>
              </div>
            </>
          )}
          <Button variant="primary" loading={busy} onClick={() => void run()}>شبیه‌سازی روی تاریخچه</Button>
        </div>
      </Card>

      {result && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="lab-summary">
            <StatTile label="انتقال‌های بازپخش‌شده" value={toPersianDigits(result.replayed)} />
            <StatTile label="اکنون مسدود می‌شد" value={toPersianDigits(result.summary.wouldBlock)} tone={result.summary.wouldBlock ? 'danger' : 'success'} />
            <StatTile label="اکنون عبور می‌کرد" value={toPersianDigits(result.summary.wouldAllow)} hint={`${toPersianDigits(result.blockedAttempts)} تلاش مسدودشده بررسی شد`} tone={result.summary.wouldAllow ? 'warning' : 'neutral'} />
            <StatTile label="ورودی نامعتبر" value={toPersianDigits(result.invalid.length)} hint={result.invalid[0]} tone={result.invalid.length ? 'danger' : 'success'} />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <FindingList title="اکنون مسدود می‌شد" items={result.wouldBlock} empty="هیچ انتقال گذشته‌ای زیر این قانون مسدود نمی‌شد" testId="would-block" />
            <FindingList title="اکنون عبور می‌کرد" items={result.wouldAllow} empty="هیچ تلاش مسدودشده‌ای زیر این قانون عبور نمی‌کرد" testId="would-allow" />
          </div>
          <Card title="فرض‌های شبیه‌سازی">
            <ul className="space-y-1 px-4 py-3 text-xs text-ink-600">{result.assumptions.map((a, i) => <li key={i}>• {a}</li>)}</ul>
          </Card>
        </>
      )}
    </div>
  );
}

function FindingList({ title, items, empty, testId }: { title: string; items: Finding[]; empty: string; testId: string }) {
  return (
    <Card title={title} subtitle={`${toPersianDigits(items.length)} مورد`}>
      {!items.length ? <EmptyState title={empty} /> : (
        <ul className="max-h-96 divide-y divide-ink-100 overflow-auto" data-testid={testId}>
          {items.slice(0, 100).map((f, i) => (
            <li key={i} className="px-4 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral">{BECAUSE[f.because] ?? f.because}</Badge>
                <span className="text-ink-800">{WORKFLOWS[f.entity]?.labelFa ?? f.entity} · <Code>{f.action}</Code></span>
                <span className="text-ink-400">{formatDateTime(f.at)}</span>
              </div>
              <p className="mt-0.5 text-ink-600">{f.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
