import { Link } from 'react-router-dom';
import { DEPARTMENT_LABELS, type DepartmentCode } from '@hiva/contracts';
import { formatDate, localDigits } from '../lib/format';
import { STAGE, stageOf } from '../lib/plain';
import { StagePill } from './WorkCard';
import { isEnglish, loc, tr } from '../i18n';

/**
 * A project answered in six questions (the owner's brief, 2026-11-02): where it stands, what is done,
 * what is being done and by whom, what comes next, whether anything is stuck, and who is responsible.
 * Read from what the project's page already loads — nothing is computed that the records do not say.
 */

interface Task { id: string; title: string; state: string; dueDate: string | null; closedAt?: string | null; blockReason?: string | null; assignee?: { fullName: string } | null }
interface Deliverable { id: string; name: string; state: string; dueDate: string | null; departmentCode: string }
interface Order { id: string; title: string; state: string; targetDepartmentCode: string; owner?: { fullName: string } | null }
interface Issue { id: string; title: string; state: string; severity: string }
interface Clock { id: string; state: string; policy?: { labelFa: string; labelEn: string } | null }
export interface GlanceData {
  project: { state: string; healthStatus?: string | null; accountOwner?: { fullName: string } | null };
  tasks: Task[]; deliverables: Deliverable[]; workOrders: Order[]; issues: Issue[]; slaClocks: Clock[];
}

const HEALTH: Record<string, { label: string; cls: string }> = {
  GREEN: { label: tr('روی روال'), cls: 'text-emerald-700' },
  AMBER: { label: tr('نیازمند توجه'), cls: 'text-amber-700' },
  RED: { label: tr('در خطر'), cls: 'text-rose-700' },
};
const DONE_TASK = new Set(['APPROVED', 'CLOSED']);
const DONE_DELIVERABLE = new Set(['APPROVED', 'DELIVERED', 'ACCEPTED']);
const unitName = (code: string) => {
  const l = DEPARTMENT_LABELS[code as DepartmentCode];
  return l ? (isEnglish() ? l.en : l.fa) : code;
};

/** The six answers, as lists a person can read. */
export function glance(d: GlanceData, now = Date.now()) {
  const open = d.tasks.filter((t) => !DONE_TASK.has(t.state) && t.state !== 'CANCELLED');
  const late = (at: string | null) => !!at && new Date(at).getTime() < now;
  return {
    done: { tasks: d.tasks.filter((t) => DONE_TASK.has(t.state)).length, of: d.tasks.filter((t) => t.state !== 'CANCELLED').length,
      deliverables: d.deliverables.filter((x) => DONE_DELIVERABLE.has(x.state)).length, ofDeliverables: d.deliverables.length },
    doing: open.filter((t) => ['ACCEPTED', 'IN_PROGRESS', 'SUBMITTED', 'IN_QC'].includes(t.state)),
    next: [...open.filter((t) => t.dueDate && !late(t.dueDate)).map((t) => ({ id: t.id, title: t.title, at: t.dueDate!, who: t.assignee?.fullName ?? null, href: `/tasks/${t.id}` })),
      ...d.deliverables.filter((x) => !DONE_DELIVERABLE.has(x.state) && x.dueDate && !late(x.dueDate)).map((x) => ({ id: x.id, title: x.name, at: x.dueDate!, who: unitName(x.departmentCode), href: null }))]
      .sort((a, b) => a.at.localeCompare(b.at)).slice(0, 4),
    stuck: [
      ...open.filter((t) => t.state === 'BLOCKED').map((t) => ({ id: t.id, text: tr('«{0}» متوقف است{1}', t.title, t.blockReason ? tr(': {0}', t.blockReason) : ''), href: `/tasks/${t.id}` })),
      ...open.filter((t) => t.state !== 'BLOCKED' && late(t.dueDate)).map((t) => ({ id: t.id, text: tr('«{0}» {1} روز از مهلتش گذشته است{2}', t.title, localDigits(Math.max(1, Math.round((now - new Date(t.dueDate!).getTime()) / 86_400_000))), t.assignee ? tr(' — {0}', t.assignee.fullName) : ''), href: `/tasks/${t.id}` })),
      ...d.workOrders.filter((o) => o.state === 'CLARIFICATION_REQUESTED').map((o) => ({ id: o.id, text: tr('واحد {0} دربارهٔ «{1}» سؤال دارد', unitName(o.targetDepartmentCode), o.title), href: `/work-orders/${o.id}` })),
      ...d.issues.filter((i) => ['OPEN', 'IN_PROGRESS'].includes(i.state)).map((i) => ({ id: i.id, text: tr('مسئلهٔ باز: {0}', i.title), href: null })),
      ...d.slaClocks.filter((c) => c.state === 'BREACHED').map((c) => ({ id: c.id, text: tr('مهلت «{0}» گذشته است', c.policy ? loc(c.policy, 'label') : tr('یک گام')), href: null })),
    ],
    owners: [...new Map(d.workOrders.filter((o) => o.owner && o.state !== 'CANCELLED').map((o) => [o.targetDepartmentCode, o.owner!.fullName])).entries()],
  };
}

