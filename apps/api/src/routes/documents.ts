import type { FastifyPluginAsync } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { parse, actorFrom } from '../lib/http.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { BRAND_ROLES, legalHoldSchema, type BrandRole } from '@hiva/contracts';
import { extractMetadata } from '../documents/metadata.js';
import { SIGNATURE_HEAD_BYTES, signatureMatches } from '../lib/file-signature.js';
import { assertStorageFor, writeUpload } from '../documents/storage.js';
import { audit } from '../lib/audit.js';
import { FINANCIAL_FILE_KINDS, SITE_FILE_KINDS } from '../sites/access.js';
import { isFileRecord, mayReadFile, mayReadRecord, recordInOrganization } from '../documents/records.js';

/** Only these types are accepted; anything executable or unknown is refused. */
const ALLOWED_MIME = new Set([
  // No image/svg+xml: SVG carries script. The download path forces an attachment
  // disposition and octet-stream, but there is no need to accept the format at all.
  'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv', 'application/zip', 'video/mp4',
  // A client's typefaces, for the brand library (roadmap #42).
  'font/ttf', 'font/otf', 'font/woff', 'font/woff2',
]);

/** What the app can show in place: images, video, PDF pages, typefaces. */
const PREVIEWABLE = (mime: string) => mime.startsWith('image/') || mime === 'video/mp4' || mime === 'application/pdf' || mime.startsWith('font/');

/** Browsers name font files inconsistently; the extension settles it, and the signature is still checked. */
const FONT_BY_EXT: Record<string, string> = { '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const declaredType = (mime: string, fileName: string) => {
  const ext = path.extname(fileName).toLowerCase();
  return FONT_BY_EXT[ext] && (mime.startsWith('font/') || mime.includes('font') || mime === 'application/octet-stream' || mime === 'application/vnd.ms-opentype') ? FONT_BY_EXT[ext]! : mime;
};

