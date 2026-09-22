/**
 * The organisation's memory (roadmap #21).
 *
 * Doc_H's whole closure ritual — lessons learned, case studies, client feedback, closure
 * minutes — exists so the next project is better than the last. In practice nobody reads last
 * year's closure forms, because finding the relevant one means remembering it exists. This is
 * the index that answers "what have we done before that looks like this".
 *
 * Six kinds go in, each reduced to the text worth remembering: briefs, proposals, meeting
 * minutes, lessons learned, client feedback, status reports. Retrieval is hybrid — the cosine
 * of the embedding, plus trigram similarity on the normalised text — because with the local
 * embedder (no service configured) meaning alone is weak, and a keyword nobody would have
 * guessed is still worth finding.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import type { Tx } from '../db.js';
import { cosine, embed, embeddingServiceConfigured, LOCAL_MODEL, normalisePersian } from './embed.js';

export type MemoryKind = 'brief' | 'proposal' | 'meeting' | 'lessonLearned' | 'feedback' | 'statusReport';

export const MEMORY_KINDS: MemoryKind[] = ['brief', 'proposal', 'meeting', 'lessonLearned', 'feedback', 'statusReport'];

export const KIND_LABEL_FA: Record<MemoryKind, string> = {
  brief: 'بریف',
  proposal: 'پروپوزال',
  meeting: 'صورتجلسه',
  lessonLearned: 'درس آموخته',
  feedback: 'بازخورد مشتری',
  statusReport: 'گزارش وضعیت',
};

/** The permission each kind is read under — memory can never widen anyone's reach. */
export const KIND_PERMISSION: Record<MemoryKind, string> = {
  brief: 'brief.read',
  proposal: 'proposal.read',
  meeting: 'project.read',
  lessonLearned: 'project.read',
  feedback: 'project.read',
  statusReport: 'report.read',
};

export const KIND_HREF: Record<MemoryKind, (id: string, projectId: string | null) => string> = {
  brief: (id) => `/briefs/${id}`,
  proposal: (id) => `/proposals/${id}`,
  meeting: (_id, projectId) => (projectId ? `/projects/${projectId}` : '/projects'),
  lessonLearned: (_id, projectId) => (projectId ? `/projects/${projectId}` : '/projects'),
  feedback: (_id, projectId) => (projectId ? `/projects/${projectId}` : '/projects'),
  statusReport: (_id, projectId) => (projectId ? `/projects/${projectId}` : '/projects'),
};

interface Source {
  entityType: MemoryKind;
  entityId: string;
  projectId: string | null;
  companyId: string | null;
  titleFa: string;
  body: string;
  sourceUpdatedAt: Date;
}

const join = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join('\n');

/** Everything worth remembering, as text. One query per kind; the corpus is agency-sized. */
export async function collectSources(tx: Tx, organizationId: string, kinds: MemoryKind[] = MEMORY_KINDS): Promise<Source[]> {
  const out: Source[] = [];
  const wanted = new Set(kinds);

  if (wanted.has('brief')) {
    for (const b of await tx.brief.findMany({ where: { organizationId }, take: 2_000 })) {
      out.push({
        entityType: 'brief', entityId: b.id, projectId: null, companyId: null,
        titleFa: b.title,
        body: join(b.title, b.businessObjective, b.targetAudience, b.scope, b.expectedDeliverables, b.competitorContext, b.successCriteria, b.constraints),
        sourceUpdatedAt: b.updatedAt,
      });
    }
  }
  if (wanted.has('proposal')) {
    for (const p of await tx.proposal.findMany({ where: { organizationId }, include: { brief: { select: { title: true } } }, take: 2_000 })) {
      out.push({
        entityType: 'proposal', entityId: p.id, projectId: null, companyId: null,
        titleFa: p.title || (p.brief?.title ? `پروپوزال ${p.brief.title}` : p.code),
        body: join(p.title, p.brief?.title, p.executiveSummary, p.approach, p.deliverablesSummary, p.timelineSummary, p.pricingRationale, p.clientFeedback),
        sourceUpdatedAt: p.updatedAt,
      });
    }
  }
  if (wanted.has('meeting')) {
    for (const m of await tx.meeting.findMany({ where: { organizationId }, take: 3_000 })) {
      out.push({
        entityType: 'meeting', entityId: m.id, projectId: m.projectId, companyId: m.companyId,
        titleFa: m.subject,
        body: join(m.subject, m.agenda, m.decisions, typeof m.actions === 'string' ? m.actions : JSON.stringify(m.actions)),
        sourceUpdatedAt: m.updatedAt,
      });
    }
  }
  if (wanted.has('lessonLearned')) {
    for (const l of await tx.lessonLearned.findMany({ where: { organizationId }, take: 3_000 })) {
      out.push({
        entityType: 'lessonLearned', entityId: l.id, projectId: l.projectId, companyId: null,
        titleFa: l.title,
        body: join(l.title, l.category, l.situation, l.lesson, l.recommendation),
        sourceUpdatedAt: l.createdAt,
      });
    }
  }
  if (wanted.has('feedback')) {
    for (const f of await tx.feedback.findMany({ where: { organizationId }, include: { project: { select: { name: true } } }, take: 3_000 })) {
      const body = join(f.positives, f.improvements, f.futureNeeds);
      if (!body.trim()) continue;                     // a rating with no words remembers nothing
      out.push({
        entityType: 'feedback', entityId: f.id, projectId: f.projectId, companyId: null,
        titleFa: `بازخورد ${f.project?.name ?? ''}`.trim(),
        body, sourceUpdatedAt: f.createdAt,
      });
    }
  }
  if (wanted.has('statusReport')) {
    for (const r of await tx.statusReport.findMany({ where: { organizationId }, include: { project: { select: { name: true } } }, take: 3_000 })) {
      out.push({
        entityType: 'statusReport', entityId: r.id, projectId: r.projectId, companyId: null,
        titleFa: `گزارش ${r.project?.name ?? ''} — ${r.period}`.trim(),
        body: join(r.progress, r.risks, r.issues, r.decisionsNeeded),
        sourceUpdatedAt: r.createdAt,
      });
    }
  }
  return out;
}

