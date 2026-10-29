import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEPARTMENT_LABELS, DIRECT_CHANNEL_LABELS, LEAD_SOURCE_LABELS, createBriefSchema, createChangeRequestSchema, createCompanySchema, createContactSchema, createContractSchema,
  createDecisionSchema, createDeliverableSchema, createIssueSchema, createLeadSchema, createOpportunitySchema, createOutsourceRequestSchema,
  createProjectSchema, createProposalSchema, createRevisionSchema, createRiskSchema, createStatusReportSchema, createSupplierSchema,
  createTaskSchema, createWorkOrderSchema, stateLabelFa, type DepartmentCode, type DirectChannel, type LeadSourceKind,
} from '@hiva/contracts';
import { currencyFa } from './Fx';
import { apiGet, apiPost, type Page } from '../lib/api';
import { useSystemAdmin } from '../lib/auth';
import { JalaliDateInput } from './JalaliDateInput';
import { Button, Checkbox, Field, IconPlus, Input, Modal, Select, Textarea, useToast } from './ui';
import { isEnglish, tr, trx } from '../i18n';

/**
 * Adding any record from anywhere — the system administrator's (the owner's instruction, 2026-10-28:
 * "in every section I must be able to add, from every section"). One form for every kind the API
 * creates directly, built from that kind's own create schema in the contracts: the fields, which are
 * required, the choices, the records a field points at. Nothing about a kind is written twice, so a
 * field added to a schema appears here by itself. The record is made through the ordinary create route
 * and lands in the history under the administrator's name, without the steps that usually precede it.
 */

/** A contracts create schema, read for its shape — the web does not depend on zod itself. */
type ZodTypeAny = { readonly _def: unknown };

export interface RecordKind {
  key: string;
  label: string;
  section: string;
  /** The list route the API creates through, and the list page that shows it. */
  path: string;
  schema: ZodTypeAny;
  /** Where the new record is opened, when it has a page of its own. */
  href?: (id: string) => string;
}

const S = { sales: tr('CRM و فروش'), account: tr('اکانت و پروپوزال'), exec: tr('اجرا و کنترل'), commercial: tr('تجاری و مالی'), governance: tr('حاکمیت پروژه') };

export const RECORD_KINDS: RecordKind[] = [
  { key: 'lead', label: tr('سرنخ'), section: S.sales, path: '/leads', schema: createLeadSchema },
  { key: 'opportunity', label: tr('فرصت فروش'), section: S.sales, path: '/opportunities', schema: createOpportunitySchema, href: (id) => `/opportunities/${id}` },
  { key: 'company', label: tr('مشتری'), section: S.sales, path: '/companies', schema: createCompanySchema, href: (id) => `/companies/${id}` },
  { key: 'contact', label: tr('مخاطب مشتری'), section: S.sales, path: '/contacts', schema: createContactSchema },
  { key: 'brief', label: tr('بریف'), section: S.account, path: '/briefs', schema: createBriefSchema, href: (id) => `/briefs/${id}` },
  { key: 'proposal', label: tr('پروپوزال'), section: S.account, path: '/proposals', schema: createProposalSchema, href: (id) => `/proposals/${id}` },
  { key: 'project', label: tr('پروژه'), section: S.exec, path: '/projects', schema: createProjectSchema, href: (id) => `/projects/${id}` },
  { key: 'workOrder', label: tr('سفارش کار'), section: S.exec, path: '/work-orders', schema: createWorkOrderSchema, href: (id) => `/work-orders/${id}` },
  { key: 'task', label: tr('وظیفه'), section: S.exec, path: '/tasks', schema: createTaskSchema, href: (id) => `/tasks/${id}` },
  { key: 'deliverable', label: tr('خروجی'), section: S.exec, path: '/deliverables', schema: createDeliverableSchema },
  { key: 'changeRequest', label: tr('درخواست تغییر'), section: S.exec, path: '/change-requests', schema: createChangeRequestSchema, href: (id) => `/changes/${id}` },
  { key: 'revision', label: tr('اصلاحیه'), section: S.exec, path: '/revisions', schema: createRevisionSchema },
  { key: 'supplier', label: tr('تأمین‌کننده'), section: S.exec, path: '/suppliers', schema: createSupplierSchema, href: (id) => `/suppliers/${id}` },
  { key: 'outsourceRequest', label: tr('درخواست تأمین بیرونی'), section: S.exec, path: '/outsource-requests', schema: createOutsourceRequestSchema },
  { key: 'contract', label: tr('قرارداد'), section: S.commercial, path: '/contracts', schema: createContractSchema, href: (id) => `/contracts/${id}` },
  { key: 'risk', label: tr('ریسک'), section: S.governance, path: '/risks', schema: createRiskSchema },
  { key: 'issue', label: tr('مسئله'), section: S.governance, path: '/issues', schema: createIssueSchema },
  { key: 'decision', label: tr('تصمیم'), section: S.governance, path: '/decisions', schema: createDecisionSchema },
  { key: 'statusReport', label: tr('گزارش وضعیت'), section: S.governance, path: '/status-reports', schema: createStatusReportSchema },
];

