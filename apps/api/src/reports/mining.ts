/**
 * Process mining and conformance (roadmap #1).
 *
 * state_transitions is an event log in the textbook sense: entityId is the case, action the
 * activity, createdAt the timestamp, actorId the resource. Tools that cost real money extract
 * exactly this from ERPs through weeks of ETL; here it has been clean from day one. This module
 * discovers the process the organisation actually runs from that log and lays it against the
 * process it declared in WORKFLOWS — which paths are never taken, which loops repeat, where the
 * waiting is.
 *
 * Time is measured in working hours against the organisation's calendar, the same unit as SLA,
 * so a "3.2 hour" wait here and a 4-hour policy there are the same kind of number.
 */
import { WORKFLOWS } from '@hiva/contracts';
import type { Tx } from '../db.js';
import { businessHoursBetween, type Calendar } from '../lib/business-calendar.js';

export interface MinedEdge {
  from: string;
  to: string;
  action: string;
  count: number;
  cases: number;
  /** Working hours spent in `from` before this move; the wait the move ends. */
  meanHours: number | null;
  medianHours: number | null;
  /** The declared model has this transition. */
  declared: boolean;
  /** Written by a cascade rather than by someone acting on the record. */
  cascade: boolean;
}

export interface MinedNode {
  state: string;
  /** How many cases ever entered this state. */
  visits: number;
  /** Working hours cases spend here, on average, before leaving. */
  meanDwellHours: number | null;
  medianDwellHours: number | null;
  /** Cases currently sitting here (their last event brought them here and it is not terminal). */
  open: number;
  declared: boolean;
  initial: boolean;
  terminal: boolean;
}

export interface Variant { path: string[]; count: number; share: number; meanHours: number | null }

export interface Loop { from: string; to: string; action: string; count: number; cases: number }

