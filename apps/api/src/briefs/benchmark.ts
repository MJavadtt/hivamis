/**
 * What good briefs look like *here* (roadmap #25).
 *
 * The rules in quality.ts are general; the organisation's own history is specific. Two
 * questions are answered from it: what did briefs that became won deals look like, and does a
 * low score actually predict the brief being sent back? The second is the one that matters — a
 * score that does not track returns is decoration, and this is where that would show.
 */
import type { Tx } from '../db.js';
import { scoreBrief, type BriefBand } from './quality.js';
import { searchMemory } from '../memory/index.js';

export const MIN_SAMPLES = 5;

export interface Benchmark {
  briefs: number;
  winners: { count: number; meanScore: number | null; medianWords: Record<string, number> };
  /** Share of briefs in each band that were sent back at least once. */
  returnRateByBand: { band: BriefBand; briefs: number; returned: number; rate: number | null }[];
  enoughHistory: boolean;
  noteFa: string;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

export async function briefBenchmark(tx: Tx, organizationId: string): Promise<Benchmark> {
  const briefs = await tx.brief.findMany({
    where: { organizationId, deletedAt: null },
    include: { opportunity: { select: { state: true } } },
    take: 5_000,
  });
  const scored = briefs.map((b) => ({ b, q: scoreBrief(b as unknown as Record<string, unknown>) }));
  const winners = scored.filter((s) => s.b.opportunity?.state === 'WON');

  const medianWords: Record<string, number> = {};
  for (const key of ['businessObjective', 'targetAudience', 'scope', 'expectedDeliverables', 'successCriteria']) {
    medianWords[key] = median(winners.map((w) => w.q.fields.find((f) => f.key === key)?.words ?? 0));
  }

  const bands: BriefBand[] = ['STRONG', 'ADEQUATE', 'WEAK', 'INCOMPLETE'];
  const returnRateByBand = bands.map((band) => {
    const inBand = scored.filter((s) => s.q.band === band);
    const returned = inBand.filter((s) => s.b.returnCount > 0).length;
    return {
      band, briefs: inBand.length, returned,
      rate: inBand.length >= MIN_SAMPLES ? Math.round((returned / inBand.length) * 100) / 100 : null,
    };
  });

  const enough = winners.length >= MIN_SAMPLES;
  return {
    briefs: briefs.length,
    winners: {
      count: winners.length,
      meanScore: winners.length ? Math.round(winners.reduce((s, w) => s + w.q.score, 0) / winners.length) : null,
      medianWords,
    },
    returnRateByBand,
    enoughHistory: enough,
    noteFa: enough
      ? `بر پایهٔ ${winners.length} بریف که به قرارداد رسیدند`
      : `تنها ${winners.length} بریف تا امروز به قرارداد رسیده — مقایسه با تاریخچه هنوز معنادار نیست و قواعد عمومی مبنا هستند`,
  };
}

/**
 * A brief like this one that became a won deal — shown as an example of what the missing
 * field looked like when it worked. Retrieved by meaning (#21), never invented.
 */
export async function winningExample(
  tx: Tx, organizationId: string, briefId: string, permissions: string[],
) {
  const brief = await tx.brief.findFirst({ where: { id: briefId, organizationId } });
  if (!brief) return null;
  const query = [brief.title, brief.businessObjective, brief.scope, brief.targetAudience].filter(Boolean).join('\n');
  if (!query.trim()) return null;
  const found = await searchMemory(organizationId, query, { kinds: ['brief'], permissions, limit: 15 });
  const candidates = found.hits.filter((h) => h.entityId !== briefId).map((h) => h.entityId);
  if (!candidates.length) return null;
  const winners = await tx.brief.findMany({
    where: { id: { in: candidates }, organizationId, opportunity: { state: 'WON' } },
    select: {
      id: true, code: true, title: true, businessObjective: true, targetAudience: true,
      scope: true, expectedDeliverables: true, successCriteria: true, constraints: true,
    },
  });
  if (!winners.length) return null;
  // Keep the retrieval order: the first winner in it is the closest one.
  const best = candidates.map((id) => winners.find((w) => w.id === id)).find(Boolean)!;
  const hit = found.hits.find((h) => h.entityId === best.id)!;
  return { ...best, similarity: hit.score, quality: scoreBrief(best as unknown as Record<string, unknown>) };
}
