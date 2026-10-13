import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CLIENT_APPROVAL_EVENT_LABELS, CLIENT_APPROVAL_STATUS_LABELS, type ClientApprovalStatus } from '@hiva/contracts';
import { apiGet, apiPost, apiUpload, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, Modal, Select, Textarea, useToast } from './ui';
import { formatDateTime, localDigits } from '../lib/format';
import { pair, tr, trx } from '../i18n';
import { WriteAssist } from './WriteAssist';

/** «تأیید مشتری» is also the state «client approved»; here it names the approval being asked for. */
const CLIENT_APPROVAL = () => pair({ fa: 'تأیید مشتری', en: 'Client approval' });

/* Roadmap #35 — a client's approval, kept as evidence. */

type SubjectType = 'DELIVERABLE' | 'PROPOSAL';
const WRITE: Record<SubjectType, string> = { DELIVERABLE: 'deliverable.deliver', PROPOSAL: 'proposal.record_feedback' };
const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  PENDING: 'info', APPROVED: 'success', CHANGES_REQUESTED: 'warning', CANCELLED: 'neutral', EXPIRED: 'neutral',
};
const short = (h?: string | null) => (h ? `${h.slice(0, 12)}…${h.slice(-6)}` : '—');

export function ApprovalStatus({ status }: { status: string }) {
  return <Badge tone={TONE[status] ?? 'neutral'}>{trx(CLIENT_APPROVAL_STATUS_LABELS[status as ClientApprovalStatus] ?? status)}</Badge>;
}

/** Every request for one deliverable or proposal: ask, withdraw, check, print. */
export function ClientApprovalsPanel({ subjectType, subjectId }: { subjectType: SubjectType; subjectId: string }) {
  const { can } = useAuth();
  const [asking, setAsking] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const { data: rows } = useQuery<any[]>({
    queryKey: ['/client-approvals', subjectType, subjectId],
    queryFn: () => apiGet('/client-approvals', { subjectType, subjectId }),
  });
  if (!rows) return null;
  const pending = rows.some((r) => r.status === 'PENDING');
  return (
    <div className="space-y-3" data-testid="client-approvals">
      {can(WRITE[subjectType]) && !pending && (
        <Button size="sm" variant="primary" onClick={() => setAsking(true)}>{tr('درخواست تأیید از مشتری')}</Button>
      )}
      {link && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="approval-link">
          <p className="font-medium">{tr('ایمیل سازمان پیکربندی نشده است؛ این پیوند را خودتان به مشتری برسانید. فقط همین یک بار نمایش داده می‌شود.')}</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="ltr block flex-1 truncate rounded bg-white px-2 py-1 text-[12.5px]">{link}</code>
            <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(link)}>{tr('رونوشت')}</Button>
          </div>
        </div>
      )}
      {!rows.length ? <EmptyState title={tr('هنوز از مشتری تأییدی خواسته نشده')} description={tr('تأیید مشتری با نام، زمان، نشانی و اثر انگشت فایل‌هایی که دید ثبت می‌شود.')} /> : (
        <ul className="space-y-3">{rows.map((r) => <ApprovalCard key={r.id} a={r} canWrite={can(WRITE[subjectType])} />)}</ul>
      )}
      {asking && <AskModal subjectType={subjectType} subjectId={subjectId} onClose={() => setAsking(false)} onLink={setLink} />}
    </div>
  );
}

