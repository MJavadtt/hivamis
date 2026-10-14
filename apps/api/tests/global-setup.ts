import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  TEMPLATE_SCHEMA, TEMPLATE_SHAPE, adminUrl, applyMigrations, baseUrl, copyData, isolationMode,
  loadTestEnv, migrationStatements, schemaNameFor, schemaShape, sweepTestSchemas,
  tablesInDependencyOrder, urlForSchema,
} from './db-isolation.js';

const API_DIR = path.resolve(import.meta.dirname, '..');

/** How many schemas to clone at once. Enough to overlap the round trips, low enough to stay calm. */
const CLONE_CONCURRENCY = 4;

/** Load reference data (departments, roles, permissions, SLA policies, 130 forms) plus demo data. */
function seed(databaseUrl: string): void {
  try {
    execFileSync('pnpm', ['exec', 'tsx', 'prisma/seed.ts'], {
      cwd: API_DIR, stdio: 'pipe', env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  } catch (error) {
    // stdio is piped, so the child's own diagnostics are not on the terminal. Without this a
    // seed failure in CI surfaces only as a non-zero exit code.
    const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`seeding failed\n${stderr?.toString() ?? ''}${stdout?.toString() ?? ''}`);
  }
}

/**
 * Runs once before the suite.
 *
 * Isolated (the default, and what CI runs): build one migrated and seeded template schema, then
 * clone it once per test file. Every schema exists before the first worker starts.
 *
 * That last part is not tidiness. Provisioning lazily, inside each file's own setup, meant a
 * worker replaying 313 DDL statements while other workers were mid-test; the catalogue locks
 * that takes were enough to push their queries past Prisma's 5s connect timeout, and the suite
 * failed roughly one run in four with an unrelated-looking HTTP 500. Doing all the DDL here,
 * before any test runs, removes the overlap entirely.
 *
 * Shared: the older behaviour, kept because it is the faster inner loop when you are iterating
 * on a single file and want the rows you just created to survive the next run. Deliberately
 * non-destructive; the seed is idempotent and business codes come from an atomic counter, so
 * repeated runs do not collide. It does accumulate rows, which is exactly why it is not the
 * default.
 */
export default async function setup(project: { testFilesList?: string[] | null }) {
  loadTestEnv();

  if (isolationMode() === 'shared') {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: API_DIR, stdio: 'pipe', env: process.env,
    });
    seed(baseUrl());
    return;
  }

  const admin = new PrismaClient({ datasourceUrl: adminUrl(CLONE_CONCURRENCY + 1) });
  try {
    await sweepTestSchemas(admin);

    const statements = migrationStatements();
    await applyMigrations(admin, TEMPLATE_SCHEMA, statements);

    await assertTemplateShape(admin);

    seed(urlForSchema(baseUrl(), TEMPLATE_SCHEMA));

    // Cloned a few at a time. Concurrency is safe *here* and nowhere else: no test is running
    // yet, so the catalogue locks that DDL takes can only slow this loop down, never time out
    // a query someone is waiting on.
    const plan = await tablesInDependencyOrder(admin, TEMPLATE_SCHEMA);
    const files = [...(project.testFilesList ?? [])];
    await Promise.all(Array.from({ length: CLONE_CONCURRENCY }, async () => {
      for (let file = files.shift(); file; file = files.shift()) {
        const schema = schemaNameFor(file);
        await applyMigrations(admin, schema, statements);
        await copyData(admin, TEMPLATE_SCHEMA, schema, plan);
      }
    }));
  } finally {
    await admin.$disconnect();
  }

  return async () => {
    const admin = new PrismaClient({ datasourceUrl: adminUrl() });
    try { await sweepTestSchemas(admin); } finally { await admin.$disconnect(); }
  };
}

/** Check that replaying the migrations built the schema the migrations describe. */
async function assertTemplateShape(admin: PrismaClient): Promise<void> {
  const shape = await schemaShape(admin, TEMPLATE_SCHEMA);
  for (const [key, expected] of Object.entries(TEMPLATE_SHAPE)) {
    if (shape[key] !== expected) {
      throw new Error(
        `template schema has ${shape[key]} ${key}, expected ${expected}. A migration changed ` +
        `the schema (update TEMPLATE_SHAPE in tests/db-isolation.ts), or a migration now uses ` +
        `SQL that cannot be split on semicolons — a dollar-quoted body, for instance.`,
      );
    }
  }
}
