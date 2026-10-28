import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SITE_EVENT_LABELS, type SiteEvent } from '@hiva/contracts';
import { apiGet, apiPost, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDate, formatDateTime, formatRelative, localDigits } from '../../lib/format';
import { PageBody, PageHeader } from '../../components/Shell';
import {
  Badge, Button, Card, EmptyState, ErrorBlock, Field, Input, LoadingBlock, Modal, Pagination, Select, StateBadge, Table, Tabs, Td, Textarea, Th, Tr, useToast,
} from '../../components/ui';
import { tr, trx } from '../../i18n';
import { SitesNav, pairLabel, useSiteSettings } from './shared';

/**
 * Reminders and texts (ADR-103): the reminders the daily run sent — to whom, by which channel, what the
 * SMS provider answered — and the texts sent to the venues. «SENT» is the provider taking a message;
 * «delivered» only what the provider later reports.
 */

export function SendSms({ venueIds = [], contactIds = [], siteProjectId, onClose }: { venueIds?: string[]; contactIds?: string[]; siteProjectId?: string; onClose: () => void }) {
  const { data: settings } = useSiteSettings();
  const toast = useToast();
  const qc = useQueryClient();
  const [templateKey, setTemplateKey] = useState('');
  const [text, setText] = useState('');
  const [values, setValues] = useState({ amount: '', dueDate: '', project: '' });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ sent: number; sandbox: number; failed: number; skipped: { name: string; reason: string }[] } | null>(null);
  const send = async () => {
    setBusy(true);
    try {
      const r = await apiPost<typeof result>('/venue-messages', { venueIds, contactIds, siteProjectId: siteProjectId ?? null, templateKey: templateKey || null, text, values: { amount: values.amount || null, dueDate: values.dueDate || null, project: values.project || null } });
      setResult(r);
      await qc.invalidateQueries();
    } catch (e: any) { toast(e?.message ?? tr('عملیات ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={tr('پیامک به {0} مکان', localDigits(venueIds.length + contactIds.length))}
      footer={result ? <Button onClick={onClose}>{tr('بستن')}</Button> : <><Button onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" loading={busy} disabled={text.trim().length < 5} onClick={() => void send()}>{tr('ارسال')}</Button></>}>
      {result ? (
        <div className="space-y-2 text-sm" role="status">
          {result.sent > 0 && <p className="text-emerald-700">{tr('{0} پیامک به سامانهٔ پیامک تحویل شد (رسیدنش را سامانه بعداً گزارش می‌کند).', localDigits(result.sent))}</p>}
          {result.sandbox > 0 && <p className="text-amber-700">{tr('{0} پیامک در حالت آزمایشی ثبت شد و فرستاده نشد: سامانهٔ پیامکی در این نصب پیکربندی نشده است.', localDigits(result.sandbox))}</p>}
          {result.failed > 0 && <p className="text-rose-700">{tr('{0} پیامک فرستاده نشد؛ دوباره تلاش می‌شود.', localDigits(result.failed))}</p>}
          {result.skipped.length > 0 && <p className="text-ink-600">{tr('بی‌شمارهٔ همراه، کنار گذاشته شد: {0}', result.skipped.map((s) => s.name).join('، '))}</p>}
        </div>
      ) : (
        <div className="space-y-3">
          <Field label={tr('قالب')}>
            <Select value={templateKey} onChange={(e) => { setTemplateKey(e.target.value); setText(settings?.smsTemplates.find((t) => t.key === e.target.value)?.text ?? text); }}>
              <option value="">{tr('— متن آزاد —')}</option>
              {settings?.smsTemplates.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </Select>
          </Field>
          <Field label={tr('متن')} required hint={tr('جانشین‌ها: {venue} نام مکان، {contact} نام مخاطب، {project}، {amount}، {dueDate}، {sender} نام سازمان')}>
            <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} maxLength={600} />
          </Field>
          {/\{(amount|dueDate|project)\}/.test(text) && (
            <div className="grid gap-2 sm:grid-cols-3">
              {text.includes('{project}') && <Field label={tr('پروژه')}><Input value={values.project} onChange={(e) => setValues({ ...values, project: e.target.value })} /></Field>}
              {text.includes('{amount}') && <Field label={tr('مبلغ')}><Input value={values.amount} onChange={(e) => setValues({ ...values, amount: e.target.value })} /></Field>}
              {text.includes('{dueDate}') && <Field label={tr('تاریخ')}><Input value={values.dueDate} onChange={(e) => setValues({ ...values, dueDate: e.target.value })} /></Field>}
            </div>
          )}
          <p className="text-xs text-ink-500">{tr('به مخاطب اصلی هر مکان (یا نخستین مخاطبی که شمارهٔ همراه دارد) فرستاده می‌شود؛ هر شماره یک بار.')}</p>
        </div>
      )}
    </Modal>
  );
}

interface ReminderRow { id: string; event: SiteEvent; subjectType: string; dueDate: string; offsetDays: number; channel: string; recipient: string; recipientName: string | null; status: string; attempts: number; error: string | null; sentAt: string | null; createdAt: string; project: { id: string; code: string; name: string } | null }
interface MessageRow { id: string; phone: string; text: string; status: string; error: string | null; attempts: number; createdAt: string; venue: { id: string; name: string } | null; contact: { fullName: string } | null; sentBy: { fullName: string } | null }

export default function RemindersPage() {
  const { can, canAny } = useAuth();
  const [tab, setTab] = useState(canAny('rental.read', 'site.configure') ? 'reminders' : 'messages');
  return (
    <>
      <PageHeader title={tr('یادآوری‌ها و پیامک‌ها')} subtitle={tr('آنچه یادآوری شد و به چه کسی، و پیامک‌هایی که به مکان‌ها رفت')} />
      <PageBody>
        <SitesNav />
        <Card>
          <Tabs active={tab} onChange={setTab} tabs={[
            ...(canAny('rental.read', 'site.configure') ? [{ key: 'reminders', label: tr('یادآوری‌ها') }] : []),
            ...(can('venue.sms') ? [{ key: 'messages', label: tr('پیامک به مکان‌ها') }] : []),
          ]} />
          {tab === 'reminders' ? <ReminderLog /> : <MessageLog />}
        </Card>
      </PageBody>
    </>
  );
}

function ReminderLog() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);
  const { data, isLoading, error, refetch } = useQuery<Page<ReminderRow>>({ queryKey: ['/site-reminders', page, status], queryFn: () => apiGet('/site-reminders', { page: String(page), ...(status ? { status } : {}) }) });
  const run = async () => {
    setRunning(true);
    try {
      const r = await apiPost<{ sent: number; skipped: number; sms: number; smsFailed: number }>('/site-reminders/run');
      toast(tr('{0} یادآوری تازه فرستاده شد؛ {1} پیش‌تر فرستاده شده بود.', localDigits(r.sent), localDigits(r.skipped)));
      await qc.invalidateQueries({ queryKey: ['/site-reminders'] });
    } catch (e: any) { toast(e?.message ?? tr('عملیات ناموفق بود.'), 'danger'); } finally { setRunning(false); }
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 p-3">
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label={tr('وضعیت')} className="w-44">
          <option value="">{tr('همهٔ وضعیت‌ها')}</option><option value="SENT">{tr('فرستاده‌شده')}</option><option value="SANDBOX">{tr('آزمایشی')}</option><option value="FAILED">{tr('ناموفق')}</option>
        </Select>
        <span className="flex-1 text-xs text-ink-500">{tr('هر روز ساعت ۸:۳۰ اجرا می‌شود؛ هر یادآوری یک بار.')}</span>
        {can('site.configure') && <Button size="sm" loading={running} onClick={() => void run()}>{tr('اجرای همین حالا')}</Button>}
      </div>
      {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={() => void refetch()} /> : !data?.items.length ? <EmptyState title={tr('یادآوری‌ای فرستاده نشده')} /> : (
        <>
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>{tr('رویداد')}</Th><Th>{tr('پروژه')}</Th><Th>{tr('سررسید')}</Th><Th>{tr('گیرنده')}</Th><Th>{tr('کانال')}</Th><Th>{tr('وضعیت')}</Th><Th>{tr('زمان')}</Th></tr></thead>
            <tbody>
              {data.items.map((r) => (
                <Tr key={r.id}>
                  <Td><span className="text-sm">{pairLabel(SITE_EVENT_LABELS, r.event)}</span><span className="block text-xs text-ink-500">{r.offsetDays > 0 ? tr('{0} روز پیش از سررسید', localDigits(r.offsetDays)) : r.offsetDays < 0 ? tr('{0} روز پس از سررسید', localDigits(-r.offsetDays)) : tr('روز سررسید')}</span></Td>
                  <Td>{r.project ? <Link to={`/sites/projects/${r.project.id}`} className="text-brand-700 hover:underline">{r.project.name}</Link> : '—'}</Td>
                  <Td>{formatDate(r.dueDate)}</Td>
                  <Td>{r.recipientName ?? <span dir="ltr" className="nums">{localDigits(r.recipient)}</span>}</Td>
                  <Td><Badge>{r.channel === 'SMS' ? tr('پیامک') : r.channel === 'EMAIL' ? tr('ایمیل') : tr('درون برنامه')}</Badge></Td>
                  <Td><StateBadge state={r.status} />{r.error && <span className="block text-xs text-rose-700">{trx(r.error)}</span>}{r.attempts > 1 && <span className="block text-xs text-ink-500">{tr('{0} بار تلاش', localDigits(r.attempts))}</span>}</Td>
                  <Td><span className="text-xs">{formatDateTime(r.sentAt ?? r.createdAt)}</span></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={data.page} pageCount={data.pageCount} total={data.total} onChange={setPage} />
        </>
      )}
    </>
  );
}

function MessageLog() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const { data, isLoading, error, refetch } = useQuery<Page<MessageRow>>({ queryKey: ['/venue-messages', page, status], queryFn: () => apiGet('/venue-messages', { page: String(page), ...(status ? { status } : {}) }) });
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 p-3">
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label={tr('وضعیت')} className="w-48">
          <option value="">{tr('همهٔ وضعیت‌ها')}</option>
          <option value="SENT">{tr('تحویل سامانهٔ پیامک')}</option><option value="DELIVERED">{tr('رسید')}</option><option value="UNDELIVERED">{tr('نرسید')}</option>
          <option value="FAILED">{tr('ناموفق')}</option><option value="SANDBOX">{tr('آزمایشی')}</option>
        </Select>
        <span className="text-xs text-ink-500">{tr('برای فرستادن، از فهرست مکان‌ها مکان‌ها را برگزینید.')}</span>
      </div>
      {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={() => void refetch()} /> : !data?.items.length ? <EmptyState title={tr('پیامکی فرستاده نشده')} /> : (
        <>
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>{tr('مکان')}</Th><Th>{tr('گیرنده')}</Th><Th>{tr('متن')}</Th><Th>{tr('وضعیت')}</Th><Th>{tr('فرستنده')}</Th></tr></thead>
            <tbody>
              {data.items.map((m) => (
                <Tr key={m.id}>
                  <Td>{m.venue ? <Link to={`/sites/venues/${m.venue.id}`} className="text-brand-700 hover:underline">{m.venue.name}</Link> : '—'}</Td>
                  <Td><span className="text-xs">{m.contact?.fullName}</span><span dir="ltr" className="block nums text-xs">{localDigits(m.phone)}</span></Td>
                  <Td><span className="line-clamp-2 text-xs">{m.text}</span></Td>
                  <Td><StateBadge state={m.status} />{m.error && <span className="block text-xs text-rose-700">{trx(m.error)}</span>}</Td>
                  <Td><span className="text-xs">{m.sentBy?.fullName} · {formatRelative(m.createdAt)}</span></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={data.page} pageCount={data.pageCount} total={data.total} onChange={setPage} />
        </>
      )}
    </>
  );
}

