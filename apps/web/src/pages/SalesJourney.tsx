import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEPARTMENT_LABELS, DEPARTMENT_CODES, normalizeIranMobile, type DepartmentCode } from '@hiva/contracts';
import { ApiError, apiGet, apiPost, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatRelative, localDigits } from '../lib/format';
import { forwardMove, stageOf, type Transition } from '../lib/plain';
import { PageBody, PageHeader } from '../components/Shell';
import { JourneySteps, StepSection, type JourneyStep } from '../components/Journey';
import { LeadSourcePicker, sourceComplete, type LeadSourceValue } from '../components/LeadSource';
import { JalaliDateInput } from '../components/JalaliDateInput';
import { WorkflowActions } from '../components/common';
import { ReturnNote, StagePill } from '../components/WorkCard';
import { Button, Checkbox, ErrorBlock, Field, Input, LoadingBlock, Select, Textarea, useToast } from '../components/ui';
import { flow, isEnglish, tr } from '../i18n';

/**
 * A customer, from first contact to a brief sent for review (the owner's brief, 2026-11-02): register
 * the customer and its people, record each meeting and call, turn it into a sale and write the brief,
 * send it. Four steps on one page, each saying what it is for. Every step writes through the routes the
 * rest of the CRM uses — a client, its contacts, a lead with its source, activities, the lead's own
 * conversion, a brief and the brief's own moves — so nothing here is a second way of doing anything.
 */

interface ContactDraft { fullName: string; jobTitle: string; phone: string; email: string }
const blankContact = (): ContactDraft => ({ fullName: '', jobTitle: '', phone: '', email: '' });

interface Duplicates {
  phone: string | null;
  leads: { id: string; code: string; name: string; companyName: string; owner: string | null }[];
  contacts: { id: string; fullName: string; company: string; companyId: string }[];
}

/* ── step one: a new customer ─────────────────────────────────────────────── */

