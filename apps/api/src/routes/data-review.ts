import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';

/**
 * Data review (ADR-136): what the system cannot decide on its own, listed for a person who can.
 *
 * Records are never merged, deleted or relinked here because two names look alike: the brief is
 * explicit that ambiguous records are flagged, not guessed. The page shows the candidates and the
 * reason they were flagged. The one action it offers is linking a lead to a client a person picks
 * themselves, and that is audited. Merging two clients is a decision about which record stays. It
 * is left to the person, through the client's own edit and delete (ADR-132).
 */

/** A name as people mean it: Arabic letters folded into Persian, joiners and spacing ignored, case ignored. */
export function nameKey(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[ۀة]/g, 'ه').replace(/[أإآ]/g, 'ا')
    .replace(/[‌‏‎ً-ٟ]/g, '')
    .replace(/(^|\s)(شرکت|گروه|موسسه|مؤسسه)(?=\s|$)/g, ' ')
    .replace(/[\s.\-_،,()«»"']+/g, '')
    .toLowerCase();
}

const linkSchema = z.object({ companyId: z.string().uuid() });

const dataReviewRoutes: FastifyPluginAsync = async (app) => {
  app.get('/data-review', { preHandler: [app.authenticate, app.requirePermissions('crm.company.read')] }, async (req) => {
    const actor = actorFrom(req);
    const org = actor.organizationId;
    const can = (p: string) => actor.permissions.includes(p);

    const [companies, contacts, leads, units] = await Promise.all([
      prisma.company.findMany({ where: { organizationId: org, deletedAt: null }, select: { id: true, legalName: true, brandName: true, phone: true, createdAt: true } }),
      can('crm.contact.read')
        ? prisma.contact.findMany({ where: { organizationId: org, deletedAt: null, phone: { not: null } }, select: { id: true, fullName: true, phone: true, companyId: true, company: { select: { legalName: true } } } })
        : [],
      can('crm.lead.read')
        ? prisma.lead.findMany({ where: { organizationId: org, deletedAt: null }, select: { id: true, code: true, name: true, companyName: true, state: true, companyId: true, phone: true } })
        : [],
      prisma.department.findMany({ where: { organizationId: org }, select: { id: true, code: true, nameFa: true, managerId: true, manager: { select: { fullName: true, deletedAt: true, isActive: true } } } }),
    ]);

    // Clients whose names say the same thing: a candidate for a person to compare, never merged here.
    const byName = new Map<string, typeof companies>();
    for (const c of companies) {
      const k = nameKey(c.legalName);
      if (k.length >= 2) byName.set(k, [...(byName.get(k) ?? []), c]);
    }
    const duplicateClients = [...byName.values()].filter((g) => g.length > 1)
      .map((g) => g.sort((a, b) => +a.createdAt - +b.createdAt).map((c) => ({ id: c.id, legalName: c.legalName, brandName: c.brandName, phone: c.phone })));

    // One phone on people of different clients, or twice on one: the same person entered twice, or a switchboard.
    const byPhone = new Map<string, typeof contacts>();
    for (const c of contacts) if (c.phone) byPhone.set(c.phone, [...(byPhone.get(c.phone) ?? []), c]);
    const sharedPhones = [...byPhone.entries()].filter(([, g]) => g.length > 1)
      .map(([phone, g]) => ({ phone, contacts: g.map((c) => ({ id: c.id, fullName: c.fullName, companyId: c.companyId, company: c.company?.legalName ?? null })) }));

    // A lead tied to no client, whose company name is a client's: link it when it is the same one.
    const clientsByKey = new Map<string, { id: string; legalName: string }[]>();
    for (const c of companies) clientsByKey.set(nameKey(c.legalName), [...(clientsByKey.get(nameKey(c.legalName)) ?? []), { id: c.id, legalName: c.legalName }]);
    const unlinkedLeads = leads.filter((l) => !l.companyId && l.state !== 'DISQUALIFIED')
      .map((l) => ({ id: l.id, code: l.code, name: l.name, companyName: l.companyName, state: l.state, candidates: clientsByKey.get(nameKey(l.companyName)) ?? [] }))
      .filter((l) => l.candidates.length || l.state === 'CONVERTED')
      // Converted first: those are the ones the old bare state move left without a client.
      .sort((a, b) => Number(b.state === 'CONVERTED') - Number(a.state === 'CONVERTED'));

    // Units whose manager is gone: approvals that go to the unit's manager have no one to go to.
    const unitsWithoutManager = units.filter((u) => !u.managerId || !u.manager || u.manager.deletedAt || !u.manager.isActive)
      .map((u) => ({ id: u.id, code: u.code, nameFa: u.nameFa, manager: u.manager?.fullName ?? null, reason: !u.managerId ? 'NONE' : 'LEFT' }));

    return {
      duplicateClients, sharedPhones, unlinkedLeads, unitsWithoutManager,
      total: duplicateClients.length + sharedPhones.length + unlinkedLeads.length + unitsWithoutManager.length,
    };
  });

  /** A person links a lead to the client they chose. Recorded, as any change of what a record points at. */
  app.post('/data-review/leads/:id/link', { preHandler: [app.authenticate, app.requirePermissions('crm.lead.write')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const { companyId } = parse(linkSchema, req.body ?? {});
    const lead = await prisma.lead.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null } });
    if (!lead) throw notFound('سرنخ');
    if (lead.companyId) throw new AppError(409, 'LEAD_ALREADY_LINKED', 'این سرنخ پیش‌تر به مشتری‌ای پیوند خورده است.');
    const company = await prisma.company.findFirst({ where: { id: companyId, organizationId: actor.organizationId, deletedAt: null }, select: { id: true, legalName: true } });
    if (!company) throw notFound('مشتری');
    await prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id }, data: { companyId } });
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'lead', entityId: id,
        before: { companyId: null }, after: { companyId, company: company.legalName }, reason: 'بازبینی داده — پیوند سرنخ به مشتری',
        ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
      }, tx);
    });
    return { id, companyId };
  });
};

export default dataReviewRoutes;
