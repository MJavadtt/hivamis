import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBlob, apiGet, apiPost, apiUpload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fallbackInterval, useLiveStatus, useLiveUpdates } from '../lib/live';
import { formatDate, formatDateTime, formatRelative, localDigits } from '../lib/format';
import {
  disablePush, enablePush, pushErrorFa, pushState, reannouncePush, removeSubscription, type PushKey, type PushState,
} from '../lib/push';
import { useDismissable, useFocusTrap } from '../hooks/useDismissable';
import { STAGE_ZERO_VERDICT } from '../components/StageZero';
import { VoiceButton } from '../components/VoiceButton';
import { AssistantChat } from '../components/AssistantChat';
import { Badge, Button, Checkbox, EmptyState, ErrorBlock, Field, IconBell, IconClose, LoadingBlock, Spinner, Textarea, cx, useToast } from '../components/ui';
import { loc, tr, trx } from '../i18n';

/**
 * The phone (roadmap #49): three things, done well, and nothing else. Accepting a work order,
 * deciding a form, recording a unit's level-1 QC — each has a deadline of hours, and each is
 * something a person does away from a desk. Everything goes through the same endpoints and the
 * same engine as the full interface; this screen only asks less of the person holding the phone.
 */

interface WorkItem {
  kind: string; entityType: string; entityId: string; code: string; title: string; state: string;
  projectCode: string | null; projectName: string | null; dueAt: string | null;
  sla: { policyCode: string; labelFa: string; state: string; dueAt: string; budgetHours: number; controlledHours: number } | null;
  availableTransitions: { action: string; labelFa: string; requiresReason: boolean }[];
}
interface Queue { items: WorkItem[] }

type TabKey = 'workOrder' | 'formApproval' | 'qcUnit';
const TABS: { key: TabKey; labelFa: string; entityType: string; match: (i: WorkItem) => boolean; emptyFa: string }[] = [
  { key: 'workOrder', labelFa: tr('پذیرش سفارش'), entityType: 'workOrder', match: (i) => i.kind === 'workOrder' && ['ISSUED', 'PENDING_ACCEPTANCE'].includes(i.state), emptyFa: tr('سفارشی در انتظار پذیرش شما نیست.') },
  { key: 'formApproval', labelFa: tr('تأیید فرم'), entityType: 'formSubmission', match: (i) => i.kind === 'formApproval', emptyFa: tr('فرمی در انتظار تصمیم شما نیست.') },
  { key: 'qcUnit', labelFa: tr('QC واحد'), entityType: 'deliverable', match: (i) => i.kind === 'qcUnit', emptyFa: tr('خروجی‌ای در انتظار QC واحد نیست.') },
];

const errorFa = (e: unknown) => (e as { message?: string })?.message ?? tr('ثبت نشد؛ دوباره تلاش کنید.');

/** What is left of a clock, in working hours — or that it has gone. */
function SlaPill({ sla }: { sla: WorkItem['sla'] }) {
  if (!sla) return null;
  const left = Math.max(0, sla.budgetHours - sla.controlledHours);
  const tone = sla.state === 'BREACHED' ? 'danger' : sla.state === 'AT_RISK' ? 'warning' : sla.state === 'PAUSED' ? 'neutral' : 'info';
  return (
    <Badge tone={tone} className="shrink-0 whitespace-nowrap">
      {sla.state === 'BREACHED' ? tr('مهلت گذشته') : sla.state === 'PAUSED' ? tr('متوقف') : tr('{0} ساعت مانده', localDigits(Math.round(left * 10) / 10))}
    </Badge>
  );
}

/** A sheet from the bottom — the phone's dialog. Escape, outside tap and focus as the app's overlays have them. */
function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useDismissable<HTMLDivElement>({ open: true, onClose });
  useFocusTrap(ref, true);
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink-900/40">
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title}
        className="animate-in flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-2xl bg-surface shadow-2xl">
        <header className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
          <h2 className="min-w-0 truncate text-sm font-semibold text-ink-800">{title}</h2>
          <button onClick={onClose} className="rounded p-1.5 text-ink-400 hover:bg-ink-100" aria-label={tr('بستن')}><IconClose className="size-5" /></button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer && <footer className="border-t border-ink-100 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</footer>}
      </div>
    </div>
  );
}

