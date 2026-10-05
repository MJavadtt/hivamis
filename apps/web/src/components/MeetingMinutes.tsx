import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiUpload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { UserSelect } from '../pages/Forms';
import { JalaliDateInput } from './JalaliDateInput';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, Modal, Select, Textarea, useToast } from './ui';
import { Code } from './common';
import { formatDate, formatDateTime, localDigits } from '../lib/format';
import { tr } from '../i18n';

interface Meeting {
  id: string; code: string; subject: string; heldAt: string; kind: string; attendees: string;
  decisions: string | null; minutesRecordedAt: string | null;
  actions: { action: string; ownerId: string | null; dueDate: string | null; taskId?: string | null }[];
}
interface DraftAction {
  title: string; assigneeId: string | null; assigneeName: string | null; ownerRaw: string | null;
  candidates: { id: string; fullName: string }[]; departmentCode: string | null;
  dueDate: string | null; dueRaw: string | null; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; sourceLine: string;
}
interface Draft { decisions: { text: string }[]; actions: DraftAction[]; unresolvedFa: string[]; canCreateTasks: boolean }
interface Row { title: string; assigneeId: string; departmentCode: string; dueDate: string; createTask: boolean; candidates: DraftAction['candidates']; ownerRaw: string | null; confidence: string; sourceLine: string }

const UNITS = [['S', tr('فروش')], ['A', tr('اکانت')], ['ST', tr('استراتژی')], ['CR', tr('خلاقیت/تولید')], ['ME', tr('رسانه')], ['DM', tr('دیجیتال')], ['FI', tr('مالی')], ['LG', tr('حقوقی')], ['OP', tr('عملیات')], ['M', tr('مدیریت')]] as const;
const CONF_TONE = { HIGH: 'success', MEDIUM: 'warning', LOW: 'neutral' } as const;

/**
 * A project's meetings, and the way their decisions stop being verbal (roadmap #23, Doc_H §6).
 * Notes — typed, or transcribed where a speech service is configured — become a draft the person
 * who ran the meeting corrects; each action they keep becomes a task sourced to the minutes.
 */
