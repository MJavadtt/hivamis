/**
 * QC stage zero (roadmap #22).
 *
 * Doc_H has three human QC levels — the unit, Account, final. Each costs a reviewer's time, and a
 * good share of what the Account desk sends back is not a judgement at all: the PDF that was
 * asked for is not there, the open file is missing, the banner is 1080×1080 when the order said
 * 1080×1920, a draft went up instead of the final. None of that needs a person.
 *
 * This runs those mechanical checks when the unit hands a deliverable to Account, and keeps two
 * kinds of finding strictly apart:
 *  - FAIL — objective and certain: a format the order named is missing, a file is empty, an
 *    image's pixels disagree with dimensions the order spelled out. Only these hold the handover
 *    back (guard `deliverable.passesStageZero`, which the governed waiver of #7 can lift).
 *  - WARN — plausible but not certain: fewer files than the order counted, a file name that looks
 *    like a draft, something that reads like the project's out-of-scope list. Shown, never
 *    blocking: a person decides.
 * What the checker cannot inspect (video dimensions, the contents of a PDF) is listed as not
 * checked, so a pass is never mistaken for a review.
 */
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { Tx } from '../db.js';
import { env } from '../env.js';
import { normalisePersian } from '../memory/embed.js';
import { brandFindingsFa, checkScan } from '../brand/check.js';
import { kitOf, scanOf } from '../brand/kit.js';
import { BRAND_SCANNABLE } from '../brand/scan.js';

export type Severity = 'FAIL' | 'WARN' | 'INFO';

export interface StageZeroFinding {
  check: string;
  severity: Severity;
  messageFa: string;
  fileName?: string;
}

export interface StageZeroResult {
  deliverableId: string;
  verdict: 'PASS' | 'WARN' | 'FAIL';
  findings: StageZeroFinding[];
  /** What was inspected, and what could not be — a pass is only as good as this list. */
  checkedFa: string[];
  notCheckedFa: string[];
  files: { name: string; mimeType: string; sizeBytes: number; width?: number; height?: number }[];
  /** What the handed-over archives contain, by name. */
  archived: { name: string; size: number; archive: string }[];
  requested: { formats: string[]; dimensions: { width: number; height: number }[]; counts: { kind: string; count: number }[] };
}

/**
 * A whole-word matcher. `\b` knows nothing of Persian letters, and a substring match is worse
 * than useless for a check that can FAIL a handover: «ورد» (Word) sits inside «مورد», «تصویر»
 * inside «تصویربرداری». Only a word standing on its own counts.
 */
const word = (...alternatives: string[]) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'iu');

/** Words an order uses for a format, mapped to the files that satisfy it. */
const FORMATS: { key: string; labelFa: string; words: RegExp; extensions: string[] }[] = [
  { key: 'pdf', labelFa: 'PDF', words: word('pdf', 'پی\\s*دی\\s*اف'), extensions: ['.pdf'] },
  { key: 'open', labelFa: 'فایل باز (لایه‌باز)', words: word('فایل\\s*باز', 'لایه\\s*باز', 'open\\s*file', 'source\\s*file', 'psd', 'ai', 'figma', 'فیگما'), extensions: ['.psd', '.ai', '.fig', '.indd', '.aep', '.prproj', '.sketch', '.xd', '.eps', '.svg'] },
  { key: 'video', labelFa: 'ویدئو', words: word('ویدئو', 'ویدیو', 'تیزر', 'mp4', 'mov', 'video'), extensions: ['.mp4', '.mov', '.m4v', '.webm'] },
  { key: 'image', labelFa: 'تصویر', words: word('تصویر', 'عکس', 'پوستر', 'بنر', 'استوری', 'jpe?g', 'png', 'image'), extensions: ['.jpg', '.jpeg', '.png', '.webp'] },
  { key: 'doc', labelFa: 'سند Word', words: word('docx?', 'ورد', 'word'), extensions: ['.doc', '.docx'] },
  { key: 'deck', labelFa: 'ارائه', words: word('pptx?', 'پاورپوینت', 'deck', 'presentation'), extensions: ['.ppt', '.pptx', '.key', '.pdf'] },
  { key: 'sheet', labelFa: 'جدول', words: word('xlsx?', 'اکسل', 'excel'), extensions: ['.xls', '.xlsx', '.csv'] },
];

/** Things an order might count, and the formats that count towards each. */
const COUNTABLE: { kind: string; words: RegExp; format: string }[] = [
  { kind: 'ویدئو', words: /(\d+)\s*(ویدئو|ویدیو|تیزر)/g, format: 'video' },
  { kind: 'پوستر/پست/بنر', words: /(\d+)\s*(پوستر|پست|بنر|استوری|تصویر)/g, format: 'image' },
];

