/**
 * Magic-byte verification for uploads.
 *
 * `file.mimetype` comes from the multipart Content-Type header, which the client writes and can
 * say anything. Checking it alone means a .exe declared as application/pdf is stored as a PDF.
 * These signatures are checked against the bytes actually received.
 *
 * Hand-rolled rather than pulling in `file-type`: the allow-list reduces to a few dozen signatures,
 * the container formats (OOXML, OpenDocument, legacy Office) share two of them, and the dependency
 * would bring an ESM-only tree for a table that fits on a screen.
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
  // The studio's and the printers' working files (ADR-123): layered, vector and print formats.
  'image/bmp': [{ offset: 0, bytes: ascii('BM') }],
  'image/tiff': [{ offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] }, { offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] }],
  // A phone's photo: an ISO media file, as an MP4 is.
  'image/heic': [{ offset: 4, bytes: ascii('ftyp') }],
  'image/vnd.adobe.photoshop': [{ offset: 0, bytes: ascii('8BPS') }],
  // Illustrator saves a PDF, or PostScript in older versions.
  'application/illustrator': [{ offset: 0, bytes: ascii('%PDF-') }, { offset: 0, bytes: ascii('%!PS') }],
  'application/postscript': [{ offset: 0, bytes: ascii('%!PS') }, { offset: 0, bytes: [0xc5, 0xd0, 0xd3, 0xc6] }],
  'application/x-indesign': [{ offset: 0, bytes: [0x06, 0x06, 0xed, 0xf5, 0xd8, 0x1d, 0x46, 0xe5, 0xbd, 0x31, 0xef, 0xe7, 0xfe, 0x74, 0xb7, 0x1d] }],
  // CorelDRAW, which the print shops here live in: RIFF in old versions, ZIP since X4.
  'application/vnd.corel-draw': [{ offset: 0, bytes: ascii('RIFF') }, { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }],
  'application/rtf': [{ offset: 0, bytes: ascii('{\\rtf') }],
  'application/vnd.rar': [{ offset: 0, bytes: ascii('Rar!') }],
  'application/x-7z-compressed': [{ offset: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] }],
  'video/quicktime': ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].map((box) => ({ offset: 4, bytes: ascii(box) })),
  'video/x-msvideo': [{ offset: 0, bytes: ascii('RIFF') }],
  'audio/mpeg': [{ offset: 0, bytes: ascii('ID3') }, { offset: 0, bytes: [0xff, 0xfb] }, { offset: 0, bytes: [0xff, 0xf3] }, { offset: 0, bytes: [0xff, 0xf2] }],
  'audio/wav': [{ offset: 0, bytes: ascii('RIFF') }],
  'audio/mp4': [{ offset: 4, bytes: ascii('ftyp') }],
  'audio/ogg': [{ offset: 0, bytes: ascii('OggS') }],
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
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
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
    // UTF-16 says so in its first two bytes — Excel's «Unicode text» is how Persian often leaves a sheet.
    if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) return true;
    // Otherwise a NUL byte in the first chunk means this is not the text file it claims to be.
    return !head.subarray(0, 1024).includes(0x00);
  }

  const sigs = SIGNATURES[declared];
  // An allow-listed type with no signature entry would otherwise pass unchecked.
  if (!sigs) return false;
  return sigs.some((s) => matches(head, s));
}

/** How many leading bytes the checks above need. */
export const SIGNATURE_HEAD_BYTES = 1024;
