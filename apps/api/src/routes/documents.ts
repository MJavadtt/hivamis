import type { FastifyPluginAsync } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { actorFrom } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

/** Only these types are accepted; anything executable or unknown is refused. */
const ALLOWED_MIME = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv', 'application/zip', 'video/mp4',
]);

const documentRoutes: FastifyPluginAsync = async (app) => {
  const storageRoot = path.resolve(env.STORAGE_DIR);
  await mkdir(storageRoot, { recursive: true });

  app.get('/documents', {
    preHandler: [app.authenticate, app.requirePermissions('document.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { projectId, companyId, contractId, deliverableId } = req.query as Record<string, string | undefined>;
    return prisma.document.findMany({
      where: {
        organizationId: actor.organizationId, deletedAt: null,
        ...(projectId ? { projectId } : {}), ...(companyId ? { companyId } : {}),
        ...(contractId ? { contractId } : {}), ...(deliverableId ? { deliverableId } : {}),
      },
      include: { uploadedBy: { select: { id: true, fullName: true } } },
      orderBy: { createdAt: 'desc' }, take: 200,
    });
  });

  app.post('/documents', {
    preHandler: [app.authenticate, app.requirePermissions('document.write')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const file = await (req as any).file();
    if (!file) throw badRequest('NO_FILE', 'فایلی ارسال نشده است.');

    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw badRequest('UNSUPPORTED_TYPE', `نوع فایل «${file.mimetype}» مجاز نیست.`);
    }

    // Store under a generated name; the client-supplied filename is never used as a path.
    const ext = path.extname(file.filename).slice(0, 12).replace(/[^.\w]/g, '');
    const storedName = `${randomUUID()}${ext}`;
    const target = path.join(storageRoot, storedName);
    if (!target.startsWith(storageRoot + path.sep)) {
      throw badRequest('BAD_PATH', 'مسیر فایل نامعتبر است.');
    }

    const hash = createHash('sha256');
    let size = 0;
    file.file.on('data', (chunk: Buffer) => { size += chunk.length; hash.update(chunk); });

    await pipeline(file.file, createWriteStream(target));
    if ((file.file as any).truncated) {
      await unlink(target).catch(() => undefined);
      throw badRequest('FILE_TOO_LARGE', `حداکثر حجم مجاز ${env.MAX_UPLOAD_MB} مگابایت است.`);
    }

    const fields = (file.fields ?? {}) as Record<string, { value?: string } | undefined>;
    const val = (k: string) => fields[k]?.value || null;

    const document = await prisma.document.create({
      data: {
        organizationId: actor.organizationId,
        fileName: path.basename(file.filename).slice(0, 200),
        storedName, mimeType: file.mimetype, sizeBytes: size,
        checksum: hash.digest('hex'),
        projectId: val('projectId'), companyId: val('companyId'),
        contractId: val('contractId'), deliverableId: val('deliverableId'),
        submissionId: val('submissionId'),
        tags: val('tags')?.split(',').map((t) => t.trim()).filter(Boolean) ?? [],
        uploadedById: actor.id,
      },
    });

    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'FILE_UPLOAD',
      entityType: 'document', entityId: document.id,
      after: { fileName: document.fileName, sizeBytes: size },
      ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return reply.code(201).send(document);
  });

  app.get('/documents/:id/download', {
    preHandler: [app.authenticate, app.requirePermissions('document.read')],
    /*
     * @fastify/static derives Content-Type from the file extension, which would let an uploaded
     * SVG or HTML file be served with a renderable type. Overriding it in onSend — after the
     * static handler has set its own — guarantees every download is opaque bytes.
     */
    onSend: async (_req, reply, payload) => {
      reply.header('Content-Type', 'application/octet-stream');
      return payload;
    },
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const doc = await prisma.document.findUnique({ where: { id } });
    if (!doc || doc.deletedAt || doc.organizationId !== actor.organizationId) throw notFound('سند');

    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'FILE_DOWNLOAD',
      entityType: 'document', entityId: id, ipAddress: actor.ipAddress,
    });

    // Force download rather than inline rendering — avoids stored-XSS via SVG/HTML.
    return reply
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.fileName)}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .sendFile(doc.storedName, storageRoot);
  });

  app.delete('/documents/:id', {
    preHandler: [app.authenticate, app.requirePermissions('document.delete')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const doc = await prisma.document.findUnique({ where: { id } });
    if (!doc || doc.organizationId !== actor.organizationId) throw notFound('سند');
    // Soft delete: the audit trail must keep pointing at a real row.
    await prisma.document.update({ where: { id }, data: { deletedAt: new Date() } });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'DELETE',
      entityType: 'document', entityId: id, before: doc, ipAddress: actor.ipAddress,
    });
    return reply.code(204).send();
  });
};

export default documentRoutes;