export function ProjectMeetings({ projectId, meetings }: { projectId: string; meetings: Meeting[] }) {
  const { can } = useAuth();
  const [open, setOpen] = useState<Meeting | null>(null);
  const [creating, setCreating] = useState(false);
  const mayWrite = can('meeting.write');

  return (
    <Card
      title={tr('جلسه‌ها و صورتجلسه‌ها')}
      subtitle={tr('قانون ۶ — هیچ وظیفهٔ شفاهی معتبر نیست. تصمیم‌های جلسه با صورتجلسه به وظیفهٔ ثبت‌شده تبدیل می‌شوند.')}
      action={mayWrite ? <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>{tr('جلسهٔ تازه')}</Button> : undefined}
    >
      {!meetings.length ? <EmptyState title={tr('جلسه‌ای برای این پروژه ثبت نشده')} /> : (
        <ul className="divide-y divide-ink-100" data-testid="project-meetings">
          {meetings.map((m) => {
            const tasks = (m.actions ?? []).filter((a) => a.taskId).length;
            return (
              <li key={m.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                <Code>{m.code}</Code>
                <span className="font-medium text-ink-800">{m.subject}</span>
                <span className="text-xs text-ink-500">{formatDateTime(m.heldAt)}</span>
                {m.minutesRecordedAt
                  ? <Badge tone="success">{tr('صورتجلسه ثبت شده{0}', tasks ? tr(' — {0} وظیفه', localDigits(tasks)) : '')}</Badge>
                  : <Badge tone="warning">{tr('بدون صورتجلسه')}</Badge>}
                {mayWrite && !m.minutesRecordedAt && (
                  <Button size="sm" variant="primary" className="ms-auto" onClick={() => setOpen(m)}>{tr('ثبت صورتجلسه')}</Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {open && <MinutesDialog meeting={open} onClose={() => setOpen(null)} />}
      {creating && <NewMeeting projectId={projectId} onClose={() => setCreating(false)} />}
    </Card>
  );
}

function NewMeeting({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [v, setV] = useState({ subject: '', heldAt: new Date().toISOString(), attendees: '', kind: 'INTERNAL' });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  return (
    <Modal open title={tr('جلسهٔ تازه')} onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
        <Button variant="primary" loading={busy} disabled={v.subject.trim().length < 2 || v.attendees.trim().length < 2}
          onClick={async () => {
            setBusy(true);
            try {
              await apiPost('/meetings', { projectId, ...v });
              toast(tr('جلسه ثبت شد.')); await qc.invalidateQueries(); onClose();
            } catch (e: any) { toast(e?.message ?? tr('ثبت جلسه ناموفق بود.'), 'danger'); } finally { setBusy(false); }
          }}>{tr('ثبت')}</Button>
      </>}>
      <div className="grid gap-3">
        <Field label={tr('موضوع')} required><Input value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} aria-label={tr('موضوع')} /></Field>
        <Field label={tr('زمان')} required><JalaliDateInput mode="datetime" value={v.heldAt} onChange={(val) => setV({ ...v, heldAt: val ?? v.heldAt })} /></Field>
        <Field label={tr('حاضران')} required><Input value={v.attendees} onChange={(e) => setV({ ...v, attendees: e.target.value })} aria-label={tr('حاضران')} /></Field>
        <Field label={tr('نوع')}>
          <Select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })} aria-label={tr('نوع')}>
            <option value="INTERNAL">{tr('داخلی')}</option><option value="CLIENT">{tr('با مشتری')}</option><option value="KICKOFF">Kick-off</option><option value="CLOSURE">{tr('پایان پروژه')}</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

export function MinutesDialog({ meeting, onClose }: { meeting: Meeting; onClose: () => void }) {
  const [notes, setNotes] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [decisions, setDecisions] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const toast = useToast();
  const qc = useQueryClient();
  const { data: caps } = useQuery<{ transcription: boolean }>({ queryKey: ['/meetings/capabilities'], queryFn: () => apiGet('/meetings/capabilities') });

  const makeDraft = async () => {
    setBusy(true);
    try {
      const d = await apiPost<Draft>(`/meetings/${meeting.id}/draft-minutes`, { notes });
      setDraft(d);
      setDecisions(d.decisions.map((x) => x.text).join('\n'));
      setRows(d.actions.map((a) => ({
        title: a.title, assigneeId: a.assigneeId ?? '', departmentCode: a.departmentCode ?? '', dueDate: a.dueDate ?? '',
        createTask: d.canCreateTasks, candidates: a.candidates, ownerRaw: a.ownerRaw, confidence: a.confidence, sourceLine: a.sourceLine,
      })));
    } catch (e: any) { toast(e?.message ?? tr('ساخت پیش‌نویس ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const body = new FormData(); body.append('file', file);
      const res = await apiUpload<{ transcript: string }>(`/meetings/${meeting.id}/transcribe`, body);
      setNotes(res.transcript);
      toast(tr('صوت جلسه رونویسی شد — متن را بازبینی و سپس پیش‌نویس بسازید.'));
    } catch (e: any) { toast(e?.message ?? tr('رونویسی ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setProblems([]);
    try {
      const res = await apiPost<{ tasks: unknown[] }>(`/meetings/${meeting.id}/minutes`, {
        decisions, source: notes,
        actions: rows.filter((r) => r.title.trim().length >= 2).map((r) => ({
          title: r.title.trim(), assigneeId: r.assigneeId || undefined, departmentCode: r.departmentCode || undefined,
          dueDate: r.dueDate || undefined, createTask: r.createTask,
        })),
      });
      toast(tr('صورتجلسه ثبت شد{0}.', res.tasks.length ? tr(' و {0} وظیفه ساخته شد', localDigits(res.tasks.length)) : ''));
      await qc.invalidateQueries(); onClose();
    } catch (e: any) {
      setProblems((e?.body?.details?.problems as string[]) ?? []);
      toast(e?.message ?? tr('ثبت صورتجلسه ناموفق بود.'), 'danger');
    } finally { setBusy(false); }
  };
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Modal open wide title={tr('صورتجلسه — {0}', meeting.subject)} onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
        {draft && <Button variant="primary" loading={busy} onClick={() => void save()}>{tr('ثبت صورتجلسه{0}', rows.some((r) => r.createTask) ? tr(' و ساخت وظایف') : '')}</Button>}
      </>}>
      {!draft ? (
        <div className="space-y-3">
          <Field label={tr('یادداشت‌های جلسه')} hint={tr('هر تصمیم یا اقدام در یک خط؛ نام مسئول و مهلت («تا شنبه»، «ظرف ۳ روز»، «۱۲ مهر») را همان‌طور که گفته شد بنویسید.')}>
            <Textarea rows={8} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label={tr('یادداشت‌های جلسه')} />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" loading={busy} disabled={notes.trim().length < 10} onClick={() => void makeDraft()}>{tr('ساخت پیش‌نویس')}</Button>
            {caps?.transcription ? (
              <label className="cursor-pointer text-xs text-brand-700 underline">{tr('بارگذاری صوت جلسه')}<input type="file" accept="audio/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
              </label>
            ) : (
              <span className="text-[12.5px] text-ink-400">{tr('رونویسی صوت پیکربندی نشده — متن یادداشت‌ها را وارد کنید.')}</span>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4" data-testid="minutes-draft">
          <Field label={tr('تصمیم‌ها')}><Textarea rows={3} value={decisions} onChange={(e) => setDecisions(e.target.value)} aria-label={tr('تصمیم‌ها')} /></Field>
          {!draft.canCreateTasks && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{tr('این جلسه به پروژه‌ای وصل نیست؛ اقدام‌ها فقط در صورتجلسه ثبت می‌شوند.')}</p>
          )}
          {problems.length > 0 && <ul className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">{problems.map((p, i) => <li key={i}>· {p}</li>)}</ul>}
          <div className="space-y-3">
            {rows.map((r, i) => (
              <div key={i} className="rounded-lg ring-1 ring-ink-200 p-3" data-testid="minutes-action">
                <div className="mb-2 flex items-center gap-2 text-[12.5px] text-ink-400">
                  <Badge tone={CONF_TONE[r.confidence as keyof typeof CONF_TONE] ?? 'neutral'}>
                    {r.confidence === 'HIGH' ? tr('مسئول و مهلت مشخص') : r.confidence === 'MEDIUM' ? tr('نیازمند تکمیل') : tr('حدسی')}
                  </Badge>
                  <span className="truncate">{tr('از متن: «{0}»', r.sourceLine)}</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label={tr('اقدام')}><Input value={r.title} onChange={(e) => set(i, { title: e.target.value })} aria-label={tr('اقدام')} /></Field>
                  <Field label={tr('مسئول')} hint={!r.assigneeId && r.ownerRaw ? tr('در متن: «{0}»{1}', r.ownerRaw, r.candidates.length ? tr(' — {0} نفر با این نام', localDigits(r.candidates.length)) : '') : undefined}>
                    {r.candidates.length && !r.assigneeId ? (
                      <Select value="" onChange={(e) => set(i, { assigneeId: e.target.value })} aria-label={tr('مسئول')}>
                        <option value="">{tr('— کدام {0}؟ —', r.ownerRaw)}</option>
                        {r.candidates.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}
                      </Select>
                    ) : <UserSelect value={r.assigneeId} onChange={(v) => set(i, { assigneeId: v })} />}
                  </Field>
                  <Field label={tr('مهلت')}><JalaliDateInput mode="date" value={r.dueDate || null} onChange={(v) => set(i, { dueDate: v ?? '' })} /></Field>
                  <Field label={tr('واحد')} hint={r.assigneeId ? tr('از واحد مسئول') : undefined}>
                    <Select value={r.departmentCode} onChange={(e) => set(i, { departmentCode: e.target.value })} aria-label={tr('واحد')}>
                      <option value="">—</option>{UNITS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                    </Select>
                  </Field>
                </div>
                <Checkbox checked={r.createTask} disabled={!draft.canCreateTasks} onChange={(e) => set(i, { createTask: e.target.checked })} label={tr('ساخت وظیفه از این اقدام')} />
              </div>
            ))}
          </div>
          {draft.unresolvedFa.length > 0 && (
            <div className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
              <p className="font-medium">{tr('تعهدهایی بدون مسئول و مهلت — تا یکی مشخص نشود، همین‌طور شفاهی می‌مانند:')}</p>
              <ul className="mt-1 space-y-0.5">{draft.unresolvedFa.map((u, i) => <li key={i}>· {u}</li>)}</ul>
              <Button size="sm" variant="ghost" onClick={() => setRows((rs) => [...rs, ...draft.unresolvedFa.map((u) => ({
                title: u, assigneeId: '', departmentCode: '', dueDate: '', createTask: draft.canCreateTasks, candidates: [], ownerRaw: null, confidence: 'LOW', sourceLine: u,
              }))])}>{tr('افزودن به اقدام‌ها')}</Button>
            </div>
          )}
          <p className="text-[12.5px] text-ink-400">{tr('جلسه در {0} — مهلت‌های نسبی («تا شنبه») از همین تاریخ حساب شده‌اند.', formatDate(meeting.heldAt))}</p>
        </div>
      )}
    </Modal>
  );
}
