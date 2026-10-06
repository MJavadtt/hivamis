import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { PageBody, PageHeader } from '../components/Shell';
import { Code } from '../components/common';
import { PdfButton } from '../components/PdfButton';
import { PdfBundleButton } from '../components/PdfBundleButton';
import {
  Badge, Button, Card, Checkbox, EmptyState, ErrorBlock, Field, Input, LoadingBlock,
  Modal, Select, StateBadge, Table, Tabs, Td, Textarea, Th, Tr, useToast, cx, IconPlus, IconSearch,
} from '../components/ui';
import { formatDateTime, localDigits } from '../lib/format';
import { JalaliDateInput } from '../components/JalaliDateInput';
import { useLocale } from '../lib/locale';
import { HelpDrawer } from '../components/HelpDrawer';
import { BulkImport } from '../components/BulkImport';
import { Outbox } from '../components/Outbox';
import { enqueue, newKey } from '../lib/outbox';
import { evaluateRouting, buildStages, type ApprovalStage, type ResolvedStage, type RoutingRule } from '@hiva/contracts';
import { flow, loc, tr } from '../i18n';

/** Doc_H unit codes → Persian names, so routing reads as language rather than symbols. */
const DEPT_FA: Record<string, string> = {
  S: tr('فروش'), A: tr('اکانت'), ST: tr('استراتژی'), CR: tr('خلاقیت'), ME: tr('رسانه'),
  DM: tr('دیجیتال'), FI: tr('مالی'), LG: tr('حقوقی'), OP: tr('عملیات'), M: tr('مدیریت'),
};
const deptNames = (codes: string[]) => codes.map((c) => DEPT_FA[c] ?? c).join(tr('، '));

const ROLE_FA: Record<string, string> = {
  SUPER_ADMIN: tr('مدیر سیستم'), CEO: tr('مدیرعامل'), DEPUTY: tr('قائم‌مقام'),
  SALES_MANAGER: tr('مدیر فروش'), SALES_REP: tr('کارشناس فروش'),
  ACCOUNT_MANAGER: tr('مدیر اکانت'), ACCOUNT_EXEC: tr('کارشناس اکانت'),
  UNIT_MANAGER: tr('مدیر واحد'), UNIT_MEMBER: tr('کارشناس واحد'),
  PMO_MANAGER: tr('مدیر عملیات'), PMO_SPECIALIST: tr('کارشناس PMO'),
  FINANCE_MANAGER: tr('مدیر مالی'), FINANCE_SPECIALIST: tr('کارشناس مالی'),
  LEGAL_MANAGER: tr('مدیر حقوقی'), LEGAL_SPECIALIST: tr('کارشناس حقوقی'), VIEWER: tr('بیننده'),
};
const roleNames = (codes: string[]) => codes.map((c) => ROLE_FA[c] ?? c).join(tr('، '));

interface FieldDef {
  key: string; labelFa: string; labelEn: string; type: string; required?: boolean;
  options?: { value: string; labelFa: string }[]; entity?: string; helpFa?: string;
  columns?: FieldDef[]; visibleWhen?: { field: string; equals: string[] };
}

export interface FormDefinition {
  id: string; no: number; code: string; nameFa: string; nameEn: string;
  category: string; module: string; senderDepts: string[]; receiverDepts: string[];
  approverRoles: string[]; slaCode: string | null; binding: string | null;
  nextProcessFa: string | null; schema: FieldDef[]; canSubmit: boolean; version?: number;
  /** Conditional approvers, evaluated against what is typed (roadmap #17). */
  routing?: RoutingRule[];
  /** Ordered approval stages with quorum (roadmap #18). */
  approvalChain?: ApprovalStage[];
}

interface Submission {
  id: string; code: string; state: string; createdAt: string;
  definition: { code: string; nameFa: string; category: string; module: string };
  submittedBy: { fullName: string };
  project: { id: string; code: string; name: string } | null;
}

const FORM_TABS = ['catalogue', 'inbox', 'mine'] as const;

