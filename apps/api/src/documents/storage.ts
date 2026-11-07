import { createWriteStream } from 'node:fs';
import { stat, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';

/**
 * Files on disk (audit LOG-5, ADR-124): what an upload leaves when it fails, how much an organisation
 * may keep, how much of the disk it may take, and when a deleted document's file is finally removed.
 */

const MB = 1024 * 1024;
/** How far an upload runs before it looks at the disk again: others may be filling it too. */
const DISK_CHECK_BYTES = 64 * MB;

const diskFull = () => new AppError(507, 'DISK_FULL', 'فضای دیسک سرور برای این فایل کافی نیست؛ با مدیر نصب هماهنگ کنید.');

/**
 * A file's only limit is the disk, and the database is on it too and stops when it is full, so an upload
 * stays out of STORAGE_RESERVE_MB. Called before an upload is read, with the size it declares, and as it runs.
 */
export async function assertDiskFor(adding: number): Promise<void> {
  const { bavail, bsize } = await statfs(path.resolve(env.STORAGE_DIR));
  if (bavail * bsize - adding < env.STORAGE_RESERVE_MB * MB) throw diskFull();
}

/**
 * A file about to be sent is on disk, or the answer says why not. Without this the static handler
 * answered a missing file with Fastify's «Route GET:… not found», in English, as if the address were wrong:
 * a file purged after its retention (FILE_RETENTION_DAYS), or a database restored without its files.
 */
export async function assertStoredFile(doc: { storedName: string; purgedAt?: Date | null }, root: string): Promise<void> {
  if (doc.purgedAt) throw new AppError(410, 'FILE_PURGED', 'فایل این سند پس از حذف، در پایان دورهٔ نگهداری پاک شده است.');
  const target = path.join(root, doc.storedName);
  const there = target.startsWith(root + path.sep) && (await stat(target).then((s) => s.isFile(), () => false));
  if (!there) throw new AppError(404, 'FILE_MISSING', 'فایل این سند روی سرور پیدا نشد؛ با مدیر نصب هماهنگ کنید.');
}

/** Whether a stored file may be read whole: whatever does so holds it in the memory every request shares. */
export const fitsInMemory = (bytes: number) => bytes <= env.IN_MEMORY_FILE_MB * MB;

/** Writes an upload to `target`. A stream that breaks off, or a disk that runs out, leaves nothing behind. */
export async function writeUpload(stream: Readable, target: string): Promise<void> {
  let unchecked = 0;
  stream.on('data', (chunk: Buffer) => {
    unchecked += chunk.length;
    if (unchecked < DISK_CHECK_BYTES) return;
    unchecked = 0;
    assertDiskFor(0).catch((e) => stream.destroy(e));
  });
  try {
    await pipeline(stream, createWriteStream(target));
  } catch (e) {
    await unlink(target).catch(() => undefined);
    throw (e as NodeJS.ErrnoException).code === 'ENOSPC' ? diskFull() : e;
  }
}

const fa = (v: number) => String(v).replace(/\d/g, (c) => '۰۱۲۳۴۵۶۷۸۹'[Number(c)]!);

/** What an organisation's files take: every document whose file is still on disk, deleted or not. */
export async function storageUsed(organizationId: string): Promise<number> {
  const r = await prisma.document.aggregate({ where: { organizationId, purgedAt: null }, _sum: { sizeBytes: true } });
  return r._sum.sizeBytes ?? 0;
}

/**
 * Refuses a file that would take the organisation past its quota, with 413 and what to do about it.
 * Called before the upload is read, with nothing to add, and after, with its size.
 */
export async function assertStorageFor(organizationId: string, adding: number): Promise<void> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { storageQuotaMb: true } });
  if (org.storageQuotaMb == null) return;
  const used = await storageUsed(organizationId);
  const quota = org.storageQuotaMb * MB;
  if (used + adding <= quota && (adding > 0 || used < quota)) return;
  throw new AppError(413, 'STORAGE_QUOTA',
    `فضای ذخیره‌سازی سازمان پر است: ${fa(Math.ceil(used / MB))} از ${fa(org.storageQuotaMb)} مگابایت به کار رفته. پروندهٔ اسناد حذف‌شده پس از ${fa(env.FILE_RETENTION_DAYS)} روز پاک می‌شود؛ برای فضای بیشتر با مدیر نصب هماهنگ کنید.`,
    { usedMb: Math.ceil(used / MB), quotaMb: org.storageQuotaMb });
}

/**
 * Removes the files of documents deleted more than FILE_RETENTION_DAYS ago. Kept regardless: QC evidence
 * (a review's photo), anything under legal hold, and an e-signature envelope's original or signed copy.
 * The row stays, marked purged, and each removal is in the audit trail.
 */
export async function purgeDeletedFiles(now = new Date()): Promise<{ purged: number; bytes: number }> {
  const before = new Date(now.getTime() - env.FILE_RETENTION_DAYS * 86_400_000);
  const due = await prisma.document.findMany({
    where: {
      deletedAt: { lt: before }, purgedAt: null, legalHold: false, qcReviewId: null,
      envelopesSent: { none: {} }, envelopesSigned: { none: {} },
    },
    select: { id: true, organizationId: true, fileName: true, storedName: true, sizeBytes: true, deletedAt: true },
    take: 500,
  });
  const root = path.resolve(env.STORAGE_DIR);
  let purged = 0, bytes = 0;
  for (const d of due) {
    await prisma.$transaction(async (tx) => {
      // Marked first, in the transaction with its audit row; the file goes after, so a crash leaves a
      // row that says purged over a file that is still there — never a row over a missing file.
      const marked = await tx.document.updateMany({ where: { id: d.id, purgedAt: null, legalHold: false }, data: { purgedAt: now } });
      if (!marked.count) return;
      await audit({
        organizationId: d.organizationId, actorId: null, action: 'PURGE', entityType: 'document', entityId: d.id,
        before: { fileName: d.fileName, sizeBytes: d.sizeBytes, deletedAt: d.deletedAt }, after: { purgedAt: now },
        reason: `file removed ${env.FILE_RETENTION_DAYS} days after the document was deleted`,
      }, tx);
      purged++; bytes += d.sizeBytes;
    });
    const target = path.join(root, d.storedName);
    if (target.startsWith(root + path.sep)) await unlink(target).catch(() => undefined);
  }
  return { purged, bytes };
}
