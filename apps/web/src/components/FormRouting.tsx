import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLE_CODES, ROLE_LABELS, ROUTING_OPERATOR_LABELS, type RoutingOperator } from '@hiva/contracts';
import { apiGet, apiPut } from '../lib/api';
import { useAction } from '../hooks/queries';
import { Code } from './common';
import { Badge, Button, Card, EmptyState, Field, Input, LoadingBlock, Select, Table, Td, Th, Tr, useToast } from './ui';
import { localDigits } from '../lib/format';
import { loc, pair, tr, trx } from '../i18n';

interface Rule {
  id: string; whenFa: string; describedFa?: string;
  when: { field?: string; op?: RoutingOperator; value?: unknown; all?: unknown[]; any?: unknown[] };
  addApprovers?: string[]; notifyRoles?: string[]; source?: string; docRef?: string; isActive?: boolean;
}
interface Routing {
  formCode: string; nameFa: string; version: number; baseRoles: string[];
  fields: { key: string; labelFa: string; type: string; options: { value: string; labelFa: string }[] | null }[];
  rules: Rule[];
}
const roleFa = (c: string) => pair(ROLE_LABELS[c as keyof typeof ROLE_LABELS]) || c;
const SOURCE_FA: Record<string, string> = { DOC_H: 'Doc_H', DEFAULT: tr('پیش‌فرض سامانه'), ORG: tr('قاعدهٔ سازمان') };
/** Operators an editor can set without writing JSON; grouping (all/any) stays an API affair. */
const SIMPLE_OPS: RoutingOperator[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'in', 'isTrue', 'isFalse', 'isSet', 'isEmpty', 'ltField', 'gtField'];

/**
 * Who must approve a form, beyond the roles Doc_H fixed (roadmap #17). The thresholds the
 * catalogue ships are defaults — this is where an organisation makes them its own. Saving mints
 * a new definition version, so forms already filed keep the rules they were judged under.
 */
