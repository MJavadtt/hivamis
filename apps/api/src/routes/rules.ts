import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';
import { actorFrom } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { RULE_KINDS, RULE_KIND_LABEL, diffRuleSets, rulesAt, type RuleKind } from '../workflow/rules.js';

/**
 * The rules as they stood at any time (roadmap #4). Read-only: versions come from what the
 * running code declares, registered at boot. Open to whoever may read the audit trail — an
 * auditor's questions are exactly what this answers.
 */
const ruleRoutes: FastifyPluginAsync = async (app) => {
  const gate = { preHandler: [app.authenticate, app.requirePermissions('admin.audit')] };

  app.get('/rules/versions', gate, async () => {
    const rows = await prisma.ruleSetVersion.findMany({
      orderBy: [{ kind: 'asc' }, { version: 'desc' }],
      select: { id: true, kind: true, version: true, hash: true, effectiveFrom: true, note: true },
    });
    return {
      kinds: Object.fromEntries(RULE_KINDS.map((k) => [k, RULE_KIND_LABEL[k]])),
      versions: rows,
      current: Object.fromEntries(RULE_KINDS.map((k) => [k, rows.find((r) => r.kind === k)?.id ?? null])),
    };
  });

  app.get('/rules/versions/:id', gate, async (req) => {
    const { id } = req.params as { id: string };
    const row = await prisma.ruleSetVersion.findUnique({ where: { id } });
    if (!row) throw notFound('نسخهٔ قوانین');
    const transitions = await prisma.stateTransition.count({ where: { OR: [{ rulesVersionId: id }, { permissionsVersionId: id }] } });
    return { ...row, labelFa: RULE_KIND_LABEL[row.kind as RuleKind], transitionsUnder: transitions };
  });

  /** Which versions were effective at an instant — the auditor's first question. */
  app.get('/rules/at', gate, async (req) => {
    const { ts } = req.query as { ts?: string };
    const at = ts ? new Date(ts) : new Date();
    if (Number.isNaN(at.getTime())) throw badRequest('INVALID_TIMESTAMP', 'زمان معتبر نیست', { ts });
    return { at, ...(await rulesAt(prisma, at)) };
  });

  /** What changed between two versions of a kind, in words. Defaults to the last two. */
  app.get('/rules/diff', gate, async (req) => {
    const { kind, from, to } = req.query as { kind?: string; from?: string; to?: string };
    if (!kind || !(RULE_KINDS as readonly string[]).includes(kind)) throw badRequest('INVALID_KIND', 'نوع قوانین باید workflows، permissions یا sla باشد');
    const rows = await prisma.ruleSetVersion.findMany({ where: { kind }, orderBy: { version: 'desc' }, take: 2 });
    const b = to ? await prisma.ruleSetVersion.findFirst({ where: { kind, version: Number(to) } }) : rows[0];
    const a = from ? await prisma.ruleSetVersion.findFirst({ where: { kind, version: Number(from) } }) : rows[1];
    if (!b) throw notFound('نسخهٔ قوانین');
    if (!a) return { kind, from: null, to: b.version, changes: [], note: 'تنها یک نسخه ثبت شده است' };
    return { kind, from: a.version, to: b.version, effectiveFrom: b.effectiveFrom, changes: diffRuleSets(kind as RuleKind, a.snapshot, b.snapshot) };
  });

  /** The rules a given transition was allowed under. */
  app.get('/rules/for-transition/:id', gate, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const t = await prisma.stateTransition.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!t) throw notFound('انتقال');
    const [workflows, permissions] = await Promise.all([
      t.rulesVersionId ? prisma.ruleSetVersion.findUnique({ where: { id: t.rulesVersionId }, select: { id: true, version: true, effectiveFrom: true } }) : null,
      t.permissionsVersionId ? prisma.ruleSetVersion.findUnique({ where: { id: t.permissionsVersionId }, select: { id: true, version: true, effectiveFrom: true } }) : null,
    ]);
    return { transition: { id: t.id, entityType: t.entityType, entityId: t.entityId, action: t.action, at: t.createdAt }, workflows, permissions, stamped: !!(t.rulesVersionId && t.permissionsVersionId) };
  });
};

export default ruleRoutes;
