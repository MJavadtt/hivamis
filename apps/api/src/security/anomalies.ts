/**
 * Anomalies on the audit trail (roadmap #26).
 *
 * `audit_events` records every export, download, failed login and refused permission with its
 * actor, time and address, and docs/operations.md told an operator to watch them by hand — which
 * in practice means reading them after something has already gone wrong. This reads them as
 * they accumulate and raises what does not look like its usual self.
 *
 * Every detector compares a person with **their own** history, not with a global threshold
 * alone: a finance lead downloading forty invoices at month end is normal; a designer doing it
 * at midnight is not. Each alert carries its evidence — the counts, the baseline and the event
 * ids — so an administrator reviews a case, not a verdict. Nothing here acts on its own: an
 * alert never locks an account, because a false positive on a person's record has a human cost
 * and the decision belongs to someone who can ask them.
 */
import type { Tx } from '../db.js';
import { isWorkingDay, type Calendar } from '../lib/business-calendar.js';
import { loadCalendar } from '../sla/engine.js';

export type AlertKind =
  | 'OFF_HOURS_EXPORT' | 'DOWNLOAD_SURGE' | 'OUT_OF_SCOPE_ACCESS'
  | 'DENIAL_SURGE' | 'LOGIN_FAILURES' | 'TOKEN_REUSE';
export type AlertSeverity = 'INFO' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface DetectedAlert {
  kind: AlertKind;
  severity: AlertSeverity;
  actorId: string | null;
  ipAddress: string | null;
  windowStart: Date;
  windowEnd: Date;
  evidence: Record<string, unknown>;
  messageFa: string;
  fingerprint: string;
}

/** Thresholds, named so they can be argued with. Each is a floor: the baseline can only raise it. */
export const THRESHOLDS = {
  offHoursExports: 8,        // exports + downloads outside working hours, in one day
  downloadSurgeFloor: 25,    // exports + downloads in 24h
  downloadSurgeMultiple: 5,  // …and at least this many times the person's usual day
  outOfScopeProjects: 3,     // distinct projects with no tie to the person, in 24h
  denialsFloor: 10,          // refused permission checks in 24h
  denialsMultiple: 4,
  loginFailuresPerIp: 10,    // failed logins from one address in an hour
  loginAccountsPerIp: 3,     // …or this many different accounts from one address
} as const;

const DAY = 86_400_000;
const EXFIL = ['EXPORT', 'FILE_DOWNLOAD'];
/** Roles whose work is the whole organisation: "outside their projects" does not apply to them. */
const ORG_WIDE_ROLES = new Set(['SUPER_ADMIN', 'CEO', 'DEPUTY', 'PMO_MANAGER', 'PMO_SPECIALIST', 'FINANCE_MANAGER', 'FINANCE_SPECIALIST', 'LEGAL_MANAGER', 'LEGAL_SPECIALIST']);

const fa = (n: number) => new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 }).format(n);
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** A person's usual day: the median of their daily counts over the baseline window, zeros included. */
function usualDay(times: Date[], from: Date, to: Date): number {
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY));
  const counts = new Map<string, number>();
  for (const t of times) counts.set(dayKey(t), (counts.get(dayKey(t)) ?? 0) + 1);
  const series: number[] = [];
  for (let i = 0; i < days; i++) series.push(counts.get(dayKey(new Date(from.getTime() + i * DAY))) ?? 0);
  return median(series);
}

function offHours(d: Date, cal: Calendar): boolean {
  if (!isWorkingDay(d, cal)) return true;
  const h = d.getHours() + d.getMinutes() / 60;
  return h < cal.startHour || h >= cal.endHour;
}

export interface ScanOptions {
  now?: Date;
  /** How far back "now" looks. */
  windowHours?: number;
  /** How far back "usual" looks. */
  baselineDays?: number;
}

