import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageBody, PageHeader } from '../components/Shell';
import { StageZero } from '../components/StageZero';
import { Code, WorkflowActions } from '../components/common';
import { PdfButton } from '../components/PdfButton';
import {
  Badge, Button, Card, Checkbox, EmptyState, ErrorBlock, Field, LoadingBlock, Modal,
  Select, StateBadge, StatTile, Table, Tabs, Td, Textarea, Th, Tr, useToast,
} from '../components/ui';
import { formatDate, formatRelative, toPersianDigits, daysFromNow } from '../lib/format';
import { REVISION_REASON_LABELS } from '@hiva/contracts';
import { HelpDrawer } from '../components/HelpDrawer';
import { AnnotateButton, AnnotationsModal, timecodeFa, type AnnotationRow } from '../components/Annotations';

interface QcQueue {
  unit: any[]; account: any[]; final: any[]; revisions: any[];
  counts: { unit: number; account: number; final: number; revisions: number; overdueRevisions: number };
}

/** Checklists mirror the Doc_H QC forms (E37 / E38 / E39) for each level. */
const CHECKLISTS: Record<string, { key: string; label: string }[]> = {
  UNIT: [
    { key: 'matchesBrief', label: 'مطابق بریف است' },
    { key: 'technicallySound', label: 'از نظر فنی صحیح است' },
    { key: 'brandCompliant', label: 'مطابق هویت بصری هیوا' },
    { key: 'completeDeliverable', label: 'کامل است' },
  ],
  ACCOUNT: [
    { key: 'matchesBrief', label: 'تطابق با Brief' },
    { key: 'matchesScope', label: 'تطابق با Scope' },
    { key: 'matchesKickoff', label: 'تطابق با تصمیمات Kick-off' },
    { key: 'deliverablesComplete', label: 'کامل بودن Deliverableها' },
    { key: 'costReviewed', label: 'قیمت تمام‌شده بررسی شد' },
  ],
  FINAL: [
    { key: 'proposalComplete', label: 'پروپوزال کامل است' },
    { key: 'pricingReviewed', label: 'قیمت بررسی شد' },
    { key: 'qualityAcceptable', label: 'کیفیت قابل قبول است' },
    { key: 'clientReady', label: 'قابل ارائه به مشتری است' },
  ],
};

const LEVEL_TITLES: Record<string, string> = {
  UNIT: 'QC سطح ۱ — واحد اجرایی',
  ACCOUNT: 'QC سطح ۲ — اکانت',
  FINAL: 'QC سطح ۳ — نهایی',
};