export function ProjectGlance({ data: d }: { data: GlanceData }) {
  const g = glance(d);
  const stage = stageOf(d.project.state, 'project');
  const health = d.project.healthStatus ? HEALTH[d.project.healthStatus] : undefined;
  return (
    <section aria-label={tr('پروژه در یک نگاه')} className="rounded-xl bg-surface p-4 ring-1 ring-edge" data-testid="project-glance" data-tour="project-glance">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-bold text-ink-900">{tr('پروژه در یک نگاه')}</h2>
        <span className="flex items-center gap-2 text-sm">
          <StagePill state={d.project.state} entity="project" />
          {health && <span className={health.cls}>{health.label}</span>}
        </span>
      </div>
      <p className="mt-1 text-sm text-ink-600">{tr('وضعیت: {0}', STAGE[stage].label)}{d.project.accountOwner ? tr(' — مسئول پروژه: {0}', d.project.accountOwner.fullName) : ''}</p>

      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <Part title={tr('انجام شده')} testid="glance-done">
          <li>{tr('{0} از {1} وظیفه، و {2} از {3} خروجی.', localDigits(g.done.tasks), localDigits(g.done.of), localDigits(g.done.deliverables), localDigits(g.done.ofDeliverables))}</li>
        </Part>
        <Part title={tr('در جریان')} testid="glance-doing" empty={!g.doing.length && tr('اکنون کاری در جریان نیست.')}>
          {g.doing.slice(0, 5).map((t) => (
            <li key={t.id}><Link to={`/tasks/${t.id}`} className="text-brand-700 hover:underline">{t.title}</Link>{t.assignee ? ` — ${t.assignee.fullName}` : ''}</li>
          ))}
          {g.doing.length > 5 && <li className="text-ink-500">{tr('و {0} کار دیگر', localDigits(g.doing.length - 5))}</li>}
        </Part>
        <Part title={tr('گام‌های بعد')} testid="glance-next" empty={!g.next.length && tr('مهلت پیش‌رویی ثبت نشده است.')}>
          {g.next.map((n) => (
            <li key={n.id}>{n.href ? <Link to={n.href} className="text-brand-700 hover:underline">{n.title}</Link> : n.title}
              <span className="text-ink-500">{' — '}{formatDate(n.at)}{n.who ? ` · ${n.who}` : ''}</span></li>
          ))}
        </Part>
        <Part title={tr('گیر کرده یا دیر')} testid="glance-stuck" tone={g.stuck.length ? 'warn' : undefined} empty={!g.stuck.length && tr('چیزی گیر نکرده است.')}>
          {g.stuck.slice(0, 6).map((s) => <li key={s.id}>{s.href ? <Link to={s.href} className="hover:underline">{s.text}</Link> : s.text}</li>)}
          {g.stuck.length > 6 && <li>{tr('و {0} مورد دیگر', localDigits(g.stuck.length - 6))}</li>}
        </Part>
      </div>
      {!!g.owners.length && (
        <p className="mt-3 border-t border-ink-100 pt-2 text-sm text-ink-600" data-testid="glance-owners">
          {tr('مسئول هر واحد: ')}{g.owners.map(([u, who]) => `${unitName(u)}: ${who}`).join(tr('، '))}
        </p>
      )}
    </section>
  );
}

function Part({ title, testid, empty, tone, children }: { title: string; testid: string; empty?: string | false; tone?: 'warn'; children?: React.ReactNode }) {
  return (
    <div data-testid={testid}>
      <h3 className={tone === 'warn' ? 'text-sm font-bold text-amber-800' : 'text-sm font-bold text-ink-800'}>{title}</h3>
      {empty ? <p className="mt-1 text-sm text-ink-500">{empty}</p> : <ul className={tone === 'warn' ? 'mt-1 space-y-1 text-sm text-amber-900' : 'mt-1 space-y-1 text-sm text-ink-800'}>{children}</ul>}
    </div>
  );
}
