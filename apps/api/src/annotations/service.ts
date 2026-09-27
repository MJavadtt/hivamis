/**
 * Annotation on deliverables (roadmap #38): where on the file, in words a revision can carry.
 *
 * A pin on an image, a moment in a video, a region of a PDF page — each numbered on its file. When
 * a QC review fails, the annotations it carries become the revision's required correction, one
 * numbered line each, saying which file and where; the unit fixes against those lines and marks
 * each resolved.
 */
import type { Tx } from '../db.js';

export type AnnotatableKind = 'image' | 'video' | 'pdf';
export const kindOfFile = (mime: string): AnnotatableKind | null =>
  mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime === 'application/pdf' ? 'pdf' : null;
/** What each file kind is annotated with. */
export const ANNOTATION_FOR: Record<AnnotatableKind, 'PIN' | 'TIMECODE' | 'HIGHLIGHT'> = { image: 'PIN', video: 'TIMECODE', pdf: 'HIGHLIGHT' };

const FA = '۰۱۲۳۴۵۶۷۸۹';
const fa = (v: string | number) => String(v).replace(/\d/g, (d) => FA[Number(d)]!);
export const timecode = (sec: number) => {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return fa(`${h ? `${String(h).padStart(2, '0')}:` : ''}${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`);
};

export interface Placed { kind: string; number: number; page: number | null; timeSec: number | null; note: string; fileName: string }

export function placeFa(a: Placed) {
  if (a.kind === 'HIGHLIGHT') return `${a.fileName} — صفحهٔ ${fa(a.page ?? 1)}`;
  if (a.kind === 'TIMECODE') return `${a.fileName} — ${timecode(a.timeSec ?? 0)}`;
  return `${a.fileName} — نشانهٔ ${fa(a.number)}`;
}

/** The revision's required correction: the reviewer's words, then each annotation where it is. */
export function composeCorrection(findings: string | null | undefined, annotations: Placed[]): string {
  const lines = annotations.map((a, i) => `${fa(i + 1)}. [${placeFa(a)}] ${a.note}`);
  return [findings?.trim(), lines.length ? `یادداشت‌های روی فایل:\n${lines.join('\n')}` : ''].filter(Boolean).join('\n\n');
}

/** The next number on a file — the unique (document, number) pair makes a race fail rather than repeat. */
export async function nextNumber(tx: Tx, documentId: string) {
  const last = await tx.annotation.aggregate({ where: { documentId }, _max: { number: true } });
  return (last._max.number ?? 0) + 1;
}
