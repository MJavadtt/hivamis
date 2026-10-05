import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ENVELOPE_STATUS_LABELS, SIGNER_STATUS_LABELS } from '@hiva/contracts';
import { apiGet, apiPost, apiUpload, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, Field, Input, Select, useToast } from './ui';
import { formatDateTime, localDigits } from '../lib/format';
import { flow, tr, trx } from '../i18n';

/* Roadmap #36 — a contract sent for electronic signature, followed until it is signed. */

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  SENT: 'info', COMPLETED: 'success', DECLINED: 'danger', VOIDED: 'neutral', EXPIRED: 'neutral',
};
const MODE_FA: Record<string, string> = {
  sandbox: tr('محیط آزمایشی — امضاها اعتبار حقوقی ندارند'),
  http: tr('ارائه‌دهندهٔ امضای الکترونیکی'),
  off: tr('امضای الکترونیکی خاموش است؛ امضا را دستی ثبت کنید'),
};
const EVENT_FA: Record<string, string> = {
  SENT: tr('فرستاده شد'), SIGNED: tr('امضا شد'), DECLINED: tr('رد شد'), COMPLETED: tr('همه امضا کردند'), APPLIED: tr('قرارداد امضاشده ثبت شد'),
  VOIDED: tr('باطل شد'), EXPIRED: tr('منقضی شد'), SYNC_FAILED: tr('پرسش از ارائه‌دهنده ناموفق بود'),
};

