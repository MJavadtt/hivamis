import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction } from '../hooks/queries';
import { Code } from './common';
import { Badge, Button, Card, EmptyState, Select, StatTile } from './ui';
import { formatDate, toPersianDigits } from '../lib/format';

interface Row {
  taskId: string; code: string; title: string; state: string; assigneeName: string | null; departmentCode: string;
  estimateHours: number; estimateAssumed: boolean; earliestStart: string; earliestFinish: string; latestStart: string; latestFinish: string;
  floatHours: number; critical: boolean; dueDate: string | null; missesDueDate: boolean; prerequisites: string[]; done: boolean;
}
interface Schedule { projectId: string; start: string; plannedEnd: string | null; projectedEnd: string; slipHours: number | null; criticalPath: string[]; tasks: Row[]; cycles: string[][] }

const DAY = 86_400_000;
const h = (n: number) => `${toPersianDigits(Math.round(n * 10) / 10)} س`;

/**
 * Every task as a bar from its earliest start to its earliest finish, with its float drawn as
 * the lighter stretch it could slide into. Red is the critical chain: slip one of those and the
 * project's end moves. Nothing else here is as important as that colour.
 */
export function Gantt({ projectId }: { projectId: string }) {
  const { can } = useAuth();
  const { data, refetch } = useQuery<Schedule>({ queryKey: ['/projects', projectId, 'schedule'], queryFn: () => apiGet(`/projects/${projectId}/schedule`) });
  const [linking, setLinking] = useState<{ task: string; pre: string }>({ task: '', pre: '' });
  const link = useAction(() => apiPost(`/tasks/${linking.task}/dependencies`, { prerequisiteId: linking.pre }), 'وابستگی ثبت شد.');
  const unlink = useAction((p: { task: string; pre: string }) => apiDelete(`/tasks/${p.task}/dependencies/${p.pre}`), 'وابستگی حذف شد.');
  if (!data) return null;
  if (!data.tasks.length) return <Card title="زمان‌بندی"><EmptyState title="وظیفه‌ای برای زمان‌بندی نیست" /></Card>;

  const t0 = Math.min(new Date(data.start).getTime(), ...data.tasks.map((t) => new Date(t.earliestStart).getTime()));
  const t1 = Math.max(new Date(data.projectedEnd).getTime(), data.plannedEnd ? new Date(data.plannedEnd).getTime() : 0, ...data.tasks.map((t) => new Date(t.latestFinish).getTime()));
  const days = Math.max(1, Math.ceil((t1 - t0) / DAY) + 1);
  const LEFT = 0, COL = 34, ROW = 34, TOP = 28;
  const W = LEFT + days * COL, H = TOP + data.tasks.length * ROW + 10;
  const x = (iso: string) => LEFT + ((new Date(iso).getTime() - t0) / DAY) * COL;
  const byId = new Map(data.tasks.map((t, i) => [t.taskId, { t, i }]));
  const bar = (t: Row) => (t.done ? '#10b981' : t.critical ? '#e11d48' : t.missesDueDate ? '#d97706' : '#3b82f6');

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="پایان برنامه‌ریزی‌شده" value={data.plannedEnd ? formatDate(data.plannedEnd) : '—'} />
        <StatTile label="پایان پیش‌بینی‌شده" value={formatDate(data.projectedEnd)} tone={data.slipHours != null && data.slipHours > 0 ? 'danger' : 'success'}
          hint={data.slipHours == null ? 'برنامه‌ای ثبت نشده' : data.slipHours > 0 ? `${h(data.slipHours)} کاری دیرتر از برنامه` : `${h(-data.slipHours)} کاری زودتر از برنامه`} />
        <StatTile label="مسیر بحرانی" value={toPersianDigits(data.criticalPath.length)} hint="وظیفه‌ای که یک ساعت تأخیرش پایان پروژه را جابه‌جا می‌کند" tone={data.criticalPath.length ? 'warning' : 'neutral'} />
        <StatTile label="از موعد خود می‌گذرد" value={toPersianDigits(data.tasks.filter((t) => t.missesDueDate).length)} tone={data.tasks.some((t) => t.missesDueDate) ? 'danger' : 'success'} />
      </div>
      {data.cycles.length > 0 && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">وابستگی‌های حلقوی: {data.cycles[0]!.map((id) => byId.get(id)?.t.code ?? id).join('، ')} — این وظایف زمان‌بندی نشدند.</p>}

      <Card title="نمودار گانت و مسیر بحرانی" subtitle="قرمز: بحرانی — یک ساعت تأخیر، پایان پروژه را جابه‌جا می‌کند · ناحیهٔ کم‌رنگ: شناوری · نارنجی: از موعد خود می‌گذرد · سبز: انجام‌شده">
        <div className="grid grid-cols-[minmax(12rem,16rem)_1fr]" dir="rtl">
          <ul className="divide-y divide-ink-100 border-e border-ink-100" style={{ paddingTop: TOP }}>
            {data.tasks.map((t) => (
              <li key={t.taskId} className="flex items-center gap-2 px-3 text-xs" style={{ height: ROW }}>
                <span className={`inline-block size-2 shrink-0 rounded-full`} style={{ background: bar(t) }} />
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <Code>{t.code.slice(-6)}</Code>
                {!t.done && <span className="nums shrink-0 text-ink-500" title="شناوری">{h(t.floatHours)}</span>}
              </li>
            ))}
          </ul>
          <div className="overflow-x-auto" dir="ltr">
            <svg width={W} height={H} role="img" aria-label="نمودار گانت" data-testid="gantt">
              {Array.from({ length: days }, (_, i) => {
                const d = new Date(t0 + i * DAY);
                const weekend = [4, 5].includes(d.getDay());
                return (
                  <g key={i}>
                    <rect x={LEFT + i * COL} y={TOP} width={COL} height={H - TOP} fill={weekend ? '#f1f5f9' : i % 2 ? '#fafafa' : '#ffffff'} />
                    <text x={LEFT + i * COL + COL / 2} y={16} fontSize="9" textAnchor="middle" fill="#64748b">{formatDate(d).slice(5)}</text>
                  </g>
                );
              })}
              {data.tasks.map((t, i) => {
                const y = TOP + i * ROW + 8;
                const es = x(t.earliestStart), ef = Math.max(x(t.earliestFinish), es + 3), lf = x(t.latestFinish);
                return (
                  <g key={t.taskId} data-testid="gantt-bar" data-critical={t.critical}>
                    {!t.done && lf > ef && <rect x={ef} y={y + 5} width={lf - ef} height={ROW - 26} fill={bar(t)} opacity={0.18} rx={3} />}
                    <rect x={es} y={y} width={ef - es} height={ROW - 16} fill={bar(t)} rx={4} opacity={t.estimateAssumed ? 0.55 : 1} />
                    {t.dueDate && <line x1={x(t.dueDate)} x2={x(t.dueDate)} y1={y - 2} y2={y + ROW - 14} stroke="#d97706" strokeWidth={2} strokeDasharray="3 2" />}
                    {t.prerequisites.map((p) => {
                      const from = byId.get(p); if (!from) return null;
                      const fx = Math.max(x(from.t.earliestFinish), x(from.t.earliestStart) + 3), fy = TOP + from.i * ROW + 8 + (ROW - 16) / 2;
                      return <path key={p} d={`M ${fx} ${fy} L ${fx + 6} ${fy} L ${fx + 6} ${y + (ROW - 16) / 2} L ${es} ${y + (ROW - 16) / 2}`} fill="none" stroke="#94a3b8" strokeWidth={1.2} />;
                    })}
                  </g>
                );
              })}
              {data.plannedEnd && <line x1={x(data.plannedEnd)} x2={x(data.plannedEnd)} y1={TOP} y2={H} stroke="#0f172a" strokeWidth={1.5} strokeDasharray="6 3" />}
              <line x1={x(data.projectedEnd)} x2={x(data.projectedEnd)} y1={TOP} y2={H} stroke={data.slipHours != null && data.slipHours > 0 ? '#e11d48' : '#10b981'} strokeWidth={2} />
            </svg>
          </div>
        </div>
      </Card>

      {can('task.write') && (
        <Card title="وابستگی‌ها" subtitle="«ب» تا «الف» تمام نشود شروع نمی‌شود — حلقه‌ها پیش از ثبت رد می‌شوند">
          <div className="flex flex-wrap items-end gap-2 px-4 py-3">
            <label className="text-xs text-ink-600"><span className="mb-1 block">وظیفه</span>
              <Select value={linking.task} onChange={(e) => setLinking({ ...linking, task: e.target.value })} className="w-56 text-xs" aria-label="وظیفه">
                <option value="">— انتخاب —</option>{data.tasks.map((t) => <option key={t.taskId} value={t.taskId}>{t.title}</option>)}
              </Select></label>
            <label className="text-xs text-ink-600"><span className="mb-1 block">پس از</span>
              <Select value={linking.pre} onChange={(e) => setLinking({ ...linking, pre: e.target.value })} className="w-56 text-xs" aria-label="پیش‌نیاز">
                <option value="">— انتخاب —</option>{data.tasks.filter((t) => t.taskId !== linking.task).map((t) => <option key={t.taskId} value={t.taskId}>{t.title}</option>)}
              </Select></label>
            <Button size="sm" variant="primary" disabled={!linking.task || !linking.pre} loading={link.isPending} onClick={() => link.mutate(undefined, { onSuccess: () => void refetch() })}>ثبت وابستگی</Button>
          </div>
          <ul className="divide-y divide-ink-100 text-xs" data-testid="dependencies">
            {data.tasks.flatMap((t) => t.prerequisites.map((p) => (
              <li key={`${t.taskId}${p}`} className="flex items-center justify-between px-4 py-1.5">
                <span>{t.title} <Badge tone="neutral">پس از</Badge> {byId.get(p)?.t.title ?? p}</span>
                <Button size="sm" variant="ghost" onClick={() => unlink.mutate({ task: t.taskId, pre: p }, { onSuccess: () => void refetch() })}>حذف</Button>
              </li>
            )))}
          </ul>
        </Card>
      )}
    </div>
  );
}