export default function Quality() {
  const [tab, setTab] = useState('account');
  const [review, setReview] = useState<{ level: string; target: any } | null>(null);
  const { can } = useAuth();

  const { data, isLoading, error, refetch } = useQuery<QcQueue>({
    queryKey: ['/qc/queue'],
    queryFn: () => apiGet('/qc/queue'),
  });

  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  return (
    <>
      <PageHeader
        title="کنترل کیفیت"
        subtitle="قانون ۹ — کنترل کیفیت در سه سطح: واحد اجرایی، اکانت، و نهایی"
      
        actions={<ContextualHelp />}
      />
      <PageBody className="space-y-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="در انتظار QC واحد" value={toPersianDigits(data?.counts.unit ?? 0)} tone="info" />
          <StatTile label="در انتظار QC اکانت" value={toPersianDigits(data?.counts.account ?? 0)} tone="warning" />
          <StatTile label="در انتظار QC نهایی" value={toPersianDigits(data?.counts.final ?? 0)} tone="warning" />
          <StatTile
            label="اصلاحیه‌های باز"
            value={toPersianDigits(data?.counts.revisions ?? 0)}
            tone={data?.counts.overdueRevisions ? 'danger' : 'neutral'}
            hint={data?.counts.overdueRevisions ? `${toPersianDigits(data.counts.overdueRevisions)} مورد سررسید گذشته` : undefined}
          />
        </div>

        <Card className="overflow-hidden">
          <Tabs
            active={tab}
            onChange={setTab}
            tabs={[
              { key: 'unit', label: 'QC واحد', count: data?.counts.unit },
              { key: 'account', label: 'QC اکانت', count: data?.counts.account },
              { key: 'final', label: 'QC نهایی', count: data?.counts.final },
              { key: 'revisions', label: 'اصلاحیه‌ها', count: data?.counts.revisions },
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
    return <EmptyState title="موردی در این صف نیست" description="خروجی‌های آماده بررسی اینجا نمایش داده می‌شوند." />;
  }
  return (
    <Table>
      <thead className="bg-ink-50/60">
        <tr>
          <Th>{isProposal ? 'پروپوزال' : 'خروجی'}</Th>
          {!isProposal && <Th>واحد</Th>}
          <Th>{isProposal ? 'بریف' : 'پروژه'}</Th>
          <Th>وضعیت</Th>
          <Th>اقدام</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <Tr key={r.id}>
            <Td>
              <p className="text-sm">{r.name ?? r.title}</p><Code>{r.code}</Code>
              {/* What the machine already checked, before a person opens a file (roadmap #22). */}
              {!isProposal && <div className="mt-1"><StageZero deliverable={r} /></div>}
            </Td>
            {!isProposal && <Td className="text-xs">{r.departmentCode}</Td>}
            <Td className="text-xs">
              {isProposal ? r.brief?.title
                : r.project ? <Link to={`/projects/${r.project.id}`} className="text-brand-600 hover:underline">{r.project.name}</Link> : '—'}
            </Td>
            <Td><StateBadge state={r.state} /></Td>
            <Td>
              <div className="flex flex-wrap gap-1.5">
                {canReview && (
                  <Button size="sm" variant="primary" onClick={() => onReview(r, level)}>
                    ثبت QC
                  </Button>
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

function RevisionsTable({ rows }: { rows: any[] }) {
  if (!rows.length) return <EmptyState title="اصلاحیه بازی وجود ندارد" />;
  return (
    <Table>
      <thead className="bg-ink-50/60">
        <tr>
          <Th>خروجی</Th><Th>علت</Th><Th>اصلاح مورد انتظار</Th>
          <Th>واحد مسئول</Th><Th>مهلت</Th><Th>وضعیت</Th><Th>اقدام</Th>
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
              <Td><Badge tone="warning">{REVISION_REASON_LABELS[r.reason] ?? r.reason}</Badge></Td>
              <Td className="max-w-xs whitespace-pre-line text-xs">{r.requiredCorrection}</Td>
              <Td className="text-xs">{r.responsibleDepartmentCode}</Td>
              <Td className="text-xs">
                <span className={overdue ? 'font-medium text-rose-600' : ''}>{formatDate(r.dueDate)}</span>
                <p className="text-[11px] text-ink-400">{formatRelative(r.dueDate)}</p>
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
  const [verdict, setVerdict] = useState<'PASSED' | 'FAILED'>('PASSED');
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
        verdict,
        findings: findings.trim() || undefined,
        ...(isProposal ? {} : { annotationIds: carried }),
      });
      toast(
        verdict === 'PASSED'
          ? 'کنترل کیفیت با تأیید ثبت شد.'
          : result?.revision
            ? `عدم تأیید ثبت و اصلاحیه ${result.revision.code} صادر شد.`
            : 'عدم تأیید ثبت شد.',
        verdict === 'PASSED' ? 'success' : 'warning',
      );
      await qc.invalidateQueries();
      onClose();
    } catch (e: any) {
      toast(e?.message ?? 'ثبت QC ناموفق بود.', 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={LEVEL_TITLES[level]}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>انصراف</Button>
          <Button
            variant={verdict === 'PASSED' ? 'primary' : 'danger'}
            loading={busy}
            disabled={verdict === 'FAILED' && findings.trim().length < 3 && carried.length === 0}
            onClick={() => void submit()}
          >
            ثبت نتیجه
          </Button>
        </>
      }
    >
      <p className="mb-4 rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-700">
        {target.name ?? target.title} <Code>{target.code}</Code>
      </p>

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

      <div className="mt-4">
        <Field label="نتیجه" required>
          <Select value={verdict} onChange={(e) => setVerdict(e.target.value as 'PASSED' | 'FAILED')}>
            <option value="PASSED">تأیید</option>
            <option value="FAILED">عدم تأیید</option>
          </Select>
        </Field>
      </div>

      <div className="mt-3">
        <Field
          label="یافته‌ها"
          required={verdict === 'FAILED'}
          hint={
            verdict === 'FAILED'
              ? 'در صورت عدم تأیید، ثبت یافته‌ها الزامی است و به‌صورت خودکار اصلاحیه صادر می‌شود (قانون ۱۰).'
              : undefined
          }
        >
          <Textarea value={findings} onChange={(e) => setFindings(e.target.value)} rows={3} />
        </Field>
      </div>

      {!isProposal && (
        <div className="mt-3 rounded-lg border border-ink-200 p-3" data-testid="qc-annotations">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-ink-700">یادداشت‌های روی فایل‌ها</p>
            <Button size="sm" variant="secondary" onClick={() => setAnnotating(true)}>یادداشت روی فایل‌ها</Button>
          </div>
          {!open.length ? <p className="mt-1 text-[11px] text-ink-500">یادداشت بازی نیست؛ برای نشان دادن جای دقیق اصلاح، روی خود فایل یادداشت بگذارید.</p> : (
            <>
              <p className="mt-1 text-[11px] text-ink-500">در صورت عدم تأیید، یادداشت‌های انتخاب‌شده سطر به سطر در «اصلاح مورد انتظار» اصلاحیه می‌آیند.</p>
              <div className="mt-2 space-y-1">
                {open.map((a) => (
                  <Checkbox key={a.id} checked={!unchecked.has(a.id)}
                    onChange={(e) => setUnchecked((u) => { const n = new Set(u); if (e.target.checked) n.delete(a.id); else n.add(a.id); return n; })}
                    label={`${toPersianDigits(a.number)}. ${a.kind === 'TIMECODE' ? `[${timecodeFa(a.timeSec ?? 0)}] ` : a.kind === 'HIGHLIGHT' ? `[صفحهٔ ${toPersianDigits(a.page ?? 1)}] ` : ''}${a.note}`} />
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
      >
        راهنمای این بخش
      </button>
      <HelpDrawer open={open} onClose={() => setOpen(false)} initialSection="When the system blocks you" />
    </>
  );
}