export function NewCustomer() {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [notes, setNotes] = useState('');
  const [contacts, setContacts] = useState<ContactDraft[]>([blankContact()]);
  const [source, setSource] = useState<LeadSourceValue>({});
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [busy, setBusy] = useState(false);
  // What a save that stopped half-way already made, so that trying again does not make it twice.
  const made = useRef<{ lead?: boolean; companyId?: string; contacts: number }>({ contacts: 0 });

  // A customer already on file is opened, not made twice.
  const same = useQuery<Page<{ id: string; legalName: string; brandName: string | null }>>({
    queryKey: ['/companies', 'same', name.trim()],
    queryFn: () => apiGet('/companies', { q: name.trim(), pageSize: '5' }),
    enabled: name.trim().length >= 2,
  });
  const existing = same.data?.items.find((c) => [c.legalName, c.brandName].some((n) => n?.trim() === name.trim()));

  const first = contacts[0]!;
  const mobile = normalizeIranMobile(first.phone);
  // The main contact's mobile is checked while it is typed, as on the lead form.
  const [asked, setAsked] = useState<string | null>(null);
  useEffect(() => {
    if (!mobile) return;
    const t = setTimeout(() => setAsked(mobile), 350);
    return () => clearTimeout(t);
  }, [mobile]);
  useEffect(() => { setConfirmDuplicate(false); }, [mobile]);
  const { data: dup, refetch: recheck } = useQuery<Duplicates>({
    queryKey: ['/leads/duplicates', asked], queryFn: () => apiGet('/leads/duplicates', { phone: asked! }), enabled: !!asked,
  });
  const repeated = !made.current.lead && !!mobile && dup?.phone === mobile && (dup.leads.length > 0 || dup.contacts.length > 0);

  const ready = name.trim().length >= 2 && first.fullName.trim().length >= 2 && !!mobile && sourceComplete(source) && (!repeated || confirmDuplicate);
  const setContact = (i: number, patch: Partial<ContactDraft>) => setContacts((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const save = async () => {
    setBusy(true);
    try {
      // The lead first: it is where the source is recorded and a repeated number is refused.
      if (!made.current.lead) {
        await apiPost('/leads', {
          name: name.trim(), companyName: name.trim(), contactName: first.fullName.trim(), phone: mobile,
          email: first.email.trim() || undefined, need: notes.trim() || undefined, ...source, confirmDuplicate: confirmDuplicate || undefined,
        });
        made.current.lead = true;
      }
      if (!made.current.companyId) {
        const company = await apiPost<{ id: string }>('/companies', {
          legalName: name.trim(), industry: industry.trim() || undefined, notes: notes.trim() || undefined,
          email: first.email.trim() || undefined,
        });
        made.current.companyId = company.id;
      }
      const people = contacts.filter((c) => c.fullName.trim().length >= 2);
      for (const [i, c] of people.entries()) {
        if (i < made.current.contacts) continue;
        await apiPost('/contacts', {
          companyId: made.current.companyId, fullName: c.fullName.trim(), jobTitle: c.jobTitle.trim() || undefined,
          phone: normalizeIranMobile(c.phone) ?? (c.phone.trim() || undefined), email: c.email.trim() || undefined, isPrimary: i === 0,
        });
        made.current.contacts = i + 1;
      }
      toast(tr('مشتری ثبت شد. اکنون پیگیری‌ها را ثبت کنید و بریف را بنویسید.'));
      await qc.invalidateQueries();
      navigate(`/sales/journey/${made.current.companyId}`);
    } catch (e) {
      // Someone registered the same number between the check and the save: the panel shows who.
      if (e instanceof ApiError && e.body.code === 'DUPLICATE_LEAD') void recheck();
      else toast(e instanceof Error ? e.message : tr('ثبت ناموفق بود.'), 'danger');
    } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader title={tr('ثبت مشتری تازه')} subtitle={tr('سه بخش کوتاه: مشتری کیست، با چه کسانی در تماسیم، و از کجا آمده است.')} />
      <PageBody className="max-w-3xl space-y-4">
        <StepSection n={1} tour="customer" title={tr('مشتری')} hint={tr('نام شرکت یا برند، و اینکه در چه کاری است.')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr('نام مشتری یا برند')} required>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('مثلاً: بانک آینده‌سازان')} aria-label={tr('نام مشتری یا برند')} />
            </Field>
            <Field label={tr('نوع کسب‌وکار')} hint={tr('مثلاً: بانک، بیمه، خودرو، رستوران')}>
              <Input value={industry} onChange={(e) => setIndustry(e.target.value)} aria-label={tr('نوع کسب‌وکار')} />
            </Field>
          </div>
          {existing && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="existing-customer">
              {tr('مشتری‌ای به همین نام ثبت شده است.')}{' '}
              <Link to={`/sales/journey/${existing.id}`} className="font-medium underline">{tr('مسیر فروش آن را باز کنید')}</Link>
            </p>
          )}
          <div className="mt-3">
            <Field label={tr('یادداشت')} hint={tr('مشتری چه می‌خواهد؟ هر چه تا اینجا گفته شده.')}>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} aria-label={tr('یادداشت')} />
            </Field>
          </div>
        </StepSection>

        <StepSection n={2} tour="contacts" title={tr('مخاطب‌ها')} hint={tr('کسانی که با آن‌ها در تماسید. نفر اول مخاطب اصلی است و شمارهٔ همراهش لازم است.')}>
          <div className="space-y-3">
            {contacts.map((c, i) => (
              <div key={i} className="grid gap-2 rounded-lg bg-ink-50/60 p-3 sm:grid-cols-4" data-testid="contact-row">
                <Input value={c.fullName} onChange={(e) => setContact(i, { fullName: e.target.value })} placeholder={tr('نام و نام خانوادگی')} aria-label={tr('نام مخاطب {0}', localDigits(i + 1))} />
                <Input value={c.jobTitle} onChange={(e) => setContact(i, { jobTitle: e.target.value })} placeholder={tr('سمت')} aria-label={tr('سمت مخاطب {0}', localDigits(i + 1))} />
                <Input value={c.phone} onChange={(e) => setContact(i, { phone: e.target.value })} placeholder={i === 0 ? tr('همراه — ۰۹۱۲…') : tr('تلفن')} className="ltr" inputMode="tel" aria-label={tr('تلفن مخاطب {0}', localDigits(i + 1))} />
                <div className="flex gap-2">
                  <Input value={c.email} onChange={(e) => setContact(i, { email: e.target.value })} placeholder={tr('ایمیل')} className="ltr" aria-label={tr('ایمیل مخاطب {0}', localDigits(i + 1))} />
                  {i > 0 && <Button size="sm" variant="ghost" onClick={() => setContacts((cs) => cs.filter((_, j) => j !== i))} aria-label={tr('حذف مخاطب {0}', localDigits(i + 1))}>{tr('حذف')}</Button>}
                </div>
              </div>
            ))}
            {first.phone.trim() && !mobile && <p className="text-xs text-rose-700">{tr('شمارهٔ همراه مخاطب اصلی درست نیست؛ مثلاً ۰۹۱۲۳۴۵۶۷۸۹.')}</p>}
            <Button size="sm" variant="secondary" onClick={() => setContacts((cs) => [...cs, blankContact()])}>{tr('+ مخاطب دیگر')}</Button>
          </div>
        </StepSection>

        <StepSection n={3} tour="source" title={tr('از کجا آمده؟')} hint={tr('چه کسی یا چه راهی این مشتری را آورد — برای اینکه بدانیم کدام راه جواب می‌دهد.')}>
          <LeadSourcePicker value={source} onChange={setSource} />
        </StepSection>

        {repeated && dup && (
          <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200" role="alert" data-testid="lead-duplicate">
            <p className="font-medium">{tr('شمارهٔ همراه مخاطب اصلی پیش‌تر ثبت شده است:')}</p>
            <ul className="mt-1 space-y-0.5">
              {dup.leads.map((l) => <li key={l.id}>{tr('سرنخ')}{' '}<span className="ltr whitespace-nowrap">{l.code}</span> «{l.name}» — {l.companyName}{l.owner ? tr(' (مالک: {0})', l.owner) : ''}</li>)}
              {dup.contacts.map((c) => <li key={c.id}>{tr('مخاطب «{0}» از', c.fullName)}{' '}<Link to={`/sales/journey/${c.companyId}`} className="underline">{c.company}</Link></li>)}
            </ul>
            <div className="mt-2"><Checkbox label={tr('مشتری تازه‌ای است؛ با وجود تکرار ثبت شود')} checked={confirmDuplicate} onChange={(e) => setConfirmDuplicate(e.target.checked)} /></div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-500">{tr('پس از ثبت، صفحهٔ مسیر فروش این مشتری باز می‌شود: پیگیری‌ها را آنجا ثبت می‌کنید و بریف را می‌نویسید.')}</p>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void save()}>{tr('ثبت مشتری')}</Button>
        </div>
      </PageBody>
    </>
  );
}

/* ── the journey: follow up, sell, brief, send ──────────────────────────── */

interface Company360 {
  company: { id: string; legalName: string; brandName: string | null; industry: string | null; notes: string | null; contacts: { id: string; fullName: string; jobTitle: string | null; phone: string | null; email: string | null; isPrimary: boolean }[] };
  opportunities: { id: string; code: string; title: string; state: string; createdAt: string }[];
  activities: { id: string; kind: string; occurredAt: string; summary: string; nextStep: string | null; nextStepDue: string | null }[];
}
interface LeadRow { id: string; code: string; companyName: string; companyId: string | null; state: string; createdAt: string; availableTransitions: Transition[] }
interface BriefRow { id: string; code: string; title: string; state: string; availableTransitions: Transition[] }

const KINDS: Record<string, string> = {
  MEETING: tr('جلسه'), CALL: tr('تماس تلفنی'), VISIT: tr('بازدید'), EMAIL: tr('ایمیل'), NOTE: tr('یادداشت'),
};

export function CustomerJourney() {
  const { companyId } = useParams<{ companyId: string }>();
  const { can } = useAuth();
  const c360 = useQuery<Company360>({ queryKey: [`/companies/${companyId}/360`], queryFn: () => apiGet(`/companies/${companyId}/360`), enabled: !!companyId });
  const name = c360.data?.company.legalName ?? '';
  // The lead this customer came as: filed against it once converted, known by its name before then.
  const leads = useQuery<Page<LeadRow>>({
    queryKey: ['/leads', 'journey', name], queryFn: () => apiGet('/leads', { q: name, pageSize: '50' }), enabled: !!name && can('crm.lead.read'),
  });
  const lead = (leads.data?.items ?? [])
    .filter((l) => l.companyId === companyId || (!l.companyId && l.companyName.trim() === name.trim()))
    .filter((l) => l.state !== 'DISQUALIFIED')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const opp = [...(c360.data?.opportunities ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .find((o) => !['WON', 'LOST'].includes(o.state)) ?? c360.data?.opportunities[0];
  const briefs = useQuery<Page<BriefRow>>({
    queryKey: ['/briefs', 'journey', opp?.id], queryFn: () => apiGet('/briefs', { opportunityId: opp!.id, pageSize: '20' }), enabled: !!opp && can('brief.read'),
  });
  const brief = briefs.data?.items[0];

  if (c360.isLoading) return <PageBody><LoadingBlock /></PageBody>;
  if (c360.error || !c360.data) return <PageBody><ErrorBlock error={c360.error} onRetry={() => void c360.refetch()} /></PageBody>;
  const { company, activities } = c360.data;
  const sent = !!brief && ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED'].includes(brief.state);
  const steps: JourneyStep[] = [
    { key: 'customer', label: tr('ثبت مشتری'), done: true },
    { key: 'follow', label: tr('پیگیری و جلسه'), done: activities.length > 0 },
    { key: 'brief', label: tr('فرصت فروش و بریف'), done: !!brief },
    { key: 'send', label: tr('ارسال برای بررسی'), done: sent },
  ];

  return (
    <>
      <PageHeader title={tr('مسیر فروش — {0}', company.brandName || company.legalName)}
        subtitle={tr('از ثبت مشتری تا بریفی که برای بررسی فرستاده می‌شود؛ هر بخش می‌گوید برای چیست.')}
        actions={<Link to={`/companies/${company.id}`}><Button variant="ghost">{tr('پروندهٔ کامل مشتری')}</Button></Link>} />
      <PageBody className="space-y-4">
        <JourneySteps steps={steps} />

        <StepSection n={1} title={tr('مشتری و مخاطب‌ها')} done>
          <p className="text-sm text-ink-700">{company.legalName}{company.industry ? ` — ${company.industry}` : ''}</p>
          {company.notes && <p className="mt-1 whitespace-pre-line text-sm leading-7 text-ink-500">{company.notes}</p>}
          <ul className="mt-3 grid gap-2 sm:grid-cols-2" data-testid="journey-contacts">
            {company.contacts.map((ct) => (
              <li key={ct.id} className="rounded-lg bg-ink-50/60 px-3 py-2 text-sm">
                <span className="font-medium text-ink-800">{ct.fullName}</span>{ct.isPrimary && <span className="ms-2 text-xs text-brand-700">{tr('مخاطب اصلی')}</span>}
                <span className="block text-xs text-ink-500">{[ct.jobTitle, ct.phone, ct.email].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
          {can('crm.contact.write') && <AddContact companyId={company.id} onDone={() => void c360.refetch()} />}
        </StepSection>

        <StepSection n={2} tour="follow-ups" title={tr('پیگیری‌ها و جلسه‌ها')} done={activities.length > 0}
          hint={tr('هر تماس، جلسه یا بازدید را با خلاصه‌اش ثبت کنید، و اینکه پیگیری بعدی کی است. هر بار که لازم شد، دوباره.')}>
          {can('crm.activity.write') && <FollowUp companyId={company.id} opportunityId={opp?.id} contacts={company.contacts} onDone={() => void c360.refetch()} />}
          {!activities.length ? <p className="mt-3 text-sm text-ink-500">{tr('هنوز پیگیری‌ای ثبت نشده است.')}</p> : (
            <ol className="mt-4 space-y-3 border-s-2 border-ink-100 ps-4" data-testid="timeline">
              {activities.map((a) => (
                <li key={a.id} className="relative">
                  <span className="absolute -start-[1.4rem] top-1.5 size-2.5 rounded-full bg-brand-500" aria-hidden />
                  <p className="text-xs text-ink-500">{KINDS[a.kind] ?? a.kind} — {formatDate(a.occurredAt)}</p>
                  <p className="mt-0.5 whitespace-pre-line text-sm leading-7 text-ink-800">{a.summary}</p>
                  {(a.nextStep || a.nextStepDue) && (
                    <p className="mt-0.5 text-xs text-brand-700">{tr('پیگیری بعدی')}{a.nextStepDue ? ` (${formatDate(a.nextStepDue)} — ${formatRelative(a.nextStepDue)})` : ''}{a.nextStep ? `: ${a.nextStep}` : ''}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </StepSection>

        <StepSection n={3} tour="brief" title={tr('فرصت فروش و بریف')} done={!!brief}
          hint={tr('وقتی مشتری جدی شد، فرصت فروش می‌شود و بریفش را می‌نویسید: چه می‌خواهد، برای چه کسی، با چه بودجه و تا کی.')}>
          {opp ? (
            <>
              <p className="text-sm text-ink-700">
                {tr('فرصت فروش: ')}<Link to={`/opportunities/${opp.id}`} className="font-medium text-brand-700 hover:underline">{opp.title}</Link>{' '}<StagePill state={opp.state} entity="opportunity" />
              </p>
              {brief ? (
                <p className="mt-2 text-sm text-ink-700">
                  {tr('بریف: ')}<Link to={`/briefs/${brief.id}`} className="font-medium text-brand-700 hover:underline">{brief.title}</Link>{' '}<StagePill state={brief.state} entity="brief" />
                  <span className="ms-2 text-xs text-ink-500">{tr('برای تکمیل جزئیات، بریف را باز کنید.')}</span>
                </p>
              ) : can('brief.write') ? <NewBrief opportunityId={opp.id} customer={company.brandName || company.legalName} onDone={() => void briefs.refetch()} />
                : <p className="mt-2 text-sm text-ink-500">{tr('نوشتن بریف با کسی است که دسترسی آن را دارد.')}</p>}
            </>
          ) : lead ? <LeadToSale lead={lead} companyId={company.id} customer={company.brandName || company.legalName} onDone={() => { void leads.refetch(); void c360.refetch(); }} />
            : <p className="text-sm text-ink-500">{tr('برای این مشتری سرنخی پیدا نشد. فرصت فروش را از پروندهٔ مشتری بسازید.')}</p>}
        </StepSection>

        <StepSection n={4} tour="send" title={tr('ارسال برای بررسی')} done={sent}
          hint={tr('بریف کامل‌شده برای اکانت فرستاده می‌شود. اگر چیزی کم باشد، با توضیح به شما برمی‌گردد و همین‌جا می‌بینید.')}>
          {!brief ? <p className="text-sm text-ink-500">{tr('اول بریف را بنویسید.')}</p> : <SendBrief brief={brief} onDone={() => void briefs.refetch()} />}
        </StepSection>
      </PageBody>
    </>
  );
}

function AddContact({ companyId, onDone }: { companyId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [c, setC] = useState<ContactDraft>(blankContact());
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  if (!open) return <Button size="sm" variant="secondary" className="mt-3" onClick={() => setOpen(true)}>{tr('+ مخاطب دیگر')}</Button>;
  const save = async () => {
    setBusy(true);
    try {
      await apiPost('/contacts', { companyId, fullName: c.fullName.trim(), jobTitle: c.jobTitle.trim() || undefined, phone: normalizeIranMobile(c.phone) ?? (c.phone.trim() || undefined), email: c.email.trim() || undefined });
      toast(tr('مخاطب ثبت شد.')); setC(blankContact()); setOpen(false); onDone();
    } catch (e: any) { toast(e?.message ?? tr('ثبت ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  return (
    <div className="mt-3 grid gap-2 rounded-lg bg-ink-50/60 p-3 sm:grid-cols-5">
      <Input value={c.fullName} onChange={(e) => setC({ ...c, fullName: e.target.value })} placeholder={tr('نام و نام خانوادگی')} aria-label={tr('نام مخاطب تازه')} />
      <Input value={c.jobTitle} onChange={(e) => setC({ ...c, jobTitle: e.target.value })} placeholder={tr('سمت')} aria-label={tr('سمت مخاطب تازه')} />
      <Input value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} placeholder={tr('تلفن')} className="ltr" aria-label={tr('تلفن مخاطب تازه')} />
      <Input value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} placeholder={tr('ایمیل')} className="ltr" aria-label={tr('ایمیل مخاطب تازه')} />
      <Button size="sm" variant="primary" loading={busy} disabled={c.fullName.trim().length < 2} onClick={() => void save()}>{tr('ثبت مخاطب')}</Button>
    </div>
  );
}

/** One meeting, call or visit: with whom, where, what was said, and when to follow up. */
function FollowUp({ companyId, opportunityId, contacts, onDone }: { companyId: string; opportunityId?: string; contacts: Company360['company']['contacts']; onDone: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [v, setV] = useState({ kind: 'MEETING', occurredAt: today, contactId: '', place: '', summary: '', nextStep: '', nextStepDue: '' });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const save = async () => {
    setBusy(true);
    const who = contacts.find((c) => c.id === v.contactId)?.fullName;
    // The activity keeps a summary, a next step and its date; with whom and where are said at its head.
    const head = [who && tr('با: {0}', who), v.place.trim() && tr('محل: {0}', v.place.trim())].filter(Boolean).join(' — ');
    try {
      await apiPost('/activities', {
        companyId, opportunityId, kind: v.kind, occurredAt: v.occurredAt,
        summary: [head, v.summary.trim()].filter(Boolean).join('\n'),
        nextStep: v.nextStep.trim() || undefined, nextStepDue: v.nextStepDue || undefined,
      });
      toast(tr('پیگیری ثبت شد.'));
      setV({ ...v, summary: '', nextStep: '', nextStepDue: '', place: '' });
      onDone();
    } catch (e: any) { toast(e?.message ?? tr('ثبت ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-3 rounded-lg bg-ink-50/60 p-3 sm:grid-cols-2" data-testid="follow-up">
      <Field label={tr('چه بود؟')}>
        <Select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })} aria-label={tr('نوع پیگیری')}>
          {Object.entries(KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
      </Field>
      <Field label={tr('کی؟')}><JalaliDateInput mode="date" value={v.occurredAt} onChange={(d) => setV({ ...v, occurredAt: d || today })} label={tr('تاریخ پیگیری')} /></Field>
      <Field label={tr('با چه کسی؟')}>
        <Select value={v.contactId} onChange={(e) => setV({ ...v, contactId: e.target.value })} aria-label={tr('مخاطب پیگیری')}>
          <option value="">{tr('— هیچ —')}</option>
          {contacts.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}
        </Select>
      </Field>
      <Field label={tr('کجا؟')}><Input value={v.place} onChange={(e) => setV({ ...v, place: e.target.value })} placeholder={tr('مثلاً: دفتر مشتری')} aria-label={tr('محل جلسه')} /></Field>
      <div className="sm:col-span-2"><Field label={tr('خلاصهٔ گفت‌وگو')} required><Textarea value={v.summary} onChange={(e) => setV({ ...v, summary: e.target.value })} rows={3} aria-label={tr('خلاصهٔ گفت‌وگو')} /></Field></div>
      <Field label={tr('پیگیری بعدی چیست؟')}><Input value={v.nextStep} onChange={(e) => setV({ ...v, nextStep: e.target.value })} placeholder={tr('مثلاً: فرستادن نمونه‌کار')} aria-label={tr('پیگیری بعدی')} /></Field>
      <Field label={tr('تا کی؟')}><JalaliDateInput mode="date" value={v.nextStepDue || null} onChange={(d) => setV({ ...v, nextStepDue: d })} label={tr('تاریخ پیگیری بعدی')} /></Field>
      <div className="sm:col-span-2 flex justify-end"><Button variant="primary" loading={busy} disabled={v.summary.trim().length < 2} onClick={() => void save()}>{tr('ثبت پیگیری')}</Button></div>
    </div>
  );
}

/** A lead becomes a sale on its own road — contacted, qualified, converted — onto this same customer. */
function LeadToSale({ lead, companyId, customer, onDone }: { lead: LeadRow; companyId: string; customer: string; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { can } = useAuth();
  if (lead.state === 'QUALIFIED') {
    const convert = async () => {
      setBusy(true);
      try {
        await apiPost(`/leads/${lead.id}/convert`, { companyId, title: tr('فرصت — {0}', customer) });
        toast(tr('فرصت فروش ساخته شد. اکنون بریف را بنویسید.')); onDone();
      } catch (e: any) { toast(e?.message ?? tr('عملیات ناموفق بود.'), 'danger'); } finally { setBusy(false); }
    };
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-700">{tr('این مشتری واجد شرایط است. آن را فرصت فروش کنید تا بریفش را بنویسید.')}</p>
        {can('crm.lead.convert') && <Button variant="primary" loading={busy} onClick={() => void convert()}>{tr('تبدیل به فرصت فروش')}</Button>}
      </div>
    );
  }
  const move = forwardMove(lead.availableTransitions);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-ink-700">
        {lead.state === 'NEW' ? tr('گام بعد: اعلام کنید که با این مشتری تماس گرفته‌اید.')
          : tr('اگر مشتری جدی است و نیاز و بودجه دارد، آن را واجد شرایط اعلام کنید.')}
      </p>
      {move && <WorkflowActions minimal entity="lead" id={lead.id} transitions={[move]} onDone={onDone} />}
    </div>
  );
}

/** The brief, step by step: what for, for whom, what is to be made, how much, by when, by which units. */
function NewBrief({ opportunityId, customer, onDone }: { opportunityId: string; customer: string; onDone: () => void }) {
  const [v, setV] = useState({ title: tr('بریف — {0}', customer), businessObjective: '', targetAudience: '', scope: '', expectedDeliverables: '', budgetRange: '', desiredDeadline: '' });
  const [units, setUnits] = useState<DepartmentCode[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (k: keyof typeof v, value: string) => setV((x) => ({ ...x, [k]: value }));
  const save = async () => {
    setBusy(true);
    try {
      await apiPost('/briefs', {
        opportunityId, title: v.title.trim(), businessObjective: v.businessObjective.trim() || undefined, targetAudience: v.targetAudience.trim() || undefined,
        scope: v.scope.trim() || undefined, expectedDeliverables: v.expectedDeliverables.trim() || undefined,
        budgetRange: v.budgetRange ? Number(v.budgetRange) : undefined, desiredDeadline: v.desiredDeadline || undefined, unitsNeeded: units,
      });
      toast(tr('بریف ذخیره شد. هر وقت کامل شد، آن را بفرستید.')); onDone();
    } catch (e: any) { toast(e?.message ?? tr('ذخیره ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  const units_ = DEPARTMENT_CODES.filter((d) => !['M', 'OP', 'FI', 'LG', 'A', 'S'].includes(d));
  return (
    <div className="mt-3 grid gap-3 rounded-lg bg-ink-50/60 p-3 sm:grid-cols-2" data-testid="new-brief">
      <div className="sm:col-span-2"><Field label={tr('عنوان بریف')} required><Input value={v.title} onChange={(e) => set('title', e.target.value)} aria-label={tr('عنوان بریف')} /></Field></div>
      <Field label={tr('مشتری چه می‌خواهد به دست آورد؟')} hint={tr('هدف کسب‌وکار؛ مثلاً: معرفی محصول تازه به جوانان')}><Textarea value={v.businessObjective} onChange={(e) => set('businessObjective', e.target.value)} rows={2} aria-label={tr('هدف کسب‌وکار')} /></Field>
      <Field label={tr('برای چه کسانی؟')} hint={tr('مخاطب هدف')}><Textarea value={v.targetAudience} onChange={(e) => set('targetAudience', e.target.value)} rows={2} aria-label={tr('مخاطب هدف')} /></Field>
      <Field label={tr('چه کاری باید انجام شود؟')} hint={tr('محدودهٔ کار')}><Textarea value={v.scope} onChange={(e) => set('scope', e.target.value)} rows={2} aria-label={tr('محدودهٔ کار')} /></Field>
      <Field label={tr('چه چیزهایی تحویل داده می‌شود؟')} hint={tr('مثلاً: لوگو، تیزر ۳۰ ثانیه‌ای، بیلبورد')}><Textarea value={v.expectedDeliverables} onChange={(e) => set('expectedDeliverables', e.target.value)} rows={2} aria-label={tr('خروجی‌های مورد انتظار')} /></Field>
      <Field label={tr('بودجه (ریال)')}><Input type="number" inputMode="decimal" value={v.budgetRange} onChange={(e) => set('budgetRange', e.target.value)} className="ltr" aria-label={tr('بودجه')} /></Field>
      <Field label={tr('تا کی؟')}><JalaliDateInput mode="date" value={v.desiredDeadline || null} onChange={(d) => set('desiredDeadline', d)} label={tr('مهلت مطلوب')} /></Field>
      <div className="sm:col-span-2">
        <fieldset>
          <legend className="mb-1 text-xs font-bold text-ink-700">{tr('کدام واحدها لازم‌اند؟')}</legend>
          <div className="flex flex-wrap gap-3">
            {units_.map((d) => <Checkbox key={d} label={isEnglish() ? DEPARTMENT_LABELS[d].en : DEPARTMENT_LABELS[d].fa} checked={units.includes(d)} onChange={(e) => setUnits(e.target.checked ? [...units, d] : units.filter((x) => x !== d))} />)}
          </div>
        </fieldset>
      </div>
      <div className="sm:col-span-2 flex justify-end"><Button variant="primary" loading={busy} disabled={v.title.trim().length < 2} onClick={() => void save()}>{tr('ذخیرهٔ بریف')}</Button></div>
    </div>
  );
}

/** Send it, and say plainly where it went and what happens next. */
function SendBrief({ brief, onDone }: { brief: BriefRow; onDone: () => void }) {
  const stage = stageOf(brief.state, 'brief');
  const move = forwardMove(brief.availableTransitions);
  if (brief.state === 'APPROVED') return <p className="text-sm text-emerald-700">{tr('بریف تأیید شد. کار به اکانت رسید و از اینجا ادامه می‌یابد.')} <Link to={`/briefs/${brief.id}`} className="underline">{tr('دیدن بریف')} {flow()}</Link></p>;
  if (stage === 'waiting') return <p className="text-sm text-ink-700">{tr('بریف فرستاده شد و منتظر بررسی اکانت است. اگر ناقص باشد، با توضیح به شما برمی‌گردد.')}</p>;
  return (
    <div className="space-y-2">
      {stage === 'returned' && <ReturnNote entity="brief" id={brief.id} state={brief.state} />}
      <p className="text-sm text-ink-700">{stage === 'returned'
        ? tr('بریف برای تکمیل برگشته است. آن را باز کنید، کامل کنید، و دوباره بفرستید.')
        : tr('وقتی بریف کامل شد، آن را بفرستید. با فرستادن، اکانت آن را بررسی می‌کند.')}</p>
      <div className="flex flex-wrap gap-2">
        <Link to={`/briefs/${brief.id}`}><Button variant="secondary">{tr('باز کردن و تکمیل بریف')}</Button></Link>
        {move && <WorkflowActions minimal entity="brief" id={brief.id} transitions={[move]} onDone={onDone} />}
      </div>
    </div>
  );
}

/** «مسیر فروش» on a customer's page. */
export function JourneyLink({ companyId }: { companyId: string }) {
  return <Link to={`/sales/journey/${companyId}`}><Button variant="primary">{tr('مسیر فروش')}</Button></Link>;
}
