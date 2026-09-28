import type { FastifyPluginAsync } from 'fastify';
import { BRAND_ROLES, brandKitSchema } from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';

/** A client's brand library (roadmap #42): palette, typefaces, and the brand files on the client. */
const brandRoutes: FastifyPluginAsync = async (app) => {
  app.get('/companies/:id/brand', { preHandler: [app.authenticate, app.requirePermissions('document.read')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const company = await prisma.company.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true, legalName: true, brandName: true } });
    if (!company) throw notFound('مشتری');
    const [kit, files] = await Promise.all([
      prisma.brandKit.findUnique({ where: { companyId: id } }),
      prisma.document.findMany({
        where: { organizationId: actor.organizationId, companyId: id, brandRole: { not: null }, deletedAt: null, supersededAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true, lineageId: true, fileName: true, mimeType: true, sizeBytes: true, brandRole: true, version: true, metadata: true, createdAt: true, uploadedBy: { select: { fullName: true } } },
      }),
    ]);
    // Logos first, then typefaces, the guide, images — the order the library is read in.
    const rank = (r: string | null) => BRAND_ROLES.indexOf(r as (typeof BRAND_ROLES)[number]);
    files.sort((a, b) => rank(a.brandRole) - rank(b.brandRole));
    return { company, kit: kit ?? { colors: [], fonts: [], notes: null, updatedAt: null }, files };
  });

  app.put('/companies/:id/brand', { preHandler: [app.authenticate, app.requirePermissions('brand.manage')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(brandKitSchema, req.body);
    const company = await prisma.company.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true } });
    if (!company) throw notFound('مشتری');
    const before = await prisma.brandKit.findUnique({ where: { companyId: id } });
    const data = { colors: input.colors, fonts: input.fonts, notes: input.notes ?? null, updatedById: actor.id };
    const kit = await prisma.brandKit.upsert({ where: { companyId: id }, create: { organizationId: actor.organizationId, companyId: id, ...data }, update: data });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: before ? 'UPDATE' : 'CREATE', entityType: 'brandKit', entityId: kit.id, before, after: kit, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return kit;
  });
};

export default brandRoutes;
