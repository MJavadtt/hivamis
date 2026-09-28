/**
 * An organisation's own rules on its workflows (roadmap #47) — written in the app, with no code.
 *
 * A GUARD is a condition the move must satisfy; a NOTIFY tells roles when the move happens (and,
 * optionally, only when a condition holds). Conditions are #17's language — the one managers
 * already use for form routing — evaluated over the record's own fields, with each date also
 * offered as "days from now" and the actor's id for four-eyes rules. Pure: no query, no side
 * effect, so preflight can ask it on every page view and a replay can ask it of the past.
 */
import { Prisma, type CustomRule } from '@prisma/client';
import { ROLE_CODES, describeCondition, matchesCondition, type RoutingCondition } from '@hiva/contracts';
import type { Tx } from '../db.js';
import type { GuardContext, GuardResult } from './guards.js';

export const CUSTOM_PREFIX = 'custom:';
export const customKey = (code: string) => `${CUSTOM_PREFIX}${code}`;
export const isCustomKey = (key: string) => key.startsWith(CUSTOM_PREFIX);

const DAY = 86_400_000;

/** A record as the condition language sees it: flat scalars, money as numbers, dates twice. */
export function factsOf(record: Record<string, unknown>, actorId: string, now = new Date()): Record<string, unknown> {
  const facts: Record<string, unknown> = { 'actor.id': actorId };
  for (const [key, v] of Object.entries(record)) {
    if (v instanceof Prisma.Decimal) facts[key] = v.toNumber();
    else if (v instanceof Date) {
      facts[key] = v.toISOString();
      facts[`${key}.daysFromNow`] = Math.round(((v.getTime() - now.getTime()) / DAY) * 10) / 10;
    } else if (typeof v === 'bigint') facts[key] = Number(v);
    else if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) facts[key] = v;
  }
  return facts;
}

/* ── the fields a rule may name ──────────────────────────────────────────────────────────── */

/** Persian names for the fields rules most often name; any other field keeps its own name. */
const FIELD_FA: Record<string, string> = {
  code: 'کد', name: 'نام', title: 'عنوان', state: 'وضعیت', priority: 'اولویت', description: 'شرح',
  contractValue: 'ارزش قرارداد', estimatedValue: 'ارزش برآوردی', total: 'جمع کل', subtotal: 'جمع پیش از مالیات', taxAmount: 'مالیات',
  paidAmount: 'مبلغ پرداخت‌شده', plannedBudget: 'بودجهٔ برنامه‌ریزی‌شده', budget: 'بودجه', budgetRange: 'بازهٔ بودجه', amount: 'مبلغ',
  probability: 'احتمال', currency: 'ارز', margin: 'حاشیهٔ سود', salePrice: 'قیمت فروش', totalCost: 'هزینهٔ کل',
  plannedStart: 'شروع برنامه‌ریزی‌شده', plannedEnd: 'پایان برنامه‌ریزی‌شده', actualStart: 'شروع واقعی', actualEnd: 'پایان واقعی',
  startDate: 'تاریخ شروع', endDate: 'تاریخ پایان', dueDate: 'سررسید', deadline: 'مهلت', desiredDeadline: 'زمان مورد انتظار',
  issueDate: 'تاریخ صدور', signedAt: 'تاریخ امضا', submittedAt: 'زمان تحویل', deliveredAt: 'زمان ارسال به مشتری', createdAt: 'زمان ایجاد',
  accountOwnerId: 'مالک اکانت', salesOwnerId: 'مالک فروش', ownerId: 'مالک', assigneeId: 'مسئول', createdById: 'ثبت‌کننده',
  approvedById: 'تأییدکننده', companyId: 'مشتری', projectId: 'پروژه', departmentCode: 'واحد', targetDepartmentCode: 'واحد مقصد',
  healthStatus: 'وضعیت سلامت', format: 'فرمت', round: 'دور اصلاح', returnCount: 'دفعات بازگشت', contractNumber: 'شمارهٔ قرارداد',
  'actor.id': 'انجام‌دهندهٔ این انتقال',
};
const HIDDEN = new Set(['id', 'organizationId', 'deletedAt', 'updatedAt', 'searchVector']);

export interface FieldInfo { key: string; labelFa: string; type: 'number' | 'text' | 'date' | 'boolean' | 'days' | 'id'; enumValues?: string[] }

