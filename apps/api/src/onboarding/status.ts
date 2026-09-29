/**
 * Where an organisation stands in getting started (roadmap #48), read from its data rather than
 * ticked by hand — except the two steps that are a judgement, not a count: that the calendar and
 * the SLA hours were looked at and are right. Those are confirmed, by someone, at a time.
 */
import type { Tx } from '../db.js';
import { unitMapOf } from './units.js';
import { PENDING_PREFIX } from './activation.js';

export const STEPS = ['units', 'users', 'calendar', 'sla', 'companies', 'projects'] as const;
export type Step = (typeof STEPS)[number];
export const CONFIRMED_STEPS: Step[] = ['units', 'calendar', 'sla'];

interface Confirmation { at: string; by: string; byName?: string }

export async function onboardingStatus(tx: Tx, organizationId: string) {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true, workingDays: true, workStartHour: true, workEndHour: true } });
  const confirmed = ((org.settings as { onboarding?: Record<string, Confirmation> } | null)?.onboarding ?? {}) as Record<string, Confirmation>;
  const [map, users, pending, holidays, companies, contacts, projects, openings, sla] = await Promise.all([
    unitMapOf(tx, organizationId),
    tx.user.count({ where: { organizationId, isActive: true, deletedAt: null } }),
    tx.user.count({ where: { organizationId, isActive: true, deletedAt: null, passwordHash: { startsWith: PENDING_PREFIX } } }),
    tx.holiday.count({ where: { organizationId } }),
    tx.company.count({ where: { organizationId, deletedAt: null } }),
    tx.contact.count({ where: { company: { organizationId }, deletedAt: null } }),
    tx.project.count({ where: { organizationId, deletedAt: null } }),
    tx.stateTransition.count({ where: { organizationId, opening: true } }),
    tx.slaPolicy.count({ where: { organizationId, isActive: true } }),
  ]);
  const fa = (n: number) => new Intl.NumberFormat('fa-IR').format(n);
  const steps = [
    { step: 'units' as Step, labelFa: 'واحدها', done: !!confirmed.units, detailFa: `${fa(Object.keys(map).length)} نام واحد به واحدهای Doc_H وصل شده` },
    { step: 'users' as Step, labelFa: 'کاربران', done: users > 1, detailFa: `${fa(users)} کاربر فعال${pending ? ` — ${fa(pending)} نفر هنوز رمز نگذاشته‌اند` : ''}` },
    { step: 'calendar' as Step, labelFa: 'تقویم کاری', done: !!confirmed.calendar, detailFa: `${fa(org.workingDays.length)} روز کاری در هفته، ساعت ${fa(org.workStartHour)} تا ${fa(org.workEndHour)}، ${fa(holidays)} روز تعطیل` },
    { step: 'sla' as Step, labelFa: 'مهلت‌های SLA', done: !!confirmed.sla, detailFa: `${fa(sla)} سیاست فعال` },
    { step: 'companies' as Step, labelFa: 'مشتریان', done: companies > 0, detailFa: `${fa(companies)} مشتری و ${fa(contacts)} مخاطب` },
    { step: 'projects' as Step, labelFa: 'پروژه‌های در جریان', done: projects > 0, detailFa: `${fa(projects)} پروژه${openings ? ` — ${fa(openings)} با وضعیتی که از سامانهٔ پیشین آمده` : ''}` },
  ].map((s) => ({ ...s, confirmed: confirmed[s.step] ?? null }));
  return { steps, done: steps.filter((s) => s.done).length, total: steps.length, pendingActivations: pending };
}