export async function detectAnomalies(tx: Tx, organizationId: string, opts: ScanOptions = {}): Promise<DetectedAlert[]> {
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - (opts.windowHours ?? 24) * 3_600_000);
  const baselineStart = new Date(windowStart.getTime() - (opts.baselineDays ?? 30) * DAY);
  const day = dayKey(windowStart) === dayKey(now) ? dayKey(now) : `${dayKey(windowStart)}_${dayKey(now)}`;

  const events = await tx.auditEvent.findMany({
    where: {
      organizationId, createdAt: { gte: baselineStart, lte: now },
      action: { in: [...EXFIL, 'PERMISSION_DENIED', 'LOGIN_FAILED', 'REFRESH_TOKEN_REUSE'] },
    },
    select: { id: true, action: true, actorId: true, ipAddress: true, entityType: true, entityId: true, reason: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const recent = events.filter((e) => e.createdAt >= windowStart);
  const past = events.filter((e) => e.createdAt < windowStart);
  const alerts: DetectedAlert[] = [];

  const byActor = <T extends { actorId: string | null }>(xs: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of xs) if (x.actorId) (m.get(x.actorId) ?? m.set(x.actorId, []).get(x.actorId)!).push(x);
    return m;
  };

  // ── 1 & 2. Exports and downloads: out of hours, and out of proportion ──────────────────────
  const recentExfil = byActor(recent.filter((e) => EXFIL.includes(e.action)));
  const pastExfil = byActor(past.filter((e) => EXFIL.includes(e.action)));
  for (const [actorId, mine] of recentExfil) {
    const cal = await loadCalendar(organizationId, { userId: actorId });
    const late = mine.filter((e) => offHours(e.createdAt, cal));
    const usual = usualDay((pastExfil.get(actorId) ?? []).map((e) => e.createdAt), baselineStart, windowStart);
    const usualLate = usualDay((pastExfil.get(actorId) ?? []).filter((e) => offHours(e.createdAt, cal)).map((e) => e.createdAt), baselineStart, windowStart);

    if (late.length >= Math.max(THRESHOLDS.offHoursExports, 3 * usualLate)) {
      alerts.push({
        kind: 'OFF_HOURS_EXPORT', severity: late.length >= 3 * THRESHOLDS.offHoursExports ? 'HIGH' : 'MEDIUM',
        actorId, ipAddress: late.at(-1)?.ipAddress ?? null, windowStart, windowEnd: now,
        evidence: {
          count: late.length, usualOffHoursPerDay: usualLate,
          first: late[0]!.createdAt, last: late.at(-1)!.createdAt,
          eventIds: late.slice(0, 50).map((e) => e.id),
          byType: countBy(late, (e) => e.entityType),
        },
        messageFa: `${fa(late.length)} خروجی/دانلود بیرون از ساعت کاری در ۲۴ ساعت گذشته؛ روز معمولِ همین فرد ${fa(usualLate)} مورد است`,
        fingerprint: `OFF_HOURS_EXPORT:${actorId}:${day}`,
      });
    }

    const threshold = Math.max(THRESHOLDS.downloadSurgeFloor, THRESHOLDS.downloadSurgeMultiple * Math.max(1, usual));
    if (mine.length >= threshold) {
      alerts.push({
        kind: 'DOWNLOAD_SURGE', severity: mine.length >= 2 * threshold ? 'HIGH' : 'MEDIUM',
        actorId, ipAddress: mine.at(-1)?.ipAddress ?? null, windowStart, windowEnd: now,
        evidence: {
          count: mine.length, usualPerDay: usual, threshold,
          eventIds: mine.slice(0, 50).map((e) => e.id), byType: countBy(mine, (e) => e.entityType),
        },
        messageFa: `${fa(mine.length)} خروجی/دانلود در ۲۴ ساعت گذشته؛ روز معمولِ همین فرد ${fa(usual)} مورد است`,
        fingerprint: `DOWNLOAD_SURGE:${actorId}:${day}`,
      });
    }
  }

  // ── 3. Reaching into projects the person has no tie to ────────────────────────────────────
  const scoped = await scopedActors(tx, organizationId, [...recentExfil.keys()]);
  for (const [actorId, mine] of recentExfil) {
    const ties = scoped.get(actorId);
    if (!ties) continue;                                   // org-wide role: every project is theirs
    const touched = await projectsOf(tx, mine);
    const foreign = [...touched.entries()].filter(([pid]) => !ties.has(pid));
    if (foreign.length >= THRESHOLDS.outOfScopeProjects) {
      const pastForeign = await projectsOf(tx, pastExfil.get(actorId) ?? []);
      const usualForeign = [...pastForeign.keys()].filter((pid) => !ties.has(pid)).length;
      if (foreign.length > usualForeign) {
        alerts.push({
          kind: 'OUT_OF_SCOPE_ACCESS', severity: foreign.length >= 2 * THRESHOLDS.outOfScopeProjects ? 'HIGH' : 'MEDIUM',
          actorId, ipAddress: mine.at(-1)?.ipAddress ?? null, windowStart, windowEnd: now,
          evidence: {
            projects: foreign.map(([pid, n]) => ({ projectId: pid, events: n })),
            distinct: foreign.length, previousMonthDistinct: usualForeign,
          },
          messageFa: `خروجی یا دانلود از ${fa(foreign.length)} پروژه‌ای که این فرد در آن‌ها نقشی ندارد، در ۲۴ ساعت گذشته`,
          fingerprint: `OUT_OF_SCOPE_ACCESS:${actorId}:${day}`,
        });
      }
    }
  }

  // ── 4. Refused permissions: a misassigned role, or someone trying doors ───────────────────
  const recentDenied = byActor(recent.filter((e) => e.action === 'PERMISSION_DENIED'));
  const pastDenied = byActor(past.filter((e) => e.action === 'PERMISSION_DENIED'));
  for (const [actorId, mine] of recentDenied) {
    const usual = usualDay((pastDenied.get(actorId) ?? []).map((e) => e.createdAt), baselineStart, windowStart);
    const threshold = Math.max(THRESHOLDS.denialsFloor, THRESHOLDS.denialsMultiple * Math.max(1, usual));
    if (mine.length < threshold) continue;
    const perms = countBy(mine, (e) => (e.reason ?? '').replace(/^missing:\s*/, '') || '—');
    const distinct = Object.keys(perms).length;
    // One permission asked for again and again reads as a role that is missing something; many
    // different ones read as someone trying doors. The alert says which, and why.
    const probing = distinct >= 4;
    alerts.push({
      kind: 'DENIAL_SURGE', severity: probing ? 'HIGH' : 'MEDIUM',
      actorId, ipAddress: mine.at(-1)?.ipAddress ?? null, windowStart, windowEnd: now,
      evidence: { count: mine.length, usualPerDay: usual, threshold, permissions: perms, distinctPermissions: distinct },
      messageFa: probing
        ? `${fa(mine.length)} درخواست ردشده برای ${fa(distinct)} دسترسی متفاوت در ۲۴ ساعت — الگوی آزمودن درهای مختلف`
        : `${fa(mine.length)} درخواست ردشده در ۲۴ ساعت، بیشترش برای «${Object.entries(perms).sort((a, b) => b[1] - a[1])[0]![0]}» — شاید نقش این فرد چیزی کم دارد`,
      fingerprint: `DENIAL_SURGE:${actorId}:${day}`,
    });
  }

  // ── 5. Failed logins from one address: guessing, or stuffing credentials ──────────────────
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const failures = recent.filter((e) => e.action === 'LOGIN_FAILED' && e.createdAt >= hourAgo && e.ipAddress);
  const byIp = new Map<string, typeof failures>();
  for (const f of failures) (byIp.get(f.ipAddress!) ?? byIp.set(f.ipAddress!, []).get(f.ipAddress!)!).push(f);
  for (const [ip, mine] of byIp) {
    const accounts = new Set(mine.map((e) => e.entityId).filter(Boolean));
    if (mine.length < THRESHOLDS.loginFailuresPerIp && accounts.size < THRESHOLDS.loginAccountsPerIp) continue;
    alerts.push({
      kind: 'LOGIN_FAILURES', severity: accounts.size >= THRESHOLDS.loginAccountsPerIp ? 'HIGH' : 'MEDIUM',
      actorId: null, ipAddress: ip, windowStart: hourAgo, windowEnd: now,
      evidence: { count: mine.length, accounts: accounts.size, accountIds: [...accounts].slice(0, 20) },
      messageFa: accounts.size >= THRESHOLDS.loginAccountsPerIp
        ? `${fa(mine.length)} ورود ناموفق از نشانی ${ip} برای ${fa(accounts.size)} حساب متفاوت در یک ساعت — الگوی امتحان رمزهای فهرست‌شده`
        : `${fa(mine.length)} ورود ناموفق از نشانی ${ip} در یک ساعت`,
      fingerprint: `LOGIN_FAILURES:${ip}:${dayKey(now)}T${now.getHours()}`,
    });
  }

  // ── 6. A revoked refresh token presented again: the one signal that is never noise ────────
  for (const e of recent.filter((x) => x.action === 'REFRESH_TOKEN_REUSE')) {
    alerts.push({
      kind: 'TOKEN_REUSE', severity: 'CRITICAL',
      actorId: e.entityId ?? e.actorId, ipAddress: e.ipAddress, windowStart: e.createdAt, windowEnd: e.createdAt,
      evidence: { eventId: e.id },
      messageFa: 'یک توکن نشست ابطال‌شده دوباره استفاده شد — نشانهٔ سرقت نشست؛ همهٔ نشست‌های این کاربر لغو شده است',
      fingerprint: `TOKEN_REUSE:${e.id}`,
    });
  }

  return alerts;
}

function countBy<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

/**
 * For people whose work is a set of projects rather than the whole organisation: the projects
 * they are tied to. Org-wide roles are left out, which is how the detector knows to skip them.
 */
async function scopedActors(tx: Tx, organizationId: string, actorIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!actorIds.length) return out;
  const users = await tx.user.findMany({
    where: { id: { in: actorIds }, organizationId },
    select: { id: true, department: { select: { code: true } }, roles: { select: { role: { select: { code: true } } } } },
  });
  for (const u of users) {
    if (u.roles.some((r) => ORG_WIDE_ROLES.has(r.role.code))) continue;
    const [owned, tasks, orders, raci, allocations] = await Promise.all([
      tx.project.findMany({ where: { organizationId, accountOwnerId: u.id }, select: { id: true } }),
      tx.task.findMany({ where: { organizationId, assigneeId: u.id }, select: { projectId: true } }),
      tx.workOrder.findMany({
        where: { organizationId, OR: [{ ownerId: u.id }, ...(u.department ? [{ targetDepartmentCode: u.department.code }] : [])] },
        select: { projectId: true },
      }),
      tx.raciAssignment.findMany({ where: { userId: u.id }, select: { projectId: true } }).catch(() => [] as { projectId: string }[]),
      tx.allocation.findMany({ where: { userId: u.id }, select: { projectId: true } }),
    ]);
    out.set(u.id, new Set([
      ...owned.map((p) => p.id), ...tasks.map((t) => t.projectId),
      ...orders.map((o) => o.projectId), ...raci.map((r) => r.projectId), ...allocations.map((a) => a.projectId),
    ].filter(Boolean) as string[]));
  }
  return out;
}

