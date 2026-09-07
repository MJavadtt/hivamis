import type { FastifyPluginAsync } from 'fastify';
import { aiAskSchema, paginationSchema } from '@hiva/contracts';
import { prisma } from '../db.js';
import { aiEnabled, env } from '../env.js';
import { actorFrom, page, parse } from '../lib/http.js';
import { runAi } from '../ai/service.js';

const aiRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ai/status', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    return {
      enabled: aiEnabled,
      model: aiEnabled ? env.AI_MODEL : null,
      canUse: actor.permissions.includes('ai.use'),
      // Even with no model configured, the deterministic rule engine still returns findings.
      ruleEngineAlwaysAvailable: true,
      capabilities: [
        { code: 'BRIEF_ANALYSIS', labelFa: 'تحلیل بریف', requires: 'brief.read' },
        { code: 'PROJECT_SUMMARY', labelFa: 'خلاصه وضعیت پروژه', requires: 'project.read' },
        { code: 'RISK_DETECTION', labelFa: 'شناسایی ریسک پروژه', requires: 'project.read' },
        { code: 'STATUS_REPORT_DRAFT', labelFa: 'پیش‌نویس گزارش وضعیت', requires: 'project.read' },
        { code: 'CHANGE_IMPACT_ANALYSIS', labelFa: 'تحلیل اثر درخواست تغییر', requires: 'change.read' },
        { code: 'QC_COMPARISON', labelFa: 'تطبیق خروجی با بریف', requires: 'qc.read' },
        { code: 'CUSTOMER_HEALTH', labelFa: 'سلامت مشتری', requires: 'crm.company.read' },
        { code: 'NEXT_BEST_ACTION', labelFa: 'اقدام بعدی پیشنهادی', requires: 'project.read' },
        { code: 'FREE_QUERY', labelFa: 'پرسش آزاد', requires: 'ai.use' },
      ].filter((c) => actor.permissions.includes(c.requires)),
    };
  });

  app.post('/ai/ask', {
    preHandler: [app.authenticate, app.requirePermissions('ai.use')],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req) => {
    const actor = actorFrom(req);
    const input = parse(aiAskSchema, req.body);
    return runAi(input.capability, input.entityId, input.question, {
      id: actor.id, organizationId: actor.organizationId,
      departmentCode: actor.departmentCode, permissions: actor.permissions, roles: actor.roles,
    });
  });

  /** AI governance log — every call, who made it, what it was grounded in. */
  app.get('/ai/interactions', {
    preHandler: [app.authenticate, app.requirePermissions('admin.audit')],
  }, async (req) => {
    const actor = actorFrom(req);
    const q = parse(paginationSchema, req.query);
    const where = { organizationId: actor.organizationId };
    const [items, total] = await Promise.all([
      prisma.aiInteraction.findMany({
        where, include: { user: { select: { id: true, fullName: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
      prisma.aiInteraction.count({ where }),
    ]);
    return page(items, total, q);
  });
};

export default aiRoutes;
