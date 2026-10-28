import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SITE_EVENTS, SITE_EVENT_LABELS, SITE_OPTION_LISTS, VENUE_EXPECTED_FIELDS, type SiteOptionList, type SiteSettings } from '@hiva/contracts';
import { apiGet, apiPatch, apiPost, apiPut } from '../../lib/api';
import { localDigits, toLatinDigits } from '../../lib/format';
import { PageBody, PageHeader } from '../../components/Shell';
import { Badge, Button, Card, Checkbox, ErrorBlock, Field, Input, LoadingBlock, Select, Table, Tabs, Td, Textarea, Th, Tr, useToast } from '../../components/ui';
import { tr } from '../../i18n';
import { SitesNav, fieldLabel, listLabel, pairLabel, useSiteOptions, useSiteSettings, type SiteOption } from './shared';
import { PeopleSelect } from './pickers';

/**
 * The module's settings (ADR-103) — «قابلیت کاستومایز بشدت بالا»: the organisation's own lists, and how
 * the rentals run — the reminder intervals and who hears, how a part-month is charged, what an
 * overpayment does, what going live and a deduction ask for, which venue fields are required, the SMS
 * templates. Every change is recorded with what it was before.
 */

export default function SiteSettingsPage() {
  const [tab, setTab] = useState('lists');
  return (
    <>
      <PageHeader title={tr('تنظیمات مکان‌ها و اجاره‌داری')} subtitle={tr('فهرست‌های سازمان و قواعدی که اجاره‌داری با آن کار می‌کند؛ هر تغییر با سابقه ثبت می‌شود')} />
      <PageBody>
        <SitesNav />
        <Card>
          <Tabs active={tab} onChange={setTab} tabs={[{ key: 'lists', label: tr('فهرست‌ها') }, { key: 'rules', label: tr('قواعد و یادآوری') }, { key: 'sms', label: tr('قالب‌های پیامک') }]} />
          <div className="p-4">{tab === 'lists' ? <Lists /> : <Rules tab={tab as 'rules' | 'sms'} />}</div>
        </Card>
      </PageBody>
    </>
  );
}

function Lists() {
  const opts = useSiteOptions();
  const [list, setList] = useState<SiteOptionList>('VENUE_TYPE');
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState({ code: '', labelFa: '', labelEn: '' });
  const rows = opts.of(list, false);
  const save = async (fn: () => Promise<unknown>, done: string) => { try { await fn(); toast(done); await qc.invalidateQueries({ queryKey: ['/site-options'] }); } catch (e: any) { toast(e?.message ?? tr('عملیات ناموفق بود.'), 'danger'); } };
  return (
    <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
      <ul className="space-y-1" aria-label={tr('فهرست‌ها')}>
        {SITE_OPTION_LISTS.map((l) => (
          <li key={l}><button type="button" onClick={() => setList(l)} className={`w-full rounded-lg px-3 py-1.5 text-start text-sm ${l === list ? 'bg-brand-50 font-semibold text-brand-800 ring-1 ring-brand-200' : 'hover:bg-ink-50'}`}>{listLabel(l)} <span className="text-xs text-ink-400">({localDigits(opts.of(l).length)})</span></button></li>
        ))}
      </ul>
      <div className="space-y-3">
        <p className="text-xs text-ink-500">{tr('گزینه‌ای که کنار گذاشته شود از انتخاب‌ها بیرون می‌رود ولی رکوردهای قبلی آن را نگه می‌دارند؛ کد هیچ گزینه‌ای عوض نمی‌شود.')}</p>
        <Table>
          <thead className="bg-ink-50/60"><tr><Th>{tr('کد')}</Th><Th>{tr('نام فارسی')}</Th><Th>{tr('نام انگلیسی')}</Th><Th>{tr('ترتیب')}</Th>{(list === 'COOPERATION' || list === 'PAYMENT_METHOD') && <Th>{tr('قاعده')}</Th>}<Th>{tr('وضعیت')}</Th></tr></thead>
          <tbody>{rows.map((o) => <OptionRow key={o.id} o={o} list={list} save={save} />)}</tbody>
        </Table>
        <div className="flex flex-wrap items-end gap-2 rounded-lg p-3 ring-1 ring-ink-100">
          <Field label={tr('کد لاتین')}><Input dir="ltr" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} className="w-36" /></Field>
          <Field label={tr('نام فارسی')}><Input value={draft.labelFa} onChange={(e) => setDraft({ ...draft, labelFa: e.target.value })} /></Field>
          <Field label={tr('نام انگلیسی')}><Input dir="ltr" value={draft.labelEn} onChange={(e) => setDraft({ ...draft, labelEn: e.target.value })} /></Field>
          <Button variant="primary" disabled={!draft.code || !draft.labelFa} onClick={() => void save(() => apiPost('/site-options', { list, code: draft.code, labelFa: draft.labelFa, labelEn: draft.labelEn || undefined, sortOrder: (rows.length + 1) * 10 }), tr('گزینه افزوده شد.')).then(() => setDraft({ code: '', labelFa: '', labelEn: '' }))}>{tr('افزودن')}</Button>
        </div>
      </div>
    </div>
  );
}