/** The project behind each exported or downloaded thing, where there is one. */
async function projectsOf(
  tx: Tx, events: { entityType: string; entityId: string | null }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const add = (pid: string | null | undefined) => { if (pid) out.set(pid, (out.get(pid) ?? 0) + 1); };
  const ids = (type: string) => events.filter((e) => e.entityType === type && e.entityId).map((e) => e.entityId!);
  const lookups: [string, (xs: string[]) => Promise<{ id: string; projectId: string | null }[]>][] = [
    ['document', (xs) => tx.document.findMany({ where: { id: { in: xs } }, select: { id: true, projectId: true } })],
    ['deliverable', (xs) => tx.deliverable.findMany({ where: { id: { in: xs } }, select: { id: true, projectId: true } })],
    ['workOrder', (xs) => tx.workOrder.findMany({ where: { id: { in: xs } }, select: { id: true, projectId: true } })],
    ['statusReport', (xs) => tx.statusReport.findMany({ where: { id: { in: xs } }, select: { id: true, projectId: true } })],
    ['changeRequest', (xs) => tx.changeRequest.findMany({ where: { id: { in: xs } }, select: { id: true, projectId: true } })],
  ];
  for (const pid of ids('project')) add(pid);
  for (const [type, find] of lookups) {
    const wanted = ids(type);
    if (!wanted.length) continue;
    const rows = await find([...new Set(wanted)]);
    const byId = new Map(rows.map((r) => [r.id, r.projectId]));
    for (const id of wanted) add(byId.get(id));
  }
  return out;
}