/* ── reading a schema ─────────────────────────────────────────────────────── */

type FieldKind = 'text' | 'long' | 'number' | 'date' | 'bool' | 'enum' | 'enums' | 'person' | 'record';
interface FieldSpec { key: string; kind: FieldKind; required: boolean; options?: string[]; ref?: Ref }
interface Ref { path: string; show: (r: any) => string }

const titled = (r: any) => [r.code, r.name ?? r.title ?? r.legalName].filter(Boolean).join(' — ');
const REFS: Record<string, Ref> = {
  companyId: { path: '/companies', show: (r) => r.brandName || r.legalName },
  leadId: { path: '/leads', show: titled }, opportunityId: { path: '/opportunities', show: titled },
  briefId: { path: '/briefs', show: titled }, proposalId: { path: '/proposals', show: titled },
  projectId: { path: '/projects', show: titled }, workOrderId: { path: '/work-orders', show: titled },
  deliverableId: { path: '/deliverables', show: titled }, taskId: { path: '/tasks', show: titled },
  supplierId: { path: '/suppliers', show: (r) => r.name },
};
const PEOPLE = new Set(['ownerId', 'accountOwnerId', 'salesOwnerId', 'assigneeId', 'decidedById', 'sourceUserId']);
/** Fields a person does not fill here: set by another record's own page. */
const HIDDEN = new Set(['sourceReferrerId', 'qcReviewId']);
const LONG = new Set([
  'description', 'need', 'businessObjective', 'targetAudience', 'scope', 'expectedDeliverables', 'competitorContext', 'constraints', 'successCriteria',
  'executiveSummary', 'approach', 'deliverablesSummary', 'timelineSummary', 'objective', 'inScope', 'outOfScope', 'scopeOfWork', 'brief', 'expectedOutput',
  'requiredResources', 'scopeSummary', 'paymentTerms', 'requestedChange', 'requiredCorrection', 'mitigation', 'context', 'decision', 'alternatives',
  'progress', 'completed', 'inProgress', 'next', 'risks', 'issues', 'decisionsNeeded', 'financialStatus', 'notes', 'justification', 'address',
]);

function unwrap(t: any): { t: any; optional: boolean } {
  let optional = false;
  for (;;) {
    const n = t?._def?.typeName;
    if (n === 'ZodOptional' || n === 'ZodDefault') { optional = true; t = t._def.innerType; continue; }
    if (n === 'ZodNullable') { t = t._def.innerType; continue; }
    if (n === 'ZodEffects') { t = t._def.schema; continue; }
    return { t, optional };
  }
}

export function fieldsOf(schema: ZodTypeAny): FieldSpec[] {
  const shape = (unwrap(schema).t as { shape: Record<string, ZodTypeAny> }).shape;
  return Object.entries(shape).filter(([k]) => !HIDDEN.has(k)).map(([key, raw]) => {
    const { t, optional } = unwrap(raw);
    const n = t._def.typeName as string;
    const base = { key, required: !optional };
    if (PEOPLE.has(key)) return { ...base, kind: 'person' as const };
    if (REFS[key]) return { ...base, kind: 'record' as const, ref: REFS[key] };
    if (n === 'ZodEnum') return { ...base, kind: 'enum' as const, options: [...t._def.values] as string[] };
    if (n === 'ZodArray' && unwrap(t._def.type).t._def.typeName === 'ZodEnum') return { ...base, kind: 'enums' as const, options: [...unwrap(t._def.type).t._def.values] as string[] };
    if (n === 'ZodNumber') return { ...base, kind: 'number' as const };
    if (n === 'ZodDate') return { ...base, kind: 'date' as const };
    if (n === 'ZodBoolean') return { ...base, kind: 'bool' as const };
    return { ...base, kind: LONG.has(key) ? 'long' as const : 'text' as const };
  });
}