export function FormRouting() {
  const [code, setCode] = useState('F47_PRICING');
  const qc = useQueryClient();
  const toast = useToast();
  const { data: catalogue } = useQuery<{ definitions: { code: string; nameFa: string; category: string }[] }>({
    queryKey: ['/forms/definitions'], queryFn: () => apiGet('/forms/definitions'),
  });
  const { data, isLoading } = useQuery<Routing>({
    queryKey: ['/forms/definitions', code, 'routing'], queryFn: () => apiGet(`/forms/definitions/${code}/routing`),
  });
  const [draft, setDraft] = useState<Rule | null>(null);

  const save = useAction(
    (rules: Rule[]) => apiPut(`/forms/definitions/${code}/routing`, { rules, note: tr('ویرایش از پنل مدیریت') }),
    tr('قواعد مسیریابی ذخیره شد — نسخهٔ تازه‌ای از تعریف فرم ساخته شد.'),
  );
  const commit = (rules: Rule[]) =>
    save.mutate(rules, { onSuccess: () => { setDraft(null); void qc.invalidateQueries({ queryKey: ['/forms/definitions', code, 'routing'] }); } });

  const rules = data?.rules ?? [];
  const numeric = (op?: RoutingOperator) => !['isTrue', 'isFalse', 'isSet', 'isEmpty'].includes(op ?? '');

  return (
    <Card
      title={tr('مسیریابی شرطی تأیید')}
      subtitle={tr('تأییدکنندهٔ ثابت هر فرم از Doc_H می‌آید؛ این قواعد بر اساس مقادیر همان فرم، تأییدکننده اضافه می‌کنند. آستانه‌ها پیش‌فرض‌اند و جای تغییرشان همین‌جاست.')}
      action={
        <div className="w-72">
          <Select value={code} onChange={(e) => { setCode(e.target.value); setDraft(null); }} aria-label={tr('فرم')}>
            {(catalogue?.definitions ?? []).map((d) => (
              <option key={d.code} value={d.code}>{d.category} — {loc(d, 'name')}</option>
            ))}
          </Select>
        </div>
      }
    >
      {isLoading || !data ? <LoadingBlock /> : (
        <>
          <p className="px-4 py-2 text-xs text-ink-600">{tr('تأییدکنندهٔ ثابت:')}{' '}<span className="font-medium">{data.baseRoles.map(roleFa).join(tr('، ')) || '—'}</span>
            <Badge tone="neutral" className="ms-2">{tr('نسخهٔ {0}', localDigits(data.version))}</Badge>
          </p>
          {!rules.length ? <EmptyState title={tr('قاعدهٔ شرطی‌ای برای این فرم تعریف نشده')} description={tr('هر فرم بدون قاعده، فقط تأییدکنندهٔ ثابت خود را دارد.')} /> : (
            <Table>
              <thead className="bg-ink-50/60">
                <tr><Th>{tr('شناسه')}</Th><Th>{tr('قاعده')}</Th><Th>{tr('شرط')}</Th><Th>{tr('تأییدکنندهٔ افزوده')}</Th><Th>{tr('برای اطلاع')}</Th><Th>{tr('منبع')}</Th><Th> </Th></tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <Tr key={r.id}>
                    <Td><Code>{r.id}</Code></Td>
                    <Td className="max-w-xs text-xs">{loc(r, 'when')}</Td>
                    <Td className="text-[12.5px] text-ink-500">{loc(r, 'described')}</Td>
                    <Td className="text-xs">{(r.addApprovers ?? []).map(roleFa).join(tr('، ')) || '—'}</Td>
                    <Td className="text-xs">{(r.notifyRoles ?? []).map(roleFa).join(tr('، ')) || '—'}</Td>
                    <Td><Badge tone={r.source === 'DOC_H' ? 'info' : r.source === 'ORG' ? 'success' : 'neutral'}>{SOURCE_FA[r.source ?? 'DEFAULT']}</Badge></Td>
                    <Td>
                      <Button size="sm" variant="ghost" loading={save.isPending}
                        onClick={() => { if (confirm(tr('قاعدهٔ «{0}» حذف شود؟', r.whenFa))) commit(rules.filter((x) => x.id !== r.id)); }}>{tr('حذف')}</Button>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}

          <div className="border-t border-ink-100 px-4 py-3">
            {!draft ? (
              <Button size="sm" variant="secondary" onClick={() => setDraft({ id: '', whenFa: '', when: { field: data.fields[0]?.key, op: 'gt', value: '' }, addApprovers: [] })}>{tr('افزودن قاعده')}</Button>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="routing-draft">
                <Field label={tr('شناسه')} required hint={tr('حروف لاتین، رقم، نقطه — مثل contract.large-value')}>
                  <Input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} className="ltr" aria-label={tr('شناسه')} />
                </Field>
                <Field label={tr('قاعده به زبان فارسی')} required hint={tr('همین جمله هنگام پر کردن فرم و کنار تصمیم دیده می‌شود.')}>
                  <Input value={draft.whenFa} onChange={(e) => setDraft({ ...draft, whenFa: e.target.value })} aria-label={tr('قاعده')} />
                </Field>
                <Field label={tr('فیلد')}>
                  <Select value={String(draft.when.field ?? '')} onChange={(e) => setDraft({ ...draft, when: { ...draft.when, field: e.target.value } })} aria-label={tr('فیلد')}>
                    {data.fields.map((f) => <option key={f.key} value={f.key}>{loc(f, 'label')}</option>)}
                  </Select>
                </Field>
                <Field label={tr('عملگر')}>
                  <Select value={String(draft.when.op ?? 'gt')} onChange={(e) => setDraft({ ...draft, when: { ...draft.when, op: e.target.value as RoutingOperator } })} aria-label={tr('عملگر')}>
                    {SIMPLE_OPS.map((op) => <option key={op} value={op}>{trx(ROUTING_OPERATOR_LABELS[op])}</option>)}
                  </Select>
                </Field>
                {numeric(draft.when.op) && (
                  <Field label={tr('مقدار')} hint={draft.when.op === 'in' ? tr('چند مقدار را با کاما جدا کنید') : draft.when.op?.endsWith('Field') ? tr('کلید فیلد دیگر') : undefined}>
                    <Input value={String(draft.when.value ?? '')} onChange={(e) => setDraft({ ...draft, when: { ...draft.when, value: e.target.value } })} className="ltr" aria-label={tr('مقدار')} />
                  </Field>
                )}
                <Field label={tr('تأییدکنندهٔ افزوده')}>
                  <Select value={draft.addApprovers?.[0] ?? ''} onChange={(e) => setDraft({ ...draft, addApprovers: e.target.value ? [e.target.value] : [] })} aria-label={tr('تأییدکنندهٔ افزوده')}>
                    <option value="">{tr('— بدون تأییدکنندهٔ تازه —')}</option>
                    {ROLE_CODES.map((r) => <option key={r} value={r}>{roleFa(r)}</option>)}
                  </Select>
                </Field>
                <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
                  <Button size="sm" variant="primary" loading={save.isPending}
                    disabled={draft.id.trim().length < 2 || draft.whenFa.trim().length < 5}
                    onClick={() => {
                      const op = draft.when.op ?? 'gt';
                      const raw = String(draft.when.value ?? '').trim();
                      const value = op === 'in'
                        ? raw.split(/[,،]/).map((v) => v.trim()).filter(Boolean)
                        : op.endsWith('Field') || op === 'eq' || op === 'ne'
                          ? raw
                          : Number(raw.replace(/[,٬\s]/g, ''));
                      if (typeof value === 'number' && !Number.isFinite(value)) { toast(tr('مقدار عددی معتبر نیست.'), 'danger'); return; }
                      commit([...rules, { ...draft, id: draft.id.trim(), whenFa: draft.whenFa.trim(), when: { field: draft.when.field, op, ...(['isTrue', 'isFalse', 'isSet', 'isEmpty'].includes(op) ? {} : { value }) } }]);
                    }}>{tr('ذخیره قاعده')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>{tr('انصراف')}</Button>
                  <p className="text-[12.5px] text-ink-500">{tr('ذخیره، نسخهٔ تازه‌ای از تعریف فرم می‌سازد؛ فرم‌های ثبت‌شده با قواعد زمان خودشان می‌مانند.')}</p>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
