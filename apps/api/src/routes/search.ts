import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';
import { actorFrom } from '../lib/http.js';

/**
 * Permission-aware global search. Each entity type is queried only when the caller holds
 * the corresponding read permission, so results can never leak across the Sales/Account divide.
 */
const searchRoutes: FastifyPluginAsync = async (app) => {
  app.get('/search', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { q } = req.query as { q?: string };
    const term = (q ?? '').trim();
    if (term.length < 2) return { query: term, groups: [] };

    const like = { contains: term, mode: 'insensitive' as const };
    const org = actor.organizationId;
    const can = (p: string) => actor.permissions.includes(p);
    const groups: { type: string; labelFa: string; items: unknown[] }[] = [];

    const [companies, opportunities, projects, tasks, contracts, briefs, proposals] = await Promise.all([
      can('crm.company.read') ? prisma.company.findMany({
        where: { organizationId: org, deletedAt: null, OR: [{ legalName: like }, { brandName: like }] },
        select: { id: true, legalName: true, brandName: true }, take: 8,
      }) : [],
      can('crm.opportunity.read') ? prisma.opportunity.findMany({
        where: { organizationId: org, deletedAt: null, OR: [{ title: like }, { code: like }] },
        select: { id: true, code: true, title: true, state: true }, take: 8,
      }) : [],
      can('project.read') ? prisma.project.findMany({
        where: { organizationId: org, deletedAt: null, OR: [{ name: like }, { code: like }] },
        select: { id: true, code: true, name: true, state: true }, take: 8,
      }) : [],
      can('task.read') ? prisma.task.findMany({
        where: { organizationId: org, OR: [{ title: like }, { code: like }] },
        select: { id: true, code: true, title: true, state: true, projectId: true }, take: 8,
      }) : [],
      can('contract.read') ? prisma.contract.findMany({
        where: { organizationId: org, OR: [{ title: like }, { code: like }, { contractNumber: like }] },
        select: { id: true, code: true, title: true, state: true }, take: 8,
      }) : [],
      can('brief.read') ? prisma.brief.findMany({
        where: { organizationId: org, deletedAt: null, OR: [{ title: like }, { code: like }] },
        select: { id: true, code: true, title: true, state: true }, take: 8,
      }) : [],
      can('proposal.read') ? prisma.proposal.findMany({
        where: { organizationId: org, deletedAt: null, OR: [{ title: like }, { code: like }] },
        select: { id: true, code: true, title: true, state: true }, take: 8,
      }) : [],
    ]);

    const push = (type: string, labelFa: string, items: unknown[]) => {
      if (items.length) groups.push({ type, labelFa, items });
    };
    push('company', 'مشتریان', companies);
    push('opportunity', 'فرصت‌های فروش', opportunities);
    push('project', 'پروژه‌ها', projects);
    push('task', 'وظایف', tasks);
    push('brief', 'بریف‌ها', briefs);
    push('proposal', 'پروپوزال‌ها', proposals);
    push('contract', 'قراردادها', contracts);

    return { query: term, groups, total: groups.reduce((s, g) => s + g.items.length, 0) };
  });
};

export default searchRoutes;
