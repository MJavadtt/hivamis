import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { Code } from './common';
import { Badge, Button, Card, EmptyState } from './ui';
import { formatDateTime, localDigits } from '../lib/format';
import { tr, trx } from '../i18n';

interface Version { id: string; kind: string; version: number; hash: string; effectiveFrom: string; note: string | null }
interface Listing { kinds: Record<string, string>; versions: Version[]; current: Record<string, string | null> }

/**
 * The rules as they have stood over time. Every transition names the version that allowed it;
 * this is where an auditor reads what that version said, and what changed since.
 */
export function RuleVersions() {
  const { data } = useQuery<Listing>({ queryKey: ['/rules/versions'], queryFn: () => apiGet('/rules/versions') });
  if (!data) return null;
  return (
    <div className="space-y-5" data-testid="rule-versions">
      {Object.entries(data.kinds).map(([kind, label]) => {
        const rows = data.versions.filter((v) => v.kind === kind);
        return (
          <Card key={kind} title={trx(label)} subtitle={rows.length ? tr('{0} نسخه — نسخهٔ جاری {1}', localDigits(rows.length), localDigits(rows[0]!.version)) : undefined}>
            {!rows.length ? <EmptyState title={tr('نسخه‌ای ثبت نشده')} /> : (
              <ul className="divide-y divide-ink-100">
                {rows.map((v, i) => <Row key={v.id} v={v} current={data.current[kind] === v.id} previous={rows[i + 1]} />)}
              </ul>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function Row({ v, current, previous }: { v: Version; current: boolean; previous?: Version }) {
  const [open, setOpen] = useState(false);
  const { data } = useQuery<{ changes: string[] }>({
    queryKey: ['/rules/diff', v.kind, v.version],
    queryFn: () => apiGet('/rules/diff', { kind: v.kind, from: String(previous!.version), to: String(v.version) }),
    enabled: open && !!previous,
  });
  return (
    <li className="px-4 py-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink-800">{tr('نسخهٔ {0}', localDigits(v.version))}</span>
        {current && <Badge tone="success">{tr('جاری')}</Badge>}
        <span className="text-ink-500">{tr('از {0}', formatDateTime(v.effectiveFrom))}</span>
        <Code>{v.hash.slice(0, 10)}</Code>
        {v.note && <span className="text-ink-600">— {v.note}</span>}
        {previous && <Button size="sm" variant="ghost" className="ms-auto" onClick={() => setOpen(!open)}>{open ? tr('بستن') : tr('تغییرات نسبت به نسخهٔ قبل')}</Button>}
      </div>
      {open && data && (
        <ul className="mt-2 space-y-0.5 rounded-lg bg-ink-50/60 p-2 text-ink-700" data-testid="rule-diff">
          {data.changes.length ? data.changes.map((c, i) => <li key={i}>• {c}</li>) : <li>{tr('تفاوتی در ساختار ثبت نشده')}</li>}
        </ul>
      )}
    </li>
  );
}
