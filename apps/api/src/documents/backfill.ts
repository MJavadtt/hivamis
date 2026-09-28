/**
 * Metadata for files uploaded before roadmap #42 read it at upload — a few at a time, by the job.
 * A file that says nothing readable is marked `{}`, so it is not read again.
 */
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { extractMetadata } from './metadata.js';

const READABLE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'application/pdf', 'font/ttf', 'font/otf'];

export async function backfillMetadata(limit = 50) {
  const root = path.resolve(env.STORAGE_DIR);
  const docs = await prisma.document.findMany({
    where: { metadata: { equals: Prisma.DbNull }, deletedAt: null, mimeType: { in: READABLE } },
    select: { id: true, storedName: true, mimeType: true }, take: limit,
  });
  for (const d of docs) {
    const target = path.join(root, d.storedName);
    const metadata = target.startsWith(root + path.sep) ? await extractMetadata(target, d.mimeType) : null;
    await prisma.document.update({ where: { id: d.id }, data: { metadata: (metadata ?? {}) as object } });
  }
  return { read: docs.length };
}
