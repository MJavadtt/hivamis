import { useState } from 'react';
import { PageBody, PageHeader } from '../components/Shell';
import { Tabs } from '../components/ui';
import { CodeRules, OrgRules } from '../components/OrgRules';
import { tr } from '../i18n';

/**
 * The rules on the workflows, open to everyone (roadmap #47): the people a rule stops should be
 * able to read it. Only `rules.manage` writes the organisation's own.
 */
export default function Rules() {
  const [tab, setTab] = useState('org');
  return (
    <>
      <PageHeader title={tr('قوانین سازمان')} subtitle={tr('قوانینی که بر گردش کار حاکم است — از Doc_H، از افزونه‌های نصب‌شده، و آنچه سازمان خودش نوشته')} />
      <div className="border-b border-ink-200 bg-surface px-2">
        <Tabs active={tab} onChange={setTab} tabs={[{ key: 'org', label: tr('قوانین سازمان') }, { key: 'code', label: tr('Doc_H و افزونه‌ها') }]} />
      </div>
      <PageBody>
        {tab === 'org' ? <OrgRules /> : <CodeRules />}
      </PageBody>
    </>
  );
}