const documentRoutes: FastifyPluginAsync = async (app) => {
  const storageRoot = path.resolve(env.STORAGE_DIR);
  await mkdir(storageRoot, { recursive: true });

  app.get('/documents', {
    preHandler: [app.authenticate, app.requirePermissions('document.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { projectId, companyId, contractId, deliverableId, proposalId, versions, venueId, siteProjectId, recordType, recordId } = req.query as Record<string, string | undefined>;
    const rows = await prisma.document.findMany({
      where: {
        // A file shared in a conversation is its members' (audit F-5), served by the chat alone.
        organizationId: actor.organizationId, deletedAt: null, chatConversationId: null,
        // A person's photo (audit F-6) is not one of the organisation's files.
        avatarOf: { is: null },
        // The current version of each file, unless every version is asked for (roadmap #42).
        ...(versions === 'all' ? {} : { supersededAt: null }),
        ...(projectId ? { projectId } : {}), ...(companyId ? { companyId } : {}),
        ...(contractId ? { contractId } : {}), ...(deliverableId ? { deliverableId } : {}),
        ...(proposalId ? { proposalId } : {}),
        ...(venueId ? { venueId } : {}), ...(siteProjectId ? { siteProjectId } : {}),
        ...(recordType ? { recordType } : {}), ...(recordId ? { recordId } : {}),
      },
      include: { uploadedBy: { select: { id: true, fullName: true } } },
      orderBy: { createdAt: 'desc' }, take: 200,
    });
    // A venue's photo or a deployment project's file is read with that module's permission (ADR-103),
    // and a record's file as the record is (ADR-121).
    const readable = await Promise.all(rows.map((d) => mayReadFile(actor, d)));
    return rows.filter((_, i) => readable[i]);
  });

  app.post('/documents', {
    preHandler: [app.authenticate, app.requirePermissions('document.write')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const file = await (req as any).file();
    if (!file) throw badRequest('NO_FILE', 'فایلی ارسال نشده است.');

    // A full store refuses before a byte is read (audit LOG-5).
    await assertStorageFor(actor.organizationId, 0);
    const mimeType = declaredType(file.mimetype, file.filename);
    if (!ALLOWED_MIME.has(mimeType)) {
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
    const headChunks: Buffer[] = [];
    let headBytes = 0;
    file.file.on('data', (chunk: Buffer) => {
      size += chunk.length;
      hash.update(chunk);
      // Keep just enough of the leading bytes to verify the declared type; the file itself is
      // never buffered.
      if (headBytes < SIGNATURE_HEAD_BYTES) {
        headChunks.push(chunk.subarray(0, SIGNATURE_HEAD_BYTES - headBytes));
        headBytes += chunk.length;
      }
    });

    // A stream that breaks off leaves no half-written file behind (audit LOG-5).
    await writeUpload(file.file, target);
    if ((file.file as any).truncated) {
      await unlink(target).catch(() => undefined);
      throw badRequest('FILE_TOO_LARGE', `حداکثر حجم مجاز ${env.MAX_UPLOAD_MB} مگابایت است.`);
    }
    await assertStorageFor(actor.organizationId, size).catch(async (e) => { await unlink(target).catch(() => undefined); throw e; });

    // The declared Content-Type is client-controlled; confirm the bytes agree with it.
    if (!signatureMatches(mimeType, Buffer.concat(headChunks))) {
      await unlink(target).catch(() => undefined);
      throw badRequest(
        'UNSUPPORTED_TYPE',
        `محتوای فایل با نوع اعلام‌شده «${file.mimetype}» مطابقت ندارد.`,
      );
    }

    const fields = (file.fields ?? {}) as Record<string, { value?: string } | undefined>;
    const val = (k: string) => fields[k]?.value || null;

    /**
     * The attachment targets arrive as multipart fields and were written straight to the row.
     * Verify each exists inside the caller's organisation, so an upload cannot be filed against
     * another tenant's project or a record that does not exist.
     */
    const fail = async (code: string, message: string, status = 400) => {
      await unlink(target).catch(() => undefined);
      throw new AppError(status, code, message);
    };

    /**
     * A new version of a file already here (roadmap #42): it takes the file's place — its links,
     * its lineage, the next version number — and the old version is kept, marked superseded.
     */
    const replacesId = val('replacesId');
    const replaced = replacesId
      ? await prisma.document.findFirst({ where: { id: replacesId, organizationId: actor.organizationId, deletedAt: null, chatConversationId: null } })
      : null;
    if (replacesId && !replaced) return fail('UNKNOWN_REFERENCE', 'فایلی که نسخهٔ تازه‌اش را می‌فرستید پیدا نشد.', 422);
    if (replaced?.supersededAt) return fail('DOCUMENT_SUPERSEDED', 'نسخهٔ تازه‌تری از این فایل پیش‌تر بارگذاری شده است؛ روی آخرین نسخه کار کنید.', 409);
    if (replaced?.qcReviewId) return fail('QC_EVIDENCE_FIXED', 'عکس شاهد بررسی کیفیت نسخهٔ تازه نمی‌گیرد؛ آنچه آن روز دیده شد همان می‌ماند.', 409);

    const links = replaced
      ? { projectId: replaced.projectId, companyId: replaced.companyId, contractId: replaced.contractId, deliverableId: replaced.deliverableId, submissionId: replaced.submissionId, proposalId: replaced.proposalId, venueId: replaced.venueId, siteProjectId: replaced.siteProjectId }
      : {
          projectId: val('projectId'), companyId: val('companyId'), contractId: val('contractId'),
          deliverableId: val('deliverableId'), submissionId: val('submissionId'), proposalId: val('proposalId'),
          venueId: val('venueId'), siteProjectId: val('siteProjectId'),
        };

    // A brand-library file: on a client, by someone who keeps brands.
    const brandRole = replaced?.brandRole ?? val('brandRole');
    if (brandRole) {
      if (!BRAND_ROLES.includes(brandRole as BrandRole)) return fail('BAD_BRAND_ROLE', 'نقش فایل در کتابخانهٔ برند نامعتبر است.');
      if (!links.companyId) return fail('BRAND_NEEDS_CLIENT', 'فایل کتابخانهٔ برند باید به یک مشتری وصل باشد.');
      if (!actor.permissions.includes('brand.manage')) return fail('FORBIDDEN', 'برای افزودن به کتابخانهٔ برند به دسترسی «brand.manage» نیاز دارید.', 403);
    }
    /**
     * Evidence of a QC review (roadmap #49) — the photo from the set. It is the review's, not the
     * deliverable's, whose files are the work itself; so it is filed on nothing else, is an image,
     * and is added by the reviewer on the day of the review, not amended into it later.
     */
    const qcReviewId = replaced ? replaced.qcReviewId : val('qcReviewId');
    if (qcReviewId && !replaced) {
      const review = await prisma.qcReview.findFirst({ where: { id: qcReviewId, organizationId: actor.organizationId }, select: { reviewerId: true, reviewedAt: true } });
      if (!review) return fail('UNKNOWN_REFERENCE', 'بررسی کیفیتی که عکس برایش است پیدا نشد.', 422);
      if (review.reviewerId !== actor.id) return fail('FORBIDDEN', 'عکس شاهد را فقط کسی می‌افزاید که بررسی را ثبت کرده است.', 403);
      if (Date.now() - review.reviewedAt.getTime() > 24 * 3_600_000) return fail('QC_EVIDENCE_LATE', 'عکس شاهد تا یک روز پس از ثبت بررسی پذیرفته می‌شود.', 409);
      if (!mimeType.startsWith('image/')) return fail('QC_EVIDENCE_IMAGE', 'شاهد بررسی کیفیت باید عکس باشد.');
      if (Object.values(links).some(Boolean) || brandRole) return fail('QC_EVIDENCE_ALONE', 'عکس شاهد فقط به بررسی کیفیت وصل می‌شود، نه به پرونده‌ای دیگر.');
    }
    /**
     * A file shared in a conversation (audit F-5): by a member who may chat, on nothing else. It is
     * the conversation's — the documents routes do not list or serve it; the chat does, to members.
     */
    const chatConversationId = replaced ? null : val('chatConversationId');
    if (chatConversationId) {
      const member = actor.permissions.includes('chat.use') && await prisma.chatMember.count({
        where: { conversationId: chatConversationId, userId: actor.id, leftAt: null, conversation: { organizationId: actor.organizationId, archivedAt: null } },
      });
      if (!member) return fail('UNKNOWN_REFERENCE', 'ارجاع «chatConversationId» نامعتبر است.', 422);
      if (Object.values(links).some(Boolean) || brandRole || qcReviewId) return fail('CHAT_FILE_ALONE', 'فایل گفت‌وگو فقط به همان گفت‌وگو وصل می‌شود.');
    }
    /**
     * A venue's photo, or a deployment project's file (ADR-103): filed by someone who may write there, on
     * nothing else, and — for a project — as evidence of a record of that project: a contract version, an
     * approval, a negotiation, a payment, a deposit deduction. A receipt or a deduction's evidence is the
     * ledger's, filed by whoever keeps it.
     */
    const site = replaced
      ? { siteRecordType: replaced.siteRecordType, siteRecordId: replaced.siteRecordId, category: replaced.category, caption: val('caption') ?? replaced.caption, takenAt: replaced.takenAt }
      : { siteRecordType: val('siteRecordType'), siteRecordId: val('siteRecordId'), category: val('category')?.slice(0, 40) ?? null, caption: val('caption')?.slice(0, 300) ?? null, takenAt: val('takenAt') ? new Date(val('takenAt')!) : null };
    if (site.takenAt && Number.isNaN(site.takenAt.getTime())) return fail('VALIDATION_ERROR', 'تاریخ عکس نامعتبر است.');
    if (replaced?.siteRecordType === 'contract' && replaced.siteRecordId && !(await prisma.siteContract.count({ where: { id: replaced.siteRecordId, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } } }))) {
      return fail('SITE_EVIDENCE_FIXED', 'فایل قراردادی که درباره‌اش تصمیم گرفته شده نسخهٔ تازه نمی‌گیرد؛ نسخهٔ تازهٔ قرارداد ثبت کنید.', 409);
    }
    if (links.venueId || links.siteProjectId) {
      const others = Object.entries(links).filter(([k, v]) => v && k !== 'venueId' && k !== 'siteProjectId');
      if (others.length || (links.venueId && links.siteProjectId) || brandRole || qcReviewId || chatConversationId) return fail('SITE_FILE_ALONE', 'فایل مکان یا پروژهٔ استقرار فقط به همان وصل می‌شود.');
    }
    if (links.venueId && !replaced) {
      if (!actor.permissions.includes('venue.write')) return fail('FORBIDDEN', 'برای افزودن عکس و فایل مکان به دسترسی «venue.write» نیاز دارید.', 403);
    }
    if (links.siteProjectId && !replaced) {
      const kind = site.siteRecordType ?? 'general';
      if (!(SITE_FILE_KINDS as readonly string[]).includes(kind)) return fail('VALIDATION_ERROR', 'نوع پیوست پروژهٔ استقرار نامعتبر است.');
      site.siteRecordType = kind;
      const needs = FINANCIAL_FILE_KINDS.has(kind) ? 'rental.manage' : 'site.write';
      if (!actor.permissions.includes(needs)) return fail('FORBIDDEN', `برای افزودن این پیوست به دسترسی «${needs}» نیاز دارید.`, 403);
      const recordOf: Record<string, ((id: string) => Promise<number>) | null> = {
        contract: (rid) => prisma.siteContract.count({ where: { id: rid, organizationId: actor.organizationId, siteProjectId: links.siteProjectId!, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } } }),
        approval: (rid) => prisma.siteApproval.count({ where: { id: rid, organizationId: actor.organizationId, siteProjectId: links.siteProjectId! } }),
        negotiation: (rid) => prisma.siteNegotiation.count({ where: { id: rid, organizationId: actor.organizationId, siteProjectId: links.siteProjectId! } }),
        payment: (rid) => prisma.sitePayment.count({ where: { id: rid, organizationId: actor.organizationId, siteProjectId: links.siteProjectId! } }),
        deduction: (rid) => prisma.siteDepositEntry.count({ where: { id: rid, organizationId: actor.organizationId, siteProjectId: links.siteProjectId!, kind: 'DEDUCTION' } }),
        installation: null, general: null,
      };
      const check = recordOf[kind];
      if (check && (!site.siteRecordId || !(await check(site.siteRecordId)))) {
        return fail('UNKNOWN_REFERENCE', kind === 'contract' ? 'فایل قرارداد به نسخه‌ای پیوست می‌شود که هنوز تصمیمی درباره‌اش گرفته نشده.' : 'رکوردی از این پروژه که پیوست برای آن است پیدا نشد.', 422);
      }
      if (!check) site.siteRecordId = null;
    } else if (!links.siteProjectId && !replaced) {
      site.siteRecordType = null; site.siteRecordId = null;
    }
    /**
     * A file on any other record (ADR-121): on that record alone, by someone who may read it, in this
     * organisation. Another's record, or none, answers as `links` do below.
     */
    const record = replaced ? { recordType: replaced.recordType, recordId: replaced.recordId } : { recordType: val('recordType'), recordId: val('recordId') };
    if (!replaced && (record.recordType || record.recordId)) {
      const { recordType, recordId } = record;
      if (!isFileRecord(recordType) || !recordId) return fail('VALIDATION_ERROR', 'پرونده‌ای که فایل به آن پیوست می‌شود نامعتبر است.');
      if (Object.values(links).some(Boolean) || brandRole || qcReviewId || chatConversationId) return fail('RECORD_FILE_ALONE', 'پیوست یک پرونده فقط به همان پرونده وصل می‌شود.');
      if (!(await recordInOrganization(recordType, recordId, actor.organizationId))) return fail('UNKNOWN_REFERENCE', 'پرونده‌ای که فایل به آن پیوست می‌شود پیدا نشد.', 422);
      if (!(await mayReadRecord(actor, recordType, recordId))) return fail('FORBIDDEN', 'به این پرونده دسترسی ندارید.', 403);
    }
    const owners: Record<keyof typeof links, { count: (a: object) => Promise<number> }> = {
      projectId: prisma.project, companyId: prisma.company, contractId: prisma.contract,
      deliverableId: prisma.deliverable, submissionId: prisma.formSubmission, proposalId: prisma.proposal,
      venueId: prisma.venue, siteProjectId: prisma.siteProject,
    };
    for (const [field, id] of replaced ? [] : Object.entries(links)) {
      if (!id) continue;
      const found = await owners[field as keyof typeof links].count({
        where: { id, organizationId: actor.organizationId },
      });
      if (found === 0) {
        await unlink(target).catch(() => undefined);
        // One answer for "no such record" and "another organisation's record": 422, as registerCrud gives.
        throw new AppError(422, 'UNKNOWN_REFERENCE', `ارجاع «${field}» نامعتبر است.`);
      }
    }

    const id = randomUUID();
    const metadata = await extractMetadata(target, mimeType);
    const document = await prisma.$transaction(async (tx) => {
      const created = await tx.document.create({
        data: {
          id,
          organizationId: actor.organizationId,
          fileName: path.basename(file.filename).slice(0, 200),
          storedName, mimeType, sizeBytes: size,
          checksum: hash.digest('hex'),
          projectId: links.projectId, companyId: links.companyId,
          contractId: links.contractId, deliverableId: links.deliverableId,
          submissionId: links.submissionId, proposalId: links.proposalId, qcReviewId, chatConversationId,
          venueId: links.venueId, siteProjectId: links.siteProjectId, ...site, ...record,
          tags: val('tags')?.split(',').map((t) => t.trim()).filter(Boolean) ?? replaced?.tags ?? [],
          uploadedById: actor.id,
          lineageId: replaced ? replaced.lineageId ?? replaced.id : id,
          version: replaced ? replaced.version + 1 : 1,
          metadata: (metadata ?? undefined) as object | undefined,
          brandRole: brandRole ?? null,
        },
      });
      if (replaced) {
        // Only the current version may be replaced; two uploads racing on it cannot both win.
        const r = await tx.document.updateMany({ where: { id: replaced.id, supersededAt: null }, data: { supersededAt: new Date(), supersededById: id } });
        if (r.count !== 1) throw new AppError(409, 'DOCUMENT_SUPERSEDED', 'نسخهٔ تازه‌تری از این فایل هم‌زمان بارگذاری شد.');
      }
      return created;
    }).catch(async (e) => { await unlink(target).catch(() => undefined); throw e; });

    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'FILE_UPLOAD',
      entityType: 'document', entityId: document.id,
      after: { fileName: document.fileName, sizeBytes: size, ...(replaced ? { replaces: replaced.id, version: document.version } : {}), ...(brandRole ? { brandRole } : {}), ...(qcReviewId ? { qcReviewId } : {}), ...(chatConversationId ? { chatConversationId } : {}) },
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
    if (!doc || doc.deletedAt || doc.organizationId !== actor.organizationId || doc.chatConversationId || !(await mayReadFile(actor, doc))) throw notFound('سند');

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

  /**
   * A file shown in the app — a thumbnail, the annotator, a version compared (roadmap #42). The
   * bytes are the same as a download; what differs is the record: one FILE_VIEW row per person,
   * file and hour, so a page of thumbnails is not a pile of downloads. The anomaly scan still
   * counts every distinct file a person viewed. Only what the app can show is served here.
   */
  app.get('/documents/:id/preview', {
    preHandler: [app.authenticate, app.requirePermissions('document.read')],
    onSend: async (_req, reply, payload) => {
      reply.header('Content-Type', 'application/octet-stream');
      // A version's bytes never change (a new version is a new id), so the browser may keep them a
      // while; set here because the static handler writes its own.
      if (reply.statusCode === 200) reply.header('Cache-Control', 'private, max-age=300');
      return payload;
    },
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const doc = await prisma.document.findUnique({ where: { id } });
    if (!doc || doc.deletedAt || doc.organizationId !== actor.organizationId || doc.chatConversationId || !(await mayReadFile(actor, doc))) throw notFound('سند');
    if (!PREVIEWABLE(doc.mimeType)) throw new AppError(422, 'PREVIEW_UNSUPPORTED', 'این نوع فایل پیش‌نمایش ندارد؛ آن را دریافت کنید.');
    const seen = await prisma.auditEvent.findFirst({
      where: { actorId: actor.id, action: 'FILE_VIEW', entityType: 'document', entityId: id, createdAt: { gte: new Date(Date.now() - 3_600_000) } },
      select: { id: true },
    });
    if (!seen) {
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'FILE_VIEW', entityType: 'document', entityId: id, ipAddress: actor.ipAddress, requestId: actor.requestId });
    }
    return reply
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.fileName)}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .sendFile(doc.storedName, storageRoot);
  });

  /** Every version of a file, oldest first, with what each one says about itself (roadmap #42). */
  app.get('/documents/:id/versions', {
    preHandler: [app.authenticate, app.requirePermissions('document.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const doc = await prisma.document.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null, chatConversationId: null }, select: { id: true, lineageId: true, venueId: true, siteProjectId: true, siteRecordType: true, recordType: true, recordId: true } });
    if (!doc || !(await mayReadFile(actor, doc))) throw notFound('سند');
    const lineage = doc.lineageId ?? doc.id;
    const rows = await prisma.document.findMany({
      where: { organizationId: actor.organizationId, deletedAt: null, OR: [{ lineageId: lineage }, { id: lineage }] },
      orderBy: { version: 'asc' },
      select: {
        id: true, fileName: true, mimeType: true, sizeBytes: true, checksum: true, version: true, metadata: true, createdAt: true,
        supersededAt: true, clientVisible: true, uploadedBy: { select: { fullName: true } }, _count: { select: { annotations: true } },
      },
    });
    return rows.map(({ _count, ...r }) => ({ ...r, current: !r.supersededAt, annotations: _count.annotations }));
  });

  /**
   * Audit LOG-5: a legal hold — a dispute, an inquiry — keeps the document's file whatever happens to the
   * document, past the retention period, until it is lifted. The legal team's to place and lift.
   */
  app.post('/documents/:id/legal-hold', {
    preHandler: [app.authenticate, app.requirePermissions('contract.legal_review')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const { hold, reason } = parse(legalHoldSchema, req.body ?? {});
    const doc = await prisma.document.findFirst({ where: { id, organizationId: actor.organizationId, chatConversationId: null } });
    if (!doc) throw notFound('سند');
    if (doc.purgedAt) throw conflict('ALREADY_PURGED', 'پروندهٔ این سند پیش‌تر پاک شده است؛ نگه‌داشتی برای آن نمی‌ماند.');
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.document.update({ where: { id }, data: { legalHold: hold, legalHoldReason: hold ? reason! : null } });
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: hold ? 'LEGAL_HOLD' : 'LEGAL_HOLD_RELEASED',
        entityType: 'document', entityId: id, before: { legalHold: doc.legalHold, legalHoldReason: doc.legalHoldReason },
        after: { legalHold: u.legalHold, legalHoldReason: u.legalHoldReason }, reason: reason ?? null,
        ipAddress: actor.ipAddress, requestId: actor.requestId,
      }, tx);
      return u;
    });
    return { id, legalHold: updated.legalHold, legalHoldReason: updated.legalHoldReason };
  });

  app.delete('/documents/:id', {
    preHandler: [app.authenticate, app.requirePermissions('document.delete')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const doc = await prisma.document.findUnique({ where: { id } });
    if (!doc || doc.organizationId !== actor.organizationId || doc.chatConversationId || !(await mayReadFile(actor, doc))) throw notFound('سند');
    // A deployment project's evidence stays once what it evidences is decided (ADR-103): a contract
    // sent or approved, an approval, a payment, a decided deduction.
    if (doc.siteProjectId && doc.siteRecordId) {
      const decided =
        doc.siteRecordType === 'contract' ? await prisma.siteContract.count({ where: { id: doc.siteRecordId, status: { not: 'DRAFT' } } })
        : doc.siteRecordType === 'deduction' ? await prisma.siteDepositEntry.count({ where: { id: doc.siteRecordId, status: { not: 'PROPOSED' } } })
        : doc.siteRecordType === 'approval' || doc.siteRecordType === 'payment' ? 1 : 0;
      if (decided) throw new AppError(409, 'SITE_EVIDENCE_FIXED', 'این پیوست شاهد تصمیمی ثبت‌شده است و برداشته نمی‌شود؛ نسخهٔ تازه بارگذاری کنید.');
    }
    // A QC review's evidence (roadmap #49) is taken back only by its reviewer, the same day — a
    // wrong photo corrected, not a record of what was seen edited afterwards.
    if (doc.qcReviewId && (doc.uploadedById !== actor.id || Date.now() - doc.createdAt.getTime() > 24 * 3_600_000)) {
      throw new AppError(409, 'QC_EVIDENCE_FIXED', 'عکس شاهد بررسی کیفیت را فقط بررسی‌کننده و همان روز می‌تواند بردارد.');
    }
    // Soft delete: the audit trail must keep pointing at a real row. Taking back the current
    // version makes the one it replaced current again (roadmap #42).
    await prisma.$transaction([
      prisma.document.update({ where: { id }, data: { deletedAt: new Date() } }),
      ...(doc.supersededAt ? [] : [prisma.document.updateMany({ where: { supersededById: id, deletedAt: null }, data: { supersededAt: null, supersededById: null } })]),
    ]);
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'DELETE',
      entityType: 'document', entityId: id, before: doc, ipAddress: actor.ipAddress,
    });
    return reply.code(204).send();
  });
};

export default documentRoutes;
