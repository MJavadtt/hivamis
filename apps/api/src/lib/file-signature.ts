/**
 * Magic-byte verification for uploads.
 *
 * `file.mimetype` comes from the multipart Content-Type header, which the client writes and can
 * say anything. Checking it alone means a .exe declared as application/pdf is stored as a PDF.
 * These signatures are checked against the bytes actually received.
 *
 * Hand-rolled rather than pulling in `file-type`: the allow-list is fifteen formats reducible to
 * seven signatures, the container formats (OOXML, legacy Office) share two of them, and the
 * dependency would bring an ESM-only tree for a table that fits on a screen.
 */

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

interface Signature {
  /** Byte offset the pattern starts at. */
  readonly offset: number;
  readonly bytes: readonly number[];
}

/** A declared type is accepted when the head matches ANY of its signatures. */
const SIGNATURES: Record<string, readonly Signature[]> = {
  'application/pdf': [{ offset: 0, bytes: ascii('%PDF-') }],
  'image/png': [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  'image/jpeg': [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  'image/gif': [{ offset: 0, bytes: ascii('GIF87a') }, { offset: 0, bytes: ascii('GIF89a') }],
  // RIFF container with a WEBP fourcc; the four bytes between are the file length.
  'image/webp': [{ offset: 0, bytes: ascii('RIFF') }],
  'video/mp4': [{ offset: 4, bytes: ascii('ftyp') }],
  // Matroska/WebM: the EBML header (the guide's screen recordings, Hivamis task 8).
  'video/webm': [{ offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] }],
  // Brand typefaces (roadmap #42): TrueType (version 1.0 or Apple's 'true'), OpenType/CFF, WOFF 1 and 2.
  'font/ttf': [{ offset: 0, bytes: [0x00, 0x01, 0x00, 0x00] }, { offset: 0, bytes: ascii('true') }],
  'font/otf': [{ offset: 0, bytes: ascii('OTTO') }],
  'font/woff': [{ offset: 0, bytes: ascii('wOFF') }],
  'font/woff2': [{ offset: 0, bytes: ascii('wOF2') }],
};

/** ZIP local-file header, plus the empty and spanned variants. */
const ZIP: readonly Signature[] = [
  { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  { offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06] },
  { offset: 0, bytes: [0x50, 0x4b, 0x07, 0x08] },
];

/** OLE2 compound document — the pre-2007 Office container. */
const OLE2: readonly Signature[] = [
  { offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];

for (const t of [
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]) SIGNATURES[t] = ZIP;

for (const t of [
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
]) SIGNATURES[t] = OLE2;

/** Text formats carry no signature, so they are checked for the absence of binary content. */
const TEXT_TYPES = new Set(['text/plain', 'text/csv']);

const matches = (head: Buffer, sig: Signature): boolean =>
  head.length >= sig.offset + sig.bytes.length &&
  sig.bytes.every((b, i) => head[sig.offset + i] === b);

/**
 * True when `head` is consistent with `declared`.
 *
 * Container formats are deliberately verified only to their container: a .docx is a ZIP, and
 * this confirms it is one. Distinguishing a Word document from any other ZIP would mean
 * parsing the archive, which is a different job from rejecting a mislabelled binary.
 */
export function signatureMatches(declared: string, head: Buffer): boolean {
  if (head.length === 0) return false;

  if (TEXT_TYPES.has(declared)) {
    // A NUL byte in the first chunk means this is not the text file it claims to be.
    // UTF-16 text is the known false negative here, and is not a format this app accepts.
    return !head.subarray(0, 1024).includes(0x00);
  }

  const sigs = SIGNATURES[declared];
  // An allow-listed type with no signature entry would otherwise pass unchecked.
  if (!sigs) return false;
  return sigs.some((s) => matches(head, s));
}

/** How many leading bytes the checks above need. */
export const SIGNATURE_HEAD_BYTES = 1024;
