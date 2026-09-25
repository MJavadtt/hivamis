/**
 * Running the detectors and keeping what they find (roadmap #26).
 *
 * An alert is keyed by kind, subject and window, so a scan every fifteen minutes updates the
 * same alert as the evidence grows instead of raising it forty times. A reviewed alert keeps its
 * review: the evidence may still grow, but the administrator's decision stands until they change
 * it. Administrators are told once, when a HIGH or CRITICAL alert first appears — never the
 * person it is about, who is not the audience for an unproven suspicion.
 */
import { prisma } from '../db.js';
import { notify } from '../mail/notify.js';
import { detectAnomalies, type ScanOptions } from './anomalies.js';

export interface ScanResult { detected: number; created: number; updated: number; notified: number }

const KIND_FA: Record<string, string> = {
  OFF_HOURS_EXPORT: 'خروجی بیرون از ساعت کاری',
  DOWNLOAD_SURGE: 'جهش دانلود',
  OUT_OF_SCOPE_ACCESS: 'دسترسی بیرون از پروژه‌های خود',
  DENIAL_SURGE: 'جهش دسترسی‌های ردشده',
  LOGIN_FAILURES: 'ورودهای ناموفق پیاپی',
  TOKEN_REUSE: 'استفادهٔ دوباره از نشست ابطال‌شده',
};
export const alertKindFa = (k: string) => KIND_FA[k] ?? k;

export async function scanOrganization(organizationId: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const detected = await detectAnomalies(prisma, organizationId, opts);
  let created = 0; let updated = 0; let notified = 0;
  const fresh: typeof detected = [];

  for (const a of detected) {
    const existing = await prisma.securityAlert.findUnique({
      where: { organizationId_fingerprint: { organizationId, fingerprint: a.fingerprint } },
      select: { id: true },
    });
    if (existing) {
      await prisma.securityAlert.update({
        where: { id: existing.id },
        data: { severity: a.severity, evidence: a.evidence as object, messageFa: a.messageFa, windowEnd: a.windowEnd },
      });
      updated++;
    } else {
      await prisma.securityAlert.create({
        data: {
          organizationId, kind: a.kind, severity: a.severity, actorId: a.actorId, ipAddress: a.ipAddress,
          windowStart: a.windowStart, windowEnd: a.windowEnd, evidence: a.evidence as object,
          messageFa: a.messageFa, fingerprint: a.fingerprint,
        },
      });
      created++;
      if (a.severity === 'HIGH' || a.severity === 'CRITICAL') fresh.push(a);
    }
  }

  if (fresh.length) {
    const reviewers = await prisma.user.findMany({
      where: {
        organizationId, isActive: true, deletedAt: null,
        roles: { some: { role: { permissions: { some: { permission: { code: 'admin.audit' } } } } } },
      },
      select: { id: true },
    });
    for (const a of fresh) {
      for (const r of reviewers) {
        if (r.id === a.actorId) continue;               // never told about oneself
        await notify({
          userId: r.id, kind: 'SECURITY_ALERT', severity: a.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
          title: `هشدار امنیتی — ${alertKindFa(a.kind)}`, body: a.messageFa,
          entityType: 'securityAlert', entityId: null,
        });
        notified++;
      }
    }
  }
  return { detected: detected.length, created, updated, notified };
}

export async function scanAll(opts: ScanOptions = {}): Promise<ScanResult> {
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  const total: ScanResult = { detected: 0, created: 0, updated: 0, notified: 0 };
  for (const o of orgs) {
    const r = await scanOrganization(o.id, opts);
    total.detected += r.detected; total.created += r.created; total.updated += r.updated; total.notified += r.notified;
  }
  return total;
}
