/**
 * The evidence of a client's approval (roadmap #35), and how it is checked.
 *
 * Three hashes, each over something that can be recomputed:
 *   - each file's SHA-256, read from storage when the request is made and again whenever the file
 *     is served — a file that no longer matches is not served as the one approved;
 *   - the manifest hash — over what the client was shown: the subject, its client-facing content
 *     and the file hashes, frozen when the request is made;
 *   - the evidence hash — over the decision with who, when, from where, how the approver was
 *     verified, the log of what they did before deciding, and the previous decision's evidence
 *     hash in the organisation, so one decision cannot be rewritten without every later one.
 *
 * JSON is hashed in one canonical form: keys sorted, no whitespace, dates as ISO strings.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';

export const GENESIS = '0'.repeat(64);

export function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const hashOf = (value: unknown) => sha256(canonical(value));

/** The SHA-256 of a stored file, streamed — a video is never held in memory. Null when it is gone. */
export async function hashStoredFile(storageRoot: string, storedName: string): Promise<string | null> {
  const target = path.join(storageRoot, storedName);
  if (!target.startsWith(storageRoot + path.sep)) return null;
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(target)) hash.update(chunk as Buffer);
  } catch {
    return null;
  }
  return hash.digest('hex');
}

export interface ManifestFile { documentId: string; fileName: string; mimeType: string; sizeBytes: number; sha256: string }
export interface Manifest {
  v: 1;
  organization: string;
  subject: { type: 'DELIVERABLE' | 'PROPOSAL'; id: string; code: string; title: string; version: string; context: string | null };
  /** What the client reads on the page, as it read it — for a proposal, the offer itself. */
  content: Record<string, string | null>;
  files: ManifestFile[];
  contact: { name: string; email: string };
  message: string | null;
  requestedAt: string;
  expiresAt: string;
}

export interface EvidenceEvent { seq: number; kind: string; documentId: string | null; ip: string | null; userAgent: string | null; at: string }
export interface Evidence {
  v: 1;
  approval: string;
  organizationId: string;
  manifestHash: string;
  decision: 'APPROVE' | 'REQUEST_CHANGES';
  comment: string | null;
  signerName: string;
  contact: { name: string; email: string };
  /** PORTAL — decided from the addressee's own portal session (#34). */
  verification: 'EMAIL_CODE' | 'LINK' | 'PORTAL';
  portalUserId?: string;
  decidedAt: string;
  ip: string | null;
  userAgent: string | null;
  /** The decision came from an address the organisation's own staff have used in the last 30 days. */
  staffAddress: boolean;
  events: EvidenceEvent[];
  sequence: number;
  prevEvidenceHash: string;
}

export interface Problem { code: string; message: string }

/** Every check a later reader would make, with what failed named. */
export function checkEvidence(row: {
  manifest: unknown; manifestHash: string; evidence: unknown; evidenceHash: string | null; decision: string | null; comment: string | null;
  signerName: string | null; contactEmail: string; decidedIp: string | null; sequence: number | null; prevEvidenceHash: string | null;
}, events: EvidenceEvent[], previous: { evidenceHash: string | null } | null, fileHashes: Record<string, string | null>): Problem[] {
  const problems: Problem[] = [];
  if (hashOf(row.manifest) !== row.manifestHash) problems.push({ code: 'MANIFEST_ALTERED', message: 'فهرست آنچه به مشتری نشان داده شد با اثر انگشت ثبت‌شده‌اش نمی‌خواند.' });
  for (const f of (row.manifest as Manifest).files) {
    const now = fileHashes[f.documentId];
    if (now === null || now === undefined) problems.push({ code: 'FILE_MISSING', message: `فایل «${f.fileName}» در بایگانی نیست.` });
    else if (now !== f.sha256) problems.push({ code: 'FILE_ALTERED', message: `فایل «${f.fileName}» با نسخه‌ای که مشتری دید یکی نیست.` });
  }
  if (!row.evidence || !row.evidenceHash) return problems;
  const e = row.evidence as Evidence;
  if (hashOf(e) !== row.evidenceHash) problems.push({ code: 'EVIDENCE_ALTERED', message: 'سند تصمیم با اثر انگشت ثبت‌شده‌اش نمی‌خواند.' });
  const fields: [string, unknown, unknown][] = [
    ['manifestHash', e.manifestHash, row.manifestHash], ['decision', e.decision, row.decision], ['comment', e.comment, row.comment],
    ['signerName', e.signerName, row.signerName], ['contact', e.contact.email, row.contactEmail], ['ip', e.ip, row.decidedIp],
    ['sequence', e.sequence, row.sequence], ['prevEvidenceHash', e.prevEvidenceHash, row.prevEvidenceHash],
  ];
  const differ = fields.filter(([, a, b]) => a !== b).map(([k]) => k);
  if (differ.length) problems.push({ code: 'RECORD_ALTERED', message: `ستون‌های رکورد با سند تصمیم نمی‌خوانند: ${differ.join('، ')}` });
  const last = Math.max(0, ...e.events.map((x) => x.seq));
  const logged = events.filter((x) => x.seq <= last);
  if (canonical(logged) !== canonical(e.events)) problems.push({ code: 'LOG_ALTERED', message: 'رویدادهای پیش از تصمیم با آنچه در سند تصمیم آمده یکی نیستند.' });
  const expectedPrev = e.sequence === 1 ? GENESIS : previous?.evidenceHash ?? null;
  if (expectedPrev !== e.prevEvidenceHash) problems.push({ code: 'CHAIN_BROKEN', message: 'حلقهٔ زنجیره با تصمیم پیشین سازمان نمی‌خواند.' });
  return problems;
}
