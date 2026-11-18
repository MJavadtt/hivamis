import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';
import { actorFrom } from '../lib/http.js';
import { narrowed, reachFor, type VisibleModel } from '../auth/visibility.js';

/**
 * Permission-aware global search. Each entity type is queried only when the caller holds
 * the corresponding read permission, so results can never leak across the Sales/Account divide —
 * and only among the records the caller sees (ADR-127).
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
    const reach = await reachFor(req, actor);
    const mine = (model: VisibleModel, where: Record<string, unknown>) => narrowed(model, reach, where);
    const groups: { type: string; labelFa: string; items: unknown[] }[] = [];

    const [companies, opportunities, projects, tasks, contracts, briefs, proposals] = await Promise.all([
      can('crm.company.read') ? prisma.company.findMany({
        where: mine('company', { organizationId: org, deletedAt: null, OR: [{ legalName: like }, { brandName: like }] }),
        select: { id: true, legalName: true, brandName: true }, take: 8,
      }) : [],
      can('crm.opportunity.read') ? prisma.opportunity.findMany({
        where: mine('opportunity', { organizationId: org, deletedAt: null, OR: [{ title: like }, { code: like }] }),
        select: { id: true, code: true, title: true, state: true }, take: 8,
      }) : [],
      can('project.read') ? prisma.project.findMany({
        where: mine('project', { organizationId: org, deletedAt: null, OR: [{ name: like }, { code: like }] }),
        select: { id: true, code: true, name: true, state: true }, take: 8,
      }) : [],
      can('task.read') ? prisma.task.findMany({
        where: mine('task', { organizationId: org, OR: [{ title: like }, { code: like }] }),
        select: { id: true, code: true, title: true, state: true, projectId: true }, take: 8,
      }) : [],
      can('contract.read') ? prisma.contract.findMany({
        where: mine('contract', { organizationId: org, OR: [{ title: like }, { code: like }, { contractNumber: like }] }),
        select: { id: true, code: true, title: true, state: true }, take: 8,
      }) : [],
      can('brief.read') ? prisma.brief.findMany({
        where: mine('brief', { organizationId: org, deletedAt: null, OR: [{ title: like }, { code: like }] }),
        select: { id: true, code: true, title: true, state: true }, take: 8,
      }) : [],
      can('proposal.read') ? prisma.proposal.findMany({
        where: mine('proposal', { organizationId: org, deletedAt: null, OR: [{ title: like }, { code: like }] }),
        select: { id: true, code: true, title: true, state: true }, take: 8,
      }) : [],
    ]);


    /**
     * The rest of the system's records (ADR-136): leads, a client's people, invoices, suppliers,
     * venues, site projects and metro bookings — each under its own read permission and, where the
     * record has an owner, among those the caller sees. A number typed in Persian digits or with
     * spaces and dashes still finds the phone it is.
     */
    const digits = [...term].map((ch) => { const p = '۰۱۲۳۴۵۶۷۸۹'.indexOf(ch), a = '٠١٢٣٤٥٦٧٨٩'.indexOf(ch); return p >= 0 ? String(p) : a >= 0 ? String(a) : ch; })
      .join('').replace(/[\s\-()]/g, '').replace(/^\+98/, '0');
    const phone = /^\d{4,}$/.test(digits) ? { contains: digits } : null;
    const [leads, contacts, invoices, suppliers, venues, siteProjects, metroBookings] = await Promise.all([
      can('crm.lead.read') ? prisma.lead.findMany({
        where: mine('lead', { organizationId: org, deletedAt: null, OR: [{ name: like }, { companyName: like }, { contactName: like }, { code: like }, { email: like }, ...(phone ? [{ phone }] : [])] }),
        select: { id: true, code: true, name: true, companyName: true, state: true, companyId: true }, take: 8,
      }) : [],
      can('crm.contact.read') ? prisma.contact.findMany({
        where: mine('contact', { organizationId: org, deletedAt: null, OR: [{ fullName: like }, { email: like }, ...(phone ? [{ phone }] : [])] }),
        select: { id: true, fullName: true, jobTitle: true, companyId: true, company: { select: { legalName: true } } }, take: 8,
      }) : [],
      can('finance.read') ? prisma.invoice.findMany({
        where: mine('invoice', { organizationId: org, OR: [{ code: like }, { number: like }] }),
        select: { id: true, code: true, number: true, state: true, companyId: true }, take: 8,
      }) : [],
      can('supplier.read') ? prisma.supplier.findMany({
        where: { organizationId: org, OR: [{ name: like }, { contactName: like }, { email: like }, ...(phone ? [{ phone }] : [])] },
        select: { id: true, name: true, contactName: true }, take: 8,
      }) : [],
      can('venue.read') ? prisma.venue.findMany({
        where: { organizationId: org, archivedAt: null, mergedIntoId: null, OR: [{ name: like }, { code: like }, ...(phone ? [{ phone }] : [])] },
        select: { id: true, code: true, name: true }, take: 8,
      }) : [],
      can('site.read') ? prisma.siteProject.findMany({
        where: mine('siteProject', { organizationId: org, archivedAt: null, OR: [{ name: like }, { code: like }] }),
        select: { id: true, code: true, name: true, state: true }, take: 8,
      }) : [],
      can('metro.read') ? prisma.metroBooking.findMany({
        where: { organizationId: org, OR: [{ code: like }, { title: like }, { clientName: like }, { company: { legalName: like } }] },
        select: { id: true, code: true, title: true, clientName: true, state: true, company: { select: { legalName: true } } }, take: 8,
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
    // Where each opens: its own page, or the list it lives in already searching for it.
    const list = (path: string, q: string) => `${path}?q=${encodeURIComponent(q)}`;
    push('lead', 'سرنخ‌ها', leads.map((l) => ({ id: l.id, code: l.code, title: l.name || l.companyName, state: l.state, sub: l.companyName, href: l.companyId ? `/companies/${l.companyId}` : list('/leads', l.code) })));
    push('contact', 'افراد مشتری', contacts.map((c) => ({ id: c.id, title: c.fullName, sub: [c.jobTitle, c.company?.legalName].filter(Boolean).join(' — '), href: `/companies/${c.companyId}` })));
    push('invoice', 'فاکتورها', invoices.map((i) => ({ id: i.id, code: i.code, title: i.number ?? i.code, state: i.state, href: i.companyId ? `/companies/${i.companyId}` : list('/finance', i.code) })));
    push('supplier', 'تأمین‌کنندگان', suppliers.map((x) => ({ id: x.id, title: x.name, sub: x.contactName ?? undefined, href: `/suppliers/${x.id}` })));
    push('venue', 'مکان‌ها', venues.map((v) => ({ id: v.id, code: v.code, title: v.name, href: `/sites/venues/${v.id}` })));
    push('siteProject', 'پروژه‌های محیطی', siteProjects.map((p) => ({ id: p.id, code: p.code, title: p.name, state: p.state, href: `/sites/projects/${p.id}` })));
    push('metroBooking', 'رزروهای مترو', metroBookings.map((b) => ({ id: b.id, code: b.code, title: b.title || b.company?.legalName || b.clientName || b.code, sub: b.company?.legalName ?? b.clientName ?? undefined, state: b.state, href: `/metro/bookings/${b.id}` })));

    return { query: term, groups, total: groups.reduce((s, g) => s + g.items.length, 0) };
  });
};

export default searchRoutes;