export interface MiningResult {
  entity: string;
  labelFa: string;
  window: { from: Date | null; to: Date | null };
  cases: number;
  events: number;
  nodes: MinedNode[];
  edges: MinedEdge[];
  /** Declared transitions the log never shows: the process on paper that nobody walks. */
  unusedDeclared: { from: string; to: string; action: string; labelFa: string }[];
  /** Backward moves: rework, returns, rejections — where the process eats its own tail. */
  loops: Loop[];
  /** The sequences of states cases actually follow, most common first. */
  variants: Variant[];
  /** The declared path with the fewest transitions from initial to a terminal state. */
  happyPath: string[] | null;
  cycleTime: { meanHours: number | null; medianHours: number | null; completed: number };
  /** States ranked by mean dwell — the bottlenecks. */
  bottlenecks: { state: string; meanDwellHours: number; visits: number }[];
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return round(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2);
};
const mean = (xs: number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const round = (n: number) => Math.round(n * 100) / 100;

/** Terminal states that mean the case failed rather than finished. The vocabulary is consistent about this. */
const UNHAPPY = /REJECTED|DISQUALIFIED|LOST|CANCELLED|TERMINATED|FAILED|WITHDRAWN/;

/**
 * The happy path: the shortest declared route from the initial state to a terminal state that
 * means success. The shortest route to *any* terminal is usually a rejection one hop from the
 * start, which is the fastest way to end a case and the last thing anyone means by "happy".
 */
export function happyPathOf(entity: string): string[] | null {
  const wf = WORKFLOWS[entity];
  if (!wf) return null;
  const good = wf.terminal.filter((t) => !UNHAPPY.test(t));
  const targets = good.length ? good : wf.terminal;
  const queue: string[][] = [[wf.initial]];
  const seen = new Set([wf.initial]);
  while (queue.length) {
    const path = queue.shift()!;
    const last = path[path.length - 1]!;
    if (targets.includes(last)) return path;
    for (const t of wf.transitions) {
      if (!t.from.includes(last) || seen.has(t.to)) continue;
      seen.add(t.to);
      queue.push([...path, t.to]);
    }
  }
  return null;
}

export async function mine(
  tx: Tx, organizationId: string, entity: string, cal: Calendar,
  window: { from?: Date; to?: Date } = {},
): Promise<MiningResult> {
  const wf = WORKFLOWS[entity];
  if (!wf) throw new Error(`no state machine for ${entity}`);

  const rows = await tx.stateTransition.findMany({
    where: {
      // A state recorded on migration (#48) is not an event of this process.
      organizationId, entityType: entity, opening: false,
      ...(window.from || window.to ? { createdAt: { ...(window.from ? { gte: window.from } : {}), ...(window.to ? { lte: window.to } : {}) } } : {}),
    },
    orderBy: [{ entityId: 'asc' }, { createdAt: 'asc' }],
    select: { entityId: true, fromState: true, toState: true, action: true, actorId: true, createdAt: true, cascade: true },
  });

  // Cases: the events of each record, in order, preceded by its creation as the arrival in
  // the initial state — the log records moves, and the first move's wait starts at creation.
  const cases = new Map<string, typeof rows>();
  for (const r of rows) (cases.get(r.entityId) ?? cases.set(r.entityId, []).get(r.entityId)!).push(r);
  const createdAt = new Map<string, Date>();
  if (cases.size) {
    const model = (tx as any)[entity];
    const recs: { id: string; createdAt: Date }[] = await model.findMany({ where: { id: { in: [...cases.keys()] } }, select: { id: true, createdAt: true } });
    for (const r of recs) createdAt.set(r.id, r.createdAt);
  }

  const declaredEdges = new Map<string, { from: string; to: string; action: string; labelFa: string }>();
  for (const t of wf.transitions) for (const f of t.from) declaredEdges.set(`${f}→${t.to}:${t.action}`, { from: f, to: t.to, action: t.action, labelFa: t.labelFa });

  const edgeAcc = new Map<string, { from: string; to: string; action: string; count: number; cases: Set<string>; waits: number[]; cascades: number }>();
  // A loop is a revisit: the case has been in the target state before. Not "a move to an earlier
  // state in the declared list" — the declared list is a vocabulary, not an order.
  const loopAcc = new Map<string, { from: string; to: string; action: string; count: number; cases: Set<string> }>();
  const dwell = new Map<string, number[]>();
  const visits = new Map<string, Set<string>>();
  const open = new Map<string, number>();
  const variantAcc = new Map<string, { path: string[]; count: number; hours: number[] }>();
  const cycle: number[] = [];

  for (const [id, events] of cases) {
    let arrivedAt = createdAt.get(id) ?? events[0]!.createdAt;
    let state = events[0]!.fromState;
    const path = [state];
    (visits.get(state) ?? visits.set(state, new Set()).get(state)!).add(id);
    for (const ev of events) {
      const wait = businessHoursBetween(arrivedAt, ev.createdAt, cal);
      const key = `${ev.fromState}→${ev.toState}:${ev.action}`;
      const e = edgeAcc.get(key) ?? edgeAcc.set(key, { from: ev.fromState, to: ev.toState, action: ev.action, count: 0, cases: new Set(), waits: [], cascades: 0 }).get(key)!;
      e.count++; e.cases.add(id); e.waits.push(wait);
      if (ev.cascade) e.cascades++;
      if (path.includes(ev.toState)) {
        const l = loopAcc.get(key) ?? loopAcc.set(key, { from: ev.fromState, to: ev.toState, action: ev.action, count: 0, cases: new Set() }).get(key)!;
        l.count++; l.cases.add(id);
      }
      (dwell.get(ev.fromState) ?? dwell.set(ev.fromState, []).get(ev.fromState)!).push(wait);
      state = ev.toState; arrivedAt = ev.createdAt; path.push(state);
      (visits.get(state) ?? visits.set(state, new Set()).get(state)!).add(id);
    }
    if (!wf.terminal.includes(state)) open.set(state, (open.get(state) ?? 0) + 1);
    const first = createdAt.get(id) ?? events[0]!.createdAt;
    const total = businessHoursBetween(first, events[events.length - 1]!.createdAt, cal);
    if (wf.terminal.includes(state)) cycle.push(total);
    const vkey = path.join('>');
    const v = variantAcc.get(vkey) ?? variantAcc.set(vkey, { path, count: 0, hours: [] }).get(vkey)!;
    v.count++; if (wf.terminal.includes(state)) v.hours.push(total);
  }

  const stateOrder = new Map(wf.states.map((s, i) => [s, i]));
  const edges: MinedEdge[] = [...edgeAcc.values()].map((e) => ({
    from: e.from, to: e.to, action: e.action, count: e.count, cases: e.cases.size,
    meanHours: mean(e.waits), medianHours: median(e.waits),
    declared: declaredEdges.has(`${e.from}→${e.to}:${e.action}`),
    // Every move on this edge was written by a cascade, not by someone acting on the record.
    cascade: e.cascades === e.count,
  })).sort((a, b) => b.count - a.count);

  const nodes: MinedNode[] = wf.states.map((s) => ({
    state: s, visits: visits.get(s)?.size ?? 0,
    meanDwellHours: mean(dwell.get(s) ?? []), medianDwellHours: median(dwell.get(s) ?? []),
    open: open.get(s) ?? 0, declared: true, initial: s === wf.initial, terminal: wf.terminal.includes(s),
  }));
  for (const s of visits.keys()) if (!stateOrder.has(s)) nodes.push({ state: s, visits: visits.get(s)!.size, meanDwellHours: mean(dwell.get(s) ?? []), medianDwellHours: median(dwell.get(s) ?? []), open: open.get(s) ?? 0, declared: false, initial: false, terminal: false });

  const used = new Set(edgeAcc.keys());
  const unusedDeclared = [...declaredEdges.entries()].filter(([k]) => !used.has(k)).map(([, v]) => v);

  const loops: Loop[] = [...loopAcc.values()].map((l) => ({ ...l, cases: l.cases.size })).sort((a, b) => b.count - a.count);

  const total = cases.size;
  const variants: Variant[] = [...variantAcc.values()].sort((a, b) => b.count - a.count).slice(0, 10)
    .map((v) => ({ path: v.path, count: v.count, share: total ? Math.round((v.count / total) * 100) : 0, meanHours: mean(v.hours) }));

  return {
    entity, labelFa: wf.labelFa, window: { from: window.from ?? null, to: window.to ?? null },
    cases: total, events: rows.length, nodes, edges, unusedDeclared, loops, variants,
    happyPath: happyPathOf(entity),
    cycleTime: { meanHours: mean(cycle), medianHours: median(cycle), completed: cycle.length },
    bottlenecks: nodes.filter((n) => n.meanDwellHours != null && !n.terminal).map((n) => ({ state: n.state, meanDwellHours: n.meanDwellHours!, visits: n.visits }))
      .sort((a, b) => b.meanDwellHours - a.meanDwellHours).slice(0, 5),
  };
}