const DRAFT_NAME = /(draft|پیش\s*نویس|پیشنویس|نهایی\s*نشده|\btest\b|تست|copy of|کپی|\bv0\b|\bwip\b|temp)/i;

const toLatinDigits = (v: string) =>
  v.replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660));

/** "1080x1920", "۱۰۸۰×۱۹۲۰", "1080 * 1920" — dimensions an order spelled out. */
export function requestedDimensions(text: string): { width: number; height: number }[] {
  const out: { width: number; height: number }[] = [];
  for (const m of toLatinDigits(text).matchAll(/(\d{2,5})\s*[x×*]\s*(\d{2,5})/gi)) {
    out.push({ width: Number(m[1]), height: Number(m[2]) });
  }
  return out;
}

export function requestedFormats(text: string): string[] {
  return FORMATS.filter((f) => f.words.test(text)).map((f) => f.key);
}

export function requestedCounts(text: string): { kind: string; count: number; format: string }[] {
  const latin = toLatinDigits(text);
  const out: { kind: string; count: number; format: string }[] = [];
  for (const c of COUNTABLE) {
    let total = 0;
    for (const m of latin.matchAll(c.words)) total += Number(m[1]);
    if (total > 0) out.push({ kind: c.kind, count: total, format: c.format });
  }
  return out;
}

/**
 * Pixel dimensions from a PNG or JPEG header — read from the first bytes of the file, without a
 * decoding library. Anything else, or anything malformed, is "unknown", never a guess.
 */
export async function imageDimensions(filePath: string): Promise<{ width: number; height: number } | null> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const head = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const b = head.subarray(0, bytesRead);
    // PNG: signature, then IHDR width/height as big-endian 32-bit at 16 and 20.
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    // JPEG: walk the markers to the first start-of-frame.
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1]!;
        const length = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + length;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * The names inside a ZIP, from its central directory — no library, no decompression. Source
 * files (PSD, AI, Figma, After Effects) are outside the upload allow-list, so in this system an
 * "open file" can only arrive inside an archive; a check that could not look into one would
 * demand something nobody can upload. ZIP64 and damaged archives answer null — "could not read",
 * which the caller turns into a warning, never a failure.
 */
export async function zipEntries(filePath: string): Promise<{ name: string; size: number }[] | null> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const { size } = await handle.stat();
    const tailSize = Math.min(size, 65_535 + 22);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const entries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || cdOffset + cdSize > size) return null;
    const cd = Buffer.alloc(cdSize);
    await handle.read(cd, 0, cdSize, cdOffset);
    const out: { name: string; size: number }[] = [];
    let at = 0;
    for (let n = 0; n < entries && at + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(at) !== 0x02014b50) return null;
      const uncompressed = cd.readUInt32LE(at + 24);
      const nameLength = cd.readUInt16LE(at + 28);
      const extraLength = cd.readUInt16LE(at + 30);
      const commentLength = cd.readUInt16LE(at + 32);
      const name = cd.subarray(at + 46, at + 46 + nameLength).toString('utf8');
      if (!name.endsWith('/') && !name.startsWith('__MACOSX/')) out.push({ name: path.basename(name), size: uncompressed });
      at += 46 + nameLength + extraLength + commentLength;
    }
    return out;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

const extOf = (name: string) => path.extname(name).toLowerCase();

