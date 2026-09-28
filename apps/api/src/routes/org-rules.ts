import type { FastifyPluginAsync } from 'fastify';
import {
  ROLE_CODES, ROUTING_OPERATORS, WORKFLOWS, customRuleSchema, describeCondition, matchesCondition, type RoutingCondition,
} from '@hiva/contracts';
import { z } from 'zod';
import { prisma, type Tx } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { nextCode } from '../lib/codes.js';
import { delegate } from '../workflow/engine.js';
import { allAttachments, allEffects, allGuards } from '../workflow/registry.js';
import { describeRule, factsOf, fieldsNamed, fieldsOf } from '../workflow/custom.js';
import { loadedExtensions } from '../extensions/loader.js';

type RuleInput = z.infer<typeof customRuleSchema>;

/** What the schema cannot know: the transition exists, and every field the condition names does. */
function problems(input: RuleInput): string[] {
  const out: string[] = [];
  const wf = WORKFLOWS[input.entity];
  if (!wf) return [`«${input.entity}» ماشین حالت ندارد`];
  if (!wf.transitions.some((t) => t.action === input.action)) out.push(`انتقال «${input.action}» در «${wf.labelFa}» نیست`);
  if (input.when) {
    const known = new Set(fieldsOf(input.entity).map((f) => f.key));
    const unknown = [...new Set(fieldsNamed(input.when as RoutingCondition))].filter((f) => !known.has(f));
    if (unknown.length) out.push(`این فیلدها در «${wf.labelFa}» نیستند: ${unknown.join('، ')}`);
  }
  return out;
}

const transitionFa = (entity: string, action: string) => WORKFLOWS[entity]?.transitions.find((t) => t.action === action)?.labelFa ?? action;

async function withNames(rows: { createdById: string }[]) {
  const ids = [...new Set(rows.map((r) => r.createdById))];
  return new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
}

const present = (r: Awaited<ReturnType<typeof prisma.customRule.findFirstOrThrow>>, names: Map<string, string>) => ({
  ...r,
  entityFa: WORKFLOWS[r.entity]?.labelFa ?? r.entity,
  transitionFa: transitionFa(r.entity, r.action),
  whenFa: r.when ? describeRule(r.entity, r.when as unknown as RoutingCondition) : null,
  createdByName: names.get(r.createdById) ?? '—',
  current: !r.retiredAt,
});

/**
 * An organisation's own rules on its workflows (roadmap #47), and the whole rule registry beside
 * them. Anyone in the organisation may read the rules — the people a rule stops should be able to
 * see it, and preflight shows it to them anyway. Writing, and trying a draft against records or
 * the past (which reads other people's records), needs `rules.manage`.
 */