const Row = ({ label, children }: { label: string; children: ReactNode }) =>
  children == null || children === '' ? null : (
    <div className="py-2">
      <dt className="text-[12.5px] text-ink-500">{label}</dt>
      <dd className="mt-0.5 whitespace-pre-line text-sm text-ink-800">{children}</dd>
    </div>
  );

const Alert = ({ children }: { children: ReactNode }) => (
  <p role="alert" className="mb-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800 ring-1 ring-inset ring-rose-200">{children}</p>
);

const transition = (entity: string, id: string, action: string, reason?: string) =>
  apiPost(`/workflow/${entity}/${id}/transitions`, { action, ...(reason ? { reason } : {}) });

/* ── 1. Accepting a work order ─────────────────────────────────────────────────────────────── */

interface WorkOrder {
  id: string; code: string; title: string; state: string; scopeOfWork: string; brief: string; expectedOutput: string;
  outputFormat: string; deadline: string; requiredResources: string | null;
  project: { code: string; name: string; company?: { legalName: string } | null } | null;
}

function WorkOrderSheet({ item, onDone, onClose }: { item: WorkItem; onDone: (message: string) => void; onClose: () => void }) {
  const { data, isLoading, error } = useQuery<WorkOrder>({ queryKey: [`/work-orders/${item.entityId}`], queryFn: () => apiGet(`/work-orders/${item.entityId}`) });
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const can = (a: string) => item.availableTransitions.some((t) => t.action === a);

  const act = async (action: 'accept' | 'request_clarification') => {
    setBusy(true); setProblem(null);
    try {
      await transition('workOrder', item.entityId, action, action === 'request_clarification' ? reason.trim() : undefined);
      onDone(action === 'accept' ? tr('سفارش {0} پذیرفته شد.', item.code) : tr('ابهام سفارش {0} برای اکانت ثبت شد.', item.code));
    } catch (e) { setProblem(errorFa(e)); } finally { setBusy(false); }
  };

  return (
    <Sheet title={item.title} onClose={onClose} footer={
      asking ? (
        <div className="space-y-2">
          <Field label={tr('چه چیزی مبهم است؟')} required hint={tr('مهلت پذیرش تا پاسخ اکانت متوقف می‌شود.')}>
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={() => setAsking(false)}>{tr('بازگشت')}</Button>
            <Button variant="primary" loading={busy} disabled={!reason.trim()} onClick={() => void act('request_clarification')}>{tr('ثبت ابهام')}</Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" disabled={!can('request_clarification') || busy} onClick={() => setAsking(true)}>{tr('اعلام ابهام')}</Button>
          <Button variant="primary" loading={busy} disabled={!can('accept')} onClick={() => void act('accept')}>{tr('پذیرش سفارش')}</Button>
        </div>
      )
    }>
      {problem && <Alert>{problem}</Alert>}
      {!can('accept') && <p className="mb-2 text-xs text-ink-500">{tr('پذیرش این سفارش با دسترسی شما نیست.')}</p>}
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-ink-500">
        <span dir="ltr">{item.code}</span>{item.sla && <SlaPill sla={item.sla} />}
      </div>
      {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} /> : data && (
        <dl className="divide-y divide-ink-100">
          <Row label={tr('پروژه')}>{data.project ? `${data.project.name}${data.project.company?.legalName ? ` — ${data.project.company.legalName}` : ''}` : null}</Row>
          <Row label={tr('موعد تحویل')}>{`${formatDate(data.deadline)} (${formatRelative(data.deadline)})`}</Row>
          <Row label={tr('خروجی مورد انتظار')}>{data.expectedOutput}</Row>
          <Row label={tr('قالب خروجی')}>{data.outputFormat}</Row>
          <Row label={tr('شرح کار')}>{data.scopeOfWork}</Row>
          <Row label={tr('بریف')}>{data.brief}</Row>
          <Row label={tr('منابع لازم')}>{data.requiredResources}</Row>
        </dl>
      )}
    </Sheet>
  );
}

/* ── 2. Deciding a form ────────────────────────────────────────────────────────────────────── */

interface FieldDef { key: string; labelFa: string; type: string; entity?: string; options?: { value: string; labelFa: string }[] }
interface SubmissionDetail {
  id: string; code: string; state: string; data: Record<string, unknown>; createdAt: string;
  definition: { nameFa: string; schema: FieldDef[] }; schema?: FieldDef[];
  submittedBy: { fullName: string }; project: { id: string; code: string; name: string } | null;
  documents: { id: string; fileName: string }[];
}