export interface IndexResult { scanned: number; indexed: number; removed: number; model: string }

/**
 * Bring the index up to date. Only what changed is re-embedded — the source's own timestamp
 * decides — so a scheduled run over an unchanged corpus costs one query per kind and no
 * embedding calls at all.
 */
export async function reindexMemory(
  organizationId: string, opts: { kinds?: MemoryKind[]; force?: boolean } = {},
): Promise<IndexResult> {
  const sources = await collectSources(prisma, organizationId, opts.kinds);
  const existing = await prisma.memoryDocument.findMany({
    where: { organizationId, ...(opts.kinds ? { entityType: { in: opts.kinds } } : {}) },
    select: { id: true, entityType: true, entityId: true, sourceUpdatedAt: true, model: true },
  });
  const byKey = new Map(existing.map((e) => [`${e.entityType}:${e.entityId}`, e]));
  const wantedModel = embeddingServiceConfigured() ? null : LOCAL_MODEL;

  let indexed = 0;
  for (const source of sources) {
    const key = `${source.entityType}:${source.entityId}`;
    const current = byKey.get(key);
    byKey.delete(key);
    const stale = !current
      || opts.force
      || current.sourceUpdatedAt.getTime() < source.sourceUpdatedAt.getTime()
      // A deployment that gains an embedding service should not keep answering with hash vectors.
      || (wantedModel !== null && current.model !== wantedModel);
    if (!stale) continue;

    const text = `${source.titleFa}\n${source.body}`.trim();
    if (!text) continue;
    const { vector, model, dims } = await embed(text);
    await prisma.memoryDocument.upsert({
      where: { entityType_entityId: { entityType: source.entityType, entityId: source.entityId } },
      create: {
        organizationId, entityType: source.entityType, entityId: source.entityId,
        projectId: source.projectId, companyId: source.companyId,
        titleFa: source.titleFa || KIND_LABEL_FA[source.entityType],
        body: source.body.slice(0, 20_000), searchText: normalisePersian(text).slice(0, 20_000),
        vector, dims, model, sourceUpdatedAt: source.sourceUpdatedAt,
      },
      update: {
        projectId: source.projectId, companyId: source.companyId,
        titleFa: source.titleFa || KIND_LABEL_FA[source.entityType],
        body: source.body.slice(0, 20_000), searchText: normalisePersian(text).slice(0, 20_000),
        vector, dims, model, sourceUpdatedAt: source.sourceUpdatedAt, indexedAt: new Date(),
      },
    });
    indexed++;
  }

  // Whatever is left in the map no longer exists in the system, and should not be remembered.
  const orphans = [...byKey.values()].map((e) => e.id);
  if (orphans.length) await prisma.memoryDocument.deleteMany({ where: { id: { in: orphans } } });

  return {
    scanned: sources.length, indexed, removed: orphans.length,
    model: embeddingServiceConfigured() ? 'service' : LOCAL_MODEL,
  };
}

