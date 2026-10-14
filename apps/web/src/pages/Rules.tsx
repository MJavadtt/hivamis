import { useState } from 'react';
import { OVERSIGHT_NOTICE } from '@hiva/contracts';
import { PageBody, PageHeader } from '../components/Shell';
import { Card, Tabs } from '../components/ui';
import { CodeRules, OrgRules } from '../components/OrgRules';
import { isEnglish, tr } from '../i18n';

/**
 * The rules on the workflows, open to everyone (roadmap #47): the people a rule stops should be
 * able to read it. Only `rules.manage` writes the organisation's own. Beside them, how the system
 * itself may be used — what everyone should know before they write in it (audit F-5).
 */
export default function Rules() {
  const [tab, setTab] = useState('org');
  return (
    <>
      <PageHeader title={tr('قوانین سازمان')} subtitle={tr('قوانینی که بر گردش کار حاکم است — از Doc_H، از افزونه‌های نصب‌شده، و آنچه سازمان خودش نوشته')} />
      <div className="mx-3 mt-3 rounded-xl bg-surface px-2 shadow-sm ring-1 ring-edge sm:mx-5 lg:mx-0 [&>[role=tablist]]:border-b-0">
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'org', label: tr('قوانین سازمان') }, { key: 'code', label: tr('Doc_H و افزونه‌ها') }, { key: 'use', label: tr('سیاست استفاده') },
        ]} />
      </div>
      <PageBody>
        {tab === 'org' ? <OrgRules /> : tab === 'code' ? <CodeRules /> : <UsagePolicy />}
      </PageBody>
    </>
  );
}

function UsagePolicy() {
  return (
    <Card title={tr('سیاست استفاده از سامانه')}>
      <ul className="list-disc space-y-2 px-8 py-4 text-sm leading-7 text-ink-800" data-testid="usage-policy">
        <li>{tr('هر کار در سامانه به نام کسی ثبت می‌شود که آن را انجام داده است؛ رمز خود را به کسی ندهید و برای سپردن کار، «تفویض اختیار» را به کار ببرید.')}</li>
        <li>{tr('دستیار فقط همان چیزی را می‌بیند که شما می‌بینید و بی‌تأیید شما چیزی را تغییر نمی‌دهد.')}</li>
        {/* The owner's words (the fix prompt's ⛔ ASK for F-5, answered 2026-10-14). */}
        <li data-testid="oversight-notice">{isEnglish() ? OVERSIGHT_NOTICE.en : OVERSIGHT_NOTICE.fa}</li>
      </ul>
    </Card>
  );
}