/** What a rule on this entity may name, from the schema itself — so it can never name a field that is not there. */
export function fieldsOf(entity: string): FieldInfo[] {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === entity.charAt(0).toUpperCase() + entity.slice(1));
  if (!model) return [];
  const enums = new Map(Prisma.dmmf.datamodel.enums.map((e) => [e.name, e.values.map((v) => v.name)]));
  const out: FieldInfo[] = [];
  for (const f of model.fields) {
    if ((f.kind !== 'scalar' && f.kind !== 'enum') || f.isList || HIDDEN.has(f.name) || f.type === 'Json' || f.type === 'Bytes') continue;
    const labelFa = FIELD_FA[f.name] ?? f.name;
    if (f.type === 'DateTime') {
      out.push({ key: f.name, labelFa, type: 'date' });
      out.push({ key: `${f.name}.daysFromNow`, labelFa: `${labelFa} — روز تا امروز`, type: 'days' });
    } else if (['Int', 'Float', 'Decimal', 'BigInt'].includes(f.type)) out.push({ key: f.name, labelFa, type: 'number' });
    else if (f.type === 'Boolean') out.push({ key: f.name, labelFa, type: 'boolean' });
    else if (f.kind === 'enum') out.push({ key: f.name, labelFa, type: 'text', enumValues: enums.get(f.type) });
    else out.push({ key: f.name, labelFa, type: f.name.endsWith('Id') ? 'id' : 'text' });
  }
  out.push({ key: 'actor.id', labelFa: FIELD_FA['actor.id']!, type: 'id' });
  return out;
}

/** Every field a condition names, for validation. */
export function fieldsNamed(cond: RoutingCondition): string[] {
  if ('all' in cond) return cond.all.flatMap(fieldsNamed);
  if ('any' in cond) return cond.any.flatMap(fieldsNamed);
  const other = ['ltField', 'gtField', 'eqField', 'neField'].includes(cond.op) ? [String(cond.value)] : [];
  return [cond.field, ...other];
}

export const describeRule = (entity: string, when: RoutingCondition) => describeCondition(when, fieldsOf(entity) as never);

/* ── at the transition ───────────────────────────────────────────────────────────────────── */

export async function customRulesFor(tx: Tx, organizationId: string, entity: string, action?: string): Promise<CustomRule[]> {
  return tx.customRule.findMany({
    where: { organizationId, entity, ...(action ? { action } : {}), retiredAt: null },
    orderBy: { code: 'asc' },
  });
}

export function evaluateGuard(rule: Pick<CustomRule, 'code' | 'version' | 'entity' | 'labelFa' | 'messageFa' | 'when'>, record: Record<string, unknown>, actorId: string): GuardResult {
  const when = rule.when as unknown as RoutingCondition;
  const ok = matchesCondition(when, factsOf(record, actorId));
  return ok
    ? { ok: true }
    : {
        ok: false,
        rule: `قانون سازمان ${rule.code} (نسخهٔ ${rule.version})`,
        messageFa: rule.messageFa?.trim() || `«${rule.labelFa}» برقرار نیست: ${describeRule(rule.entity, when)}`,
        details: { customRule: { code: rule.code, version: rule.version } },
      };
}

/** The organisation's guards on one transition, in the shape the guard runners take. */
export function customGuards(rules: CustomRule[]): { keys: string[]; resolve: GuardContext['resolve']; labelOf: GuardContext['labelOf'] } {
  const guards = rules.filter((r) => r.kind === 'GUARD');
  const byKey = new Map(guards.map((r) => [customKey(r.code), r]));
  return {
    keys: [...byKey.keys()],
    resolve: (key) => {
      const rule = byKey.get(key);
      return rule ? async (c: GuardContext) => evaluateGuard(rule, c.record, c.actorId) : undefined;
    },
    labelOf: (key) => byKey.get(key)?.labelFa,
  };
}

/** After the move: tell the roles a NOTIFY rule names — everyone active in them but the one who moved it. */
export async function applyNotifyRules(
  tx: Tx, rules: CustomRule[],
  input: { organizationId: string; entity: string; record: Record<string, unknown>; actorId: string; transitionFa: string },
): Promise<string[]> {
  const fired: string[] = [];
  for (const rule of rules.filter((r) => r.kind === 'NOTIFY')) {
    if (rule.when && !matchesCondition(rule.when as unknown as RoutingCondition, factsOf(input.record, input.actorId))) continue;
    const roles = rule.notifyRoles.filter((r) => (ROLE_CODES as readonly string[]).includes(r));
    const users = await tx.user.findMany({
      where: { organizationId: input.organizationId, isActive: true, id: { not: input.actorId }, roles: { some: { role: { code: { in: roles } } } } },
      select: { id: true },
    });
    const code = typeof input.record.code === 'string' ? input.record.code : '';
    // Written in the transition's own transaction: a move that rolls back tells no one.
    if (users.length) {
      await tx.notification.createMany({
        data: users.map((u) => ({
          userId: u.id, kind: 'CUSTOM_RULE', severity: 'INFO', entityType: input.entity, entityId: String(input.record.id),
          title: `${rule.labelFa}${code ? ` — ${code}` : ''}`,
          body: rule.messageFa?.trim() || `«${input.transitionFa}» انجام شد.`,
        })),
      });
    }
    fired.push(`${rule.code}@${rule.version}`);
  }
  return fired;
}
