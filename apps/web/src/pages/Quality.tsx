import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { openFile } from '../components/RecordFiles';
import { useAuth } from '../lib/auth';
import { PageBody, PageHeader } from '../components/Shell';
import { StageZero } from '../components/StageZero';
import { Code, WorkflowActions } from '../components/common';
import { PdfButton } from '../components/PdfButton';
import {
  Badge, Button, Card, Checkbox, EmptyState, ErrorBlock, Field, LoadingBlock, Modal,
  StateBadge, StatTile, Table, Tabs, Td, Textarea, Th, Tr, useToast,
} from '../components/ui';
import { formatDate, formatRelative, localDigits, daysFromNow } from '../lib/format';
import { REVISION_REASON_LABELS } from '@hiva/contracts';
import { HelpDrawer } from '../components/HelpDrawer';
import { AnnotateButton, AnnotationsModal, timecodeFa, type AnnotationRow } from '../components/Annotations';
import { tr, trx } from '../i18n';
import { UnitTag } from '../components/UnitTag';

interface QcQueue {
  unit: any[]; account: any[]; final: any[]; revisions: any[];
  counts: { unit: number; account: number; final: number; revisions: number; overdueRevisions: number };
}

/** Checklists mirror the Doc_H QC forms (E37 / E38 / E39) for each level. */
const CHECKLISTS: Record<string, { key: string; label: string }[]> = {
  UNIT: [
    { key: 'matchesBrief', label: tr('مطابق بریف است') },
    { key: 'technicallySound', label: tr('از نظر فنی صحیح است') },
    { key: 'brandCompliant', label: tr('مطابق هویت بصری هیوا') },
    { key: 'completeDeliverable', label: tr('کامل است') },
  ],
  ACCOUNT: [
    { key: 'matchesBrief', label: tr('تطابق با Brief') },
    { key: 'matchesScope', label: tr('تطابق با Scope') },
    { key: 'matchesKickoff', label: tr('تطابق با تصمیمات Kick-off') },
    { key: 'deliverablesComplete', label: tr('کامل بودن Deliverableها') },
    { key: 'costReviewed', label: tr('قیمت تمام‌شده بررسی شد') },
  ],
  FINAL: [
    { key: 'proposalComplete', label: tr('پروپوزال کامل است') },
    { key: 'pricingReviewed', label: tr('قیمت بررسی شد') },
    { key: 'qualityAcceptable', label: tr('کیفیت قابل قبول است') },
    { key: 'clientReady', label: tr('قابل ارائه به مشتری است') },
  ],
};

/** The reasons work is most often sent back for, one click into the explanation. */
const QUICK_REASONS = [tr('با بریف نمی‌خواند'), tr('ناقص است'), tr('کیفیت کافی نیست'), tr('با هویت بصری نمی‌خواند'), tr('خطای فنی دارد')];

const LEVEL_TITLES: Record<string, string> = {
  UNIT: tr('QC سطح ۱ — واحد اجرایی'),
  ACCOUNT: tr('QC سطح ۲ — اکانت'),
  FINAL: tr('QC سطح ۳ — نهایی'),
};

const LEVEL_OF: Record<string, string> = { unit: 'UNIT', account: 'ACCOUNT', final: 'FINAL' };

