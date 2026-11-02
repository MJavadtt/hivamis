import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PRIORITY_LEVELS, stateLabelFa, type DepartmentCode } from '@hiva/contracts';
import { apiGet, apiPost } from '../lib/api';
import { JalaliDateInput } from './JalaliDateInput';
import { Button, Field, Input, Select, Textarea, useToast } from './ui';
import { tr, trx } from '../i18n';

/**
 * An order to a unit, its required parts asked as questions (ADR-114) and filled with whatever the page
 * already knows — the brief for a proposal's order, the contract for an execution order (ADR-120). The
 * owner is chosen from the unit's own people. The order is written as a draft; its «صدور» sends it.
 */

export interface OrderDefaults { title: string; scopeOfWork: string; brief: string; expectedOutput: string; outputFormat?: string; deadline: string }
interface Person { id: string; fullName: string; jobTitle: string | null; department: { code: string } | null }

export function UnitOrderForm({ unit, projectId, proposalId, defaults, onClose, onDone }: {
  unit: DepartmentCode; projectId: string; proposalId?: string; defaults: OrderDefaults;
  onClose: () => void; onDone: (order: { id: string; code: string }) => void;
}) {
  const people = useQuery<Person[]>({ queryKey: ['/people', ''], queryFn: () => apiGet('/people') });
  const inUnit = (people.data ?? []).filter((x) => x.department?.code === unit);
  const toast = useToast();
  const [v, setV] = useState({ ...defaults, outputFormat: defaults.outputFormat ?? '', ownerId: '', priority: 'NORMAL' });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v, value: string) => setV((x) => ({ ...x, [k]: value }));
  const ready = v.title.trim().length >= 2 && v.scopeOfWork.trim().length >= 2 && v.brief.trim().length >= 2 && v.expectedOutput.trim().length >= 2 && !!v.outputFormat.trim() && !!v.deadline && !!v.ownerId;
  const save = async () => {
    setBusy(true);
    try {
      const order = await apiPost<{ id: string; code: string }>('/work-orders', {
        projectId, proposalId, targetDepartmentCode: unit, title: v.title.trim(), scopeOfWork: v.scopeOfWork.trim(), brief: v.brief.trim(),
        expectedOutput: v.expectedOutput.trim(), outputFormat: v.outputFormat.trim(), deadline: v.deadline, ownerId: v.ownerId, priority: v.priority,
      });
      toast(tr('سفارش نوشته شد. با «صدور سفارش» به واحد می‌رسد.'));
      onClose(); onDone(order);
    } catch (e: any) { toast(e?.message ?? tr('ذخیره ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  return (
    <div className="mt-2 grid gap-3 rounded-lg bg-surface p-3 ring-1 ring-edge sm:grid-cols-2" data-testid="order-form">
      <div className="sm:col-span-2"><Field label={tr('عنوان سفارش')} required><Input value={v.title} onChange={(e) => set('title', e.target.value)} aria-label={tr('عنوان سفارش')} /></Field></div>
      <Field label={tr('چه کاری باید انجام شود؟')} required><Textarea value={v.scopeOfWork} onChange={(e) => set('scopeOfWork', e.target.value)} rows={2} aria-label={tr('شرح کار')} /></Field>
      <Field label={tr('برای چه؟ (بریف واحد)')} required><Textarea value={v.brief} onChange={(e) => set('brief', e.target.value)} rows={2} aria-label={tr('بریف واحد')} /></Field>
      <Field label={tr('چه چیزی تحویل می‌دهد؟')} required><Textarea value={v.expectedOutput} onChange={(e) => set('expectedOutput', e.target.value)} rows={2} aria-label={tr('خروجی مورد انتظار')} /></Field>
      <Field label={tr('در چه قالبی؟')} required hint={tr('مثلاً: فایل لایه‌باز و PDF')}><Input value={v.outputFormat} onChange={(e) => set('outputFormat', e.target.value)} aria-label={tr('قالب خروجی')} /></Field>
      <Field label={tr('تا کی؟')} required><JalaliDateInput mode="date" value={v.deadline || null} onChange={(d) => set('deadline', d)} label={tr('مهلت سفارش')} /></Field>
      <Field label={tr('مسئول در واحد')} required>
        <Select value={v.ownerId} onChange={(e) => set('ownerId', e.target.value)} aria-label={tr('مسئول سفارش')}>
          <option value="">{tr('— برگزینید —')}</option>
          {(inUnit.length ? inUnit : people.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.jobTitle ? `${x.fullName} — ${x.jobTitle}` : x.fullName}</option>)}
        </Select>
      </Field>
      <Field label={tr('فوریت')}>
        <Select value={v.priority} onChange={(e) => set('priority', e.target.value)} aria-label={tr('فوریت سفارش')}>
          {PRIORITY_LEVELS.map((l) => <option key={l} value={l}>{trx(stateLabelFa(l))}</option>)}
        </Select>
      </Field>
      <div className="sm:col-span-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
        <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void save()}>{tr('ذخیرهٔ سفارش')}</Button>
      </div>
    </div>
  );
}
