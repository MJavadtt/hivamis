import type { FastifyPluginAsync } from 'fastify';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { GUIDE } from '@hiva/contracts';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { actorFrom } from '../lib/http.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { SIGNATURE_HEAD_BYTES, signatureMatches } from '../lib/file-signature.js';
import { assertDiskFor, writeUpload } from '../documents/storage.js';
import { audit } from '../lib/audit.js';

/**
 * The guide's videos (Hivamis task 8). The owl's tours are drawn on the live page and need no file;
 * a recording is the organisation's own — its screen, its voice — uploaded by the system
 * administrator, one per section and language.
 *
 * A <video> element cannot send the Authorization header, so playing one goes through a link the
 * signed-in person is given: the video's id and an expiry, signed with the server's secret. The
 * link plays that one video until it expires and opens nothing else; byte ranges are served, so the
 * player can seek without downloading the whole file.
 */

const SECTIONS = new Set(GUIDE.map((s) => s.id));
const TYPES: Record<string, string> = { 'video/mp4': '.mp4', 'video/webm': '.webm' };
const LINK_TTL_MS = 3 * 3_600_000;

const sign = (id: string, exp: number) =>
  createHmac('sha256', env.JWT_SECRET).update(`guide-video:${id}:${exp}`).digest('base64url');

function validSignature(id: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const want = Buffer.from(sign(id, exp));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The declared type, from the browser's word or failing that the file's extension. */
function videoType(mimetype: string, filename: string): string | null {
  if (TYPES[mimetype]) return mimetype;
  const ext = path.extname(filename).toLowerCase();
  return ext === '.mp4' || ext === '.m4v' ? 'video/mp4' : ext === '.webm' ? 'video/webm' : null;
}

const guideRoutes: FastifyPluginAsync = async (app) => {
  const storageRoot = path.resolve(env.STORAGE_DIR);
  await mkdir(storageRoot, { recursive: true });
  const signedIn = { preHandler: [app.authenticate] };
  const admin = { preHandler: [app.authenticate, app.requirePermissions('admin.settings')] };

  app.get('/guide/videos', signedIn, async (req) => {
    const actor = actorFrom(req);
    return prisma.guideVideo.findMany({
      where: { organizationId: actor.organizationId },
      select: { id: true, sectionId: true, locale: true, title: true, mimeType: true, sizeBytes: true, createdAt: true, uploadedBy: { select: { fullName: true } } },
      orderBy: [{ sectionId: 'asc' }, { locale: 'asc' }],
    });
  });

  /** Upload a section's video: `?sectionId=&locale=&title=`, the file as the one multipart part. */
  app.post('/guide/videos', admin, async (req, reply) => {
    const actor = actorFrom(req);
    const q = req.query as Record<string, string | undefined>;
    const sectionId = q.sectionId ?? '';
    const locale = q.locale ?? '';
    if (!SECTIONS.has(sectionId)) throw badRequest('UNKNOWN_SECTION', 'این بخش در راهنما نیست.');
    if (locale !== 'fa' && locale !== 'en') throw badRequest('BAD_LOCALE', 'زبان ویدیو باید فارسی یا انگلیسی باشد.');
    const section = GUIDE.find((s) => s.id === sectionId)!;
    const title = (q.title ?? '').trim().slice(0, 120) || section.title[locale];

    await assertDiskFor(Number(req.headers['content-length']) || 0);
    const file = await (req as any).file({ limits: { fileSize: Infinity } });
    if (!file) throw badRequest('NO_FILE', 'فایلی ارسال نشده است.');
    const mimeType = videoType(file.mimetype, file.filename);
    if (!mimeType) {
      file.file.resume();
      throw badRequest('UNSUPPORTED_TYPE', 'ویدیو باید MP4 یا WebM باشد.');
    }

    const storedName = `guide-${randomUUID()}${TYPES[mimeType]}`;
    const target = path.join(storageRoot, storedName);
    let size = 0;
    const head: Buffer[] = [];
    let headBytes = 0;
    file.file.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (headBytes < SIGNATURE_HEAD_BYTES) { head.push(chunk.subarray(0, SIGNATURE_HEAD_BYTES - headBytes)); headBytes += chunk.length; }
    });
    // A stream that breaks off leaves no half-written file behind (audit LOG-5).
    await writeUpload(file.file, target).catch((e) => { reply.header('connection', 'close'); throw e; });
    if (!size || !signatureMatches(mimeType, Buffer.concat(head))) {
      await unlink(target).catch(() => undefined);
      throw badRequest('UNSUPPORTED_TYPE', 'محتوای فایل یک ویدیوی MP4 یا WebM نیست.');
    }

    const [previous, video] = await prisma.$transaction(async (tx) => {
      const old = await tx.guideVideo.findUnique({ where: { organizationId_sectionId_locale: { organizationId: actor.organizationId, sectionId, locale } } });
      if (old) await tx.guideVideo.delete({ where: { id: old.id } });
      const created = await tx.guideVideo.create({
        data: { organizationId: actor.organizationId, sectionId, locale, title, storedName, mimeType, sizeBytes: size, uploadedById: actor.id },
      });
      return [old, created] as const;
    });
    if (previous) await unlink(path.join(storageRoot, previous.storedName)).catch(() => undefined);
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'GUIDE_VIDEO_UPLOAD', entityType: 'guide_video', entityId: video.id,
      after: { sectionId, locale, title, sizeBytes: size, replaced: previous?.id ?? null }, ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return reply.code(201).send({ id: video.id, sectionId, locale, title, mimeType, sizeBytes: size, createdAt: video.createdAt });
  });

  app.delete('/guide/videos/:id', admin, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const video = await prisma.guideVideo.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!video) throw notFound('ویدیو');
    await prisma.guideVideo.delete({ where: { id } });
    await unlink(path.join(storageRoot, video.storedName)).catch(() => undefined);
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'GUIDE_VIDEO_DELETE', entityType: 'guide_video', entityId: id,
      before: { sectionId: video.sectionId, locale: video.locale, title: video.title }, ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return reply.code(204).send();
  });

  /** A link that plays this one video for a few hours. */
  app.get('/guide/videos/:id/link', signedIn, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const video = await prisma.guideVideo.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true } });
    if (!video) throw notFound('ویدیو');
    const exp = Date.now() + LINK_TTL_MS;
    return { url: `/api/v1/guide/videos/${id}/stream?exp=${exp}&sig=${sign(id, exp)}`, expiresAt: new Date(exp).toISOString() };
  });

  app.get('/guide/videos/:id/stream', {
    onSend: async (_req, reply, payload) => {
      // The static handler names its own type; a video is only ever served as the video it was checked to be.
      const type = reply.getHeader('x-guide-type');
      if (type) { reply.header('Content-Type', String(type)); reply.removeHeader('x-guide-type'); }
      return payload;
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { exp, sig } = req.query as { exp?: string; sig?: string };
    if (!validSignature(id, Number(exp), sig ?? '')) throw new AppError(403, 'LINK_INVALID', 'این پیوند ویدیو معتبر نیست یا منقضی شده است.');
    const video = await prisma.guideVideo.findUnique({ where: { id } });
    if (!video) throw notFound('ویدیو');
    return reply
      .header('x-guide-type', video.mimeType)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', 'inline')
      .header('Cache-Control', 'private, max-age=3600')
      .sendFile(video.storedName, storageRoot);
  });
};

export default guideRoutes;
