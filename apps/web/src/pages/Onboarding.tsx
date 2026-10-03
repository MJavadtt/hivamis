import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { PageBody, PageHeader } from '../components/Shell';
import { Badge } from '../components/ui';
import { CalendarStep, ImportPanel, PendingActivations, SlaStep, UnitMapStep } from '../components/Onboarding';
import { formatDateTime, localDigits } from '../lib/format';
import { loc, tr } from '../i18n';

interface Status {
  steps: { step: string; labelFa: string; done: boolean; detailFa: string; confirmed: { at: string } | null }[];
  done: number; total: number; pendingActivations: number;
}

/**
 * Getting an organisation started (roadmap #48): six steps, each read from the data — what is
 * there, what is not — and the two that are a judgement confirmed by a person.
 */
export default function Onboarding() {
  const qc = useQueryClient();
  const { data } = useQuery<Status>({ queryKey: ['/onboarding'], queryFn: () => apiGet('/onboarding') });
  const [step, setStep] = useState('units');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['/onboarding'] });
  return (
    <>
      <PageHeader title={tr('راه‌اندازی سازمان')} subtitle={tr('ساختار سازمانی، کاربران، تقویم و مهلت‌ها، مشتریان و پروژه‌های در جریان — از فایل‌هایی که همین حالا دارید')}
        badge={data && <Badge tone={data.done === data.total ? 'success' : 'info'}>{tr('{0} از {1} گام', localDigits(data.done), localDigits(data.total))}</Badge>} />
      <PageBody className="space-y-5">
        <ol className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="onboarding-steps">
          {data?.steps.map((s, i) => (
            <li key={s.step}>
              <button type="button" onClick={() => setStep(s.step)}
                className={`h-full w-full rounded-lg border px-3 py-2 text-start text-xs ${step === s.step ? 'border-brand-500 bg-brand-50' : 'border-ink-200 bg-surface'}`}>
                <span className="flex items-center gap-1.5">
                  <span className={`grid size-5 place-items-center rounded-full text-[10px] text-white ${s.done ? 'bg-emerald-600' : 'bg-ink-300'}`}>{s.done ? '✓' : localDigits(i + 1)}</span>
                  <span className="font-medium text-ink-800">{loc(s, 'label')}</span>
                </span>
                <span className="mt-1 block text-[11px] text-ink-500">{loc(s, 'detail')}</span>
                {s.confirmed && <span className="mt-0.5 block text-[10px] text-emerald-700">{tr('تأیید شد {0}', formatDateTime(s.confirmed.at))}</span>}
              </button>
            </li>
          ))}
        </ol>
        {step === 'units' && <UnitMapStep onChanged={refresh} />}
        {step === 'users' && <div className="space-y-5"><ImportPanel kind="users" onDone={refresh} /><PendingActivations /></div>}
        {step === 'calendar' && <CalendarStep onChanged={refresh} />}
        {step === 'sla' && <SlaStep onChanged={refresh} />}
        {step === 'companies' && <div className="space-y-5"><ImportPanel kind="companies" onDone={refresh} /><ImportPanel kind="contacts" onDone={refresh} /></div>}
        {step === 'projects' && <ImportPanel kind="projects" onDone={refresh} />}
      </PageBody>
    </>
  );
}