export default function Quality() {
  // A work card opens the page on its own level and its own item (`?tab=unit&review=…`).
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState(() => (['unit', 'account', 'final', 'revisions'].includes(params.get('tab') ?? '') ? params.get('tab')! : 'account'));
  const [review, setReview] = useState<{ level: string; target: any } | null>(null);
  const { can } = useAuth();

  const { data, isLoading, error, refetch } = useQuery<QcQueue>({
    queryKey: ['/qc/queue'],
    queryFn: () => apiGet('/qc/queue'),
  });
  const asked = params.get('review');
  const askedRow = asked && LEVEL_OF[tab] ? (data?.[tab as 'unit' | 'account' | 'final'] ?? []).find((r) => r.id === asked) : undefined;
  if (askedRow && !review && can(`qc.${tab}`)) {
    setReview({ level: LEVEL_OF[tab]!, target: askedRow });
    setParams((p) => { p.delete('review'); return p; }, { replace: true });
  }

  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  return (
    <>
      <PageHeader
        title={tr('کنترل کیفیت')}
        subtitle={tr('قانون ۹ — کنترل کیفیت در سه سطح: واحد اجرایی، اکانت، و نهایی')}
      
        actions={<ContextualHelp />}
      />
      <PageBody className="space-y-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label={tr('در انتظار QC واحد')} value={localDigits(data?.counts.unit ?? 0)} tone="info" />
          <StatTile label={tr('در انتظار QC اکانت')} value={localDigits(data?.counts.account ?? 0)} tone="warning" />
          <StatTile label={tr('در انتظار QC نهایی')} value={localDigits(data?.counts.final ?? 0)} tone="warning" />
          <StatTile
            label={tr('اصلاحیه‌های باز')}
            value={localDigits(data?.counts.revisions ?? 0)}
            tone={data?.counts.overdueRevisions ? 'danger' : 'neutral'}
            hint={data?.counts.overdueRevisions ? tr('{0} مورد سررسید گذشته', localDigits(data.counts.overdueRevisions)) : undefined}
          />
        </div>

        <Card className="overflow-hidden">
          <Tabs
            active={tab}
            onChange={setTab}
            tabs={[
              { key: 'unit', label: tr('QC واحد'), count: data?.counts.unit },
              { key: 'account', label: tr('QC اکانت'), count: data?.counts.account },
              { key: 'final', label: tr('QC نهایی'), count: data?.counts.final },
              { key: 'revisions', label: tr('اصلاحیه‌ها'), count: data?.counts.revisions },
            ]}
          />

          {tab === 'revisions' ? (
            <RevisionsTable rows={data?.revisions ?? []} />
          ) : (
            <QueueTable
              rows={tab === 'unit' ? data?.unit ?? [] : tab === 'account' ? data?.account ?? [] : data?.final ?? []}
              level={tab === 'unit' ? 'UNIT' : tab === 'account' ? 'ACCOUNT' : 'FINAL'}
              isProposal={tab === 'final'}
              canReview={can(tab === 'unit' ? 'qc.unit' : tab === 'account' ? 'qc.account' : 'qc.final')}
              onReview={(target, level) => setReview({ level, target })}
            />
          )}
        </Card>
      </PageBody>

      {review && (
        <QcReviewModal
          level={review.level}
          target={review.target}
          onClose={() => setReview(null)}
        />
      )}
    </>
  );
}

