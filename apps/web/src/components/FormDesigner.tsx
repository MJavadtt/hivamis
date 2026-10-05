import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEPARTMENT_CODES, DEPARTMENT_LABELS, ROLE_CODES, ROLE_LABELS } from '@hiva/contracts';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { useAction } from '../hooks/queries';
import { Code } from './common';
import { FormField } from '../pages/Forms';
import {
  Badge, Button, Card, Checkbox, Field, Input, LoadingBlock, Modal, Select,
  Table, Td, Th, Tr, Textarea, useToast,
} from './ui';
import { formatDateTime, localDigits } from '../lib/format';
import { loc, pair, tr, trx } from '../i18n';

interface DesignerField {
  key: string; labelFa: string; labelEn: string; type: string; required?: boolean;
  options?: { value: string; labelFa: string }[]; entity?: string; helpFa?: string;
  visibleWhen?: { field: string; equals: string[] };
  columns?: DesignerField[];
}
interface Design {
  code: string; nameFa: string; nameEn: string; category: string; module: string; no: number;
  version: number; isCustom: boolean; isActive: boolean; customizedAt: string | null;
  binding: string | null; slaCode: string | null;
  senderDepts: string[]; receiverDepts: string[]; approverRoles: string[]; nextProcessFa: string | null;
  fields: DesignerField[];
  protectedKeys: { key: string; labelFa: string; type: string }[];
  submissions: number;
}

const TYPES: { value: string; labelFa: string }[] = [
  { value: 'text', labelFa: tr('متن کوتاه') }, { value: 'textarea', labelFa: tr('متن بلند') },
  { value: 'number', labelFa: tr('عدد') }, { value: 'currency', labelFa: tr('مبلغ (ریال)') },
  { value: 'percent', labelFa: tr('درصد') }, { value: 'date', labelFa: tr('تاریخ') },
  { value: 'datetime', labelFa: tr('تاریخ و ساعت') }, { value: 'select', labelFa: tr('انتخاب یکی') },
  { value: 'multiselect', labelFa: tr('انتخاب چند') }, { value: 'checkbox', labelFa: tr('تیک') },
  { value: 'user', labelFa: tr('کاربر') }, { value: 'department', labelFa: tr('واحد') },
  { value: 'entityRef', labelFa: tr('ارجاع به رکورد') }, { value: 'attachment', labelFa: tr('پیوست') },
  { value: 'mobile', labelFa: tr('تلفن همراه') },
];
const typeFa = (t: string) => trx(TYPES.find((x) => x.value === t)?.labelFa ?? t);
const deptFa = (c: string) => pair(DEPARTMENT_LABELS[c as keyof typeof DEPARTMENT_LABELS]) || c;
const roleFa = (c: string) => pair(ROLE_LABELS[c as keyof typeof ROLE_LABELS]) || c;

const blank = (): DesignerField => ({ key: '', labelFa: '', labelEn: '', type: 'text', required: false });

/**
 * Building a form without writing TypeScript (roadmap #15). The fields produced here are the
 * same `FieldDef` the Doc_H catalogue declares, so one renderer draws both and one validator
 * judges both — the preview on the right is the real form component, not a mock-up of it.
 *
 * Fields the process depends on are shown locked rather than hidden: an administrator should
 * see that Doc_H's nine order elements exist and why they cannot go.
 */