function OptionRow({ o, list, save }: { o: SiteOption; list: SiteOptionList; save: (fn: () => Promise<unknown>, done: string) => Promise<void> }) {
  const [v, setV] = useState({ labelFa: o.labelFa, labelEn: o.labelEn ?? '', sortOrder: o.sortOrder });
  const dirty = v.labelFa !== o.labelFa || v.labelEn !== (o.labelEn ?? '') || v.sortOrder !== o.sortOrder;
  return (
    <Tr className={o.isActive ? undefined : 'opacity-60'}>
      <Td><code className="ltr text-xs">{o.code}</code></Td>
      <Td><Input value={v.labelFa} onChange={(e) => setV({ ...v, labelFa: e.target.value })} aria-label={tr('نام فارسی {0}', o.code)} /></Td>
      <Td><Input dir="ltr" value={v.labelEn} onChange={(e) => setV({ ...v, labelEn: e.target.value })} aria-label={tr('نام انگلیسی {0}', o.code)} /></Td>
      <Td><Input type="number" value={v.sortOrder} onChange={(e) => setV({ ...v, sortOrder: Number(e.target.value) })} className="w-20" aria-label={tr('ترتیب {0}', o.code)} /></Td>
      {list === 'COOPERATION' && <Td><Checkbox label={tr('فایل قرارداد لازم است')} checked={o.meta.requiresContract !== false} onChange={(e) => void save(() => apiPatch(`/site-options/${o.id}`, { meta: { requiresContract: e.target.checked } }), tr('ثبت شد.'))} /></Td>}
      {list === 'PAYMENT_METHOD' && <Td><Checkbox label={tr('چک (شماره و تاریخ پرسیده شود)')} checked={!!o.meta.isCheque} onChange={(e) => void save(() => apiPatch(`/site-options/${o.id}`, { meta: { isCheque: e.target.checked } }), tr('ثبت شد.'))} /></Td>}
      <Td>
        <span className="flex gap-1">
          {dirty && <Button size="sm" variant="primary" onClick={() => void save(() => apiPatch(`/site-options/${o.id}`, { labelFa: v.labelFa, labelEn: v.labelEn || undefined, sortOrder: v.sortOrder }), tr('ثبت شد.'))}>{tr('ذخیره')}</Button>}
          <Button size="sm" variant="ghost" onClick={() => void save(() => apiPatch(`/site-options/${o.id}`, { isActive: !o.isActive }), o.isActive ? tr('گزینه کنار گذاشته شد.') : tr('گزینه دوباره فعال شد.'))}>{o.isActive ? tr('کنار گذاشتن') : tr('فعال کردن')}</Button>
        </span>
      </Td>
    </Tr>
  );
}

const days = (v: number[]) => v.map((d) => localDigits(d)).join('، ');
const parseDays = (s: string) => [...new Set(toLatinDigits(s).split(/[,،\s]+/).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 0 && x <= 365))].sort((a, b) => b - a);

