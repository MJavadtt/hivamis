import { describe, it, expect, afterAll } from 'vitest';
import { ALL_FORMS } from '@hiva/contracts';
import { closeApp } from './helpers.js';
import { prisma } from '../src/db.js';
import { TEMPLATE_SCHEMA, TEMPLATE_SHAPE, isolationMode, schemaNameFor } from './db-isolation.js';

/**
 * Guards the per-file database isolation itself.
 *
 * Without something asserting it, isolation fails silently: the suite would go on passing
 * against a shared schema and simply stop being repeatable, which is the state these tests
 * were written to end.
 */
const isolated = isolationMode() === 'isolated';

afterAll(async () => { await closeApp(); });

async function scalar(sql: string, ...args: unknown[]): Promise<number> {
  const [row] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(sql, ...args);
  return row!.n;
}

describe('Per-file database isolation', () => {
  it.runIf(isolated)('puts this file in a schema named after itself', async () => {
    const [row] = await prisma.$queryRawUnsafe<Array<{ schema: string }>>(
      'SELECT current_schema() AS schema',
    );
    expect(row!.schema).toBe(schemaNameFor(import.meta.filename));
  });

  it.runIf(isolated)('sees only the rows the template was seeded with', async () => {
    // Nothing in this file writes, so every table should still hold exactly what the clone
    // copied. Comparing all 59 rather than a chosen few is deliberate: whichever table a
    // future leak lands in, this notices. Counting a whole schema in one round trip needs
    // the query_to_xml idiom — there is no plain SQL way to count every table at once.
    const counts = (schema: string) => prisma.$queryRawUnsafe<Array<{ table: string; n: number }>>(
      `SELECT table_name AS table,
              (xpath('/row/c/text()',
                     query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
                                  false, true, '')))[1]::text::int AS n
         FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      schema,
    );
    const asMap = (rows: Array<{ table: string; n: number }>) =>
      Object.fromEntries(rows.map((r) => [r.table, Number(r.n)]));

    const [here, template] = await Promise.all([
      counts(schemaNameFor(import.meta.filename)), counts(TEMPLATE_SCHEMA),
    ]);
    expect(asMap(here)).toEqual(asMap(template));
  });

  it('carries the full reference catalogue', async () => {
    expect(await prisma.formDefinition.count()).toBe(ALL_FORMS.length);
  });

  /**
   * The clone replays migration SQL rather than `prisma migrate diff --from-empty`, because
   * Prisma's schema model has no CHECK constraint and that route silently drops all 15 of the
   * state-vocabulary constraints. This is what notices if anyone takes the shortcut.
   */
  it('reproduces the schema the migrations describe, constraints included', async () => {
    const checks = await scalar(
      `SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = current_schema() AND c.contype = 'c'`,
    );
    const fks = await scalar(
      `SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = current_schema() AND c.contype = 'f'`,
    );
    // _prisma_migrations is `migrate deploy`'s own ledger, present only in shared mode; it is
    // not something the migrations describe, so it is not something the clone should carry.
    const tables = await scalar(
      `SELECT count(*)::int AS n FROM pg_tables
        WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`,
    );
    expect({ tables, checkConstraints: checks, foreignKeys: fks }).toEqual({ ...TEMPLATE_SHAPE });
  });
});
