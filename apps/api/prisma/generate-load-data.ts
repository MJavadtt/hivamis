/**
 * Load-test data generator — NOT FOR PRODUCTION.
 *
 * Creates a realistic-shaped dataset so the report endpoints can be measured under volume the
 * demo seed does not reach (it has three projects). Every row it writes is tagged with the
 * `PERF-` code prefix and belongs to companies named «شرکت آزمون بار …», so `--purge` can remove
 * exactly what this wrote and nothing else.
 *
 *   pnpm --filter @hiva/api exec tsx prisma/generate-load-data.ts            # default volumes
 *   pnpm --filter @hiva/api exec tsx prisma/generate-load-data.ts --scale=2  # double them
 *   pnpm --filter @hiva/api exec tsx prisma/generate-load-data.ts --purge    # remove it all
 *
 * Idempotent: re-running purges its own previous output first.
 */
import { PrismaClient } from '@prisma/client';
import { PROJECT_STATES, TASK_STATES, DELIVERABLE_STATES, EXECUTION_DEPARTMENTS } from '@hiva/contracts';

const prisma = new PrismaClient();
const PREFIX = 'PERF-';
const COMPANY_TAG = 'شرکت آزمون بار';

const arg = (name: string, fallback: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const scale = arg('scale', 1);

const VOLUMES = {
  companies: Math.round(200 * scale),
  projects: Math.round(400 * scale),
  tasks: Math.round(20_000 * scale),
  deliverables: Math.round(5_000 * scale),
  submissions: Math.round(2_000 * scale),
  invoices: Math.round(1_200 * scale),
  costs: Math.round(3_000 * scale),
};

const pick = <T,>(xs: readonly T[], i: number): T => xs[i % xs.length]!;
const rand = (n: number) => Math.floor(Math.random() * n);
const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000);