export default function Forms() {
  // A link may name the tab (the dashboard's tiles) or one submission (approval emails, the phone):
  // the latter opens it for a decision in the inbox.
  const [params] = useSearchParams();
  const linked = params.get('submission');
  const asked = params.get('tab');
  const [tab, setTab] = useState<string>(linked ? 'inbox' : FORM_TABS.includes(asked as never) ? asked! : 'catalogue');
  return (
    <>
      <PageHeader
        title={tr('فرم‌ها')}
        subtitle={tr('۱۳۰ فرم ارتباطی و انتقال داده — هر فرم یک Data Object با مسیر، تأییدکننده و SLA مشخص')}
      
        actions={<ContextualHelp />}
      />
      <div className="mx-3 mt-3 rounded-xl bg-surface px-2 shadow-sm ring-1 ring-edge sm:mx-5 lg:mx-0 [&>[role=tablist]]:border-b-0">
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { key: 'catalogue', label: tr('کاتالوگ فرم‌ها') },
            { key: 'inbox', label: tr('در انتظار تأیید من') },
            { key: 'mine', label: tr('فرم‌های من') },
          ]}
        />
      </div>
      <PageBody className="space-y-5">
        {/* Whatever this device is still carrying, before anything else on the page. */}
        <Outbox />
        {tab === 'catalogue' && <Catalogue />}
        {tab === 'inbox' && <Submissions awaitingMe openId={linked} />}
        {tab === 'mine' && <Submissions mine />}
      </PageBody>
    </>
  );
}

/* ── Catalogue ─────────────────────────────────────────────────────────── */

