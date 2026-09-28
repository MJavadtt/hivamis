/**
 * The two inputs of a brand check (roadmap #43): the client's kit, and what a file is made of.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import type { Tx } from '../db.js';
import { env } from '../env.js';
import type { FileMetadata } from '../documents/metadata.js';
import { BRAND_SCANNABLE, BRAND_SCAN_VERSION, imageBrandScan, pdfBrandScan, type BrandScan } from './scan.js';
import type { Kit } from './check.js';

export async function kitOf(tx: Tx, companyId: string | null | undefined): Promise<Kit | null> {
  if (!companyId) return null;
  const row = await tx.brandKit.findUnique({ where: { companyId }, select: { colors: true, fonts: true } });
  if (!row) return null;
  const kit = { colors: (row.colors ?? []) as unknown as Kit['colors'], fonts: (row.fonts ?? []) as unknown as Kit['fonts'] };
  return kit.colors.length || kit.fonts.length ? kit : null;
}

/**
 * The file's scan as kept with its metadata — or, for a file read before the scan existed, made
 * now in memory. Never written from here: this is called from guards and reads.
 */
export async function scanOf(doc: { storedName: string; mimeType: string; metadata: unknown }): Promise<BrandScan | null> {
  if (!BRAND_SCANNABLE.includes(doc.mimeType)) return null;
  const kept = (doc.metadata as FileMetadata | null)?.brand;
  if (kept && kept.v >= BRAND_SCAN_VERSION) return kept;
  const root = path.resolve(env.STORAGE_DIR), target = path.join(root, doc.storedName);
  if (!target.startsWith(root + path.sep)) return null;
  const bytes = await readFile(target).catch(() => null);
  if (!bytes) return null;
  if (doc.mimeType !== 'application/pdf') return imageBrandScan(bytes, doc.mimeType);
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }).catch(() => null);
  return pdf ? pdfBrandScan(pdf) : { v: BRAND_SCAN_VERSION, kind: 'pdf', colours: [], inks: [], skipped: 'UNREADABLE' };
}
