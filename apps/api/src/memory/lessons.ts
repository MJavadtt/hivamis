/**
 * Lessons, at the moment they can still change something (roadmap #44).
 *
 * Doc_H §15 makes lessons learned mandatory and puts them on the closing checklist, so the
 * organisation has been writing them for years. A lesson that is written and never read is a
 * ritual, not learning — and nobody reads last year's closure forms, because finding the
 * relevant one means remembering it exists.
 *
 * This asks the question for them. At kick-off, a project's own text — its name, objective,
 * scope and brief — is used to retrieve past lessons (#21), and three plain signals raise what
 * the roadmap asked for: the same client, the same execution units, the same account owner.
 * Each hit says which of those applied, so nothing arrives as an unexplained ranking.
 */
import type { Tx } from '../db.js';
import { searchMemory, type MemoryHit } from './index.js';

/** A lesson from the same client is worth more than a similar one from a stranger. */
const SAME_COMPANY_BOOST = 0.18;
const SAME_UNIT_BOOST = 0.10;
const SAME_OWNER_BOOST = 0.05;

export interface SurfacedLesson extends MemoryHit {
  lessonId: string;
  fromProject: { id: string; code: string; name: string } | null;
  companyName: string | null;
  category: string | null;
  recommendation: string | null;
  /** Why this one is here, in words. */
  whyFa: string[];
  review: { decision: string; note: string | null; reviewedAt: Date; reviewedBy: string | null } | null;
}

export interface LessonsForProject {
  project: { id: string; code: string; name: string; state: string };
  lessons: SurfacedLesson[];
  /** Reviewed out of surfaced — the number that says whether the ritual became a habit. */
  reviewed: number;
  usedService: boolean;
  noteFa: string | null;
}

export async function lessonsForProject(
  tx: Tx,
  organizationId: string,
  projectId: string,
  opts: { permissions: string[]; limit?: number; includeReviewed?: boolean },
): Promise<LessonsForProject> {
  const project = await tx.project.findFirstOrThrow({
    where: { id: projectId, organizationId },
    include: {
      company: { select: { id: true, legalName: true } },
      brief: { select: { title: true, businessObjective: true, scope: true, targetAudience: true, unitsNeeded: true } },
      workOrders: { select: { targetDepartmentCode: true } },
    },
  });

  const query = [
    project.name, project.objective, project.inScope,
    project.brief?.title, project.brief?.businessObjective, project.brief?.scope, project.brief?.targetAudience,
  ].filter(Boolean).join('\n');

  if (!query.trim()) {
    return {
      project: { id: project.id, code: project.code, name: project.name, state: project.state },
      lessons: [], reviewed: 0, usedService: false,
      noteFa: 'این پروژه هنوز شرح یا بریفی ندارد که بتوان بر اساس آن در حافظهٔ سازمان جست‌وجو کرد.',
    };
  }

  const found = await searchMemory(organizationId, query, {
    kinds: ['lessonLearned'],
    excludeProjectId: projectId,           // a project cannot learn from itself
    permissions: opts.permissions,
    limit: 40,
  });
  if (!found.hits.length) {
    return {
      project: { id: project.id, code: project.code, name: project.name, state: project.state },
      lessons: [], reviewed: 0, usedService: found.usedService,
      noteFa: 'درس آموختهٔ مرتبطی از پروژه‌های گذشته پیدا نشد.',
    };
  }

  // The lessons themselves, plus the projects they came from — for the client and unit signals.
  const lessons = await tx.lessonLearned.findMany({
    where: { organizationId, id: { in: found.hits.map((h) => h.entityId) } },
    include: {
      project: {
        select: {
          id: true, code: true, name: true, companyId: true, accountOwnerId: true,
          company: { select: { legalName: true } },
          workOrders: { select: { targetDepartmentCode: true } },
        },
      },
    },
  });
  const byId = new Map(lessons.map((l) => [l.id, l]));
  const reviews = await tx.lessonReview.findMany({
    where: { projectId },
    include: { lesson: { select: { id: true } } },
  });
  const reviewers = await tx.user.findMany({
    where: { id: { in: [...new Set(reviews.map((r) => r.reviewedById))] } },
    select: { id: true, fullName: true },
  });
  const reviewerName = new Map(reviewers.map((u) => [u.id, u.fullName]));
  const reviewByLesson = new Map(reviews.map((r) => [r.lessonId, r]));

  const myUnits = new Set(project.workOrders.map((w) => w.targetDepartmentCode));
  for (const u of project.brief?.unitsNeeded ?? []) myUnits.add(u);

  const surfaced: SurfacedLesson[] = [];
  for (const hit of found.hits) {
    const lesson = byId.get(hit.entityId);
    if (!lesson) continue;
    const review = reviewByLesson.get(lesson.id);
    if (review && !opts.includeReviewed) continue;

    const whyFa: string[] = [];
    let score = hit.score;
    if (lesson.project?.companyId && lesson.project.companyId === project.companyId) {
      score += SAME_COMPANY_BOOST;
      whyFa.push(`همین مشتری — ${project.company.legalName}`);
    }
    const theirUnits = new Set(lesson.project?.workOrders.map((w) => w.targetDepartmentCode) ?? []);
    const shared = [...myUnits].filter((u) => theirUnits.has(u));
    if (shared.length) {
      score += SAME_UNIT_BOOST;
      whyFa.push(`همان واحد اجرایی: ${shared.join('، ')}`);
    }
    if (lesson.project?.accountOwnerId && lesson.project.accountOwnerId === project.accountOwnerId) {
      score += SAME_OWNER_BOOST;
      whyFa.push('همان مدیر اکانت');
    }
    whyFa.push(hit.semantic >= hit.lexical ? 'شباهت موضوعی با شرح این پروژه' : 'واژه‌های مشترک با شرح این پروژه');

    surfaced.push({
      ...hit,
      score: Math.round(Math.min(1, score) * 1000) / 1000,
      lessonId: lesson.id,
      fromProject: lesson.project ? { id: lesson.project.id, code: lesson.project.code, name: lesson.project.name } : null,
      companyName: lesson.project?.company?.legalName ?? null,
      category: lesson.category,
      recommendation: lesson.recommendation,
      whyFa,
      review: review
        ? { decision: review.decision, note: review.note, reviewedAt: review.createdAt, reviewedBy: reviewerName.get(review.reviewedById) ?? null }
        : null,
    });
  }
  surfaced.sort((a, b) => b.score - a.score);

  return {
    project: { id: project.id, code: project.code, name: project.name, state: project.state },
    lessons: surfaced.slice(0, Math.min(Math.max(opts.limit ?? 6, 1), 30)),
    reviewed: reviews.length,
    usedService: found.usedService,
    noteFa: null,
  };
}