async function purge(): Promise<void> {
  const companies = await prisma.company.findMany({
    where: { legalName: { startsWith: COMPANY_TAG } }, select: { id: true },
  });
  const ids = companies.map((c) => c.id);
  if (ids.length === 0) return void console.log('  nothing to purge');

  const projects = await prisma.project.findMany({
    where: { companyId: { in: ids } }, select: { id: true },
  });
  const pIds = projects.map((p) => p.id);

  // Children first — the schema cascades from project, but be explicit about order.
  await prisma.$transaction([
    prisma.task.deleteMany({ where: { projectId: { in: pIds } } }),
    prisma.costDeclaration.deleteMany({ where: { workOrder: { projectId: { in: pIds } } } }),
    prisma.deliverable.deleteMany({ where: { projectId: { in: pIds } } }),
    prisma.workOrder.deleteMany({ where: { projectId: { in: pIds } } }),
    prisma.formSubmission.deleteMany({ where: { projectId: { in: pIds } } }),
    prisma.invoice.deleteMany({ where: { companyId: { in: ids } } }),
    prisma.opportunity.deleteMany({ where: { companyId: { in: ids } } }),
    prisma.project.deleteMany({ where: { id: { in: pIds } } }),
    prisma.company.deleteMany({ where: { id: { in: ids } } }),
  ]);
  console.log(`  purged ${ids.length} companies and ${pIds.length} projects`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--purge')) {
    await purge();
    return;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('generate-load-data refuses to run with NODE_ENV=production');
  }

  console.log('→ purging any previous run first');
  await purge();

  const org = await prisma.organization.findFirstOrThrow();
  const users = await prisma.user.findMany({ where: { organizationId: org.id }, select: { id: true } });
  const accountOwner = users[0]!.id;
  const t0 = Date.now();

  console.log(`→ generating at scale ${scale}:`, VOLUMES);

  await prisma.company.createMany({
    data: Array.from({ length: VOLUMES.companies }, (_, i) => ({
      organizationId: org.id,
      legalName: `${COMPANY_TAG} ${i + 1}`,
      industry: pick(['خرده‌فروشی', 'بانکداری', 'خودرو', 'دارو', 'فناوری'], i),
      accountOwnerId: pick(users, i).id,
    })),
  });
  const companies = await prisma.company.findMany({
    where: { legalName: { startsWith: COMPANY_TAG } }, select: { id: true },
  });

  await prisma.project.createMany({
    data: Array.from({ length: VOLUMES.projects }, (_, i) => ({
      organizationId: org.id,
      code: `${PREFIX}PRJ-${String(i).padStart(6, '0')}`,
      name: `پروژه آزمون بار ${i + 1}`,
      companyId: pick(companies, i).id,
      accountOwnerId: accountOwner,
      // Weighted towards ACTIVE, which is what the dashboard actually aggregates.
      state: i % 5 === 0 ? pick(PROJECT_STATES, i) : 'ACTIVE',
      plannedStart: daysFromNow(-rand(120)),
      plannedEnd: daysFromNow(rand(120)),
      plannedBudget: 500_000_000 + rand(9_000_000_000),
      contractValue: 800_000_000 + rand(12_000_000_000),
      healthStatus: pick(['GREEN', 'AMBER', 'RED'], i),
    })),
  });
  const projects = await prisma.project.findMany({
    where: { code: { startsWith: `${PREFIX}PRJ` } }, select: { id: true, companyId: true },
  });

  await prisma.workOrder.createMany({
    data: projects.map((p, i) => ({
      organizationId: org.id,
      code: `${PREFIX}WO-${String(i).padStart(6, '0')}`,
      projectId: p.id,
      targetDepartmentCode: pick(EXECUTION_DEPARTMENTS, i),
      title: `سفارش کار ${i + 1}`,
      scopeOfWork: 'شرح کار آزمون بار', brief: 'بریف آزمون بار',
      expectedOutput: 'خروجی آزمون', outputFormat: 'PDF',
      deadline: daysFromNow(rand(60)), ownerId: pick(users, i).id,
      budget: 100_000_000 + rand(900_000_000), state: 'IN_PROGRESS',
    })),
  });
  const workOrders = await prisma.workOrder.findMany({
    where: { code: { startsWith: `${PREFIX}WO` } }, select: { id: true, projectId: true },
  });

  // Tasks are the volume driver and the reason projectHealth was quadratic.
  const CHUNK = 5_000;
  for (let start = 0; start < VOLUMES.tasks; start += CHUNK) {
    const n = Math.min(CHUNK, VOLUMES.tasks - start);
    await prisma.task.createMany({
      data: Array.from({ length: n }, (_, k) => {
        const i = start + k;
        const p = pick(projects, i);
        return {
          organizationId: org.id,
          code: `${PREFIX}TSK-${String(i).padStart(7, '0')}`,
          projectId: p.id,
          title: `وظیفه آزمون بار ${i + 1}`,
          departmentCode: pick(EXECUTION_DEPARTMENTS, i),
          assigneeId: pick(users, i).id,
          // A third are overdue, so the late-task roll-up has something to find.
          dueDate: i % 3 === 0 ? daysFromNow(-rand(30)) : daysFromNow(rand(45)),
          estimateHours: 2 + rand(20),
          state: pick(TASK_STATES.filter((s) => s !== 'CANCELLED'), i),
          sourceType: 'ORDER_FORM', sourceRef: `${PREFIX}WO-${i % VOLUMES.projects}`,
          createdById: accountOwner,
        };
      }),
    });
    process.stdout.write(`\r  tasks: ${start + n}/${VOLUMES.tasks}`);
  }
  process.stdout.write('\n');

  await prisma.deliverable.createMany({
    data: Array.from({ length: VOLUMES.deliverables }, (_, i) => ({
      organizationId: org.id,
      code: `${PREFIX}DLV-${String(i).padStart(6, '0')}`,
      projectId: pick(projects, i).id,
      name: `خروجی آزمون بار ${i + 1}`,
      departmentCode: pick(EXECUTION_DEPARTMENTS, i),
      dueDate: daysFromNow(rand(60)),
      state: pick(DELIVERABLE_STATES, i),
    })),
  });

  await prisma.costDeclaration.createMany({
    data: Array.from({ length: VOLUMES.costs }, (_, i) => ({
      organizationId: org.id,
      workOrderId: pick(workOrders, i).id,
      departmentCode: pick(EXECUTION_DEPARTMENTS, i),
      internalCost: 20_000_000 + rand(400_000_000),
      externalCost: rand(150_000_000),
      declaredById: pick(users, i).id,
    })),
  });

  await prisma.invoice.createMany({
    data: Array.from({ length: VOLUMES.invoices }, (_, i) => {
      const total = 500_000_000 + rand(6_000_000_000);
      return {
        organizationId: org.id,
        code: `${PREFIX}INV-${String(i).padStart(6, '0')}`,
        kind: i % 3 === 0 ? 'PROFORMA' : 'INVOICE',
        number: `${PREFIX}${1000 + i}`,
        companyId: pick(companies, i).id,
        projectId: pick(projects, i).id,
        issueDate: daysFromNow(-rand(180)),
        dueDate: daysFromNow(rand(60)),
        lines: [{ description: 'خدمات', quantity: 1, unitPrice: total }],
        subtotal: total, taxPercent: 9, taxAmount: Math.round(total * 0.09),
        total: Math.round(total * 1.09),
        paidAmount: i % 2 === 0 ? Math.round(total * 1.09) : 0,
        state: i % 2 === 0 ? 'PAID' : 'SENT',
        createdById: accountOwner,
      };
    }),
  });

  const defs = await prisma.formDefinition.findMany({ select: { id: true }, take: 40 });
  await prisma.formSubmission.createMany({
    data: Array.from({ length: VOLUMES.submissions }, (_, i) => ({
      organizationId: org.id,
      code: `${PREFIX}FRM-${String(i).padStart(6, '0')}`,
      definitionId: pick(defs, i).id,
      data: { note: 'داده آزمون بار' },
      state: i % 4 === 0 ? 'PENDING_APPROVAL' : 'APPROVED',
      submittedById: pick(users, i).id,
      projectId: pick(projects, i).id,
    })),
  });

  const counts = await Promise.all([
    prisma.company.count(), prisma.project.count(), prisma.task.count(),
    prisma.deliverable.count(), prisma.invoice.count(), prisma.formSubmission.count(),
  ]);
  console.log(`\n→ done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  totals now — companies ${counts[0]}, projects ${counts[1]}, tasks ${counts[2]}, ` +
              `deliverables ${counts[3]}, invoices ${counts[4]}, submissions ${counts[5]}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
