import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { PageBody, PageHeader } from '../components/Shell';
import {
  Badge, Button, Card, EmptyState, Field, LoadingBlock, Select, Spinner,
  Textarea, IconSpark, IconAlert,
} from '../components/ui';
import { loc, tr } from '../i18n';

interface AiStatus {
  enabled: boolean; model: string | null; canUse: boolean; ruleEngineAlwaysAvailable: boolean;
  capabilities: { code: string; labelFa: string; requires: string }[];
}

interface AiResult {
  capability: string; modelUsed: boolean; model: string | null;
  findings: { severity: 'INFO' | 'WARNING' | 'CRITICAL'; labelFa: string; detailFa: string }[];
  grounding: { entity: string; id: string; label: string }[];
  narrative: string | null; disabledReason?: string;
}

/** Entity picker source per capability — the assistant only reads what the user can already open. */
const ENTITY_SOURCE: Record<string, { path: string; label: (r: any) => string } | null> = {
  BRIEF_ANALYSIS: { path: '/briefs', label: (r) => `${r.title} (${r.code})` },
  PROJECT_SUMMARY: { path: '/projects', label: (r) => `${r.name} (${r.code})` },
  RISK_DETECTION: { path: '/projects', label: (r) => `${r.name} (${r.code})` },
  STATUS_REPORT_DRAFT: { path: '/projects', label: (r) => `${r.name} (${r.code})` },
  NEXT_BEST_ACTION: { path: '/projects', label: (r) => `${r.name} (${r.code})` },
  CHANGE_IMPACT_ANALYSIS: { path: '/change-requests', label: (r) => `${r.title} (${r.code})` },
  QC_COMPARISON: { path: '/deliverables', label: (r) => `${r.name} (${r.code})` },
  CUSTOMER_HEALTH: { path: '/companies', label: (r) => r.legalName },
  FREE_QUERY: null,
};