const orgRuleRoutes: FastifyPluginAsync = async (app) => {
  const read = { preHandler: [app.authenticate] };
  const manage = { preHandler: [app.authenticate, app.requirePermissions('rules.manage')] };

  /** Every rule standing on the workflows, by where it comes from. */
  app.get('/rules/registry', read, async (req) => {
    const actor = actorFrom(req);
    const own = await prisma.customRule.findMany({ where: { organizationId: actor.organizationId, retiredAt: null }, orderBy: { code: 'asc' } });
    const meta = <T extends { source: string; extension?: string }>(x: T) => ({ source: x.source, extension: x.extension ?? null });
    return {
      extensions: loadedExtensions(),
      guards: allGuards().map((g) => ({ key: g.key, labelFa: g.labelFa, descriptionFa: g.descriptionFa ?? null, ...meta(g) })),
      attachments: allAttachments().map((a) => ({ entity: a.entity, action: a.action, transitionFa: transitionFa(a.entity, a.action), guard: a.guard, ...meta(a) })),
      effects: allEffects().filter((e) => e.source !== 'core').map((e) => ({ key: e.key, entity: e.entity, action: e.action, transitionFa: transitionFa(e.entity, e.action), labelFa: e.labelFa, ...meta(e) })),
      custom: own.length,
    };
  });

  /** What the editor needs: the workflows and their transitions, each entity's fields, roles, operators. */
  app.get('/rules/custom/vocabulary', read, async () => ({
    entities: Object.entries(WORKFLOWS).map(([entity, wf]) => ({
      entity, labelFa: wf.labelFa,
      transitions: wf.transitions.map((t) => ({ action: t.action, labelFa: t.labelFa, guards: t.guards ?? [] })),
      fields: fieldsOf(entity),
    })),
    roles: ROLE_CODES, operators: ROUTING_OPERATORS,
  }));

  app.get('/rules/custom', read, async (req) => {
    const actor = actorFrom(req);
    const { all } = req.query as { all?: string };
    const rows = await prisma.customRule.findMany({
      where: { organizationId: actor.organizationId, ...(all === '1' ? {} : { retiredAt: null }) },
      orderBy: [{ code: 'asc' }, { version: 'desc' }],
    });
    const names = await withNames(rows);
    return rows.map((r) => present(r, names));
  });

  /** One rule's every version, newest first. */
  app.get('/rules/custom/:code', read, async (req) => {
    const actor = actorFrom(req);
    const { code } = req.params as { code: string };
    const rows = await prisma.customRule.findMany({ where: { organizationId: actor.organizationId, code }, orderBy: { version: 'desc' } });
    if (!rows.length) throw notFound('قانون');
    const names = await withNames(rows);
    return rows.map((r) => present(r, names));
  });

  const validated = (body: unknown) => {
    const input = parse(customRuleSchema, body);
    const issues = problems(input);
    if (issues.length) throw new AppError(422, 'RULE_INVALID', issues.join('؛ '), { issues });
    return input;
  };
  const data = (input: RuleInput) => ({
    kind: input.kind, entity: input.entity, action: input.action, labelFa: input.labelFa,
    messageFa: input.messageFa?.trim() || null, when: (input.when ?? undefined) as object | undefined,
    notifyRoles: input.kind === 'NOTIFY' ? input.notifyRoles ?? [] : [],
  });

  app.post('/rules/custom', manage, async (req, reply) => {
    const actor = actorFrom(req);
    const input = validated(req.body);
    const rule = await prisma.$transaction(async (tx: Tx) => tx.customRule.create({
      data: { organizationId: actor.organizationId, code: await nextCode(tx, 'customRule'), version: 1, createdById: actor.id, ...data(input) },
    }));
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'customRule', entityId: rule.id, after: { code: rule.code, version: 1, ...data(input) }, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return reply.code(201).send(present(rule, await withNames([rule])));
  });

  /** A change is a new version; the one it replaces is retired, never edited. */
  app.put('/rules/custom/:code', manage, async (req) => {
    const actor = actorFrom(req);
    const { code } = req.params as { code: string };
    const input = validated(req.body);
    const rule = await prisma.$transaction(async (tx: Tx) => {
      const current = await tx.customRule.findFirst({ where: { organizationId: actor.organizationId, code, retiredAt: null } });
      if (!current) throw notFound('قانون فعال');
      // Retire first — one current version per rule is a database rule — and only if still current:
      // of two edits made at once, one wins and the other is told.
      const retired = await tx.customRule.updateMany({ where: { id: current.id, retiredAt: null }, data: { retiredAt: new Date(), retiredById: actor.id } });
      if (retired.count !== 1) throw new AppError(409, 'RULE_CHANGED', 'این قانون هم‌زمان تغییر کرد؛ صفحه را تازه کنید.');
      const next = await tx.customRule.create({
        data: { organizationId: actor.organizationId, code, version: current.version + 1, createdById: actor.id, ...data(input) },
      });
      await tx.customRule.update({ where: { id: current.id }, data: { supersededById: next.id } });
      return next;
    }).catch(async (e: { code?: string }) => {
      // The unique (code, version): someone published a version a moment ago.
      if (e.code === 'P2002') throw new AppError(409, 'RULE_CHANGED', 'این قانون هم‌زمان تغییر کرد؛ صفحه را تازه کنید.');
      throw e;
    });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'customRule', entityId: rule.id, after: { code, version: rule.version, ...data(input) }, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return present(rule, await withNames([rule]));
  });

  app.post('/rules/custom/:code/retire', manage, async (req) => {
    const actor = actorFrom(req);
    const { code } = req.params as { code: string };
    const { reason } = (req.body ?? {}) as { reason?: string };
    if (!reason?.trim() || reason.trim().length < 5) throw badRequest('REASON_REQUIRED', 'دلیل کنار گذاشتن قانون لازم است');
    const current = await prisma.customRule.findFirst({ where: { organizationId: actor.organizationId, code, retiredAt: null } });
    if (!current) throw notFound('قانون فعال');
    const retired = await prisma.customRule.update({ where: { id: current.id }, data: { retiredAt: new Date(), retiredById: actor.id } });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'customRule', entityId: current.id, before: { retiredAt: null }, after: { code, version: current.version, retiredAt: retired.retiredAt }, reason: reason.trim(), ipAddress: actor.ipAddress, requestId: actor.requestId });
    return present(retired, await withNames([retired]));
  });

  /** A draft rule against one record, now: would it hold, and on which values. Nothing is written. */
  app.post('/rules/custom/test', manage, async (req) => {
    const actor = actorFrom(req);
    const { rule, recordId } = (req.body ?? {}) as { rule?: unknown; recordId?: string };
    const input = validated(rule);
    const record = await delegate(prisma, input.entity).findFirst({ where: { OR: [{ id: recordId ?? '' }, { code: recordId ?? '' }], organizationId: actor.organizationId } });
    if (!record) throw notFound('رکورد');
    const facts = factsOf(record, actor.id);
    const named = input.when ? [...new Set(fieldsNamed(input.when as RoutingCondition))] : [];
    const holds = input.when ? matchesCondition(input.when as RoutingCondition, facts) : true;
    return {
      record: { id: record.id, code: record.code ?? null, state: record.state },
      holds,
      verdictFa: input.kind === 'GUARD'
        ? (holds ? 'برقرار است — انتقال از این قانون می‌گذرد' : 'برقرار نیست — این قانون انتقال را نگه می‌دارد')
        : (holds ? 'آگاه‌سازی فرستاده می‌شد' : 'آگاه‌سازی فرستاده نمی‌شد'),
      whenFa: input.when ? describeCondition(input.when as RoutingCondition, fieldsOf(input.entity) as never) : null,
      values: Object.fromEntries(named.map((k) => [k, facts[k] ?? null])),
    };
  });

  /**
   * A draft guard against the transitions this organisation already made (like the rule lab, #5):
   * which of them it would have held back. Records are judged as they stand today — the only
   * state there is — which the answer says.
   */
  app.post('/rules/custom/replay', manage, async (req) => {
    const actor = actorFrom(req);
    const { rule, limit } = (req.body ?? {}) as { rule?: unknown; limit?: number };
    const input = validated(rule);
    const rows = await prisma.stateTransition.findMany({
      where: { organizationId: actor.organizationId, entityType: input.entity, action: input.action, cascade: false },
      orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(Number(limit) || 500, 1), 2000),
    });
    const ids = [...new Set(rows.map((r) => r.entityId))];
    const records = new Map<string, Record<string, unknown>>(
      (await delegate(prisma, input.entity).findMany({ where: { id: { in: ids }, organizationId: actor.organizationId } }) as Record<string, unknown>[]).map((r) => [String(r.id), r]),
    );
    const hits: { transitionId: string; entityId: string; code: string | null; at: Date; actorId: string | null }[] = [];
    for (const r of rows) {
      const record = records.get(r.entityId);
      if (!record) continue;
      const holds = input.when ? matchesCondition(input.when as RoutingCondition, factsOf(record, r.actorId ?? '')) : true;
      if (input.kind === 'GUARD' ? !holds : holds) hits.push({ transitionId: r.id, entityId: r.entityId, code: (record.code as string) ?? null, at: r.createdAt, actorId: r.actorId });
    }
    return {
      replayed: rows.length,
      count: hits.length,
      hits: hits.slice(0, 100),
      meaningFa: input.kind === 'GUARD' ? 'انتقال‌هایی که این قانون نگه می‌داشت' : 'انتقال‌هایی که آگاه‌سازی می‌فرستادند',
      assumptionFa: 'هر رکورد با مقدارهای امروزش سنجیده شد، نه مقدارهای لحظهٔ انتقال.',
    };
  });
};

export default orgRuleRoutes;