/* ── the labels people read ───────────────────────────────────────────────── */

const LABELS: Record<string, string> = {
  name: tr('نام'), title: tr('عنوان'), companyName: tr('نام شرکت'), contactName: tr('نام رابط'), phone: tr('تلفن'), email: tr('ایمیل'),
  source: tr('منبع'), sourceChannel: tr('کانال'), sourcePartnerName: tr('نام معرف'), sourceUserId: tr('همکار معرف'), estimatedValue: tr('ارزش تخمینی'),
  need: tr('نیاز'), ownerId: tr('مسئول'), confirmDuplicate: tr('با وجود تکراری ثبت شود'), companyId: tr('مشتری'), leadId: tr('سرنخ'),
  expectedCloseDate: tr('تاریخ پیش‌بینی بستن'), servicesNeeded: tr('خدمات مورد نیاز'), description: tr('شرح'), legalName: tr('نام حقوقی'),
  brandName: tr('نام تجاری'), industry: tr('صنعت'), nationalId: tr('شناسهٔ ملی'), economicCode: tr('کد اقتصادی'), postalCode: tr('کد پستی'),
  website: tr('وب‌سایت'), address: tr('آدرس'), accountOwnerId: tr('مالک اکانت'), salesOwnerId: tr('مسئول فروش'), fullName: tr('نام و نام خانوادگی'),
  jobTitle: tr('عنوان شغلی'), isPrimary: tr('رابط اصلی'), notes: tr('یادداشت'), opportunityId: tr('فرصت فروش'), businessObjective: tr('هدف کسب‌وکار'),
  targetAudience: tr('مخاطب هدف'), scope: tr('محدودهٔ کار (Scope)'), expectedDeliverables: tr('خروجی‌های مورد انتظار'), budgetRange: tr('بودجه'),
  desiredDeadline: tr('مهلت مطلوب'), unitsNeeded: tr('واحدهای مورد نیاز'), competitorContext: tr('رقبا'), constraints: tr('محدودیت‌ها'),
  successCriteria: tr('معیار موفقیت'), briefId: tr('بریف'), executiveSummary: tr('خلاصهٔ مدیریتی'), approach: tr('رویکرد'),
  deliverablesSummary: tr('خلاصهٔ خروجی‌ها'), timelineSummary: tr('خلاصهٔ زمان‌بندی'), proposalId: tr('پروپوزال'), objective: tr('هدف'),
  plannedStart: tr('آغاز برنامه‌ریزی‌شده'), plannedEnd: tr('پایان برنامه‌ریزی‌شده'), plannedBudget: tr('بودجهٔ برنامه‌ریزی‌شده'),
  inScope: tr('داخل Scope'), outOfScope: tr('خارج از Scope'), projectId: tr('پروژه'), targetDepartmentCode: tr('واحد مقصد'),
  scopeOfWork: tr('شرح کار'), brief: tr('بریف کار'), expectedOutput: tr('خروجی مورد انتظار'), outputFormat: tr('قالب خروجی'),
  deadline: tr('مهلت'), budget: tr('بودجه'), requiredResources: tr('منابع لازم'), priority: tr('اولویت'), workOrderId: tr('سفارش کار'),
  deliverableId: tr('خروجی'), departmentCode: tr('واحد'), assigneeId: tr('مسئول انجام'), dueDate: tr('سررسید'), estimateHours: tr('ساعت تخمینی'),
  sourceType: tr('منشأ'), sourceRef: tr('مرجع منشأ'), format: tr('قالب'), contractValue: tr('مبلغ قرارداد'), currency: tr('ارز'),
  startDate: tr('تاریخ آغاز'), endDate: tr('تاریخ پایان'), scopeSummary: tr('خلاصهٔ Scope'), paymentTerms: tr('شرایط پرداخت'),
  requestedChange: tr('تغییر درخواستی'), requestedBy: tr('درخواست‌دهنده'), requestedDate: tr('تاریخ درخواست'), taskId: tr('وظیفه'),
  reason: tr('دلیل'), requiredCorrection: tr('اصلاح لازم'), responsibleDepartmentCode: tr('واحد مسئول'), probability: tr('احتمال'),
  impact: tr('اثر'), mitigation: tr('اقدام کاهشی'), severity: tr('شدت'), targetResolution: tr('مهلت رفع'), context: tr('زمینه'),
  decision: tr('تصمیم'), alternatives: tr('گزینه‌های دیگر'), decidedById: tr('تصمیم‌گیرنده'), decidedAt: tr('تاریخ تصمیم'),
  period: tr('دوره'), progress: tr('پیشرفت'), completed: tr('انجام‌شده'), inProgress: tr('در جریان'), next: tr('گام بعد'),
  timelineStatus: tr('وضعیت زمان‌بندی'), risks: tr('ریسک‌ها'), issues: tr('مسائل'), decisionsNeeded: tr('تصمیم‌های لازم'),
  financialStatus: tr('وضعیت مالی'), kind: tr('نوع'), specialty: tr('تخصص'), dayRate: tr('نرخ روزانه'), supplierId: tr('تأمین‌کننده'),
  proposedSupplierName: tr('تأمین‌کنندهٔ پیشنهادی'), estimatedCost: tr('هزینهٔ تخمینی'), neededBy: tr('مورد نیاز تا'), justification: tr('توجیه'),
};
const labelOf = (key: string) => LABELS[key] ?? key;
/** Choices named by their own vocabulary rather than the shared state labels. */
const TASK_SOURCES: Record<string, string> = {
  BRIEF: tr('بریف'), ORDER_FORM: tr('فرم سفارش'), TASK: tr('وظیفه'),
  MEETING_MINUTES: tr('صورتجلسه'), CHANGE_REQUEST: tr('درخواست تغییر'), REVISION_FORM: tr('فرم اصلاحیه'),
};
const bilingual = (l: { fa: string; en: string } | undefined, v: string) => (l ? (isEnglish() ? l.en : l.fa) : trx(stateLabelFa(v)));