export async function stageZero(tx: Tx, organizationId: string, deliverableId: string): Promise<StageZeroResult> {
  const d = await tx.deliverable.findFirstOrThrow({
    where: { id: deliverableId, organizationId },
    include: {
      documents: { where: { deletedAt: null, supersededAt: null }, select: { fileName: true, storedName: true, mimeType: true, sizeBytes: true, metadata: true } },
      workOrder: { select: { outputFormat: true, expectedOutput: true, deadline: true, code: true } },
      project: { select: { outOfScope: true, companyId: true } },
    },
  });

  /*
   * What the order *requires* comes from its format field alone. The expected-output text says
   * what is being made — «۳ پوستر» — not how it is delivered, and posters routinely arrive as a
   * PDF; reading it as a format requirement would fail a correct handover. Dimensions and counts
   * may be written in either place.
   */
  const formatText = [d.workOrder?.outputFormat, d.format].filter(Boolean).join('\n');
  const anyText = [d.workOrder?.outputFormat, d.workOrder?.expectedOutput, d.format].filter(Boolean).join('\n');
  const formats = requestedFormats(formatText);
  const dimensions = requestedDimensions(anyText);
  const counts = requestedCounts([d.workOrder?.expectedOutput, d.workOrder?.outputFormat].filter(Boolean).join('\n'));
  const findings: StageZeroFinding[] = [];
  const checkedFa: string[] = [];
  const notCheckedFa: string[] = [];
  const storageRoot = path.resolve(env.STORAGE_DIR);

  const files: StageZeroResult['files'] = [];
  /** Names inside archives: they count towards formats and quantities like any other file. */
  const archived: { name: string; size: number; archive: string }[] = [];
  let unreadableArchive: string | null = null;
  for (const doc of d.documents) {
    const entry: StageZeroResult['files'][number] = { name: doc.fileName, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes };
    const full = path.join(storageRoot, doc.storedName);
    if (['.png', '.jpg', '.jpeg'].includes(extOf(doc.fileName))) {
      const dims = await imageDimensions(full);
      if (dims) { entry.width = dims.width; entry.height = dims.height; }
    }
    if (extOf(doc.fileName) === '.zip') {
      const inside = await zipEntries(full);
      if (inside) archived.push(...inside.map((e) => ({ ...e, archive: doc.fileName })));
      else unreadableArchive = doc.fileName;
    }
    files.push(entry);
  }
  /** Every name that could satisfy a requirement: files handed over, and what their archives hold. */
  const names = [...files.map((f) => f.name), ...archived.map((a) => a.name)];

  // 1. Something was handed over at all.
  checkedFa.push('وجود فایل');
  if (!files.length) {
    findings.push(formats.length
      ? { check: 'files', severity: 'FAIL', messageFa: `هیچ فایلی پیوست نشده، در حالی که سفارش ${d.workOrder?.code ?? ''} خروجی ${formats.map((f) => FORMATS.find((x) => x.key === f)!.labelFa).join(' و ')} خواسته است` }
      : { check: 'files', severity: 'WARN', messageFa: 'هیچ فایلی پیوست نشده — اگر خروجی فایل دارد، پیش از تحویل بارگذاری شود' });
  }

  // 2. No empty files.
  checkedFa.push('فایل خالی');
  for (const f of files) {
    if (f.sizeBytes === 0) findings.push({ check: 'empty', severity: 'FAIL', fileName: f.name, messageFa: `فایل «${f.name}» خالی است (۰ بایت)` });
  }
  for (const a of archived) {
    if (a.size === 0) findings.push({ check: 'empty', severity: 'WARN', fileName: a.name, messageFa: `«${a.name}» درون «${a.archive}» خالی است` });
  }
  if (archived.length) checkedFa.push('فهرست فایل‌های درون فایل فشرده');
  if (unreadableArchive) notCheckedFa.push(`محتوای «${unreadableArchive}» خوانده نشد — فرمت‌های درون آن بررسی نشد`);

  // 3. Every format the order named is there.
  if (formats.length && files.length) {
    checkedFa.push('فرمت‌های خواسته‌شده در سفارش');
    for (const key of formats) {
      const spec = FORMATS.find((f) => f.key === key)!;
      if (!names.some((n) => spec.extensions.includes(extOf(n)))) {
        // Certain only if there is nowhere else it could be: an archive we could not read might hold it.
        findings.push(unreadableArchive
          ? { check: 'format', severity: 'WARN', messageFa: `فایل «${spec.labelFa}» دیده نشد — شاید درون «${unreadableArchive}» باشد که خوانده نشد` }
          : { check: 'format', severity: 'FAIL', messageFa: `سفارش «${spec.labelFa}» خواسته، اما فایلی با پسوند ${spec.extensions.slice(0, 4).join('، ')} نه مستقیم پیوست شده و نه درون فایل فشرده است` });
      }
    }
  }

  // 4. Image pixels against dimensions the order spelled out.
  if (dimensions.length) {
    const images = files.filter((f) => f.width && f.height);
    if (images.length) {
      checkedFa.push('ابعاد تصاویر در برابر ابعاد سفارش');
      const wanted = dimensions.map((x) => `${x.width}×${x.height}`).join('، ');
      for (const img of images) {
        const ok = dimensions.some((x) => x.width === img.width && x.height === img.height);
        if (!ok) findings.push({ check: 'dimensions', severity: 'FAIL', fileName: img.name, messageFa: `ابعاد «${img.name}» ${img.width}×${img.height} است؛ سفارش ${wanted} خواسته است` });
      }
    }
    if (files.some((f) => ['.mp4', '.mov', '.m4v', '.webm'].includes(extOf(f.name)))) {
      notCheckedFa.push('ابعاد و مدت ویدئو — ابزار خواندن آن در سامانه نیست؛ بازبین بررسی کند');
    }
  }

  // 5. As many of each as the order counted — a warning: they may be bundled in an archive.
  if (counts.length && files.length) {
    checkedFa.push('تعداد خروجی‌های شمرده‌شده در سفارش');
    const opaque = !!unreadableArchive || files.some((f) => ['.rar', '.7z'].includes(extOf(f.name)));
    // A counted item may arrive in its natural format or in any format the order named.
    const orderExtensions = formats.flatMap((k) => FORMATS.find((f) => f.key === k)!.extensions);
    for (const c of counts) {
      const spec = FORMATS.find((f) => f.key === c.format)!;
      const accepted = new Set([...spec.extensions, ...orderExtensions]);
      const have = names.filter((n) => accepted.has(extOf(n))).length;
      if (have < c.count) {
        findings.push({
          check: 'count', severity: 'WARN',
          messageFa: `سفارش ${c.count} ${c.kind} خواسته و ${have} فایل از این نوع پیوست شده${opaque ? ' — شاید بقیه در فایل فشرده‌ای باشند که خوانده نشد' : ''}`,
        });
      }
    }
  }

  // 6. File names that look like drafts.
  checkedFa.push('نام فایل‌های پیش‌نویس‌مانند');
  for (const n of names) {
    if (DRAFT_NAME.test(n)) findings.push({ check: 'draft', severity: 'WARN', fileName: n, messageFa: `نام «${n}» شبیه پیش‌نویس است — مطمئن شوید نسخهٔ نهایی بارگذاری شده` });
  }

  // 7. Nothing from the project's out-of-scope list — by words, so only a warning.
  const outOfScope = (d.project?.outOfScope ?? '').split(/[،,؛;\n]| و /).map((s) => normalisePersian(s)).filter((s) => s.length > 3);
  if (outOfScope.length) {
    checkedFa.push('موارد خارج از Scope پروژه');
    const haystack = normalisePersian([d.name, d.description, ...names].filter(Boolean).join(' '));
    for (const item of outOfScope) {
      const words = item.split(' ').filter((w) => w.length > 2);
      const hits = words.filter((w) => haystack.includes(w));
      if (words.length && hits.length >= Math.min(2, words.length)) {
        findings.push({ check: 'outOfScope', severity: 'WARN', messageFa: `این خروجی به موردی از فهرست «خارج از Scope» پروژه شبیه است: «${item}» — اگر درست است، درخواست تغییر لازم است` });
      }
    }
  }

  // 8. Late against the order — information for the reviewer, not a quality failure. Judged at
  // the moment of handover (or now, if it has not happened), not against today's date: work
  // delivered on time does not become late by being looked at later.
  const handedOver = d.submittedAt ?? new Date();
  if (d.workOrder?.deadline && d.workOrder.deadline < handedOver) {
    findings.push({ check: 'late', severity: 'INFO', messageFa: 'مهلت سفارش کار پیش از این تحویل گذشته بود' });
  }

  // 9. The client's brand (roadmap #43): each image's main colours and each PDF's colours and
  // typefaces against the brand library. Warnings at most — a photograph or a chart has colours no
  // palette lists, and a person judges; what could not be judged is said.
  const scannable = d.documents.filter((doc) => BRAND_SCANNABLE.includes(doc.mimeType));
  const kit = scannable.length ? await kitOf(tx, d.project?.companyId) : null;
  if (scannable.length && !kit) notCheckedFa.push('هویت بصری — کتابخانهٔ برند این مشتری رنگ و فونتی ندارد');
  if (kit) {
    checkedFa.push('رنگ‌ها و فونت‌ها در برابر کتابخانهٔ برند مشتری');
    const notes = new Set<string>();
    for (const doc of scannable) {
      const scan = await scanOf(doc);
      if (!scan) { notes.add(`«${doc.fileName}» خوانده نشد`); continue; }
      const result = checkScan(scan, kit);
      for (const f of brandFindingsFa(doc.fileName, result)) findings.push({ check: 'brand', severity: f.severity, fileName: doc.fileName, messageFa: f.messageFa });
      result.notesFa.forEach((n) => notes.add(n));
    }
    for (const n of notes) notCheckedFa.push(`هویت بصری: ${n}`);
  }
  if (kit && d.documents.some((doc) => doc.mimeType.startsWith('video/') || ['image/gif', 'image/webp'].includes(doc.mimeType))) {
    notCheckedFa.push('هویت بصری ویدئو و تصاویر GIF/WebP سنجیده نمی‌شود');
  }

  notCheckedFa.push('محتوای فایل‌ها، هماهنگی با بریف، و کاربرد درست لوگو و ترکیب‌بندی — کار بازبین انسانی است');

  const verdict = findings.some((f) => f.severity === 'FAIL') ? 'FAIL' : findings.some((f) => f.severity === 'WARN') ? 'WARN' : 'PASS';
  return {
    deliverableId, verdict, findings, checkedFa, notCheckedFa, files, archived,
    requested: { formats, dimensions, counts: counts.map(({ kind, count }) => ({ kind, count })) },
  };
}
