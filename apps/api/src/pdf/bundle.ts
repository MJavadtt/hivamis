import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { badRequest } from '../lib/errors.js';
import type { AccessTokenClaims } from '../auth/tokens.js';
import { DOCUMENT_POLICIES, type DocumentKind } from './access.js';
import { buildDocument } from './index.js';
import { renderPdf } from './renderer.js';
import { docHeader, section } from './sections.js';
import { dateTime, esc, num, table } from './fmt.js';

/** Rendering is the slow step; a bundle is capped so one request cannot monopolise the engine. */
export const MAX_BUNDLE_ITEMS = 40;

const EMBEDDABLE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/jpg']);

export interface BundleSelection {
  readonly kind: DocumentKind;
  readonly id: string;
}

export interface BundleRequest {
  readonly items: readonly BundleSelection[];
  readonly fileIds: readonly string[];
}

export interface BundleResult {
  readonly pdf: Buffer;
  /** Sections that made it in, for the audit record. */
  readonly included: { kind: string; id: string; title: string }[];
  /** Files listed on the index page rather than merged, with the reason. */
  readonly notEmbedded: { title: string; reason: string }[];
  readonly withheld: string[];
}

interface Part {
  title: string;
  code: string;
  bytes: Buffer;
}

/**
 * Assemble a dossier: the main document followed by every selected attachment.
 *
 * Access order is re-checked per item — the picker only offers what the caller may export, but the
 * bundle endpoint never trusts the client's list. Each rendered sub-document carries its own
 * field-level redaction, so a bundle can never reveal more than the same user could export one by one.
 */
export async function buildBundle(
  mainKind: DocumentKind,
  mainId: string,
  req: BundleRequest,
  orgId: string,
  user: AccessTokenClaims,
): Promise<BundleResult> {
  if (req.items.length + req.fileIds.length > MAX_BUNDLE_ITEMS) {
    throw badRequest(
      'BUNDLE_TOO_LARGE',
      `حداکثر ${MAX_BUNDLE_ITEMS} پیوست در یک بسته مجاز است. لطفاً تعداد کمتری انتخاب کنید.`,
    );
  }

  const withheld = new Set<string>();
  const parts: Part[] = [];
  const included: BundleResult['included'] = [];
  const notEmbedded: BundleResult['notEmbedded'] = [];

  // 1. Main document.
  const main = await buildDocument(mainKind, mainId, orgId, user);
  main.redaction.withheld.forEach((w) => withheld.add(w));
  parts.push({
    title: main.titleFa,
    code: main.code,
    bytes: await renderPdf(main.html, { headerRight: main.code }),
  });
  included.push({ kind: mainKind, id: mainId, title: `${main.titleFa} — ${main.code}` });

  // 2. Selected records, each re-authorised and rendered with its own redaction.
  for (const item of req.items) {
    const policy = DOCUMENT_POLICIES[item.kind];
    if (!policy) continue;
    if (!policy.permissions.every((p) => user.permissions.includes(p))) {
      // Silently skipped: naming it would disclose that the record exists.
      continue;
    }
    const doc = await buildDocument(item.kind, item.id, orgId, user);
    doc.redaction.withheld.forEach((w) => withheld.add(w));
    parts.push({
      title: doc.titleFa,
      code: doc.code,
      bytes: await renderPdf(doc.html, { headerRight: doc.code, landscape: policy.landscape }),
    });
    included.push({ kind: item.kind, id: item.id, title: `${doc.titleFa} — ${doc.code}` });
  }

  // 3. Uploaded files.
  const files = req.fileIds.length && user.permissions.includes('document.read')
    ? await prisma.document.findMany({
        where: { id: { in: [...req.fileIds] }, organizationId: orgId, deletedAt: null },
      })
    : [];

  const storageRoot = path.resolve(env.STORAGE_DIR);

  for (const doc of files) {
    // Defence in depth: storedName is server-generated, but never let it escape the root.
    const target = path.join(storageRoot, doc.storedName);
    if (!target.startsWith(storageRoot + path.sep)) {
      notEmbedded.push({ title: doc.fileName, reason: 'مسیر فایل نامعتبر است' });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(target);
    } catch {
      notEmbedded.push({ title: doc.fileName, reason: 'فایل روی دیسک یافت نشد' });
      continue;
    }

    if (doc.mimeType === 'application/pdf') {
      parts.push({ title: doc.fileName, code: '', bytes });
      included.push({ kind: 'file', id: doc.id, title: doc.fileName });
    } else if (EMBEDDABLE_IMAGE.has(doc.mimeType)) {
      parts.push({
        title: doc.fileName,
        code: '',
        bytes: await renderPdf(imagePageHtml(doc.fileName, doc.mimeType, bytes), {
          headerRight: main.code,
          footerNote: `پیوست تصویری — ${doc.fileName}`,
        }),
      });
      included.push({ kind: 'file', id: doc.id, title: doc.fileName });
    } else {
      notEmbedded.push({
        title: doc.fileName,
        reason: `نوع «${doc.mimeType}» قابل درج در PDF نیست — جداگانه دریافت کنید`,
      });
    }
  }

  // 4. Cover page, produced last so it can describe what actually made it in.
  const cover = await renderPdf(
    coverHtml(main.titleFa, main.code, included, notEmbedded),
    { headerRight: main.code, footerNote: `بسته اسناد — ${main.code}` },
  );

  // 5. Merge.
  const out = await PDFDocument.create();
  out.setTitle(`${main.titleFa} — ${main.code}`);
  out.setProducer('Hiva OS');
  out.setCreationDate(new Date());

  for (const bytes of [cover, ...parts.map((p) => p.bytes)]) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }

  return {
    pdf: Buffer.from(await out.save()),
    included,
    notEmbedded,
    withheld: [...withheld],
  };
}

/** One page per image attachment, captioned in Persian and scaled to the printable area. */
function imagePageHtml(fileName: string, mimeType: string, bytes: Buffer): string {
  const dataUri = `data:${mimeType};base64,${bytes.toString('base64')}`;
  return [
    docHeader({ title: 'پیوست تصویری', subtitle: fileName }),
    `<div style="text-align:center;margin-top:6mm;">
       <img src="${dataUri}" style="max-width:100%;max-height:210mm;object-fit:contain;" />
     </div>`,
  ].join('');
}

function coverHtml(
  titleFa: string,
  code: string,
  included: BundleResult['included'],
  notEmbedded: BundleResult['notEmbedded'],
): string {
  return [
    docHeader({
      title: 'بسته کامل اسناد',
      code,
      subtitle: `${titleFa} — به همراه ${num(included.length - 1)} پیوست`,
    }),
    section('فهرست محتویات', table(
      ['#', 'سند', 'نوع'],
      included.map((it, i) => [
        `<span class="num">${num(i + 1)}</span>`,
        esc(it.title),
        it.kind === 'file' ? 'فایل پیوست' : 'سند سامانه',
      ]),
    )),
    notEmbedded.length
      ? section('پیوست‌های درج‌نشده', [
          '<p class="muted">این فایل‌ها قابل درج در PDF نبودند و باید جداگانه دریافت شوند:</p>',
          table(['فایل', 'دلیل'], notEmbedded.map((f) => [esc(f.title), esc(f.reason)])),
        ].join(''))
      : '',
    `<div class="rule">این بسته در تاریخ ${dateTime(new Date())} تولید شده است. هر سند مطابق سطح دسترسی
      دریافت‌کننده تولید شده؛ بخش‌های خارج از سطح دسترسی با عبارت «محرمانه» مشخص شده‌اند.</div>`,
  ].join('');
}