function shown(v: unknown, f: FieldDef | undefined, project: SubmissionDetail['project']): string {
  if (typeof v === 'boolean') return v ? tr('بله') : tr('خیر');
  // A link to a record is its id; the phone shows what it names, or says where to see it.
  if (f?.type === 'entityRef') return f.entity === 'project' && project && project.id === v ? `${project.name} (${project.code})` : tr('رکورد پیوست‌شده — در نسخهٔ کامل');
  if (Array.isArray(v)) return tr('{0} مورد', localDigits(v.length));
  if (f?.options) { const o = f.options.find((x) => x.value === v); return o ? loc(o, 'label') : String(v); }
  if (f?.type === 'date' || f?.type === 'datetime') return formatDate(String(v));
  return String(v);
}

function FormSheet({ item, onDone, onClose }: { item: WorkItem; onDone: (message: string) => void; onClose: () => void }) {
  const { data, isLoading, error } = useQuery<SubmissionDetail>({ queryKey: [`/forms/submissions/${item.entityId}`], queryFn: () => apiGet(`/forms/submissions/${item.entityId}`) });
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const decide = async (decision: 'APPROVE' | 'REJECT' | 'RETURN') => {
    setBusy(true); setProblem(null);
    try {
      await apiPost(`/forms/submissions/${item.entityId}/decision`, { decision, comment: comment.trim() || undefined });
      onDone(decision === 'APPROVE' ? tr('فرم {0} تأیید شد.', item.code) : decision === 'REJECT' ? tr('فرم {0} رد شد.', item.code) : tr('فرم {0} برای اصلاح بازگشت.', item.code));
    } catch (e) { setProblem(errorFa(e)); } finally { setBusy(false); }
  };

  const fields = new Map((data?.schema ?? data?.definition.schema ?? []).map((f) => [f.key, f]));
  const entries = Object.entries(data?.data ?? {}).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0));

  return (
    <Sheet title={item.title} onClose={onClose} footer={
      <div className="space-y-2">
        <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={tr('توضیح تصمیم — برای رد یا بازگشت الزامی')} aria-label={tr('توضیح تصمیم')} />
        <div className="grid grid-cols-3 gap-2">
          <Button variant="danger" loading={busy} disabled={!comment.trim()} onClick={() => void decide('REJECT')}>{tr('رد')}</Button>
          <Button variant="secondary" loading={busy} disabled={!comment.trim()} onClick={() => void decide('RETURN')}>{tr('بازگشت')}</Button>
          <Button variant="primary" loading={busy} onClick={() => void decide('APPROVE')}>{tr('تأیید')}</Button>
        </div>
      </div>
    }>
      {problem && <Alert>{problem}</Alert>}
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-ink-500">
        <span dir="ltr">{item.code}</span>{item.sla && <SlaPill sla={item.sla} />}
      </div>
      {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} /> : data && (
        <>
          <p className="text-xs text-ink-500">{tr('فرستنده: {0} — {1}{2}', data.submittedBy.fullName, formatRelative(data.createdAt), data.project ? ` — ${data.project.name}` : '')}</p>
          <dl className="mt-2 divide-y divide-ink-100">
            {entries.map(([k, v]) => <Row key={k} label={trx(fields.get(k)?.labelFa ?? k)}>{shown(v, fields.get(k), data.project)}</Row>)}
          </dl>
          {data.documents.length > 0 && (
            <p className="mt-2 text-xs text-ink-500">{tr('{0} فایل پیوست —', localDigits(data.documents.length))}{' '}<Link className="text-brand-700 underline" to={`/forms?submission=${data.id}`}>{tr('در نسخهٔ کامل')}</Link>
            </p>
          )}
        </>
      )}
    </Sheet>
  );
}

/* ── 3. Level-1 QC, often on set ───────────────────────────────────────────────────────────── */

const CHECKS: { key: string; labelFa: string }[] = [
  { key: 'matchesBrief', labelFa: tr('مطابق بریف است') },
  { key: 'technicallySound', labelFa: tr('از نظر فنی صحیح است') },
  { key: 'brandCompliant', labelFa: tr('مطابق هویت بصری است') },
  { key: 'completeDeliverable', labelFa: tr('کامل است') },
];
const MAX_PHOTOS = 4;

interface Deliverable { id: string; code: string; name: string; format: string | null; dueDate: string | null; stageZeroVerdict: 'PASS' | 'WARN' | 'FAIL' | null; description: string | null }
interface DocumentRow { id: string; fileName: string; mimeType: string }