function QueueTable({ rows, level, isProposal, canReview, onReview }: {
  rows: any[]; level: string; isProposal: boolean; canReview: boolean;
  onReview: (target: any, level: string) => void;
}) {
  if (!rows.length) {
    return <EmptyState title={tr('موردی در این صف نیست')} description={tr('خروجی‌های آماده بررسی اینجا نمایش داده می‌شوند.')} />;
  }
  return (
    <Table>
      <thead className="bg-ink-50/60">
        <tr>
          <Th>{isProposal ? tr('پروپوزال') : tr('خروجی')}</Th>
          {!isProposal && <Th>{tr('واحد')}</Th>}
          <Th>{isProposal ? tr('بریف') : tr('پروژه')}</Th>
          <Th>{tr('وضعیت')}</Th>
          <Th>{tr('اقدام')}</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <Tr key={r.id}>
            <Td>
              <p className="text-sm">{r.name ?? r.title}</p><Code>{r.code}</Code>
              {/* What the machine already checked, before a person opens a file (roadmap #22). */}
              {!isProposal && <div className="mt-1"><StageZero deliverable={r} /></div>}
              {!isProposal && <UnitQcNote review={r.qcReviews?.[0]} />}
            </Td>
            {!isProposal && <Td><UnitTag code={r.departmentCode} /></Td>}
            <Td className="text-xs">
              {isProposal ? r.brief?.title
                : r.project ? <Link to={`/projects/${r.project.id}`} className="text-brand-600 hover:underline">{r.project.name}</Link> : '—'}
            </Td>
            <Td><StateBadge state={r.state} /></Td>
            <Td>
              <div className="flex flex-wrap gap-1.5">
                {canReview && (
                  <Button size="sm" variant="primary" onClick={() => onReview(r, level)}>{tr('ثبت QC')}</Button>
                )}
                <WorkflowActions
                  entity={isProposal ? 'proposal' : 'deliverable'}
                  id={r.id}
                  transitions={r.availableTransitions}
                />
              </div>
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

interface UnitReview {
  id: string; code: string; verdict: string; findings: string | null; reviewedAt: string;
  reviewer: { fullName: string }; documents: { id: string; fileName: string; mimeType: string }[];
}

/** What the unit's level-1 QC said, and the photos taken at it — often on set (roadmap #49). */
export function UnitQcNote({ review }: { review: UnitReview | undefined }) {
  if (!review) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-500" data-testid="unit-qc-note">
      <Badge tone={review.verdict === 'PASSED' ? 'success' : 'danger'}>{tr('QC سطح ۱: {0}', review.verdict === 'PASSED' ? tr('قبول') : tr('رد'))}</Badge>
      <span>{review.reviewer.fullName} — {formatRelative(review.reviewedAt)}</span>
      {review.documents.map((d, i) => (
        <button key={d.id} className="text-brand-700 underline" onClick={() => void openFile(d)} title={d.fileName}>{tr('عکس {0}', localDigits(i + 1))}</button>
      ))}
    </div>
  );
}

function RevisionsTable({ rows }: { rows: any[] }) {
  if (!rows.length) return <EmptyState title={tr('اصلاحیه بازی وجود ندارد')} />;
  return (
    <Table>
      <thead className="bg-ink-50/60">
        <tr>
          <Th>{tr('خروجی')}</Th><Th>{tr('علت')}</Th><Th>{tr('اصلاح مورد انتظار')}</Th>
          <Th>{tr('واحد مسئول')}</Th><Th>{tr('مهلت')}</Th><Th>{tr('وضعیت')}</Th><Th>{tr('اقدام')}</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const overdue = daysFromNow(r.dueDate)! < 0;
          return (
            <Tr key={r.id}>
              <Td>
                <p className="text-sm">{r.deliverable?.name ?? '—'}</p>
                <Code>{r.code}</Code>
              </Td>
              <Td><Badge tone="warning">{trx(REVISION_REASON_LABELS[r.reason] ?? r.reason)}</Badge></Td>
              <Td className="max-w-xs whitespace-pre-line text-xs">{r.requiredCorrection}</Td>
              <Td><UnitTag code={r.responsibleDepartmentCode} /></Td>
              <Td className="text-xs">
                <span className={overdue ? 'font-medium text-rose-700' : ''}>{formatDate(r.dueDate)}</span>
                <p className="text-[12.5px] text-ink-400">{formatRelative(r.dueDate)}</p>
              </Td>
              <Td><StateBadge state={r.state} /></Td>
              <Td className="flex items-center gap-1">
                <PdfButton kind="revision" id={r.id} label="PDF" variant="ghost" />
                {r.deliverable && <AnnotateButton deliverable={r.deliverable} />}
                <WorkflowActions entity="revision" id={r.id} transitions={r.availableTransitions} />
              </Td>
            </Tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function QcReviewModal({ level, target, onClose }: { level: string; target: any; onClose: () => void }) {
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});
  const [verdict, setVerdict] = useState<'PASSED' | 'FAILED' | null>(null);
  const [findings, setFindings] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();

  const items = CHECKLISTS[level] ?? [];
  const isProposal = level === 'FINAL';
  // Roadmap #38: annotations on the deliverable's files, open and not yet carried by a review.
  const [annotating, setAnnotating] = useState(false);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const { data: marks } = useQuery<{ annotations: AnnotationRow[] }>({
    queryKey: [`/deliverables/${target.id}/annotations`], queryFn: () => apiGet(`/deliverables/${target.id}/annotations`), enabled: !isProposal,
  });
  const open = (marks?.annotations ?? []).filter((a) => a.status === 'OPEN' && !a.qcReviewId);
  const carried = open.filter((a) => !unchecked.has(a.id)).map((a) => a.id);

  const submit = async () => {
    setBusy(true);
    try {
      const result: any = await apiPost('/qc-reviews', {
        level,
        ...(isProposal ? { proposalId: target.id } : { deliverableId: target.id }),
        checklist,
        verdict: verdict!,
        findings: findings.trim() || undefined,
        ...(isProposal ? {} : { annotationIds: carried }),
      });
      toast(
        verdict === 'PASSED'
          ? tr('کنترل کیفیت با تأیید ثبت شد.')
          : result?.revision
            ? tr('عدم تأیید ثبت و اصلاحیه {0} صادر شد.', result.revision.code)
            : tr('عدم تأیید ثبت شد.'),
        verdict === 'PASSED' ? 'success' : 'warning',
      );
      await qc.invalidateQueries();
      onClose();
    } catch (e: any) {
      toast(e?.message ?? tr('ثبت QC ناموفق بود.'), 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={LEVEL_TITLES[level]}
      draftKey={`qc:${level}:${target.id}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
          <Button
            variant={verdict === 'FAILED' ? 'danger' : 'primary'}
            loading={busy}
            disabled={!verdict || (verdict === 'FAILED' && findings.trim().length < 3 && carried.length === 0)}
            onClick={() => void submit()}
          >{verdict === 'FAILED' ? tr('برگرداندن برای اصلاح') : verdict === 'PASSED' ? tr('تأیید و ارسال') : tr('ثبت نتیجه')}</Button>
        </>
      }
    >
      <div className="mb-4 rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-700">
        {target.name ?? target.title} <Code>{target.code}</Code>
        {level !== 'UNIT' && <UnitQcNote review={target.qcReviews?.[0]} />}
      </div>

      <div className="space-y-2.5">
        {items.map((i) => (
          <Checkbox
            key={i.key}
            label={i.label}
            checked={!!checklist[i.key]}
            onChange={(e) => setChecklist((c) => ({ ...c, [i.key]: e.target.checked }))}
          />
        ))}
      </div>

      {/* Two decisions, said as a person makes them (the owner's brief, 2026-11-02). */}
      <fieldset className="mt-4" data-testid="qc-decision">
        <legend className="mb-2 text-xs font-bold text-ink-700">{tr('تصمیم شما')}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <button type="button" aria-pressed={verdict === 'PASSED'} onClick={() => setVerdict('PASSED')}
            className={`rounded-lg px-3 py-2.5 text-start text-sm ring-1 ${verdict === 'PASSED' ? 'bg-emerald-50 text-emerald-900 ring-emerald-400' : 'bg-surface text-ink-800 ring-ink-200 hover:bg-ink-50'}`}>
            <span className="block font-bold">{tr('تأیید و ارسال')}</span>
            <span className="block text-[12.5px] text-ink-500">{isProposal ? tr('پروپوزال برای تأیید نهایی آماده است.') : tr('خروجی درست است و به گام بعد می‌رود.')}</span>
          </button>
          <button type="button" aria-pressed={verdict === 'FAILED'} onClick={() => setVerdict('FAILED')}
            className={`rounded-lg px-3 py-2.5 text-start text-sm ring-1 ${verdict === 'FAILED' ? 'bg-amber-50 text-amber-900 ring-amber-400' : 'bg-surface text-ink-800 ring-ink-200 hover:bg-ink-50'}`}>
            <span className="block font-bold">{tr('برگرداندن برای اصلاح')}</span>
            <span className="block text-[12.5px] text-ink-500">{tr('با توضیح روشن به مسئولش برمی‌گردد و اصلاحیه صادر می‌شود.')}</span>
          </button>
        </div>
      </fieldset>

      {verdict === 'FAILED' && (
        <div className="mt-3">
          <div className="mb-2 flex flex-wrap gap-1.5" aria-label={tr('دلیل‌های رایج')}>
            {QUICK_REASONS.map((r) => (
              <button key={r} type="button" onClick={() => setFindings((f) => (f.includes(r) ? f : [f.trim(), r].filter(Boolean).join(tr('؛ '))))}
                className="rounded-full bg-ink-50 px-2.5 py-1 text-xs text-ink-700 ring-1 ring-ink-200 hover:bg-amber-50">{r}</button>
            ))}
          </div>
          <Field label={tr('چه چیزی باید اصلاح شود؟')} required
            hint={tr('این توضیح کنار کار می‌ماند و مسئولش آن را می‌بیند؛ اصلاحیه به‌صورت خودکار صادر می‌شود (قانون ۱۰).')}>
            <Textarea value={findings} onChange={(e) => setFindings(e.target.value)} rows={3} aria-label={tr('چه چیزی باید اصلاح شود؟')} />
          </Field>
        </div>
      )}
      {verdict === 'PASSED' && (
        <div className="mt-3">
          <Field label={tr('یادداشت (اختیاری)')}>
            <Textarea value={findings} onChange={(e) => setFindings(e.target.value)} rows={2} aria-label={tr('یادداشت (اختیاری)')} />
          </Field>
        </div>
      )}

      {!isProposal && (
        <div className="mt-3 rounded-lg border border-ink-200 p-3" data-testid="qc-annotations">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-ink-700">{tr('یادداشت‌های روی فایل‌ها')}</p>
            <Button size="sm" variant="secondary" onClick={() => setAnnotating(true)}>{tr('یادداشت روی فایل‌ها')}</Button>
          </div>
          {!open.length ? <p className="mt-1 text-[12.5px] text-ink-500">{tr('یادداشت بازی نیست؛ برای نشان دادن جای دقیق اصلاح، روی خود فایل یادداشت بگذارید.')}</p> : (
            <>
              <p className="mt-1 text-[12.5px] text-ink-500">{tr('در صورت عدم تأیید، یادداشت‌های انتخاب‌شده سطر به سطر در «اصلاح مورد انتظار» اصلاحیه می‌آیند.')}</p>
              <div className="mt-2 space-y-1">
                {open.map((a) => (
                  <Checkbox key={a.id} checked={!unchecked.has(a.id)}
                    onChange={(e) => setUnchecked((u) => { const n = new Set(u); if (e.target.checked) n.delete(a.id); else n.add(a.id); return n; })}
                    label={`${localDigits(a.number)}. ${a.kind === 'TIMECODE' ? `[${timecodeFa(a.timeSec ?? 0)}] ` : a.kind === 'HIGHLIGHT' ? tr('[صفحهٔ {0}] ', localDigits(a.page ?? 1)) : ''}${a.note}`} />
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {annotating && <AnnotationsModal deliverableId={target.id} onClose={() => setAnnotating(false)} />}
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
      <HelpDrawer open={open} onClose={() => setOpen(false)} initialSection="When the system blocks you" />
    </>
  );
}