const choiceLabel = (key: string, v: string) => {
  if (/department/i.test(key) || key === 'unitsNeeded' || key === 'servicesNeeded') return bilingual(DEPARTMENT_LABELS[v as DepartmentCode], v);
  if (key === 'source') return bilingual(LEAD_SOURCE_LABELS[v as LeadSourceKind], v);
  if (key === 'sourceChannel') return bilingual(DIRECT_CHANNEL_LABELS[v as DirectChannel], v);
  if (key === 'sourceType') return TASK_SOURCES[v] ?? v;
  if (key === 'currency') return currencyFa(v);
  return trx(stateLabelFa(v));
};

/* ── the form ─────────────────────────────────────────────────────────────── */

function RefSelect({ spec, value, onChange }: { spec: FieldSpec; value: string; onChange: (v: string) => void }) {
  const people = useQuery<{ id: string; fullName: string; jobTitle: string | null }[]>({ queryKey: ['/people', ''], queryFn: () => apiGet('/people'), enabled: spec.kind === 'person' });
  const records = useQuery<Page<any>>({ queryKey: [spec.ref?.path, 'pick'], queryFn: () => apiGet(spec.ref!.path, { pageSize: '200' }), enabled: spec.kind === 'record' });
  const options = spec.kind === 'person'
    ? (people.data ?? []).map((p) => ({ value: p.id, label: p.jobTitle ? `${p.fullName} — ${p.jobTitle}` : p.fullName }))
    : (records.data?.items ?? []).map((r) => ({ value: r.id as string, label: spec.ref!.show(r) }));
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={labelOf(spec.key)}>
      <option value="">{spec.required ? tr('— برگزینید —') : tr('— هیچ —')}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </Select>
  );
}

