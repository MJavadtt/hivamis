import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiPost } from '../lib/api';
import { Badge, Button } from './ui';
import { formatRelative } from '../lib/format';
import { loc, tr } from '../i18n';

interface Finding { check: string; severity: 'FAIL' | 'WARN' | 'INFO'; messageFa: string; fileName?: string }
interface Result {
  verdict: 'PASS' | 'WARN' | 'FAIL';
  findings: Finding[];
  checkedFa: string[];
  notCheckedFa: string[];
  archived?: { name: string }[];
}
const TONE = { PASS: 'success', WARN: 'warning', FAIL: 'danger' } as const;
const VERDICT_FA = { PASS: tr('بدون ایراد مکانیکی'), WARN: tr('با هشدار'), FAIL: tr('ایراد قطعی') } as const;
/** The verdict as a badge says it, for screens that show only the verdict (the phone, #49). */
export const STAGE_ZERO_VERDICT = { tone: TONE, fa: VERDICT_FA };
const SEV = { FAIL: 'text-rose-700', WARN: 'text-amber-700', INFO: 'text-ink-500' } as const;

/**
 * QC stage zero, where the reviewer works (roadmap #22): what the machine already checked, what
 * it found, and — as prominently — what it could not check, so a pass is never read as a review.
 * The unit can run it before handing over; Account sees the stored result before opening a file.
 */
export function StageZero({ deliverable }: {
  deliverable: { id: string; stageZeroVerdict?: string | null; stageZeroAt?: string | null; stageZeroFindings?: Result | null };
}) {
  const [live, setLive] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const result = live ?? deliverable.stageZeroFindings ?? null;

  const run = async () => {
    setBusy(true);
    try {
      setLive(await apiPost<Result>(`/deliverables/${deliverable.id}/stage-zero`));
      void qc.invalidateQueries({ queryKey: ['/qc/queue'] });
    } finally { setBusy(false); }
  };

  return (
    <div className="text-[12.5px]" data-testid="stage-zero">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-ink-500">{tr('بررسی خودکار:')}</span>
        {result
          ? <Badge tone={TONE[result.verdict]}>{VERDICT_FA[result.verdict]}</Badge>
          : <span className="text-ink-400">{tr('اجرا نشده')}</span>}
        {!live && deliverable.stageZeroAt && <span className="text-ink-400">{formatRelative(deliverable.stageZeroAt)}</span>}
        <Button size="sm" variant="ghost" loading={busy} onClick={() => void run()}>{tr('بررسی دوباره')}</Button>
      </div>
      {result && result.findings.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {result.findings.map((f, i) => <li key={i} className={SEV[f.severity]}>· {loc(f, 'message')}</li>)}
        </ul>
      )}
      {result && (
        <details className="mt-1">
          <summary className="cursor-pointer text-ink-400">{tr('چه چیزهایی بررسی شد و چه چیزهایی نه')}</summary>
          <p className="mt-0.5 text-ink-500">{tr('بررسی‌شده: {0}', result.checkedFa.join(tr('، ')))}</p>
          {result.archived && result.archived.length > 0 && (
            <p className="text-ink-500">{tr('درون فایل فشرده: {0}', result.archived.map((a) => a.name).join(tr('، ')))}</p>
          )}
          <p className="text-ink-500">{tr('بررسی‌نشده: {0}', result.notCheckedFa.join(tr('؛ ')))}</p>
        </details>
      )}
    </div>
  );
}
