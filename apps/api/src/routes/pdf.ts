import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';
import { actorFrom } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import { DOCUMENT_POLICIES, buildDocument, isDocumentKind } from '../pdf/index.js';
import { renderPdf } from '../pdf/renderer.js';
import { dateTime } from '../pdf/fmt.js';

/**
 * Printed-document endpoints.
 *
 * Exporting is a read: the permission gate is the one that guards the underlying record, and the
 * rendered page is additionally field-redacted (see pdf/access.ts). Every export is written to the
 * audit trail with the list of sections withheld, so a later reviewer can tell which variant of a
 * document a given user actually received.
 */
const pdfRoutes: FastifyPluginAsync = async (app) => {
  /** Document kinds this caller may export — drives which PDF buttons the UI renders. */
  app.get('/pdf/_kinds', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    return Object.entries(DOCUMENT_POLICIES).map(([kind, policy]) => ({
      kind,
      titleFa: policy.titleFa,
      permissions: policy.permissions,
      allowed: policy.permissions.every((p) => actor.permissions.includes(p)),
    }));
  });

  app.get('/pdf/:kind/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const actor = actorFrom(req);
    const { kind, id } = req.params as { kind: string; id: string };

    if (!isDocumentKind(kind)) {
      throw badRequest('UNKNOWN_KIND', `نوع سند «${kind}» پشتیبانی نمی‌شود.`);
    }

    // Same gate as reading the record — a PDF is never a way around the permission model.
    const policy = DOCUMENT_POLICIES[kind];
    await app.requirePermissions(...policy.permissions)(req);

    const doc = await buildDocument(kind, id, actor.organizationId, req.user!);

    // The footer names the person who took the copy; the token carries no display name.
    const exporter = await prisma.user.findUnique({
      where: { id: actor.id },
      select: { fullName: true },
    });
    const footer = `${doc.titleFa} — استخراج توسط ${exporter?.fullName ?? '—'} در ${dateTime(new Date())}`;
    const pdf = await renderPdf(doc.html, {
      headerRight: doc.code,
      landscape: policy.landscape,
      footerNote: footer,
    });

    await audit({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'EXPORT',
      entityType: kind,
      entityId: id,
      after: { format: 'pdf', code: doc.code, withheld: doc.redaction.withheld },
      reason: doc.redaction.withheld.length
        ? `redacted: ${doc.redaction.withheld.join(', ')}`
        : 'full disclosure',
      ipAddress: actor.ipAddress,
      userAgent: req.headers['user-agent'] ?? null,
      requestId: actor.requestId,
    });

    // ASCII fallback plus RFC 5987 form, so Persian document codes survive every browser.
    const safe = `${kind}-${doc.code}`.replace(/[^\w.-]+/g, '_').slice(0, 80);
    const pretty = `${doc.titleFa}-${doc.code}.pdf`;

    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Length', pdf.length)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-store')
      .header(
        'Content-Disposition',
        `attachment; filename="${safe}.pdf"; filename*=UTF-8''${encodeURIComponent(pretty)}`,
      )
      .send(pdf);
  });

  /** Exports recorded for one record — lets an owner see who took a copy and how much they saw. */
  app.get('/pdf/:kind/:id/exports', {
    preHandler: [app.authenticate, app.requirePermissions('admin.audit')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { kind, id } = req.params as { kind: string; id: string };
    return prisma.auditEvent.findMany({
      where: { organizationId: actor.organizationId, action: 'EXPORT', entityType: kind, entityId: id },
      include: { actor: { select: { fullName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });
};

export default pdfRoutes;
