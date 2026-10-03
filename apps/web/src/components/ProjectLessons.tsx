import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction } from '../hooks/queries';
import { Badge, Button, Card, EmptyState, Field, Textarea, cx } from './ui';
import { Code } from './common';
import { formatDateTime, localDigits } from '../lib/format';
import { loc, tr, trx } from '../i18n';

interface Lesson {
  lessonId: string; titleFa: string; category: string | null; recommendation: string | null;
  snippetFa: string; score: number; whyFa: string[];
  fromProject: { id: string; code: string; name: string } | null;
  companyName: string | null;
  review: { decision: string; note: string | null; reviewedAt: string; reviewedBy: string | null } | null;
}
interface Payload {
  project: { id: string; code: string; name: string; state: string };
  lessons: Lesson[]; reviewed: number; usedService: boolean; noteFa: string | null;
}

/**
 * What the organisation already learned that bears on this project (roadmap #44).
 *
 * Doc_H has made lessons mandatory at closure for years, and nobody reads them — finding the
 * relevant one means remembering it exists. This asks on the team's behalf, at the point where
 * the answer can still change how the project is run, and records what they did with each one:
 * applied, or set aside with a reason. That record is the difference between learning and
 * archiving.
 */
export function ProjectLessons({ projectId }: { projectId: string }) {
  const { can } = useAuth();
  const [showReviewed, setShowReviewed] = useState(false);
  const [deciding, setDeciding] = useState<{ lesson: Lesson; decision: 'APPLIED' | 'NOT_RELEVANT' } | null>(null);
  const [note, setNote] = useState('');
  const qc = useQueryClient();

  const { data } = useQuery<Payload>({
    queryKey: ['/projects', projectId, 'lessons', showReviewed],
    queryFn: () => apiGet(`/projects/${projectId}/lessons`, { limit: '6', ...(showReviewed ? { includeReviewed: 'true' } : {}) }),
  });

  const review = useAction(
    (input: { lessonId: string; decision: string; note: string }) =>
      apiPost(`/projects/${projectId}/lessons/${input.lessonId}/review`, { decision: input.decision, note: input.note || undefined }),
    tr('ثبت شد — این درس در کارنامهٔ پروژه ماند.'),
  );

  if (!data) return null;
  const mayReview = can('project.plan');

  return (
    <Card
      title={tr('از پروژه‌های گذشته')}
      subtitle={tr('درس‌های آموخته‌ای که به این پروژه می‌خورند — بر پایهٔ شرح پروژه، همان مشتری و همان واحدها')}
      action={
        <div className="flex items-center gap-2">
          {data.reviewed > 0 && <Badge tone="success">{tr('{0} درس بررسی‌شده', localDigits(data.reviewed))}</Badge>}
          <Button size="sm" variant="ghost" onClick={() => setShowReviewed((v) => !v)}>
            {showReviewed ? tr('فقط بررسی‌نشده‌ها') : tr('نمایش بررسی‌شده‌ها')}
          </Button>
        </div>
      }
    >
      {!data.lessons.length ? (
        <EmptyState
          title={trx(data.noteFa ?? tr('درس بررسی‌نشده‌ای نمانده'))}
          description={data.reviewed > 0 ? tr('{0} درس گذشته برای این پروژه بررسی شده است.', localDigits(data.reviewed)) : undefined}
        />
      ) : (
        <ul className="divide-y divide-ink-100" data-testid="project-lessons">
          {data.lessons.map((l) => (
            <li key={l.lessonId} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink-800">{loc(l, 'title')}</span>
                {l.category && <Badge tone="neutral">{l.category}</Badge>}
                {l.review && (
                  <Badge tone={l.review.decision === 'APPLIED' ? 'success' : 'neutral'}>
                    {l.review.decision === 'APPLIED' ? tr('به‌کار گرفته شد') : tr('مرتبط نبود')}
                  </Badge>
                )}
                <span className="ms-auto nums text-[11px] text-ink-400">{tr('{0}٪ مرتبط', localDigits(Math.round(l.score * 100)))}</span>
              </div>
              {l.fromProject && (
                <p className="mt-0.5 text-[11px] text-ink-500">{tr('از')}{' '}<Link to={`/projects/${l.fromProject.id}`} className="text-brand-600 hover:underline">{l.fromProject.name}</Link>
                  {' '}<Code>{l.fromProject.code}</Code>{l.companyName ? ` — ${l.companyName}` : ''}
                </p>
              )}
              <p className="mt-1 text-xs leading-6 text-ink-700">{trx(l.recommendation || l.snippetFa)}</p>
              <ul className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-ink-400">
                {l.whyFa.map((w, i) => <li key={i}>· {w}</li>)}
              </ul>
              {l.review?.note && (
                <p className="mt-1 text-[11px] text-ink-500">{tr('یادداشت {0} در {1}: {2}', l.review.reviewedBy ?? '', formatDateTime(l.review.reviewedAt), l.review.note)}</p>
              )}
              {mayReview && !l.review && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => { setDeciding({ lesson: l, decision: 'APPLIED' }); setNote(''); }}>{tr('در این پروژه به‌کار می‌گیریم')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setDeciding({ lesson: l, decision: 'NOT_RELEVANT' }); setNote(''); }}>{tr('مرتبط نیست')}</Button>
                </div>
              )}
              {deciding?.lesson.lessonId === l.lessonId && (
                <div className={cx('mt-2 rounded-lg bg-ink-50/70 p-3')} data-testid="lesson-decision">
                  <Field
                    label={tr('یادداشت')}
                    required={deciding.decision === 'NOT_RELEVANT'}
                    hint={deciding.decision === 'APPLIED'
                      ? tr('اختیاری — اینکه دقیقاً چه چیزی را تغییر دادید، برای پروژهٔ بعدی می‌ماند.')
                      : tr('برای «مرتبط نیست» دلیل لازم است؛ قضاوتی که دلیلش نوشته نشود، به کسی چیزی یاد نمی‌دهد.')}
                  >
                    <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} aria-label={tr('یادداشت')} autoFocus />
                  </Field>
                  <div className="mt-2 flex gap-1.5">
                    <Button size="sm" variant="primary" loading={review.isPending}
                      disabled={deciding.decision === 'NOT_RELEVANT' && note.trim().length < 3}
                      onClick={() => review.mutate(
                        { lessonId: l.lessonId, decision: deciding.decision, note: note.trim() },
                        { onSuccess: () => { setDeciding(null); void qc.invalidateQueries({ queryKey: ['/projects', projectId, 'lessons'] }); } },
                      )}>{tr('ثبت')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeciding(null)}>{tr('انصراف')}</Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {!data.usedService && data.lessons.length > 0 && (
        <p className="border-t border-ink-100 px-4 py-2 text-[11px] text-ink-400">{tr('سرویس embedding پیکربندی نشده — این فهرست بیشتر بر پایهٔ واژه‌های مشترک است تا معنا.')}</p>
      )}
    </Card>
  );
}
