/**
 * Metadata for files uploaded before it was read at upload — roadmap #42's facts, and #43's brand
 * scan (colours, a PDF's typefaces) — a few at a time, by the job. A file that says nothing
 * readable is marked (`{}`, or a scan marked unreadable), so it is not read again.
 */
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { extractMetadata, type FileMetadata } from './metadata.js';
import { BRAND_SCANNABLE, BRAND_SCAN_VERSION } from '../brand/scan.js';

const READABLE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'application/pdf', 'font/ttf', 'font/otf'];

export async function backfillMetadata(limit = 50) {
  const root = path.resolve(env.STORAGE_DIR);
  const unread = await prisma.document.findMany({
    where: { metadata: { equals: Prisma.DbNull }, deletedAt: null, mimeType: { in: READABLE } },
    select: { id: true, storedName: true, mimeType: true, metadata: true }, take: limit,
  });
  // Read before the brand scan existed, or by an older version of it.
  const unscanned = await prisma.$queryRaw<{ id: string; storedName: string; mimeType: string; metadata: Prisma.JsonValue }[]>`
    SELECT id, "storedName", "mimeType", metadata FROM documents
    WHERE "deletedAt" IS NULL AND metadata IS NOT NULL AND "mimeType" IN (${Prisma.join(BRAND_SCANNABLE)})
      AND COALESCE((metadata->'brand'->>'v')::int, 0) < ${BRAND_SCAN_VERSION}
    LIMIT ${limit}`;
  for (const d of [...unread, ...unscanned]) {
    const target = path.join(root, d.storedName);
    const fresh = target.startsWith(root + path.sep) ? await extractMetadata(target, d.mimeType) : null;
    let metadata: FileMetadata = { ...((d.metadata as FileMetadata | null) ?? {}), ...(fresh ?? {}) };
    if (BRAND_SCANNABLE.includes(d.mimeType) && (metadata.brand?.v ?? 0) < BRAND_SCAN_VERSION) {
      metadata = { ...metadata, brand: { v: BRAND_SCAN_VERSION, kind: d.mimeType === 'application/pdf' ? 'pdf' : 'image', colours: [], inks: [], skipped: 'UNREADABLE' } };
    }
    await prisma.document.update({ where: { id: d.id }, data: { metadata: metadata as object } });
  }
  return { read: unread.length + unscanned.length };
}