export function FormDesigner() {
  const [code, setCode] = useState('B11_BRIEF_ANALYSIS');
  const [draft, setDraft] = useState<DesignerField[] | null>(null);
  const [editing, setEditing] = useState<{ index: number; field: DesignerField } | null>(null);
  const [preview, setPreview] = useState<Record<string, unknown>>({});
  const [creating, setCreating] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const qc = useQueryClient();
  const toast = useToast();

  const { data: catalogue } = useQuery<{ definitions: { code: string; nameFa: string; category: string }[] }>({
    queryKey: ['/forms/definitions'], queryFn: () => apiGet('/forms/definitions'),
  });
  const { data, isLoading } = useQuery<Design>({
    queryKey: ['/forms/definitions', code, 'design'],
    queryFn: () => apiGet(`/forms/definitions/${code}/design`),
  });

  const fields = draft ?? data?.fields ?? [];
  const locked = useMemo(() => new Set((data?.protectedKeys ?? []).map((p) => p.key)), [data]);
  const dirty = draft !== null;

  const save = useAction(
    (payload: DesignerField[]) => apiPut(`/forms/definitions/${code}/design`, { fields: payload, note: tr('ویرایش در طراح فرم') }),
    tr('فرم ذخیره شد — نسخهٔ تازه‌ای ساخته شد و فرم‌های ثبت‌شده دست‌نخورده ماندند.'),
  );

  const move = (index: number, delta: number) => {
    const next = [...fields];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setDraft(next);
  };
  const remove = (index: number) => setDraft(fields.filter((_, i) => i !== index));

  const commit = async () => {
    const check = await apiPost<{ ok: boolean; problems: string[] }>(`/forms/definitions/${code}/design/validate`, { fields });
    setProblems(check.problems);
    if (!check.ok) { toast(tr('طراحی هنوز ایراد دارد.'), 'danger'); return; }
    save.mutate(fields, {
      onSuccess: () => { setDraft(null); setProblems([]); void qc.invalidateQueries({ queryKey: ['/forms/definitions'] }); },
    });
  };

  return (
    <div className="space-y-4">
      <Card
        title={tr('طراح فرم')}
        subtitle={tr('فیلدها را بسازید، بچینید و ذخیره کنید — بدون کدنویسی. هر ذخیره نسخهٔ تازه‌ای می‌سازد و فرم‌های ثبت‌شده با نسخهٔ خودشان می‌مانند.')}
        action={
          <div className="flex items-center gap-2">
            <div className="w-64">
              <Select value={code} onChange={(e) => { setCode(e.target.value); setDraft(null); setProblems([]); }} aria-label={tr('فرم')}>
                {(catalogue?.definitions ?? []).map((d) => (
                  <option key={d.code} value={d.code}>{d.category} — {loc(d, 'name')}</option>
                ))}
              </Select>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>{tr('فرم تازه')}</Button>
          </div>
        }
      >
        {isLoading || !data ? <LoadingBlock /> : (
          <>
            <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs text-ink-600">
              <Code>{data.code}</Code>
              <Badge tone="neutral">{tr('نسخهٔ {0}', localDigits(data.version))}</Badge>
              <Badge tone={data.isCustom ? 'success' : 'info'}>{data.isCustom ? tr('فرم این سازمان') : tr('فرم شمارهٔ {0} Doc_H', localDigits(data.no))}</Badge>
              {data.binding && <Badge tone="warning">{tr('رکورد می‌سازد: {0}', data.binding)}</Badge>}
              <span>{tr('{0} فرم ثبت‌شده', localDigits(data.submissions))}</span>
              {data.customizedAt && <span className="text-ink-400">{tr('آخرین ویرایش سازمان: {0}', formatDateTime(data.customizedAt))}</span>}
              <span className="ms-auto">{tr('از {0} به {1} · تأیید: {2}', data.senderDepts.map(deptFa).join(tr('، ')) || '—', data.receiverDepts.map(deptFa).join(tr('، ')) || '—', data.approverRoles.map(roleFa).join(tr('، ')) || '—')}</span>
            </div>

            {problems.length > 0 && (
              <ul className="mx-4 mb-2 space-y-0.5 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800" data-testid="design-problems">
                {problems.map((p, i) => <li key={i}>· {p}</li>)}
              </ul>
            )}

            <div className="grid gap-4 px-4 pb-4 lg:grid-cols-2">
              <div>
                <Table>
                  <thead className="bg-ink-50/60">
                    <tr><Th>{tr('ترتیب')}</Th><Th>{tr('عنوان')}</Th><Th>{tr('کلید')}</Th><Th>{tr('نوع')}</Th><Th>{tr('الزامی')}</Th><Th> </Th></tr>
                  </thead>
                  <tbody data-testid="designer-fields">
                    {fields.map((f, i) => (
                      <Tr key={`${f.key}-${i}`}>
                        <Td>
                          <div className="flex gap-0.5">
                            <button type="button" className="text-ink-400 hover:text-ink-700" onClick={() => move(i, -1)} aria-label={tr('انتقال «{0}» به بالا', f.labelFa)}>▲</button>
                            <button type="button" className="text-ink-400 hover:text-ink-700" onClick={() => move(i, 1)} aria-label={tr('انتقال «{0}» به پایین', f.labelFa)}>▼</button>
                          </div>
                        </Td>
                        <Td className="text-sm">
                          {loc(f, 'label')}
                          {locked.has(f.key) && <Badge tone="info" className="ms-1">{tr('الزام فرآیند')}</Badge>}
                          {f.visibleWhen && <span className="block text-[12.5px] text-ink-400">{tr('وابسته به «{0}»', fields.find((x) => x.key === f.visibleWhen!.field)?.labelFa ?? f.visibleWhen.field)}</span>}
                        </Td>
                        <Td><Code>{f.key}</Code></Td>
                        <Td className="text-xs">{typeFa(f.type)}</Td>
                        <Td className="text-xs">{f.required ? tr('بله') : '—'}</Td>
                        <Td>
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setEditing({ index: i, field: { ...f } })}>{tr('ویرایش')}</Button>
                            <Button size="sm" variant="ghost" disabled={locked.has(f.key)}
                              title={locked.has(f.key) ? tr('این فیلد جزء الزامات فرآیند است') : undefined}
                              onClick={() => remove(i)}>{tr('حذف')}</Button>
                          </div>
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setEditing({ index: fields.length, field: blank() })}>{tr('افزودن فیلد')}</Button>
                  <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => void commit()}>{tr('ذخیره و ساخت نسخهٔ تازه')}</Button>
                  {dirty && <Button size="sm" variant="ghost" onClick={() => { setDraft(null); setProblems([]); }}>{tr('بازگرداندن')}</Button>}
                  {dirty && <Badge tone="warning">{tr('ذخیره نشده')}</Badge>}
                </div>
              </div>

              {/* The real form component, fed the draft: what the person filling it will see. */}
              <div className="rounded-lg bg-ink-50/40 p-3" data-testid="designer-preview">
                <p className="mb-2 text-xs font-medium text-ink-600">{tr('پیش‌نمایش زنده')}</p>
                <div className="grid gap-3">
                  {fields.map((f) => {
                    if (f.visibleWhen) {
                      const controlling = String(preview[f.visibleWhen.field] ?? '');
                      if (!f.visibleWhen.equals.includes(controlling)) return null;
                    }
                    return (
                      <FormField key={f.key} field={f as never} value={preview[f.key]}
                        onChange={(v) => setPreview((p) => ({ ...p, [f.key]: v }))} />
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        )}
      </Card>

      {editing && (
        <FieldEditor
          field={editing.field}
          others={fields.filter((_, i) => i !== editing.index)}
          locked={locked.has(editing.field.key)}
          onCancel={() => setEditing(null)}
          onSave={(f) => {
            const next = [...fields];
            if (editing.index >= next.length) next.push(f); else next[editing.index] = f;
            setDraft(next);
            setEditing(null);
          }}
        />
      )}
      {creating && <NewForm onClose={() => setCreating(false)} onCreated={(c) => { setCreating(false); setCode(c); void qc.invalidateQueries({ queryKey: ['/forms/definitions'] }); }} />}
    </div>
  );
}

function FieldEditor({ field, others, locked, onSave, onCancel }: {
  field: DesignerField; others: DesignerField[]; locked: boolean;
  onSave: (f: DesignerField) => void; onCancel: () => void;
}) {
  const [f, setF] = useState<DesignerField>(field);
  const [optionText, setOptionText] = useState((field.options ?? []).map((o) => `${o.value}=${o.labelFa}`).join('\n'));
  const needsOptions = f.type === 'select' || f.type === 'multiselect';
  const controllers = others.filter((o) => o.type === 'select' || o.type === 'checkbox');

  return (
    <Modal
      open wide title={field.key ? tr('ویرایش «{0}»', field.labelFa) : tr('فیلد تازه')} onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>{tr('انصراف')}</Button>
          <Button variant="primary"
            disabled={f.key.trim().length < 2 || f.labelFa.trim().length < 1}
            onClick={() => onSave({
              ...f,
              key: f.key.trim(), labelFa: f.labelFa.trim(), labelEn: (f.labelEn || f.key).trim(),
              options: needsOptions
                ? optionText.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
                    const [value, ...rest] = l.split('=');
                    return { value: (value ?? '').trim(), labelFa: (rest.join('=') || value || '').trim() };
                  })
                : undefined,
            })}>{tr('ثبت فیلد')}</Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('عنوان فارسی')} required>
          <Input value={f.labelFa} onChange={(e) => setF({ ...f, labelFa: e.target.value })} aria-label={tr('عنوان فارسی')} />
        </Field>
        <Field label={tr('عنوان انگلیسی')}>
          <Input value={f.labelEn} onChange={(e) => setF({ ...f, labelEn: e.target.value })} className="ltr" aria-label={tr('عنوان انگلیسی')} />
        </Field>
        <Field label={tr('کلید')} required hint={locked ? tr('این فیلد جزء الزامات فرآیند است و کلیدش تغییر نمی‌کند.') : tr('در داده‌ها با همین نام ذخیره می‌شود — لاتین، بدون فاصله.')}>
          <Input value={f.key} disabled={locked} onChange={(e) => setF({ ...f, key: e.target.value })} className="ltr" aria-label={tr('کلید')} />
        </Field>
        <Field label={tr('نوع')} hint={locked ? tr('نوع این فیلد ثابت است؛ فرآیند به آن تکیه دارد.') : undefined}>
          <Select value={f.type} disabled={locked} onChange={(e) => setF({ ...f, type: e.target.value })} aria-label={tr('نوع')}>
            {TYPES.map((t) => <option key={t.value} value={t.value}>{loc(t, 'label')}</option>)}
          </Select>
        </Field>
        {f.type === 'entityRef' && (
          <Field label={tr('موجودیت')} hint={tr('مثل project، brief، company')}>
            <Input value={f.entity ?? ''} onChange={(e) => setF({ ...f, entity: e.target.value })} className="ltr" aria-label={tr('موجودیت')} />
          </Field>
        )}
        <Field label={tr('راهنما')}>
          <Input value={f.helpFa ?? ''} onChange={(e) => setF({ ...f, helpFa: e.target.value })} aria-label={tr('راهنما')} />
        </Field>
        {needsOptions && (
          <div className="sm:col-span-2">
            <Field label={tr('گزینه‌ها')} required hint={tr('هر خط یک گزینه، به شکل value=برچسب فارسی')}>
              <Textarea rows={4} value={optionText} onChange={(e) => setOptionText(e.target.value)} className="ltr" aria-label={tr('گزینه‌ها')} />
            </Field>
          </div>
        )}
        <div className="sm:col-span-2 flex flex-wrap items-center gap-4">
          <Checkbox checked={!!f.required} disabled={locked}
            onChange={(e) => setF({ ...f, required: e.target.checked })} label={tr('الزامی')} />
          {controllers.length > 0 && (
            <div className="flex items-end gap-2">
              <Field label={tr('فقط وقتی نمایش بده که')}>
                <Select value={f.visibleWhen?.field ?? ''} onChange={(e) => setF({ ...f, visibleWhen: e.target.value ? { field: e.target.value, equals: f.visibleWhen?.equals ?? [] } : undefined })} aria-label={tr('وابسته به')}>
                  <option value="">{tr('— همیشه نمایش داده شود —')}</option>
                  {controllers.map((c) => <option key={c.key} value={c.key}>{loc(c, 'label')}</option>)}
                </Select>
              </Field>
              {f.visibleWhen && (
                <Field label={tr('برابر باشد با')} hint={tr('چند مقدار را با کاما جدا کنید')}>
                  <Input className="ltr" value={f.visibleWhen.equals.join(',')} aria-label={tr('مقادیر')}
                    onChange={(e) => setF({ ...f, visibleWhen: { field: f.visibleWhen!.field, equals: e.target.value.split(/[,،]/).map((v) => v.trim()).filter(Boolean) } })} />
                </Field>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function NewForm({ onClose, onCreated }: { onClose: () => void; onCreated: (code: string) => void }) {
  const [v, setV] = useState({ code: '', nameFa: '', nameEn: '', category: 'D', module: 'TRAFFIC_TASK', senderDepts: [] as string[], approverRoles: [] as string[] });
  const toast = useToast();
  const create = useAction(
    () => apiPost<{ code: string }>('/forms/definitions', {
      ...v,
      receiverDepts: [],
      fields: [{ key: 'subject', labelFa: tr('موضوع'), labelEn: 'Subject', type: 'text', required: true }],
    }),
    tr('فرم ساخته شد — حالا فیلدهایش را بسازید.'),
  );

  return (
    <Modal
      open title={tr('فرم تازهٔ سازمان')} onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
          <Button variant="primary" loading={create.isPending}
            disabled={v.code.trim().length < 3 || v.nameFa.trim().length < 2}
            onClick={() => create.mutate(undefined, {
              onSuccess: (res: any) => onCreated(res.code),
              onError: (e: any) => toast(e?.details?.problems?.join(tr('؛ ')) ?? e?.message ?? tr('ساخت فرم ناموفق بود.'), 'danger'),
            })}>{tr('ساختن')}</Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-ink-500">{tr('فرم‌های Doc_H شماره‌دارند و از کاتالوگ می‌آیند؛ این یکی مال سازمان شماست و هیچ به‌روزرسانی‌ای آن را بازنویسی نمی‌کند.')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('کد')} required hint={tr('حروف بزرگ لاتین، مثل X_EQUIPMENT_HANDOVER')}>
          <Input value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} className="ltr" aria-label={tr('کد')} />
        </Field>
        <Field label={tr('نام فارسی')} required>
          <Input value={v.nameFa} onChange={(e) => setV({ ...v, nameFa: e.target.value, nameEn: v.nameEn || e.target.value })} aria-label={tr('نام فارسی')} />
        </Field>
        <Field label={tr('واحد فرستنده')}>
          <Select value={v.senderDepts[0] ?? ''} onChange={(e) => setV({ ...v, senderDepts: e.target.value ? [e.target.value] : [] })} aria-label={tr('واحد فرستنده')}>
            <option value="">{tr('— همهٔ واحدها —')}</option>
            {DEPARTMENT_CODES.map((d) => <option key={d} value={d}>{deptFa(d)}</option>)}
          </Select>
        </Field>
        <Field label={tr('تأییدکننده')}>
          <Select value={v.approverRoles[0] ?? ''} onChange={(e) => setV({ ...v, approverRoles: e.target.value ? [e.target.value] : [] })} aria-label={tr('تأییدکننده')}>
            <option value="">{tr('— بدون تأیید —')}</option>
            {ROLE_CODES.map((r) => <option key={r} value={r}>{roleFa(r)}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