function ApprovalCard({ a, canWrite }: { a: any; canWrite: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; problems: { message: string }[] } | null>(null);
  const files: any[] = a.manifest?.files ?? [];
  const fileName = (id: string | null) => files.find((f) => f.documentId === id)?.fileName ?? '';
  const verify = async () => {
    try { setCheck(await apiGet(`/client-approvals/${a.id}/verify`)); } catch (e: any) { toast(e?.message ?? tr('بررسی ناموفق بود.'), 'danger'); }
  };
  const withdraw = async () => {
    const reason = window.prompt(tr('دلیل لغو درخواست:'));
    if (!reason) return;
    try { await apiPost(`/client-approvals/${a.id}/cancel`, { reason }); toast(tr('درخواست لغو شد.')); await qc.invalidateQueries(); }
    catch (e: any) { toast(e?.message ?? tr('لغو ناموفق بود.'), 'danger'); }
  };
  return (
    <li className="rounded-lg border border-ink-200 px-3 py-2 text-xs" data-testid="approval-row">
      <div className="flex flex-wrap items-center gap-2">
        <ApprovalStatus status={a.status} />
        <span className="ltr text-ink-500">{a.code}</span>
        <span>{a.contactName} <span className="ltr text-ink-400">{a.contactEmail}</span></span>
        <span className="text-ink-400">· {formatDateTime(a.createdAt)} · {a.requestedBy?.fullName}</span>
        <div className="ms-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>{open ? tr('بستن') : tr('جزئیات')}</Button>
          {a.decision && <Button size="sm" variant="ghost" onClick={() => void verify()}>{tr('بررسی دوباره')}</Button>}
          {a.decision && <Button size="sm" variant="ghost" onClick={() => void downloadFile(`/client-approvals/${a.id}/certificate`, `${a.code}-certificate.pdf`).catch((e) => toast(e?.message ?? tr('دریافت ناموفق بود.'), 'danger'))}>{tr('گواهی PDF')}</Button>}
          {canWrite && a.status === 'PENDING' && <Button size="sm" variant="ghost" onClick={() => void withdraw()}>{tr('لغو')}</Button>}
        </div>
      </div>
      {a.decision && (
        <p className="mt-1.5 text-ink-700">{tr('{0} توسط «', a.decision === 'APPROVE' ? tr('✓ تأیید') : tr('✗ درخواست اصلاح'))}{a.signerName}{tr('» در {0} از', formatDateTime(a.decidedAt))}{' '}<span className="ltr">{a.decidedIp}</span>
          {' — '}{a.verification === 'EMAIL_CODE' ? tr('با کد یک‌بارمصرف ایمیل‌شده') : tr('فقط با پیوند (بدون کد)')}
          {a.comment && <span className="mt-1 block text-ink-600">«{a.comment}»</span>}
        </p>
      )}
      {a.transitionError && <p className="mt-1 rounded bg-rose-50 px-2 py-1 text-rose-800">{tr('تصمیم ثبت شد اما بر پرونده اعمال نشد:')}{' '}{a.transitionError}</p>}
      {a.evidence?.staffAddress && <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-amber-900">{tr('این تصمیم از نشانی‌ای ثبت شد که کارکنان سازمان هم از آن کار کرده‌اند.')}</p>}
      {check && (
        <p className={`mt-1 rounded px-2 py-1 ${check.ok ? 'bg-emerald-50 text-emerald-900' : 'bg-rose-50 text-rose-800'}`} data-testid="approval-check">
          {check.ok ? tr('همهٔ اثر انگشت‌ها دوباره محاسبه شد و با ثبت‌شده‌ها یکی است: فایل‌ها، فهرست، تصمیم و زنجیره.') : check.problems.map((p) => p.message).join(' · ')}
        </p>
      )}
      {open && (
        <div className="mt-2 space-y-2 border-t border-ink-100 pt-2">
          <p>{tr('اثر انگشت آنچه نشان داده شد:')}{' '}<code className="ltr">{short(a.manifestHash)}</code>{a.evidenceHash && <>{' '}{tr('· اثر انگشت تصمیم:')}{' '}<code className="ltr">{short(a.evidenceHash)}</code>{' '}{tr('(حلقهٔ {0})', localDigits(a.sequence))}</>}</p>
          <ul className="space-y-0.5">{files.map((f) => <li key={f.documentId}>{f.fileName} <code className="ltr text-[12px] text-ink-400">{short(f.sha256)}</code></li>)}</ul>
          <ol className="space-y-0.5 text-[12.5px] text-ink-600" data-testid="approval-events">
            {a.events.map((e: any) => (
              <li key={e.id}>{formatDateTime(e.at)} — {trx(CLIENT_APPROVAL_EVENT_LABELS[e.kind] ?? e.kind)}{e.documentId ? ` «${fileName(e.documentId)}»` : ''} <span className="ltr text-ink-400">{e.ip}</span></li>
            ))}
          </ol>
        </div>
      )}
    </li>
  );
}

function AskModal({ subjectType, subjectId, onClose, onLink }: { subjectType: SubjectType; subjectId: string; onClose: () => void; onLink: (l: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const { data: o, refetch } = useQuery<any>({ queryKey: ['/client-approvals/options', subjectType, subjectId], queryFn: () => apiGet('/client-approvals/options', { subjectType, subjectId }) });
  const [contactId, setContactId] = useState('');
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [message, setMessage] = useState('');
  const [days, setDays] = useState('14');
  const [busy, setBusy] = useState(false);
  if (!o) return null;
  const selected = chosen ?? new Set<string>(o.documents.map((d: any) => d.id));
  const withEmail = o.contacts.filter((c: any) => c.email);
  const contact = contactId || withEmail[0]?.id || '';
  const uploadFile = async (file: File) => {
    const form = new FormData();
    form.append(subjectType === 'DELIVERABLE' ? 'deliverableId' : 'proposalId', subjectId);
    form.append('file', file);
    try {
      const doc = await apiUpload<{ id: string }>('/documents', form);
      await refetch();
      setChosen(new Set([...selected, doc.id]));
    } catch (e: any) { toast(e?.message ?? tr('بارگذاری ناموفق بود.'), 'danger'); }
  };
  const send = async () => {
    setBusy(true);
    try {
      const a = await apiPost<{ code: string; link: string | null }>('/client-approvals', {
        subjectType, subjectId, contactId: contact, documentIds: [...selected], message: message.trim() || undefined, expiresInDays: Number(days),
      });
      toast(a.link ? tr('درخواست {0} ساخته شد؛ پیوند را به مشتری برسانید.', a.code) : tr('درخواست {0} به ایمیل مشتری فرستاده شد.', a.code));
      if (a.link) onLink(a.link);
      await qc.invalidateQueries(); onClose();
    } catch (e: any) { toast(e?.message ?? tr('ساخت درخواست ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open wide title={tr('درخواست تأیید از مشتری')} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" loading={busy} disabled={!o.eligible || !contact || (subjectType === 'DELIVERABLE' && !selected.size)} onClick={() => void send()}>{tr('فرستادن')}</Button></>}>
      <div className="space-y-4" data-testid="ask-approval">
        {!o.eligible && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{subjectType === 'DELIVERABLE' ? tr('فقط خروجیِ تحویل‌شده به مشتری را می‌توان برای تأیید فرستاد.') : tr('فقط پروپوزالِ ارائه‌شده به مشتری را می‌توان برای تأیید فرستاد.')}</p>}
        <Field label={tr('از چه کسی')} hint={o.mailOn ? tr('پیوند و کد یک‌بارمصرف به ایمیل همین شخص می‌رود.') : tr('ایمیل سازمان خاموش است: پیوند یک بار به شما نشان داده می‌شود تا برسانید.')}>
          {withEmail.length ? (
            <Select value={contact} onChange={(e) => setContactId(e.target.value)} aria-label={tr('مخاطب')}>
              {withEmail.map((c: any) => <option key={c.id} value={c.id}>{c.fullName}{c.jobTitle ? ` — ${trx(c.jobTitle)}` : ''} ({c.email})</option>)}
            </Select>
          ) : <p className="text-xs text-rose-700">{tr('هیچ مخاطبِ این مشتری ایمیل ندارد؛ نخست ایمیل مخاطب را در پروندهٔ مشتری ثبت کنید.')}</p>}
        </Field>
        <div>
          <p className="mb-1 text-xs font-medium text-ink-700">{tr('آنچه مشتری می‌بیند و تأیید می‌کند')}</p>
          {!o.documents.length && <p className="text-[12.5px] text-ink-500">{subjectType === 'DELIVERABLE' ? tr('این خروجی هنوز فایلی ندارد.') : tr('متن پروپوزال و مبلغ آن نشان داده می‌شود؛ فایل ارائه (دِک) را هم می‌توانید پیوست کنید.')}</p>}
          <div className="space-y-1">
            {o.documents.map((d: any) => (
              <Checkbox key={d.id} label={`${d.fileName} (${localDigits(Math.ceil(d.sizeBytes / 1024))} KB)`} checked={selected.has(d.id)}
                onChange={(e) => { const s = new Set(selected); if (e.target.checked) s.add(d.id); else s.delete(d.id); setChosen(s); }} />
            ))}
          </div>
          <input ref={fileRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFile(f); e.target.value = ''; }} />
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => fileRef.current?.click()}>{tr('بارگذاری فایل')}</Button>
        </div>
        <div>
          <Field label={tr('پیام برای مشتری')}><Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} aria-label={tr('پیام برای مشتری')} /></Field>
          <WriteAssist value={message} onUse={setMessage} kind="email" />
        </div>
        <Field label={tr('مهلت (روز)')}><Input type="number" min={1} max={60} value={days} onChange={(e) => setDays(e.target.value)} className="w-24" aria-label={tr('مهلت')} /></Field>
      </div>
    </Modal>
  );
}

/** For a table row: the button that opens a deliverable's approvals. */
export function DeliverableApprovalButton({ deliverable }: { deliverable: { id: string; name: string; state: string } }) {
  const [open, setOpen] = useState(false);
  if (!['DELIVERED', 'ACCEPTED', 'REVISION_REQUIRED'].includes(deliverable.state)) return null;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>{CLIENT_APPROVAL()}</Button>
      {open && (
        <Modal open wide title={tr('تأیید مشتری — {0}', deliverable.name)} onClose={() => setOpen(false)} footer={<Button variant="ghost" onClick={() => setOpen(false)}>{tr('بستن')}</Button>}>
          <ClientApprovalsPanel subjectType="DELIVERABLE" subjectId={deliverable.id} />
        </Modal>
      )}
    </>
  );
}

export function ProposalApprovalCard({ proposal }: { proposal: { id: string; state: string } }) {
  if (!['PRESENTED_TO_CLIENT', 'CLIENT_APPROVED', 'CLIENT_REVISION_REQUESTED', 'CLIENT_REJECTED'].includes(proposal.state)) return null;
  return (
    <Card title={CLIENT_APPROVAL()} subtitle={tr('تأیید یا درخواست اصلاح مشتری، با نام، زمان، نشانی، و اثر انگشت آنچه دید — قابل اثبات در اختلاف بعدی.')}>
      <div className="px-4 py-3"><ClientApprovalsPanel subjectType="PROPOSAL" subjectId={proposal.id} /></div>
    </Card>
  );
}