/** Opens a file the way the app shows it — through the audited preview, never a bare link. */
async function openPreview(id: string) {
  const url = URL.createObjectURL(await apiBlob(`/documents/${id}/preview`));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function QcSheet({ item, onDone, onClose }: { item: WorkItem; onDone: (message: string) => void; onClose: () => void }) {
  const d = useQuery<Deliverable>({ queryKey: [`/deliverables/${item.entityId}`], queryFn: () => apiGet(`/deliverables/${item.entityId}`) });
  const files = useQuery<DocumentRow[]>({ queryKey: ['/documents', { deliverableId: item.entityId }], queryFn: () => apiGet('/documents', { deliverableId: item.entityId }) });
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [verdict, setVerdict] = useState<'PASSED' | 'FAILED' | null>(null);
  const [findings, setFindings] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The review exists once recorded; a photo that did not go can be sent again against it. */
  const [recorded, setRecorded] = useState<{ reviewId: string; failed: File[] } | null>(null);
  const previews = useMemo(() => photos.map((p) => URL.createObjectURL(p)), [photos]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  const sendPhotos = async (reviewId: string, list: File[]) => {
    const failed: File[] = [];
    for (const p of list) {
      const fd = new FormData();
      // The field before the file: the server reads fields that arrive ahead of the stream.
      fd.append('qcReviewId', reviewId);
      fd.append('file', p, p.name || 'photo.jpg');
      try { await apiUpload('/documents', fd); } catch { failed.push(p); }
    }
    return failed;
  };

  const finish = (failed: File[], reviewId: string) => {
    if (failed.length) {
      setRecorded({ reviewId, failed });
      setProblem(tr('QC ثبت شد، اما {0} عکس نرسید. دوباره بفرستید یا بدون آن ببندید.', localDigits(failed.length)));
    } else {
      onDone(verdict === 'PASSED' ? tr('QC واحد {0} با نتیجهٔ قبول ثبت شد.', item.code) : tr('QC واحد {0} رد شد و اصلاحیه صادر شد.', item.code));
    }
  };

  const submit = async () => {
    if (!verdict) return;
    setBusy(true); setProblem(null);
    try {
      const res = await apiPost<{ review: { id: string } }>('/qc-reviews', {
        level: 'UNIT', deliverableId: item.entityId, verdict, findings: findings.trim() || undefined,
        checklist: Object.fromEntries(CHECKS.map((c) => [c.key, Boolean(checks[c.key])])),
      });
      finish(await sendPhotos(res.review.id, photos), res.review.id);
    } catch (e) { setProblem(errorFa(e)); } finally { setBusy(false); }
  };

  const retry = async () => {
    if (!recorded) return;
    setBusy(true); setProblem(null);
    try { finish(await sendPhotos(recorded.reviewId, recorded.failed), recorded.reviewId); } finally { setBusy(false); }
  };

  const unchecked = CHECKS.filter((c) => !checks[c.key]).length;

  return (
    <Sheet title={item.title} onClose={onClose} footer={
      recorded ? (
        <div className="grid grid-cols-2 gap-2">
          <Button variant="ghost" onClick={() => onDone(tr('QC واحد {0} ثبت شد؛ عکس‌ها نرسیدند.', item.code))}>{tr('بستن بدون عکس')}</Button>
          <Button variant="primary" loading={busy} onClick={() => void retry()}>{tr('ارسال دوبارهٔ عکس')}</Button>
        </div>
      ) : (
        <Button variant="primary" className="w-full" loading={busy} disabled={!verdict || (verdict === 'FAILED' && !findings.trim())} onClick={() => void submit()}>{tr('ثبت QC {0}', verdict === 'PASSED' ? tr('— قبول') : verdict === 'FAILED' ? tr('— رد') : '')}</Button>
      )
    }>
      {problem && <Alert>{problem}</Alert>}
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-ink-500">
        <span dir="ltr">{item.code}</span>
        {d.data?.stageZeroVerdict && (
          <Badge tone={STAGE_ZERO_VERDICT.tone[d.data.stageZeroVerdict]}>{tr('مرحلهٔ صفر: {0}', STAGE_ZERO_VERDICT.fa[d.data.stageZeroVerdict])}</Badge>
        )}
      </div>
      {d.data && (
        <dl className="divide-y divide-ink-100">
          <Row label={tr('قالب')}>{d.data.format}</Row>
          <Row label={tr('سررسید')}>{d.data.dueDate ? `${formatDate(d.data.dueDate)} (${formatRelative(d.data.dueDate)})` : null}</Row>
          <Row label={tr('شرح')}>{d.data.description}</Row>
        </dl>
      )}
      <section className="mt-2">
        <h3 className="text-xs font-medium text-ink-700">{tr('فایل‌های تحویل‌شده')}</h3>
        {files.isLoading ? <Spinner className="mt-2" /> : !files.data?.length ? <p className="mt-1 text-xs text-ink-500">{tr('فایلی پیوست نیست.')}</p> : (
          <ul className="mt-1 space-y-1">
            {files.data.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate" dir="auto">{f.fileName}</span>
                <button className="shrink-0 text-brand-700 underline" onClick={() => void openPreview(f.id)}>{tr('دیدن')}</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <fieldset className="mt-3 space-y-2" disabled={Boolean(recorded)}>
        <legend className="mb-1 text-xs font-medium text-ink-700">{tr('چک‌لیست QC سطح ۱')}</legend>
        {CHECKS.map((c) => (
          <Checkbox key={c.key} label={loc(c, 'label')} checked={Boolean(checks[c.key])} onChange={(e) => setChecks((s) => ({ ...s, [c.key]: e.target.checked }))} />
        ))}
      </fieldset>

      <div className="mt-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label={tr('نتیجه')}>
        {(['PASSED', 'FAILED'] as const).map((v) => (
          <button key={v} role="radio" aria-checked={verdict === v} disabled={Boolean(recorded)} onClick={() => setVerdict(v)}
            className={cx('rounded-lg px-3 py-2.5 text-sm font-medium ring-1 ring-inset',
              verdict === v ? (v === 'PASSED' ? 'bg-emerald-600 text-white ring-emerald-600' : 'bg-rose-600 text-white ring-rose-600') : 'bg-surface text-ink-700 ring-ink-300')}>
            {v === 'PASSED' ? tr('قبول') : tr('رد — نیاز به اصلاح')}
          </button>
        ))}
      </div>
      {verdict === 'PASSED' && unchecked > 0 && (
        <p className="mt-2 text-xs text-amber-700">{tr('{0} مورد چک‌لیست تیک نخورده و با «قبول» همان‌طور ثبت می‌شود.', localDigits(unchecked))}</p>
      )}
      <div className="mt-3">
        <Field label={tr('یافته‌ها')} required={verdict === 'FAILED'} hint={verdict === 'FAILED' ? tr('اصلاحیه با همین متن صادر می‌شود.') : undefined}>
          <Textarea rows={3} value={findings} onChange={(e) => setFindings(e.target.value)} disabled={Boolean(recorded)} />
        </Field>
      </div>

      <div className="mt-3">
        <span className="mb-1 block text-xs font-medium text-ink-700">{tr('عکس از صحنه (اختیاری، تا {0} عکس)', localDigits(MAX_PHOTOS))}</span>
        <p className="mb-2 text-[12.5px] text-ink-500">{tr('شاهدِ همین بررسی است، نه فایل خروجی؛ پس از ثبت، ویرایش نمی‌شود.')}</p>
        <div className="flex flex-wrap gap-2">
          {previews.map((src, i) => (
            <div key={src} className="relative">
              <img src={src} alt={tr('عکس {0}', localDigits(i + 1))} className="size-20 rounded-lg object-cover ring-1 ring-ink-200" />
              {!recorded && (
                <button className="absolute -top-1.5 -start-1.5 rounded-full bg-ink-900/80 p-0.5 text-white" aria-label={tr('حذف عکس {0}', localDigits(i + 1))}
                  onClick={() => setPhotos((p) => p.filter((_, j) => j !== i))}><IconClose className="size-3.5" /></button>
              )}
            </div>
          ))}
          {!recorded && photos.length < MAX_PHOTOS && (
            <label className="flex size-20 cursor-pointer flex-col items-center justify-center rounded-lg text-[12.5px] text-ink-500 ring-1 ring-dashed ring-ink-300">
              <span aria-hidden className="text-lg">＋</span>{tr('عکس')}<input type="file" accept="image/*" capture="environment" multiple className="sr-only" aria-label={tr('افزودن عکس')}
                onChange={(e) => { const list = Array.from(e.target.files ?? []); setPhotos((p) => [...p, ...list].slice(0, MAX_PHOTOS)); e.target.value = ''; }} />
            </label>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/* ── Notices on this phone ─────────────────────────────────────────────────────────────────── */

interface MySubscription { id: string; host: string; userAgent: string | null; lastSuccessAt: string | null; disabledAt: string | null; disabledReason: string | null }
interface TestResult { delivery: 'on' | 'off'; results: { host: string; status: string; error: string | null }[] }

const DISABLED_FA: Record<string, string> = {
  GONE: tr('سرویس اعلان این مرورگر را دیگر نمی‌شناسد'), REJECTED: tr('سرویس اعلان کلید را نپذیرفت'), FAILING: tr('بارها نرسید'), NOT_ALLOWED: tr('سرویس اعلانش مجاز نیست'),
};
const deviceFa = (ua: string | null) =>
  !ua ? tr('مرورگر') : /iPhone|iPad/.test(ua) ? tr('آیفون/آیپد') : /Android/.test(ua) ? tr('اندروید') : /Macintosh/.test(ua) ? tr('مک') : /Windows/.test(ua) ? tr('ویندوز') : tr('مرورگر');

function PushPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { signOut } = useAuth();
  const key = useQuery<PushKey>({ queryKey: ['/push/key'], queryFn: () => apiGet('/push/key'), staleTime: Infinity });
  const subs = useQuery<MySubscription[]>({ queryKey: ['/push/subscriptions'], queryFn: () => apiGet('/push/subscriptions') });
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  useEffect(() => { if (key.data || key.error) void pushState(key.data).then(setState); }, [key.data, key.error]);
  const refresh = async () => { setState(await pushState(key.data)); await qc.invalidateQueries({ queryKey: ['/push/subscriptions'] }); };

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true); setMessage(null);
    try { await fn(); setMessage({ tone: 'ok', text: ok }); } catch (e) { setMessage({ tone: 'bad', text: pushErrorFa(e) }); } finally { setBusy(false); await refresh(); }
  };
  const test = async () => {
    setBusy(true); setMessage(null);
    try {
      const r = await apiPost<TestResult>('/push/test');
      const good = r.results.filter((x) => x.status === 'SENT').length;
      setMessage(!r.results.length ? { tone: 'bad', text: tr('مرورگری برای اعلان ثبت نشده است.') }
        : good === r.results.length ? { tone: 'ok', text: tr('سرویس اعلان پذیرفت؛ تا چند ثانیهٔ دیگر روی {0} مرورگر می‌رسد.', localDigits(good)) }
        : { tone: 'bad', text: r.results.filter((x) => x.status !== 'SENT').map((x) => `${x.host}: ${x.error ?? x.status}`).join(' — ') });
    } catch (e) { setMessage({ tone: 'bad', text: errorFa(e) }); } finally { setBusy(false); await refresh(); }
  };

  const explain: Partial<Record<PushState, string>> = {
    unsupported: tr('این مرورگر اعلان وب (Web Push) ندارد. روی اندروید، Chrome یا Firefox را به‌روز کنید؛ پیام‌رسان هم راه دیگر است.'),
    'needs-install': tr('در آیفون، اعلان فقط وقتی کار می‌کند که این صفحه را با «Share ← Add to Home Screen» به صفحهٔ اصلی بیفزایید و از همان‌جا باز کنید.'),
    'server-off': tr('این نصب هیوامیس اعلان روی گوشی نمی‌فرستد (به سرویس‌های اعلان مرورگرها راه ندارد). پیام‌رسان یا ایمیل را از مدیر سیستم بخواهید.'),
    denied: tr('اجازهٔ اعلان برای این سایت بسته است؛ از تنظیمات سایت در مرورگر «اعلان‌ها» را مجاز کنید و دوباره بیایید.'),
  };

  return (
    <Sheet title={tr('اعلان روی این گوشی')} onClose={onClose}>
      <p className="text-xs text-ink-600">{tr('وقتی سفارش کاری به شما می‌رسد، فرمی منتظر تصمیم شماست یا خروجی واحد QC می‌خواهد — و وقتی مهلتشان نزدیک است — روی همین گوشی خبر می‌گیرید. متن اعلان رمزشده به گوشی می‌رسد.')}</p>
      <div className="mt-3 rounded-lg bg-ink-50 px-3 py-3">
        {state === null ? <Spinner /> : explain[state] ? <p className="text-sm text-ink-700">{explain[state]}</p> : (
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-ink-800">{state === 'on' ? tr('اعلان روشن است') : tr('اعلان خاموش است')}</span>
            {state === 'on'
              ? <Button size="sm" variant="ghost" loading={busy} onClick={() => void run(disablePush, tr('اعلان این مرورگر خاموش شد.'))}>{tr('خاموش کردن')}</Button>
              : <Button size="sm" variant="primary" loading={busy} onClick={() => void run(enablePush, tr('اعلان روشن شد.'))}>{tr('روشن کردن')}</Button>}
          </div>
        )}
        {state === 'on' && <Button size="sm" variant="secondary" className="mt-2 w-full" loading={busy} onClick={() => void test()}>{tr('ارسال اعلان آزمایشی')}</Button>}
      </div>
      {message && (
        <p role="status" className={cx('mt-2 rounded-lg px-3 py-2 text-xs ring-1 ring-inset', message.tone === 'ok' ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-rose-50 text-rose-800 ring-rose-200')}>{message.text}</p>
      )}

      {subs.data && subs.data.length > 0 && (
        <section className="mt-4">
          <h3 className="text-xs font-medium text-ink-700">{tr('مرورگرهای شما')}</h3>
          <ul className="mt-1 divide-y divide-ink-100">
            {subs.data.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 py-2 text-xs">
                <span className="min-w-0">
                  {deviceFa(s.userAgent)} <span className="text-ink-400" dir="ltr">({s.host})</span>
                  <span className="block text-[12.5px] text-ink-500">
                    {s.disabledAt ? tr('خاموش — {0}', DISABLED_FA[s.disabledReason ?? ''] ?? s.disabledReason) : s.lastSuccessAt ? tr('آخرین اعلان: {0}', formatDateTime(s.lastSuccessAt)) : tr('هنوز اعلانی نرفته')}
                  </span>
                </span>
                <button className="shrink-0 text-rose-700 underline" onClick={() => void removeSubscription(s.id).then(refresh)}>{tr('حذف')}</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-ink-100 pt-3 text-xs">
        <Link to="/my-work" className="text-brand-700 underline">{tr('نسخهٔ کامل هیوامیس')}</Link>
        <button className="text-ink-500 underline" onClick={() => void signOut()}>{tr('خروج از حساب')}</button>
      </div>
    </Sheet>
  );
}

/* ── The screen ────────────────────────────────────────────────────────────────────────────── */

export default function Mobile() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const live = useLiveStatus();
  useLiveUpdates(qc);
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey | null>(null);
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState(false);
  // Said to the assistant (audit F-4): the words open its drawer, to be read and sent.
  const [said, setSaid] = useState<string | null>(null);
  const handled = useRef<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery<Queue>({
    queryKey: ['/me/work'], queryFn: () => apiGet('/me/work'), refetchInterval: fallbackInterval(live, 30_000),
  });
  const key = useQuery<PushKey>({ queryKey: ['/push/key'], queryFn: () => apiGet('/push/key'), staleTime: Infinity });

  // Installed from here, the app opens here (start_url /m); the full interface keeps its own manifest.
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    const before = link?.getAttribute('href') ?? null;
    link?.setAttribute('href', '/manifest-m.webmanifest');
    return () => { if (link && before) link.setAttribute('href', before); };
  }, []);

  // The browser may have renewed its subscription since the last visit; the server hears it again.
  useEffect(() => { if (key.data) void reannouncePush(key.data); }, [key.data]);

  // The worker says a push arrived (re-read now), or that a notice was tapped (go there).
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const sw = navigator.serviceWorker;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'hiva:push') void qc.invalidateQueries({ queryKey: ['/me/work'] });
      if (e.data?.type === 'hiva:open' && typeof e.data.url === 'string' && e.data.url.startsWith('/') && !e.data.url.startsWith('//')) navigate(e.data.url);
    };
    sw.addEventListener('message', onMessage);
    return () => sw.removeEventListener('message', onMessage);
  }, [qc, navigate]);

  const lists = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, (data?.items ?? []).filter(t.match)])) as Record<TabKey, WorkItem[]>, [data]);
  const active: TabKey = tab ?? TABS.find((t) => lists[t.key].length)?.key ?? 'workOrder';

  // A tapped notice arrives as ?open=<entity>:<id> — straight to that one, or say why it is not here.
  const open = params.get('open');
  useEffect(() => {
    if (!open || !data || handled.current === open) return;
    handled.current = open;
    const [type, id] = open.split(':');
    const t = TABS.find((x) => x.entityType === type);
    const found = t && lists[t.key].find((i) => i.entityId === id);
    if (t) setTab(t.key);
    if (found) { setSelected(found); setNotice(null); } else setNotice(tr('این کار دیگر در صف شما نیست — پیش‌تر انجام شده یا به کس دیگری رسیده است.'));
    setParams((p) => { p.delete('open'); return p; }, { replace: true });
  }, [open, data, lists, setParams]);

  const done = (message: string) => {
    setSelected(null);
    toast(message);
    void qc.invalidateQueries({ queryKey: ['/me/work'] });
  };

  const items = lists[active];
  const total = TABS.reduce((n, t) => n + lists[t.key].length, 0);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="btn-accent sticky top-0 z-30 flex items-center justify-between gap-2 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-white">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold">{tr('هیوامیس همراه')}</h1>
          <p className="truncate text-[12.5px] text-white/70">
            {user?.fullName} · <span className={cx('inline-block size-1.5 rounded-full align-middle', live === 'live' ? 'bg-emerald-400' : live === 'connecting' ? 'bg-amber-400' : 'bg-rose-400')} aria-hidden />{' '}
            {live === 'live' ? tr('زنده') : live === 'connecting' ? tr('در حال اتصال') : tr('بدون اتصال زنده')}
          </p>
        </div>
        <button onClick={() => setPanel(true)} className="rounded-lg p-2 hover:bg-white/10" aria-label={tr('اعلان روی این گوشی')}>
          <IconBell className="size-5" />
        </button>
      </header>

      {notice && (
        <div role="status" className="mx-3 mt-3 flex items-start justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-200">
          <span>{notice}</span><button onClick={() => setNotice(null)} aria-label={tr('بستن پیام')}><IconClose className="size-4" /></button>
        </div>
      )}

      <main className="flex-1 px-3 pb-24 pt-3">
        {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={refetch} /> : !items.length ? (
          <EmptyState title={loc(TABS.find((t) => t.key === active)!, 'empty')}
            description={total ? undefined : tr('چیزی از این سه کار با شما نیست. کارهای دیگر در نسخهٔ کامل هیوامیس است.')} />
        ) : (
          <ul className="space-y-2" data-testid="mobile-list">
            {items.map((i) => (
              <li key={`${i.kind}:${i.entityId}`}>
                <button onClick={() => setSelected(i)}
                  className={cx('w-full rounded-xl bg-surface p-3 text-start ring-1 ring-ink-200 active:bg-ink-50', i.sla?.state === 'BREACHED' && 'ring-rose-300')}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink-800">{i.title}</p>
                      <p className="mt-0.5 truncate text-xs text-ink-500"><span dir="ltr">{i.code}</span>{i.projectName ? ` · ${i.projectName}` : ''}</p>
                    </div>
                    <SlaPill sla={i.sla} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>

      <nav className="bg-panel fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t border-ink-200/70 pb-[env(safe-area-inset-bottom)]" aria-label={tr('سه کار')}>
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} aria-current={active === t.key ? 'page' : undefined}
            className={cx('flex flex-col items-center gap-0.5 py-2.5 text-xs', active === t.key ? 'font-semibold text-brand-700' : 'text-ink-500')}>
            <span>{loc(t, 'label')}</span>
            <span className={cx('min-w-5 rounded-full px-1.5 text-[12.5px]', lists[t.key].length ? 'bg-rose-600 text-white' : 'bg-ink-100 text-ink-500')}>{localDigits(lists[t.key].length)}</span>
          </button>
        ))}
      </nav>

      {selected && (selected.kind === 'workOrder'
        ? <WorkOrderSheet item={selected} onDone={done} onClose={() => setSelected(null)} />
        : selected.kind === 'formApproval'
          ? <FormSheet item={selected} onDone={done} onClose={() => setSelected(null)} />
          : <QcSheet item={selected} onDone={done} onClose={() => setSelected(null)} />)}
      {panel && <PushPanel onClose={() => setPanel(false)} />}
      {can('ai.chat') && !selected && said === null && (
        <div className="fixed bottom-[calc(4.25rem+env(safe-area-inset-bottom))] end-4 z-30">
          <VoiceButton large onText={setSaid} onError={(message) => toast(message, 'danger')} />
        </div>
      )}
      {said !== null && <AssistantChat initialDraft={said} onClose={() => setSaid(null)} />}
    </div>
  );
}