export function ESignCard({ contractId }: { contractId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const upload = useRef<HTMLInputElement>(null);
  const [links, setLinks] = useState<{ name: string; email: string; url: string | null }[] | null>(null);
  const [form, setForm] = useState<{ documentId?: string; clientContactId?: string; agencyUserId?: string; expiresInDays: string }>({ expiresInDays: '14' });
  const [busy, setBusy] = useState(false);
  const { data: o, refetch } = useQuery<any>({ queryKey: [`/contracts/${contractId}/signature-options`], queryFn: () => apiGet(`/contracts/${contractId}/signature-options`) });
  const { data: envelopes } = useQuery<any[]>({ queryKey: [`/contracts/${contractId}/signatures`], queryFn: () => apiGet(`/contracts/${contractId}/signatures`) });
  if (!o || !envelopes) return null;
  const pick = { documentId: form.documentId ?? o.documents[0]?.id, clientContactId: form.clientContactId ?? o.contacts[0]?.id, agencyUserId: form.agencyUserId ?? o.signatories[0]?.id };
  const refresh = () => qc.invalidateQueries();
  const send = async () => {
    setBusy(true);
    try {
      const r = await apiPost<{ envelope: { code: string }; links: typeof links }>(`/contracts/${contractId}/signatures`, { ...pick, expiresInDays: Number(form.expiresInDays) });
      toast(r.links ? tr('پاکت {0} ساخته شد؛ پیوندها را به امضاکنندگان برسانید.', r.envelope.code) : tr('پاکت {0} برای امضاکنندگان فرستاده شد.', r.envelope.code));
      setLinks(r.links);
      await refresh();
    } catch (e: any) { toast(e?.message ?? tr('فرستادن ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  const act = async (path: string, body: object, done: string) => {
    try { await apiPost(path, body); toast(done); await refresh(); } catch (e: any) { toast(e?.message ?? tr('انجام نشد.'), 'danger'); }
  };
  const addFile = async (file: File) => {
    const f = new FormData();
    f.append('contractId', contractId);
    f.append('file', file);
    try { await apiUpload('/documents', f); await refetch(); } catch (e: any) { toast(e?.message ?? tr('بارگذاری ناموفق بود.'), 'danger'); }
  };
  return (
    <Card title={tr('امضای الکترونیکی')} className="lg:col-span-3" subtitle={MODE_FA[o.mode]}>
      <div className="space-y-4 px-4 py-3" data-testid="esign">
        {o.mode === 'sandbox' && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{tr('این نصب به ارائه‌دهندهٔ امضای دارای گواهی وصل نیست؛ پاکت‌ها در محیط آزمایشی امضا می‌شوند و روی فایل امضاشده نوشته می‌شود که امضای حقوقی نیست.')}</p>}
        {links && (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="esign-links">
            <p className="font-medium">{tr('ایمیل سازمان پیکربندی نشده است؛ این پیوندها را به امضاکنندگان برسانید — به ترتیب، و فقط همین یک بار نمایش داده می‌شوند.')}</p>
            <ul className="mt-1 space-y-1">{links.map((l) => <li key={l.email}>{l.name}: <code className="ltr break-all">{l.url}</code></li>)}</ul>
          </div>
        )}
        {can('contract.sign') && o.eligible && (
          <div className="grid gap-3 rounded-lg border border-ink-200 p-3 sm:grid-cols-2" data-testid="esign-form">
            <Field label={tr('فایل قرارداد (PDF)')}>
              <div className="flex gap-2">
                <Select value={pick.documentId ?? ''} onChange={(e) => setForm({ ...form, documentId: e.target.value })} aria-label={tr('فایل قرارداد')}>
                  {!o.documents.length && <option value="">{tr('— فایلی نیست —')}</option>}
                  {o.documents.map((d: any) => <option key={d.id} value={d.id}>{d.fileName}{d.version > 1 ? tr(' (نسخهٔ {0})', localDigits(d.version)) : ''}</option>)}
                </Select>
                <input ref={upload} type="file" accept="application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void addFile(f); e.target.value = ''; }} />
                <Button size="sm" variant="secondary" onClick={() => upload.current?.click()}>{tr('بارگذاری')}</Button>
              </div>
            </Field>
            <Field label={tr('امضاکنندهٔ مشتری (نخست)')}>
              <Select value={pick.clientContactId ?? ''} onChange={(e) => setForm({ ...form, clientContactId: e.target.value })} aria-label={tr('امضاکنندهٔ مشتری')}>
                {o.contacts.map((c: any) => <option key={c.id} value={c.id}>{c.fullName} ({c.email})</option>)}
              </Select>
            </Field>
            <Field label={tr('امضاکنندهٔ سازمان (سپس)')}>
              <Select value={pick.agencyUserId ?? ''} onChange={(e) => setForm({ ...form, agencyUserId: e.target.value })} aria-label={tr('امضاکنندهٔ سازمان')}>
                {o.signatories.map((u: any) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
              </Select>
            </Field>
            <Field label={tr('مهلت (روز)')}><Input type="number" min={1} max={60} value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: e.target.value })} className="w-24" aria-label={tr('مهلت امضا')} /></Field>
            <div className="sm:col-span-2">
              <Button variant="primary" loading={busy} disabled={!pick.documentId || !pick.clientContactId || !pick.agencyUserId} onClick={() => void send()}>{tr('فرستادن برای امضا')}</Button>
            </div>
          </div>
        )}
        {o.inFlight && <p className="text-xs text-ink-600">{tr('تا پاکت')}{' '}{o.inFlight}{' '}{tr('در جریان است، امضای دستی قرارداد پذیرفته نمی‌شود.')}</p>}
        {!envelopes.length ? <p className="text-xs text-ink-500">{tr('این قرارداد هنوز برای امضای الکترونیکی فرستاده نشده است.')}</p> : (
          <ul className="space-y-3">
            {envelopes.map((e) => (
              <li key={e.id} className="rounded-lg border border-ink-200 px-3 py-2 text-xs" data-testid="esign-envelope">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={TONE[e.status] ?? 'neutral'}>{trx(ENVELOPE_STATUS_LABELS[e.status] ?? e.status)}</Badge>
                  <span className="ltr text-ink-500">{e.code}</span>
                  {e.provider === 'sandbox' && <Badge tone="warning">{tr('آزمایشی')}</Badge>}
                  <span className="text-ink-400">{e.document?.fileName} · {formatDateTime(e.createdAt)} · {e.createdBy?.fullName}</span>
                  <div className="ms-auto flex gap-1">
                    {e.signedDocument && <Button size="sm" variant="ghost" onClick={() => void downloadFile(`/documents/${e.signedDocument.id}/download`, e.signedDocument.fileName)}>{tr('فایل امضاشده')}</Button>}
                    {e.status === 'SENT' && can('contract.sign') && <Button size="sm" variant="ghost" onClick={() => void act(`/esign/envelopes/${e.id}/sync`, {}, tr('وضعیت از ارائه‌دهنده دوباره خوانده شد.'))}>{tr('به‌روزرسانی')}</Button>}
                    {e.status === 'SENT' && can('contract.sign') && <Button size="sm" variant="ghost" onClick={() => { const r = window.prompt(tr('دلیل ابطال:')); if (r) void act(`/esign/envelopes/${e.id}/void`, { reason: r }, tr('پاکت باطل شد.')); }}>{tr('ابطال')}</Button>}
                  </div>
                </div>
                <ol className="mt-2 space-y-1">
                  {e.signers.map((s: any) => (
                    <li key={s.id}>
                      {localDigits(s.order)}. {s.name} <span className="ltr text-ink-400">{s.email}</span> — {trx(SIGNER_STATUS_LABELS[s.status] ?? s.status)}
                      {s.signedAt && <> · {formatDateTime(s.signedAt)}</>}
                      {s.certificate && <span className="block text-[12.5px] text-ink-500">{tr('گواهی:')}{' '}<span className="ltr">{s.certificate.subject}</span>{' '}{tr('· صادرکننده:')}{' '}{s.certificate.issuer}{' '}{tr('· سریال')}{' '}<span className="ltr">{s.certificate.serial}</span></span>}
                      {s.declineReason && <span className="block text-[12.5px] text-rose-700">«{s.declineReason}»</span>}
                    </li>
                  ))}
                </ol>
                {e.transitionError && <p className="mt-1 rounded bg-rose-50 px-2 py-1 text-rose-800">{tr('امضا کامل شد اما قرارداد به «امضاشده» نرفت:')}{' '}{e.transitionError}</p>}
                <p className="mt-1 text-[12.5px] text-ink-400">{tr('SHA-256 فایل فرستاده‌شده:')}{' '}<span className="ltr">{e.originalSha256.slice(0, 16)}…</span>{e.signedSha256 && <>{' '}{tr('· فایل امضاشده:')}{' '}<span className="ltr">{e.signedSha256.slice(0, 16)}…</span></>}</p>
                <p className="mt-1 text-[12.5px] text-ink-500">{e.events.map((x: any) => `${EVENT_FA[x.kind] ?? x.kind} (${formatDateTime(x.at)})`).join(` ${flow()} `)}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