function Catalogue() {
  const { t } = useLocale();
  const [category, setCategory] = useState('');
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<FormDefinition | null>(null);

  const { data, isLoading, error, refetch } = useQuery<{
    categories: { key: string; labelFa: string; count: number }[];
    definitions: FormDefinition[];
  }>({
    queryKey: ['/forms/definitions'],
    queryFn: () => apiGet('/forms/definitions'),
  });

  const visible = useMemo(() => {
    const t = term.trim();
    return (data?.definitions ?? []).filter(
      (d) => (!category || d.category === category) && (!t || d.nameFa.includes(t) || d.code.includes(t.toUpperCase())),
    );
  }, [data, category, term]);

  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <IconSearch className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-ink-400" />
          <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder={tr('جستجوی فرم…')} aria-label={tr('جستجوی فرم…')} className="ps-9" />
        </div>
        <div className="w-64 shrink-0"><Select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">{tr('همه دسته‌ها')}</option>
          {data?.categories.map((c) => (
            <option key={c.key} value={c.key}>
              {c.key} — {t(c, "label")} ({localDigits(c.count)})
            </option>
          ))}
        </Select></div>
        <span className="text-xs text-ink-500 nums">{tr('{0} فرم', localDigits(visible.length))}</span>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {visible.map((def) => (
          <button
            key={def.code}
            onClick={() => setSelected(def)}
            className={cx(
              'rounded-xl bg-surface p-4 text-start ring-1 ring-ink-200 shadow-sm transition',
              def.canSubmit ? 'hover:ring-brand-400 hover:shadow' : 'opacity-70',
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium text-ink-800">{t(def, "name")}</p>
              <span className="shrink-0 rounded bg-ink-100 px-1.5 py-0.5 text-[12.5px] text-ink-500 nums">
                {localDigits(def.no)}
              </span>
            </div>
            <p className="mt-2 text-[12.5px] leading-5 text-ink-500">{tr('از')}{' '}<span className="text-ink-700">{deptNames(def.senderDepts)}</span>{tr('{0}به', ' ')}{' '}<span className="text-ink-700">{deptNames(def.receiverDepts)}</span>
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12.5px]">
              <Badge tone="neutral">{tr('دسته {0}', def.category)}</Badge>
              {def.slaCode && <Badge tone="warning">{tr('دارای SLA')}</Badge>}
            </div>
            {!def.canSubmit && (
              <p className="mt-1.5 text-[12.5px] text-ink-400">{tr('ثبت این فرم در اختیار واحد شما نیست')}</p>
            )}
          </button>
        ))}
      </div>

      {selected && <FormRunner definition={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

/* ── Dynamic form renderer ─────────────────────────────────────────────── */

/**
 * Renders any of the 130 Doc_H forms from its stored field schema, so adding or changing
 * a form is a data change rather than a code change.
 */
export function FormRunner({ definition, onClose, initial }: {
  definition: FormDefinition; onClose: () => void;
  /** Values the form opens with — the record it was opened from, and the ones that record belongs to (Hivamis task 4b). */
  initial?: Record<string, unknown>;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(initial ?? {});
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const toast = useToast();
  const qc = useQueryClient();

  const { data: detail } = useQuery<FormDefinition & { sla: { labelFa: string; hours: string } | null }>({
    queryKey: [`/forms/definitions/${definition.code}`],
    queryFn: () => apiGet(`/forms/definitions/${definition.code}`),
  });

  const fields = detail?.schema ?? definition.schema;

  // The same pure evaluator the server routes with, so what the person is told while filling is
  // exactly what they will get on submit — no round-trip, and no chance of the two disagreeing.
  const routed = useMemo(
    () => evaluateRouting(definition.approverRoles, detail?.routing ?? [], values),
    [definition.approverRoles, detail?.routing, values],
  );
  const added = routed.roles.filter((r) => !definition.approverRoles.includes(r));
  // The stages these values would walk through — built by the same function the server uses.
  const stages = useMemo(
    () => buildStages(detail?.approvalChain ?? [], routed.roles, values),
    [detail?.approvalChain, routed.roles, values],
  );

  const set = (key: string, value: unknown) => setValues((v) => ({ ...v, [key]: value }));

  const submit = async (asDraft: boolean) => {
    setBusy(true);
    setIssues({});
    // The device's own id for this form, so a retry over a bad link files it once (roadmap #19).
    const clientKey = newKey();
    const queue = async (reason: string) => {
      await enqueue({ id: clientKey, formCode: definition.code, formNameFa: definition.nameFa, data: values, asDraft });
      toast(tr('{0} — فرم در صف ارسال نگه داشته شد و با بازگشت اینترنت خودش ارسال می‌شود.', reason), 'warning');
      await qc.invalidateQueries({ queryKey: ['outbox'] });
      onClose();
    };
    try {
      if (navigator.onLine === false) { await queue(tr('اینترنت در دسترس نیست')); return; }
      await apiPost('/forms/submissions', { formCode: definition.code, data: values, asDraft, clientKey });
      toast(asDraft ? tr('پیش‌نویس ذخیره شد.') : tr('فرم «{0}» ثبت شد.', definition.nameFa));
      await qc.invalidateQueries();
      onClose();
    } catch (e: any) {
      // A refusal is an answer and belongs on the form; an unreachable server is not, and the
      // form belongs in the queue rather than in the bin.
      if (e?.status === undefined) { await queue(tr('ارتباط با سامانه برقرار نشد')); return; }
      const list: Record<string, string> = {};
      for (const i of e?.issues ?? []) list[i.path] = i.message;
      setIssues(list);
      toast(e?.message ?? tr('ثبت فرم ناموفق بود.'), 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={loc(definition, 'name')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
          <Button variant="secondary" loading={busy} onClick={() => void submit(true)}>{tr('ذخیره پیش‌نویس')}</Button>
          <Button variant="primary" loading={busy} disabled={!definition.canSubmit} onClick={() => void submit(false)}>{tr('ثبت و ارسال')}</Button>
        </>
      }
    >
      <div className="mb-4 space-y-1.5 rounded-lg bg-ink-50 p-3 text-xs text-ink-600">
        <p>
          <span className="font-medium">{tr('مسیر فرم:')}{' '}</span>{tr('از {0} به {1}', deptNames(definition.senderDepts), deptNames(definition.receiverDepts))}</p>
        <p data-testid="routing-approvers">
          <span className="font-medium">{tr('تأییدکننده:')}{' '}</span>
          {roleNames(routed.roles)}
          {added.length > 0 && (
            <Badge tone="warning" className="ms-1">{tr('+{0} به‌دلیل مقادیر این فرم', roleNames(added))}</Badge>
          )}
        </p>
        {stages.length > 1 && (
          <p data-testid="routing-chain">
            <span className="font-medium">{tr('زنجیرهٔ تأیید:')}{' '}</span>
            {stages.map((st, i) => (
              <span key={st.id}>
                {i > 0 && ` ${flow()} `}
                {localDigits(i + 1)}. {loc(st, 'label')} ({roleNames(st.roles)}{st.quorum > 1 ? tr(' — {0} تأیید', localDigits(st.quorum)) : ''})
              </span>
            ))}
          </p>
        )}
        {routed.matched.length > 0 && (
          <ul className="space-y-0.5 text-[12.5px] text-amber-800" data-testid="routing-matched">
            {routed.matched.map((m) => (
              <li key={m.id}>⚠ {loc(m, 'when')} → {roleNames([...m.addApprovers, ...m.notifyRoles])}</li>
            ))}
          </ul>
        )}
        {routed.unmatched.length > 0 && (
          <details className="text-[12.5px] text-ink-500">
            <summary className="cursor-pointer">{tr('قواعد مشروط این فرم ({0} مورد هنوز فعال نشده)', localDigits(routed.unmatched.length))}</summary>
            <ul className="mt-1 space-y-0.5 ps-3">
              {routed.unmatched.map((u) => <li key={u.id}>· {loc(u, 'when')}</li>)}
            </ul>
          </details>
        )}
        {detail?.sla && (
          <p>
            <span className="font-medium">SLA: </span>{tr('{0} — {1} ساعت کاری', detail.sla.labelFa, localDigits(Number(detail.sla.hours)))}</p>
        )}
        {definition.nextProcessFa && (
          <p>
            <span className="font-medium">{tr('فرآیند بعدی:')}{' '}</span>
            {loc(definition, 'nextProcess')}
          </p>
        )}
      </div>

      <div className="mb-4"><BulkImport code={definition.code} canSubmit={definition.canSubmit} /></div>

      {!definition.canSubmit && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-200">{tr('طبق تعریف Doc_H، ثبت این فرم فقط توسط واحد {0} مجاز است. می‌توانید ساختار فرم را ببینید اما ارسال آن مسدود است.', deptNames(definition.senderDepts))}</p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => {
          if (f.visibleWhen) {
            const controlling = String(values[f.visibleWhen.field] ?? '');
            if (!f.visibleWhen.equals.includes(controlling)) return null;
          }
          const wide = ['textarea', 'table', 'attachment'].includes(f.type);
          return (
            <div key={f.key} className={wide ? 'sm:col-span-2' : undefined}>
              <FormField field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} error={issues[f.key]} />
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

/** Exported for the designer's live preview (roadmap #15): one renderer, not two. */
export function FormField({ field, value, onChange, error }: {
  field: FieldDef; value: unknown; onChange: (v: unknown) => void; error?: string;
}) {
  const { t } = useLocale();
  const common = { required: field.required, error, hint: loc(field, 'help') || undefined };

  switch (field.type) {
    case 'textarea':
      return (
        <Field label={t(field, "label")} {...common}>
          <Textarea value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} rows={3} />
        </Field>
      );
    case 'number':
    case 'currency':
    case 'percent':
      return (
        <Field label={t(field, "label")} {...common} hint={field.type === 'currency' ? tr('مبلغ به ریال') : common.hint}>
          <Input type="number" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} className="ltr" />
        </Field>
      );
    case 'date':
    case 'datetime':
      return (
        <Field label={t(field, "label")} {...common}>
          <JalaliDateInput
            mode={field.type === 'date' ? 'date' : 'datetime'}
            value={(value as string) ?? ''}
            onChange={onChange}
          />
        </Field>
      );
    case 'checkbox':
      return (
        <div className="pt-5">
          <Checkbox label={t(field, "label")} checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          {error && <p className="mt-1 text-[12.5px] text-rose-600">{error}</p>}
        </div>
      );
    case 'select':
      return (
        <Field label={t(field, "label")} {...common}>
          <Select value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)}>
            <option value="">{tr('— انتخاب کنید —')}</option>
            {field.options?.map((o) => <option key={o.value} value={o.value}>{loc(o, 'label')}</option>)}
          </Select>
        </Field>
      );
    case 'multiselect':
      return (
        <Field label={t(field, "label")} {...common}>
          <div className="flex flex-wrap gap-2 rounded-lg bg-surface p-2 ring-1 ring-inset ring-ink-300">
            {field.options?.map((o) => {
              const list = (value as string[]) ?? [];
              const on = list.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => onChange(on ? list.filter((v) => v !== o.value) : [...list, o.value])}
                  className={cx(
                    'rounded-md px-2 py-1 text-xs ring-1 ring-inset transition',
                    on ? 'bg-brand-600 text-white ring-brand-600' : 'bg-surface text-ink-600 ring-ink-300 hover:bg-ink-50',
                  )}
                >
                  {loc(o, 'label')}
                </button>
              );
            })}
          </div>
        </Field>
      );
    case 'department':
      return (
        <Field label={t(field, "label")} {...common}>
          <DepartmentSelect value={(value as string) ?? ''} onChange={onChange} />
        </Field>
      );
    case 'user':
      return (
        <Field label={t(field, "label")} {...common}>
          <UserSelect value={(value as string) ?? ''} onChange={onChange} />
        </Field>
      );
    case 'entityRef':
      return (
        <Field label={t(field, "label")} {...common}>
          <EntitySelect entity={field.entity!} value={(value as string) ?? ''} onChange={onChange} />
        </Field>
      );
    case 'mobile':
      return (
        <Field label={t(field, "label")} {...common} hint={common.hint ?? tr('مانند ۰۹۱۲۱۲۳۴۵۶۷')}>
          <Input value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} className="ltr" inputMode="tel" placeholder="09xx xxx xxxx" />
        </Field>
      );
    case 'attachment':
      return (
        <Field label={t(field, "label")} hint={tr('پیوست‌ها پس از ثبت فرم، از صفحه فرم قابل بارگذاری هستند.')} error={error}>
          <div className="rounded-lg border border-dashed border-ink-300 px-3 py-4 text-center text-xs text-ink-400">{tr('بارگذاری پیوست پس از ثبت')}</div>
        </Field>
      );
    case 'table':
      return <TableField field={field} value={(value as Record<string, unknown>[]) ?? []} onChange={onChange} error={error} />;
    default:
      return (
        <Field label={t(field, "label")} {...common}>
          <Input value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
        </Field>
      );
  }
}

function TableField({ field, value, onChange, error }: {
  field: FieldDef; value: Record<string, unknown>[]; onChange: (v: unknown) => void; error?: string;
}) {
  const { t } = useLocale();
  const rows = value.length ? value : [];
  const addRow = () => onChange([...rows, {}]);
  const setCell = (i: number, key: string, v: unknown) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, [key]: v } : r)));
  const removeRow = (i: number) => onChange(rows.filter((_, idx) => idx !== i));

  return (
    <Field label={t(field, "label")} error={error}>
      <div className="overflow-hidden rounded-lg ring-1 ring-inset ring-ink-300">
        <table className="w-full text-xs">
          <thead className="bg-ink-50">
            <tr>
              {field.columns?.map((c) => (
                <th key={c.key} className="px-2 py-1.5 text-start font-medium text-ink-600">{t(c, "label")}</th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-ink-100">
                {field.columns?.map((c) => (
                  <td key={c.key} className="p-1">
                    {c.type === 'select' ? (
                      <Select
                        value={String(row[c.key] ?? '')}
                        onChange={(e) => setCell(i, c.key, e.target.value)}
                        className="py-1 text-xs"
                      >
                        <option value="">—</option>
                        {c.options?.map((o) => <option key={o.value} value={o.value}>{loc(o, 'label')}</option>)}
                      </Select>
                    ) : (
                      c.type === 'date' ? (
                        <JalaliDateInput
                          mode="date"
                          value={String(row[c.key] ?? '')}
                          onChange={(v) => setCell(i, c.key, v)}
                        />
                      ) : (
                        <Input
                          type={['number', 'currency'].includes(c.type) ? 'number' : 'text'}
                          value={String(row[c.key] ?? '')}
                          onChange={(e) => setCell(i, c.key, e.target.value)}
                          className={cx('py-1 text-xs', ['number', 'currency'].includes(c.type) && 'ltr')}
                        />
                      )
                    )}
                  </td>
                ))}
                <td className="p-1 text-center">
                  <button type="button" onClick={() => removeRow(i)} className="text-ink-400 hover:text-rose-600" aria-label={tr('حذف ردیف')}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          type="button"
          onClick={addRow}
          className="flex w-full items-center justify-center gap-1 border-t border-ink-100 py-1.5 text-xs text-brand-600 hover:bg-brand-50"
        >
          <IconPlus className="size-3" />{' '}{tr('افزودن ردیف')}</button>
      </div>
    </Field>
  );
}

/* ── Reference pickers ─────────────────────────────────────────────────── */

function DepartmentSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = useQuery<{ code: string; nameFa: string }[]>({
    queryKey: ['/departments'], queryFn: () => apiGet('/departments'), staleTime: 300_000,
  });
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{tr('— انتخاب واحد —')}</option>
      {data?.map((d) => <option key={d.code} value={d.code}>{loc(d, 'name')}</option>)}
    </Select>
  );
}

