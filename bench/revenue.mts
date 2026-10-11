/**
 * The revenue report at scale (audit PERF-3): the real revenueReport, fed synthetic records for N
 * projects through a stand-in for the database, so what is timed is the calculation itself.
 *
 *   cd apps/api && ./node_modules/.bin/tsx ../../bench/revenue.mts [projects=2000] [module=../apps/api/src/finance/revenue.ts]
 */
const projects = Number(process.argv[2] ?? 2000);
const modulePath = process.argv[3] ?? '../apps/api/src/finance/revenue.ts';
const { revenueReport, lastMonths } = await import(modulePath);

const DAY = 86_400_000;
const now = new Date();
const months = lastMonths(12, now);
const start = months[0].start.getTime();
const span = now.getTime() - start;
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const when = () => new Date(start + rnd() * span);
const methods = ['MILESTONE', 'EFFORT', 'COST'];

const rows = {
  projects: [] as any[], amendments: [] as any[], milestones: [] as any[], tasks: [] as any[], entries: [] as any[],
  users: Array.from({ length: 60 }, (_, i) => ({ id: `u${i}`, hourlyCost: i % 7 ? 800_000 + i * 1000 : null, department: { hourlyCost: 750_000 } })),
  payments: [] as any[], declarations: [] as any[], invoices: [] as any[], media: [] as any[], moves: [] as any[],
};
for (let i = 0; i < projects; i++) {
  const id = `p${i}`;
  rows.projects.push({ id, code: `PRJ-${i}`, name: `پروژه ${i}`, state: i % 9 === 0 ? 'CLOSED' : 'ACTIVE', revenueMethod: methods[i % 3], contractValue: String(500_000_000 + i * 1_000_000), closedAt: i % 9 === 0 ? when() : null, createdAt: new Date(start - 30 * DAY), company: { legalName: `مشتری ${i % 200}` } });
  if (i % 5 === 0) rows.amendments.push({ valueDelta: '50000000', effectiveDate: when(), contract: { projectId: id } });
  for (let m = 0; m < 3; m++) rows.milestones.push({ id: `${id}m${m}`, projectId: id, name: `مرحله ${m}`, revenueShare: m === 2 ? '33.34' : '33.33', completedAt: rnd() < 0.6 ? when() : null, dueDate: when() });
  for (let t = 0; t < 8; t++) {
    const tid = `${id}t${t}`;
    rows.tasks.push({ id: tid, projectId: id, estimateHours: String(10 + t), state: 'IN_PROGRESS', createdAt: new Date(start - DAY) });
    rows.moves.push({ entityId: tid, fromState: 'IN_PROGRESS', toState: rnd() < 0.5 ? 'APPROVED' : 'SUBMITTED', createdAt: when() });
    for (let e = 0; e < 4; e++) rows.entries.push({ taskId: tid, hours: '2.5', workedOn: when(), userId: `u${(i + e) % 60}`, task: { projectId: id } });
  }
  for (let v = 0; v < 3; v++) rows.invoices.push({ projectId: id, subtotal: '100000000', taxPercent: '10', total: '110000000', issueDate: when(), lines: [{ quantity: 1, unitPrice: 100000000 }], fxRate: '1' });
  rows.payments.push({ projectId: id, amount: '20000000', occurredAt: when() });
  rows.declarations.push({ internalCost: '200000000', externalCost: '100000000', workOrder: { projectId: id } });
  if (i % 4 === 0) rows.media.push({ projectId: id, agencyRevenue: '15000000', airedAt: when() });
}
rows.moves.sort((a, b) => a.createdAt - b.createdAt);

const list = (xs: unknown[]) => ({ findMany: async () => xs });
const tx = {
  organization: { findUniqueOrThrow: async () => ({ contractValueIncludesTax: false }) },
  project: list(rows.projects), amendment: list(rows.amendments), milestone: list(rows.milestones), task: list(rows.tasks),
  timeEntry: list(rows.entries), user: list(rows.users), payment: list(rows.payments), costDeclaration: list(rows.declarations),
  invoice: list(rows.invoices), mediaOrder: list(rows.media), stateTransition: list(rows.moves),
  revenuePeriod: list([]), revenueEntry: list([]),
};

await revenueReport(tx, 'org', 12, now); // warm up
const times: number[] = [];
for (let r = 0; r < 5; r++) {
  const t0 = performance.now();
  const out = await revenueReport(tx, 'org', 12, now);
  times.push(performance.now() - t0);
  if (r === 0 && out.projects.length < projects * 0.9) throw new Error('report lost projects');
}
times.sort((a, b) => a - b);
console.log(JSON.stringify({ projects, tasks: rows.tasks.length, entries: rows.entries.length, invoices: rows.invoices.length, medianMs: Math.round(times[2]), minMs: Math.round(times[0]), maxMs: Math.round(times[4]) }));