export interface MemoryHit {
  entityType: MemoryKind;
  entityId: string;
  titleFa: string;
  kindFa: string;
  projectId: string | null;
  href: string;
  /** 0–1: the blended score the ranking used. */
  score: number;
  semantic: number;
  lexical: number;
  snippetFa: string;
  indexedAt: Date;
  model: string;
}

export interface SearchOptions {
  kinds?: MemoryKind[];
  projectId?: string;
  excludeProjectId?: string;
  limit?: number;
  /** Permissions the caller holds; kinds they may not read are never searched. */
  permissions: string[];
}

const SEMANTIC_WEIGHT = 0.65;
const LEXICAL_WEIGHT = 0.35;
/** Below this the result is noise; a short list of good answers beats a long list of anything. */
const FLOOR = 0.08;

/**
 * Hybrid retrieval. The lexical half is trigram similarity computed by Postgres, which needs no
 * model and catches a proper noun the embedder never saw; the semantic half is the cosine of
 * the query's vector against each document's. Both are returned beside the blend, so a result
 * that is really a keyword hit does not get to look like understanding.
 */
export async function searchMemory(
  organizationId: string, query: string, opts: SearchOptions,
): Promise<{ hits: MemoryHit[]; model: string; usedService: boolean; candidates: number }> {
  const allowed = (opts.kinds ?? MEMORY_KINDS).filter((k) => opts.permissions.includes(KIND_PERMISSION[k]));
  if (!allowed.length || !query.trim()) {
    return { hits: [], model: embeddingServiceConfigured() ? 'service' : LOCAL_MODEL, usedService: embeddingServiceConfigured(), candidates: 0 };
  }
  const normalised = normalisePersian(query);
  const { vector, model } = await embed(query);

  /*
   * Postgres does the lexical work and the filtering; the cosine is computed here over the
   * shortlist. `word_similarity` finds a query phrase inside a long document, which plain
   * `similarity` (whole-string) would miss entirely.
   */
  const rows = await prisma.$queryRaw<Array<{
    entityType: string; entityId: string; titleFa: string; projectId: string | null;
    body: string; vector: number[]; model: string; indexedAt: Date; lexical: number;
  }>>(Prisma.sql`
    SELECT "entityType", "entityId", "titleFa", "projectId", "body", "vector", "model", "indexedAt",
           GREATEST(public.word_similarity(${normalised}, "searchText"), public.similarity(${normalised}, "titleFa")) AS lexical
    FROM memory_documents
    WHERE "organizationId" = ${organizationId}
      AND "entityType" = ANY(${allowed}::text[])
      ${opts.projectId ? Prisma.sql`AND "projectId" = ${opts.projectId}` : Prisma.empty}
      ${opts.excludeProjectId ? Prisma.sql`AND ("projectId" IS NULL OR "projectId" <> ${opts.excludeProjectId})` : Prisma.empty}
    LIMIT 4000
  `);

  const hits: MemoryHit[] = [];
  for (const row of rows) {
    const semantic = Math.max(0, cosine(vector, row.vector));
    const lexical = Number(row.lexical ?? 0);
    const score = SEMANTIC_WEIGHT * semantic + LEXICAL_WEIGHT * lexical;
    if (score < FLOOR) continue;
    hits.push({
      entityType: row.entityType as MemoryKind,
      entityId: row.entityId,
      titleFa: row.titleFa,
      kindFa: KIND_LABEL_FA[row.entityType as MemoryKind] ?? row.entityType,
      projectId: row.projectId,
      href: KIND_HREF[row.entityType as MemoryKind]?.(row.entityId, row.projectId) ?? '/',
      score: Math.round(score * 1000) / 1000,
      semantic: Math.round(semantic * 1000) / 1000,
      lexical: Math.round(lexical * 1000) / 1000,
      snippetFa: snippet(row.body, normalised),
      indexedAt: row.indexedAt,
      model: row.model,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return {
    hits: hits.slice(0, Math.min(Math.max(opts.limit ?? 10, 1), 50)),
    model, usedService: embeddingServiceConfigured(), candidates: rows.length,
  };
}

/** The part of the document worth showing: around the first query word that appears in it. */
export function snippet(body: string, normalisedQuery: string, width = 220): string {
  const words = normalisedQuery.split(' ').filter((w) => w.length > 2);
  const haystack = normalisePersian(body);
  let at = -1;
  for (const w of words) {
    const found = haystack.indexOf(w);
    if (found >= 0) { at = found; break; }
  }
  if (at < 0) return body.slice(0, width).trim() + (body.length > width ? '…' : '');
  const start = Math.max(0, at - width / 3);
  return (start > 0 ? '…' : '') + body.slice(start, start + width).trim() + (start + width < body.length ? '…' : '');
}