/** Exported for the minutes dialog (roadmap #23): one people picker, not two. */
export function UserSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = useQuery<{ items: { id: string; fullName: string; department: { nameFa: string } | null }[] }>({
    queryKey: ['/users', 'picker'], queryFn: () => apiGet('/users', { pageSize: 200 }), staleTime: 300_000,
  });
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{tr('— انتخاب کاربر —')}</option>
      {data?.items.map((u) => (
        <option key={u.id} value={u.id}>
          {u.fullName}{u.department ? ` — ${loc(u.department, 'name')}` : ''}
        </option>
      ))}
    </Select>
  );
}

const ENTITY_PATHS: Record<string, { path: string; label: (r: any) => string }> = {
  project: { path: '/projects', label: (r) => `${r.name} (${r.code})` },
  company: { path: '/companies', label: (r) => r.legalName },
  opportunity: { path: '/opportunities', label: (r) => `${r.title} (${r.code})` },
  brief: { path: '/briefs', label: (r) => `${r.title} (${r.code})` },
  proposal: { path: '/proposals', label: (r) => `${r.title} (${r.code})` },
  contract: { path: '/contracts', label: (r) => `${r.title} (${r.code})` },
  workOrder: { path: '/work-orders', label: (r) => `${r.title} (${r.code})` },
  deliverable: { path: '/deliverables', label: (r) => `${r.name} (${r.code})` },
  changeRequest: { path: '/change-requests', label: (r) => `${r.title} (${r.code})` },
  invoice: { path: '/invoices', label: (r) => `${r.number}` },
  supplier: { path: '/suppliers', label: (r) => r.name },
  revision: { path: '/revisions', label: (r) => r.code },
  task: { path: '/tasks', label: (r) => `${r.title} (${r.code})` },
  // A lead's source (Hivamis task 2): the organisation's marketers and partner companies.
  marketer: { path: '/lead-referrers?kind=MARKETER', label: (r) => r.name },
  partner: { path: '/lead-referrers?kind=PARTNER', label: (r) => r.name },
};