function Rules({ tab }: { tab: 'rules' | 'sms' }) {
  const { data, isLoading, error, refetch } = useSiteSettings();
  const { data: people } = useQuery<{ id: string; fullName: string }[]>({ queryKey: ['/people', ''], queryFn: () => apiGet('/people') });
  const toast = useToast();
  const qc = useQueryClient();
  const [s, setS] = useState<SiteSettings | null>(null);
  useEffect(() => { if (data) setS(structuredClone(data)); }, [data]);
  if (isLoading || !s) return error ? <ErrorBlock error={error} onRetry={() => void refetch()} /> : <LoadingBlock />;
  const r = s.reminders;
  const up = (patch: Partial<SiteSettings>) => setS({ ...s, ...patch });
  const save = async () => {
    try { await apiPut('/site-settings', s); toast(tr('تنظیمات ذخیره شد.')); await qc.invalidateQueries({ queryKey: ['/site-settings'] }); } catch (e: any) { toast(e?.message ?? tr('عملیات ناموفق بود.'), 'danger'); }
  };
  const footer = <div className="flex justify-end border-t border-ink-100 pt-3"><Button variant="primary" onClick={() => void save()}>{tr('ذخیرهٔ تنظیمات')}</Button></div>;
  if (tab === 'sms') {
    return (
      <div className="space-y-3">
        <p className="text-xs text-ink-500">{tr('جانشین‌ها: {venue}، {contact}، {project}، {amount}، {dueDate}، {sender}')}</p>
        {s.smsTemplates.map((t, i) => (
          <div key={i} className="grid gap-2 rounded-lg p-3 ring-1 ring-ink-100 sm:grid-cols-[10rem_1fr_auto]">
            <Input dir="ltr" value={t.key} onChange={(e) => up({ smsTemplates: s.smsTemplates.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} aria-label={tr('کلید قالب')} />
            <div className="space-y-2">
              <Input value={t.label} onChange={(e) => up({ smsTemplates: s.smsTemplates.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} aria-label={tr('عنوان قالب')} />
              <Textarea rows={2} value={t.text} onChange={(e) => up({ smsTemplates: s.smsTemplates.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} aria-label={tr('متن قالب')} />
            </div>
            <Button size="sm" variant="ghost" onClick={() => up({ smsTemplates: s.smsTemplates.filter((_, j) => j !== i) })}>{tr('حذف')}</Button>
          </div>
        ))}
        <Button size="sm" onClick={() => up({ smsTemplates: [...s.smsTemplates, { key: `t${s.smsTemplates.length + 1}`, label: '', text: '' }] })}>{tr('قالب تازه')}</Button>
        {footer}
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-2">
        <h3 className="text-sm font-bold sm:col-span-2">{tr('یادآوری‌ها')}</h3>
        <Checkbox label={tr('یادآوری‌ها روشن باشد')} checked={r.enabled} onChange={(e) => up({ reminders: { ...r, enabled: e.target.checked } })} />
        <span />
        <Field label={tr('روزهای پیش از سررسید پرداخت')} hint={tr('با ویرگول جدا کنید؛ مثلاً ۳۰، ۱۴، ۷، ۳، ۱')}><DaysInput value={r.daysBefore} onChange={(v) => up({ reminders: { ...r, daysBefore: v } })} /></Field>
        <Field label={tr('روزهای پس از سررسید (معوق)')}><DaysInput value={r.overdueDays} onChange={(v) => up({ reminders: { ...r, overdueDays: v.filter((x) => x > 0) } })} /></Field>
        <Field label={tr('روزهای پیش از پایان قرارداد')}><DaysInput value={r.contractDays} onChange={(v) => up({ reminders: { ...r, contractDays: v } })} /></Field>
        <Field label={tr('روزهای انتظار تأیید یا بستن')}><DaysInput value={r.waitingDays} onChange={(v) => up({ reminders: { ...r, waitingDays: v.filter((x) => x > 0) } })} /></Field>
        <div className="sm:col-span-2">
          <span className="mb-1 block text-xs font-bold text-ink-700">{tr('رویدادها')}</span>
          <div className="flex flex-wrap gap-3">{SITE_EVENTS.map((ev) => (
            <Checkbox key={ev} label={pairLabel(SITE_EVENT_LABELS, ev)} checked={(r.events as Record<string, boolean>)[ev] !== false} onChange={(e) => up({ reminders: { ...r, events: { ...r.events, [ev]: e.target.checked } } })} />
          ))}</div>
        </div>
        <Checkbox label={tr('به مسئول پروژه')} checked={r.toResponsible} onChange={(e) => up({ reminders: { ...r, toResponsible: e.target.checked } })} />
        <Checkbox label={tr('به مالی (دارندگان دسترسی ثبت پرداخت)')} checked={r.toFinance} onChange={(e) => up({ reminders: { ...r, toFinance: e.target.checked } })} />
        <Checkbox label={tr('پیامک هم به همراه همکار')} checked={r.smsToStaff} onChange={(e) => up({ reminders: { ...r, smsToStaff: e.target.checked } })} />
        <div className="sm:col-span-2">
          <span className="mb-1 block text-xs font-bold text-ink-700">{tr('گیرندگان دیگر')}</span>
          <div className="flex flex-wrap items-center gap-2">
            {r.userIds.map((id) => <Badge key={id}>{people?.find((x) => x.id === id)?.fullName ?? '…'} <button type="button" onClick={() => up({ reminders: { ...r, userIds: r.userIds.filter((x) => x !== id) } })} aria-label={tr('برداشتن')}>×</button></Badge>)}
            <div className="w-56"><PeopleSelect label={tr('افزودن گیرنده')} value={null} empty={tr('— افزودن همکار —')} onChange={(v) => v && !r.userIds.includes(v) && up({ reminders: { ...r, userIds: [...r.userIds, v] } })} /></div>
          </div>
        </div>
      </section>
      <section className="grid gap-3 sm:grid-cols-2">
        <h3 className="text-sm font-bold sm:col-span-2">{tr('قواعد مالی')}</h3>
        <Field label={tr('ماه ناقص در آغاز یا پایان قرارداد')}><Select value={s.schedule.proration} onChange={(e) => up({ schedule: { proration: e.target.value as 'DAYS' | 'FULL' } })}><option value="DAYS">{tr('به نسبت روزها')}</option><option value="FULL">{tr('یک ماه کامل')}</option></Select></Field>
        <Field label={tr('پرداخت بیش از اقلام')}><Select value={s.payments.overpayment} onChange={(e) => up({ payments: { overpayment: e.target.value as 'REJECT' | 'CREDIT' } })}><option value="REJECT">{tr('پذیرفته نشود')}</option><option value="CREDIT">{tr('اضافه‌پرداخت نگه داشته شود')}</option></Select></Field>
        <Checkbox label={tr('کسر از ودیعه تأیید همکار دیگری را لازم دارد')} checked={s.deposits.requireDeductionApproval} onChange={(e) => up({ deposits: { requireDeductionApproval: e.target.checked } })} />
        <span />
        <Checkbox label={tr('بهره‌برداری بی‌عکس نصب ممکن نباشد')} checked={s.activation.requireInstallationPhoto} onChange={(e) => up({ activation: { ...s.activation, requireInstallationPhoto: e.target.checked } })} />
        <Checkbox label={tr('بهره‌برداری بی‌تأییدیهٔ کارفرما ممکن نباشد')} checked={s.activation.requireEmployerApproval} onChange={(e) => up({ activation: { ...s.activation, requireEmployerApproval: e.target.checked } })} />
      </section>
      <section className="grid gap-3 sm:grid-cols-2">
        <h3 className="text-sm font-bold sm:col-span-2">{tr('مکان‌ها')}</h3>
        <div>
          <span className="mb-1 block text-xs font-bold text-ink-700">{tr('لازم برای ثبت دستی مکان')}</span>
          <div className="flex flex-wrap gap-3">{VENUE_EXPECTED_FIELDS.filter((f) => f !== 'contacts' && f !== 'photos').map((f) => (
            <Checkbox key={f} label={fieldLabel(f)} checked={s.venues.required.includes(f)} onChange={(e) => up({ venues: { ...s.venues, required: e.target.checked ? [...s.venues.required, f] : s.venues.required.filter((x) => x !== f) } })} />
          ))}</div>
        </div>
        <div>
          <span className="mb-1 block text-xs font-bold text-ink-700">{tr('تکراری بودن با')}</span>
          <div className="flex flex-wrap gap-3">{(['NAME_CITY', 'PHONE', 'ADDRESS'] as const).map((k) => (
            <Checkbox key={k} label={{ NAME_CITY: tr('نام یکسان در یک شهر'), PHONE: tr('تلفن مشترک'), ADDRESS: tr('آدرس یکسان') }[k]} checked={s.venues.duplicateBy.includes(k)}
              onChange={(e) => up({ venues: { ...s.venues, duplicateBy: e.target.checked ? [...s.venues.duplicateBy, k] : s.venues.duplicateBy.filter((x) => x !== k) } })} />
          ))}</div>
        </div>
      </section>
      {footer}
    </div>
  );
}

function DaysInput({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  const [text, setText] = useState(days(value));
  return <Input value={text} onChange={(e) => setText(e.target.value)} onBlur={() => { const v = parseDays(text); onChange(v); setText(days(v)); }} />;
}