export default function Assistant() {
  const [capability, setCapability] = useState('PROJECT_SUMMARY');
  const [entityId, setEntityId] = useState('');
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AiResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: status, isLoading } = useQuery<AiStatus>({
    queryKey: ['/ai/status'], queryFn: () => apiGet('/ai/status'),
  });

  const source = ENTITY_SOURCE[capability];
  const { data: entities } = useQuery<{ items: any[] }>({
    queryKey: [source?.path, 'ai-picker'],
    queryFn: () => apiGet(source!.path, { pageSize: 100 }),
    enabled: !!source,
  });

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await apiPost<AiResult>('/ai/ask', {
        capability,
        entityId: entityId || undefined,
        question: question.trim() || undefined,
      }));
    } catch (e: any) {
      setError(e?.message ?? tr('اجرای تحلیل ناموفق بود.'));
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) return <LoadingBlock />;

  return (
    <>
      <PageHeader
        title={tr('دستیار هوشمند')}
        subtitle={tr('تحلیل مبتنی بر داده‌های سیستم — در چارچوب دسترسی‌های شما و با ثبت کامل در گزارش حسابرسی')}
        badge={status?.enabled
          ? <Badge tone="success">{tr('مدل فعال: {0}', status.model)}</Badge>
          : <Badge tone="warning">{tr('موتور قاعده‌محور')}</Badge>}
      />
      <PageBody className="space-y-5">
        {!status?.enabled && (
          <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
            <strong className="font-semibold">{tr('مدل زبانی پیکربندی نشده است.')}{' '}</strong>{tr('تحلیل‌های قاعده‌محور (تشخیص نقض قوانین، بریف ناقص، ریسک تأخیر، ارزیابی ناقص تغییر) همچنان کار می‌کنند و کاملاً قطعی و قابل استناد هستند. برای افزودن تحلیل متنی، کلید ANTHROPIC_API_KEY را در تنظیمات سرور قرار دهید.')}</div>
        )}

        <div className="grid gap-5 lg:grid-cols-3">
          <Card title={tr('تعریف تحلیل')} className="lg:col-span-1">
            <div className="space-y-4 p-4">
              <Field label={tr('نوع تحلیل')} required>
                <Select value={capability} onChange={(e) => { setCapability(e.target.value); setEntityId(''); setResult(null); }}>
                  {status?.capabilities.map((c) => <option key={c.code} value={c.code}>{loc(c, 'label')}</option>)}
                </Select>
              </Field>

              {source && (
                <Field label={tr('موضوع تحلیل')} required>
                  <Select value={entityId} onChange={(e) => setEntityId(e.target.value)}>
                    <option value="">{tr('— انتخاب —')}</option>
                    {entities?.items.map((r) => <option key={r.id} value={r.id}>{source.label(r)}</option>)}
                  </Select>
                </Field>
              )}

              <Field label={tr('پرسش تکمیلی')} hint={tr('اختیاری — تنها در صورت فعال بودن مدل زبانی استفاده می‌شود.')}>
                <Textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={3} />
              </Field>

              <Button
                variant="primary" className="w-full" loading={busy}
                disabled={!!source && !entityId}
                onClick={() => void run()}
              >
                <IconSpark className="size-4" />{' '}{tr('اجرای تحلیل')}</Button>
            </div>
          </Card>

          <div className="space-y-5 lg:col-span-2">
            {busy && (
              <Card><div className="flex items-center justify-center gap-2 py-12 text-sm text-ink-500"><Spinner className="size-4" />{' '}{tr('در حال تحلیل…')}</div></Card>
            )}

            {error && (
              <div className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-inset ring-rose-200">{error}</div>
            )}

            {!busy && !result && !error && (
              <Card>
                <EmptyState
                  icon={<IconSpark className="size-10" />}
                  title={tr('تحلیلی اجرا نشده')}
                  description={tr('یک نوع تحلیل و موضوع آن را انتخاب کنید. تمام یافته‌ها بر پایه داده‌های واقعی سیستم و در محدوده دسترسی شما تولید می‌شوند.')}
                />
              </Card>
            )}

            {result && (
              <>
                <Card
                  title={tr('یافته‌های قاعده‌محور')}
                  subtitle={tr('قطعی و مستقیماً از داده‌های سیستم استخراج شده — بدون اتکا به مدل زبانی')}
                  action={<Badge tone="neutral">{tr('{0} یافته', result.findings.length)}</Badge>}
                >
                  {!result.findings.length ? (
                    <EmptyState title={tr('موردی یافت نشد')} description={tr('هیچ نقض قانون یا ریسک قابل تشخیصی وجود ندارد.')} />
                  ) : (
                    <ul className="divide-y divide-ink-100">
                      {result.findings.map((f, i) => (
                        <li key={i} className="flex items-start gap-3 px-4 py-3">
                          <IconAlert className={`mt-0.5 size-4 shrink-0 ${
                            f.severity === 'CRITICAL' ? 'text-rose-700'
                            : f.severity === 'WARNING' ? 'text-amber-700' : 'text-sky-700'}`} />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-medium text-ink-800">{loc(f, 'label')}</p>
                              <Badge tone={f.severity === 'CRITICAL' ? 'danger' : f.severity === 'WARNING' ? 'warning' : 'info'}>
                                {f.severity === 'CRITICAL' ? tr('بحرانی') : f.severity === 'WARNING' ? tr('هشدار') : tr('اطلاع')}
                              </Badge>
                            </div>
                            <p className="mt-1 text-sm text-ink-600">{loc(f, 'detail')}</p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                {result.narrative && (
                  <Card title={tr('تحلیل متنی')} subtitle={tr('تولیدشده توسط {0}', result.model)}>
                    <p className="whitespace-pre-wrap px-4 py-3 text-sm leading-7 text-ink-700">{result.narrative}</p>
                  </Card>
                )}

                {result.disabledReason && !result.narrative && (
                  <div className="rounded-lg bg-ink-100 px-4 py-3 text-xs text-ink-600">{result.disabledReason}</div>
                )}

                {!!result.grounding.length && (
                  <Card title={tr('مستندات پشتیبان')} subtitle={tr('داده‌هایی که تحلیل بر پایه آن‌ها انجام شده')}>
                    <ul className="flex flex-wrap gap-2 p-4">
                      {result.grounding.map((g) => (
                        <li key={g.id}>
                          <Badge tone="neutral">{g.entity} — {g.label}</Badge>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </>
            )}
          </div>
        </div>
      </PageBody>
    </>
  );
}