/** Exported for the finance dialogs (roadmap #28). */
export function EntitySelect({ entity, value, onChange }: { entity: string; value: string; onChange: (v: string) => void }) {
  const config = ENTITY_PATHS[entity];
  const { data, isError } = useQuery<{ items: any[] }>({
    queryKey: [config?.path, 'picker'],
    queryFn: () => apiGet(config!.path, { pageSize: 100 }),
    enabled: !!config,
    staleTime: 60_000,
  });

  if (!config || isError) {
    return <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={tr('شناسه رکورد')} className="ltr" />;
  }
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{tr('— انتخاب —')}</option>
      {data?.items?.map((r) => <option key={r.id} value={r.id}>{config.label(r)}</option>)}
    </Select>
  );
}

/* ── Submissions ───────────────────────────────────────────────────────── */

function Submissions({ awaitingMe, mine, openId }: { awaitingMe?: boolean; mine?: boolean; openId?: string | null }) {
  const [decide, setDecide] = useState<Submission | null>(null);
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery<{ items: Submission[]; total: number }>({
    queryKey: ['/forms/submissions', { awaitingMe, mine }],
    queryFn: () => apiGet('/forms/submissions', {
      awaitingMe: awaitingMe ? 'true' : undefined,
      mine: mine ? 'true' : undefined,
      pageSize: 50,
    }),
  });

  // Opened once from a link; a form no longer waiting for this person says so instead.
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (!openId || opened || !data) return;
    setOpened(true);
    const found = data.items.find((s) => s.id === openId);
    if (found) setDecide(found);
    else toast(tr('این فرم دیگر در انتظار تصمیم شما نیست.'), 'warning');
  }, [openId, opened, data, toast]);

  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  return (
    <>
      <Card>
        {!data?.items.length ? (
          <EmptyState
            title={awaitingMe ? tr('فرمی در انتظار تأیید شما نیست') : tr('فرمی ثبت نکرده‌اید')}
            description={awaitingMe ? tr('فرم‌های ارجاع‌شده به نقش شما اینجا نمایش داده می‌شوند.') : undefined}
          />
        ) : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr>
                <Th>{tr('فرم')}</Th><Th>{tr('دسته')}</Th><Th>{tr('ثبت‌کننده')}</Th><Th>{tr('پروژه')}</Th>
                <Th>{tr('زمان')}</Th><Th>{tr('وضعیت')}</Th><Th>{tr('خروجی')}</Th>{awaitingMe && <Th>{tr('اقدام')}</Th>}
              </tr>
            </thead>
            <tbody>
              {data.items.map((s) => (
                <Tr key={s.id}>
                  <Td><p className="text-sm">{loc(s.definition, 'name')}</p><Code>{s.code}</Code></Td>
                  <Td><Badge tone="neutral">{s.definition.category}</Badge></Td>
                  <Td className="text-xs">{s.submittedBy?.fullName}</Td>
                  <Td className="text-xs">{s.project?.name ?? '—'}</Td>
                  <Td className="text-xs">{formatDateTime(s.createdAt)}</Td>
                  <Td><StateBadge state={s.state} /></Td>
                  <Td><PdfButton kind="form-submission" id={s.id} label="PDF" variant="ghost" /></Td>
                  {awaitingMe && (
                    <Td>
                      <Button size="sm" variant="primary" onClick={() => setDecide(s)}>{tr('بررسی')}</Button>
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {decide && <DecisionModal submission={decide} onClose={() => setDecide(null)} />}
    </>
  );
}

function DecisionModal({ submission, onClose }: { submission: Submission; onClose: () => void }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();

  const { data } = useQuery<{
    data: Record<string, unknown>; definition: FormDefinition;
    /** The fields as they stood when this was filled in — the definition may have moved on since. */
    schema?: FieldDef[]; definitionVersion?: number;
    requiredRoles?: string[];
    routing?: { matched: { id: string; whenFa: string; addApprovers: string[]; notifyRoles: string[] }[] } | null;
    stages?: ResolvedStage[] | null;
    currentStage?: number;
    approvals?: { id: string; stage: string | null; decision: string; approver: { fullName: string } }[];
  }>({
    queryKey: [`/forms/submissions/${submission.id}`],
    queryFn: () => apiGet(`/forms/submissions/${submission.id}`),
  });

  const decide = async (decision: 'APPROVE' | 'REJECT' | 'RETURN') => {
    setBusy(true);
    try {
      await apiPost(`/forms/submissions/${submission.id}/decision`, { decision, comment: comment.trim() || undefined });
      toast(decision === 'APPROVE' ? tr('فرم تأیید شد.') : decision === 'REJECT' ? tr('فرم رد شد.') : tr('فرم بازگردانده شد.'));
      await qc.invalidateQueries();
      onClose();
    } catch (e: any) {
      toast(e?.message ?? tr('ثبت تصمیم ناموفق بود.'), 'danger');
    } finally {
      setBusy(false);
    }
  };

  const labels = new Map((data?.schema ?? data?.definition.schema ?? []).map((f) => [f.key, loc(f, 'label')]));
  const versionNote = data?.definitionVersion && data.definition.version && data.definitionVersion !== data.definition.version
    ? tr('این فرم با نسخهٔ {0} تعریف پر شده؛ نسخهٔ فعلی {1} است.', localDigits(data.definitionVersion), localDigits(data.definition.version))
    : null;

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={tr('بررسی: {0}', submission.definition.nameFa)}
      footer={
        <>
          <PdfButton kind="form-submission" id={submission.id} />
          <PdfBundleButton kind="form-submission" id={submission.id} />
          <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
          <Button variant="secondary" loading={busy} disabled={!comment.trim()} onClick={() => void decide('RETURN')}>{tr('بازگشت برای اصلاح')}</Button>
          <Button variant="danger" loading={busy} disabled={!comment.trim()} onClick={() => void decide('REJECT')}>{tr('رد')}</Button>
          <Button variant="primary" loading={busy} onClick={() => void decide('APPROVE')}>{tr('تأیید')}</Button>
        </>
      }
    >
      {versionNote && <p className="mb-3 text-xs text-ink-500">{versionNote}</p>}
      {data?.stages && data.stages.length > 1 ? (
        <ol className="mb-3 space-y-1 rounded-lg bg-ink-50/60 px-3 py-2 text-xs" data-testid="decision-stages">
          {data.stages.map((st, i) => {
            const names = (data.approvals ?? []).filter((a) => a.stage === st.id && a.decision === 'APPROVE').map((a) => a.approver.fullName);
            const waiting = st.state === 'PENDING' && i === (data.currentStage ?? 0);
            return (
              <li key={st.id} className={cx('flex flex-wrap items-center gap-1.5', waiting && 'font-medium text-ink-800')}>
                <span aria-hidden className={st.state === 'APPROVED' ? 'text-emerald-600' : waiting ? 'text-amber-600' : 'text-ink-300'}>
                  {st.state === 'APPROVED' ? '✓' : waiting ? '◆' : '○'}
                </span>
                <span>{localDigits(i + 1)}. {loc(st, 'label')}</span>
                <span className="text-ink-500">({roleNames(st.roles)})</span>
                {st.quorum > 1 && (
                  <Badge tone={st.state === 'APPROVED' ? 'success' : 'neutral'}>{tr('{0} از {1} تأیید', localDigits(st.approvedBy.length), localDigits(st.quorum))}</Badge>
                )}
                {names.length > 0 && <span className="text-[12.5px] text-ink-400">— {names.join(tr('، '))}</span>}
                {waiting && <Badge tone="warning">{tr('اکنون با شماست')}</Badge>}
              </li>
            );
          })}
        </ol>
      ) : null}
      {data?.routing?.matched?.length ? (
        <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-200" data-testid="routing-why">
          <p className="font-medium">{tr('چرا به تأیید {0} رسید؟', roleNames(data.requiredRoles ?? []))}</p>
          <ul className="mt-1 space-y-0.5">
            {data.routing.matched.map((m) => (
              <li key={m.id}>· {loc(m, 'when')} → {roleNames([...m.addApprovers, ...m.notifyRoles])}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <dl className="mb-4 divide-y divide-ink-100 rounded-lg bg-ink-50/60 px-3">
        {Object.entries(data?.data ?? {})
          .filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
          .map(([k, v]) => (
            <div key={k} className="flex items-start justify-between gap-4 py-2">
              <dt className="shrink-0 text-xs text-ink-500">{labels.get(k) ?? k}</dt>
              <dd className="min-w-0 text-end text-sm text-ink-800">
                {typeof v === 'boolean' ? (v ? tr('بله') : tr('خیر'))
                  : Array.isArray(v) ? tr('{0} مورد', localDigits(v.length))
                  : String(v)}
              </dd>
            </div>
          ))}
      </dl>
      <Field label={tr('توضیح تصمیم')} hint={tr('برای «رد» یا «بازگشت» ثبت دلیل الزامی است.')}>
        <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} />
      </Field>
    </Modal>
  );
}

/** Opens the guide at the section that explains this page, rather than its top. */
function ContextualHelp() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-brand-600 hover:underline
                   focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
      >{tr('راهنمای این بخش')}</button>
      <HelpDrawer open={open} onClose={() => setOpen(false)} initialSection="Forms" />
    </>
  );
}

/**
 * A form opened by its code from anywhere — a record's page, the quick menu (Hivamis task 4b) — with
 * whatever the page already knows filled in.
 */
export function FormByCode({ code, initial, onClose }: { code: string; initial?: Record<string, unknown>; onClose: () => void }) {
  const { data, error } = useQuery<FormDefinition>({ queryKey: [`/forms/definitions/${code}`], queryFn: () => apiGet(`/forms/definitions/${code}`) });
  if (error) return <Modal open title={tr('فرم')} onClose={onClose}><ErrorBlock error={error} /></Modal>;
  if (!data) return <Modal open title={tr('فرم')} onClose={onClose}><LoadingBlock /></Modal>;
  return <FormRunner definition={data} initial={initial} onClose={onClose} />;
}
