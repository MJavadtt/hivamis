import type { FastifyPluginAsync } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AVATAR_MAX_MB, AVATAR_TYPES, updateProfileSchema } from '@hiva/contracts';
import { prisma, type Tx } from '../db.js';
import { env } from '../env.js';
import { actorFrom, parse } from '../lib/http.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { assertStorageFor } from '../documents/storage.js';
import { avatarUrl, reencodeAvatar, validAvatarLink } from '../profile/avatars.js';

/**
 * A person's profile (audit F-6): their photo and a few words, written by themselves. The photo is
 * a document of the organisation's, but not one of its records: the documents pages leave it out,
 * and it is shown from a signed address (profile/avatars.ts).
 */

const PROFILE = { bio: true, pronouncedName: true, skills: true, links: true, avatarDocumentId: true } as const;

const profileRoutes: FastifyPluginAsync = async (app) => {
  const storageRoot = path.resolve(env.STORAGE_DIR);
  const signedIn = { preHandler: [app.authenticate] };
  const view = ({ avatarDocumentId, ...p }: { avatarDocumentId: string | null; bio: string | null; pronouncedName: string | null; skills: string[]; links: string[] }) =>
    ({ ...p, avatarUrl: avatarUrl(avatarDocumentId) });

  app.get('/me/about', signedIn, async (req) => {
    const actor = actorFrom(req);
    return view(await prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: PROFILE }));
  });

  app.patch('/me/about', signedIn, async (req) => {
    const actor = actorFrom(req);
    const input = parse(updateProfileSchema, req.body);
    return prisma.$transaction(async (tx) => {
      const before = await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: PROFILE });
      const after = await tx.user.update({ where: { id: actor.id, organizationId: actor.organizationId }, data: input, select: PROFILE });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'user', entityId: actor.id, before, after, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return view(after);
    });
  });

  /** A photo replaced or taken away: the old file is let go, kept for the retention period like any deleted file. */
  async function replaceAvatar(tx: Tx, userId: string, organizationId: string, next: string | null) {
    const before = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { avatarDocumentId: true } });
    await tx.user.update({ where: { id: userId, organizationId }, data: { avatarDocumentId: next } });
    if (before.avatarDocumentId) await tx.document.update({ where: { id: before.avatarDocumentId, organizationId }, data: { deletedAt: new Date() } });
    return before.avatarDocumentId;
  }

  app.post('/me/avatar', { ...signedIn, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const actor = actorFrom(req);
    const file = await (req as unknown as { file: () => Promise<{ mimetype: string; toBuffer: () => Promise<Buffer> } | undefined> }).file();
    if (!file) throw badRequest('NO_FILE', 'عکسی فرستاده نشده است.');
    if (!(AVATAR_TYPES as readonly string[]).includes(file.mimetype)) throw badRequest('UNSUPPORTED_TYPE', 'عکس باید JPEG، PNG، WebP یا GIF باشد.');
    const input = await file.toBuffer();
    if (input.length > AVATAR_MAX_MB * 1024 * 1024) throw new AppError(413, 'FILE_TOO_LARGE', `حداکثر حجم عکس ${AVATAR_MAX_MB} مگابایت است.`);
    // Decoding is the check: what is not a readable picture of a sane size is refused here.
    const image = await reencodeAvatar(input).catch(() => { throw badRequest('UNSUPPORTED_IMAGE', 'این فایل عکسِ خوانا نیست.'); });
    await assertStorageFor(actor.organizationId, image.length);

    const id = randomUUID();
    const storedName = `${id}.webp`;
    await writeFile(path.join(storageRoot, storedName), image);
    try {
      await prisma.$transaction(async (tx) => {
        await tx.document.create({
          data: {
            id, organizationId: actor.organizationId, fileName: 'avatar.webp', storedName, mimeType: 'image/webp', sizeBytes: image.length,
            checksum: createHash('sha256').update(image).digest('hex'), uploadedById: actor.id, lineageId: id, version: 1,
          },
        });
        const was = await replaceAvatar(tx, actor.id, actor.organizationId, id);
        await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'user', entityId: actor.id, before: { avatarDocumentId: was }, after: { avatarDocumentId: id }, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      });
    } catch (e) {
      await unlink(path.join(storageRoot, storedName)).catch(() => undefined);
      throw e;
    }
    return { avatarUrl: avatarUrl(id) };
  });

  app.delete('/me/avatar', signedIn, async (req) => {
    const actor = actorFrom(req);
    await prisma.$transaction(async (tx) => {
      const was = await replaceAvatar(tx, actor.id, actor.organizationId, null);
      if (was) await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'user', entityId: actor.id, before: { avatarDocumentId: was }, after: { avatarDocumentId: null }, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
    });
    return { avatarUrl: null };
  });

  /** An administrator of users takes down a photo that should not be there — recorded as theirs. */
  app.delete('/users/:id/avatar', { preHandler: [app.authenticate, app.requirePermissions('admin.users')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const person = await prisma.user.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true } });
    if (!person) throw notFound('کاربر');
    await prisma.$transaction(async (tx) => {
      const was = await replaceAvatar(tx, id, actor.organizationId, null);
      if (was) await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'user', entityId: id, before: { avatarDocumentId: was }, after: { avatarDocumentId: null }, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
    });
    return { avatarUrl: null };
  });

  /** A photo by its signed address — only a current one, only as the WebP this server wrote. */
  app.get('/avatars/:id', {
    // Set here, after the static handler has written its own type and caching.
    onSend: async (req, reply, payload) => {
      if (reply.statusCode !== 200) return payload;
      const left = Math.max(0, Math.floor((Number((req.query as { exp?: string }).exp) - Date.now()) / 1000));
      reply.header('Content-Type', 'image/webp').header('Cache-Control', `private, max-age=${Math.min(left, 86_400)}, immutable`);
      return payload;
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { exp, sig } = req.query as { exp?: string; sig?: string };
    if (!validAvatarLink(id, Number(exp), sig ?? '')) throw new AppError(403, 'LINK_INVALID', 'این پیوند عکس معتبر نیست یا منقضی شده است.');
    const doc = await prisma.document.findFirst({ where: { id, deletedAt: null, purgedAt: null, avatarOf: { isNot: null } }, select: { storedName: true } });
    if (!doc) throw notFound('عکس');
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', 'inline')
      .sendFile(doc.storedName, storageRoot);
  });
};

export default profileRoutes;