export function QuickCreateForm({ kind, onClose }: { kind: RecordKind; onClose: () => void }) {
  const fields = useMemo(() => fieldsOf(kind.schema), [kind]);
  const [v, setV] = useState<Record<string, unknown>>({});
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const set = (key: string, value: unknown) => setV((x) => ({ ...x, [key]: value }));
  const missing = fields.some((f) => f.required && f.kind !== 'bool' && f.kind !== 'enums' && (v[f.key] === undefined || v[f.key] === ''));

  const save = async () => {
    setBusy(true); setIssues({});
    const body: Record<string, unknown> = {};
    for (const f of fields) {
      const value = v[f.key];
      if (value === undefined || value === '' || (Array.isArray(value) && !value.length && !f.required)) continue;
      body[f.key] = f.kind === 'number' ? Number(value) : value;
    }
    try {
      const made = await apiPost<{ id: string }>(kind.path, body);
      toast(tr('{0} ساخته شد.', kind.label));
      await qc.invalidateQueries();
      onClose();
      if (kind.href) navigate(kind.href(made.id));
    } catch (e: any) {
      const list = e?.details?.issues as { path: string; message: string }[] | undefined;
      if (list) setIssues(Object.fromEntries(list.map((i) => [i.path.split('.')[0]!, trx(i.message)])));
      toast(e?.message ?? tr('عملیات ناموفق بود.'), 'danger');
    } finally { setBusy(false); }
  };

  return (
    <Modal open wide onClose={onClose} title={tr('{0} تازه — مستقیم، به‌عنوان مدیر سیستم', kind.label)}
      footer={<><Button onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" loading={busy} disabled={missing} onClick={() => void save()}>{tr('ساختن')}</Button></>}>
      <p className="mb-3 text-xs text-ink-600">{tr('بی‌مراحل پیشین ساخته می‌شود و با نام شما در سابقه می‌ماند.')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => {
          const label = labelOf(f.key);
          const value = v[f.key];
          const wide = f.kind === 'long' || f.kind === 'enums';
          const control = (() => {
            switch (f.kind) {
              case 'long': return <Textarea value={(value as string) ?? ''} onChange={(e) => set(f.key, e.target.value)} />;
              case 'number': return <Input type="number" inputMode="decimal" value={(value as string) ?? ''} onChange={(e) => set(f.key, e.target.value)} />;
              case 'date': return <JalaliDateInput value={(value as string) ?? ''} onChange={(d) => set(f.key, d)} label={label} />;
              case 'bool': return <Checkbox label={label} checked={!!value} onChange={(e) => set(f.key, e.target.checked)} />;
              case 'enum': return (
                <Select value={(value as string) ?? ''} onChange={(e) => set(f.key, e.target.value)}>
                  <option value="">{f.required ? tr('— برگزینید —') : tr('— هیچ —')}</option>
                  {f.options!.map((o) => <option key={o} value={o}>{choiceLabel(f.key, o)}</option>)}
                </Select>
              );
              case 'enums': return (
                <div className="flex flex-wrap gap-3">{f.options!.map((o) => (
                  <Checkbox key={o} label={choiceLabel(f.key, o)} checked={((value as string[]) ?? []).includes(o)}
                    onChange={(e) => set(f.key, e.target.checked ? [...((value as string[]) ?? []), o] : ((value as string[]) ?? []).filter((x) => x !== o))} />
                ))}</div>
              );
              case 'person': case 'record': return <RefSelect spec={f} value={(value as string) ?? ''} onChange={(x) => set(f.key, x)} />;
              default: return <Input value={(value as string) ?? ''} onChange={(e) => set(f.key, e.target.value)} />;
            }
          })();
          if (f.kind === 'bool') return <div key={f.key} className="sm:col-span-2">{control}</div>;
          return <div key={f.key} className={wide ? 'sm:col-span-2' : undefined}><Field label={label} required={f.required} error={issues[f.key]}>{control}</Field></div>;
        })}
      </div>
    </Modal>
  );
}

/** «… تازه» on a section's list, for the system administrator. */
export function QuickCreateButton({ path }: { path: string }) {
  const systemAdmin = useSystemAdmin();
  const [open, setOpen] = useState(false);
  const kind = RECORD_KINDS.find((k) => k.path === path);
  if (!systemAdmin || !kind) return null;
  return (
    <>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}><IconPlus className="size-4" />{tr('{0} تازه', kind.label)}</Button>
      {open && <QuickCreateForm kind={kind} onClose={() => setOpen(false)} />}
    </>
  );
}
