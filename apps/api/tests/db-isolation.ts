/**
 * Per-file database isolation.
 *
 * The suite used to drive one shared `public` schema through every file, which meant a test
 * could pass because of a row some earlier file — or some earlier *run* — had left behind.
 * Each test file now gets its own PostgreSQL schema, cloned from a template that is migrated
 * and seeded exactly once.
 *
 * Why a schema rather than a database: `CREATE SCHEMA` needs no CREATEDB privilege, holds no
 * lock on a template that a concurrent worker might also be copying, and keeps every artefact
 * inside the one database named by DATABASE_URL — so teardown is a single DROP and CI needs
 * no extra provisioning.
 *
 * Why clone rather than migrate-and-seed per file: measured at 0.23s against 1.25s. The seed
 * is the expensive half, and cloning copies its output as data instead of recomputing it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';

const API_DIR = path.resolve(import.meta.dirname, '..');

/** The migrated, seeded schema every per-file schema is copied from. */
export const TEMPLATE_SCHEMA = 'hiva_template';

/** Prefix for per-file schemas, so the sweep can find them without touching anything else. */
export const SCHEMA_PREFIX = 't_';

/**
 * Shape of the world the schema objects must have once the migrations have been replayed.
 * Asserted after building the template: the replay splits migration SQL on semicolons, which
 * is only safe while the migrations stay free of dollar-quoted bodies, and these counts are
 * what notices if that stops being true. Update them when a migration adds or drops objects.
 */
export const TEMPLATE_SHAPE = { tables: 70, checkConstraints: 19, foreignKeys: 117 } as const;

/** Load .env.test into process.env. env.ts validates at import time, so this must run first. */
export function loadTestEnv(): void {
  const envPath = path.join(API_DIR, '.env.test');
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}

/**
 * `shared` reproduces the old behaviour — one database, migrated and seeded in place, nothing
 * dropped — which is the faster loop when you are re-running one file over and over and want
 * the data you just created to still be there. Isolated is the default, and what CI runs.
 */
export function isolationMode(): 'isolated' | 'shared' {
  return process.env.HIVA_TEST_ISOLATION === 'shared' ? 'shared' : 'isolated';
}

/** `…/tests/001-governance.test.ts` → `t_001_governance`. Stable, so a rerun reuses the name. */
export function schemaNameFor(testPath: string): string {
  const base = path.basename(testPath).replace(/\.test\.ts$/, '');
  return SCHEMA_PREFIX + base.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
}

/**
 * Point a connection string at one schema.
 *
 * connection_limit is capped because Prisma otherwise opens cpus*2+1 connections per client;
 * with files running in parallel that multiplies by the worker count and exhausts
 * max_connections (100 by default) long before it saturates anything useful.
 */
export function urlForSchema(baseUrl: string, schema: string, connectionLimit = 5): string {
  const url = new URL(baseUrl);
  url.searchParams.set('schema', schema);
  url.searchParams.set('connection_limit', String(connectionLimit));
  return url.toString();
}

/** The connection string as configured, before any per-file schema is applied. */
export function baseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set; .env.test was not loaded');
  return url;
}

/**
 * Connection string for the client that provisions schemas.
 *
 * Capped hard: every worker builds one of these, and Prisma's default pool is cpus*2+1, which
 * on a developer machine multiplies past max_connections before the suite has run a test. Two
 * is enough — provisioning is sequential within a worker.
 */
export function adminUrl(connectionLimit = 2): string {
  const url = new URL(baseUrl());
  url.searchParams.set('connection_limit', String(connectionLimit));
  return url.toString();
}

/**
 * Every migration, in order, as individual statements.
 *
 * Replaying these is what `prisma migrate deploy` does, minus the process spawn and the
 * _prisma_migrations bookkeeping that tests have no use for. It is deliberately NOT
 * `prisma migrate diff --from-empty`: that round-trips through Prisma's own schema model,
 * which has no concept of a CHECK constraint, so it silently drops all 15 of the state
 * vocabulary constraints and would leave the tests running against a weaker database than
 * production.
 */
export function migrationStatements(): string[] {
  const dir = path.join(API_DIR, 'prisma', 'migrations');
  const sql = readdirSync(dir)
    .filter((name) => /^\d/.test(name))
    .sort()
    .map((name) => readFileSync(path.join(dir, name, 'migration.sql'), 'utf8'))
    .join('\n');

  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** DDL and data copies run in one interactive transaction so they share a connection. */
const TX = { timeout: 120_000, maxWait: 60_000 } as const;

export async function dropSchema(db: PrismaClient, schema: string): Promise<void> {
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

/**
 * Create `schema` and replay every migration into it.
 *
 * The statements run inside one interactive transaction for two reasons: Prisma pools
 * connections, so a `SET search_path` issued on its own would not reliably apply to whichever
 * connection ran the next statement; and PostgreSQL DDL is transactional, so a migration that
 * fails half way leaves no partial schema behind.
 */
export async function applyMigrations(
  db: PrismaClient, schema: string, statements: string[],
): Promise<void> {
  await dropSchema(db, schema);
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
    for (const statement of statements) await tx.$executeRawUnsafe(statement);
  }, TX);
}

/** Count what the migrations actually built, so the caller can check it against TEMPLATE_SHAPE. */
export async function schemaShape(db: PrismaClient, schema: string) {
  const [row] = await db.$queryRawUnsafe<Array<Record<string, number>>>(
    `SELECT
       (SELECT count(*)::int FROM pg_tables WHERE schemaname = $1) AS tables,
       (SELECT count(*)::int FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = $1 AND c.contype = 'c') AS "checkConstraints",
       (SELECT count(*)::int FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = $1 AND c.contype = 'f') AS "foreignKeys"`,
    schema,
  );
  return row;
}

/**
 * Tables of `schema`, ordered so that every table follows the ones its foreign keys point at.
 *
 * Copying in this order means the FKs can stay enforced during the copy. The alternative —
 * `SET session_replication_role = replica` to switch the triggers off — needs superuser, which
 * is not something a test suite should require of whoever runs it.
 */
export async function tablesInDependencyOrder(
  db: PrismaClient, schema: string,
): Promise<string[]> {
  const tables = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT tablename AS name FROM pg_tables WHERE schemaname = $1`, schema,
  );
  const edges = await db.$queryRawUnsafe<Array<{ child: string; parent: string }>>(
    `SELECT ch.relname AS child, pa.relname AS parent
       FROM pg_constraint c
       JOIN pg_class ch ON ch.oid = c.conrelid
       JOIN pg_class pa ON pa.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = ch.relnamespace
      WHERE n.nspname = $1 AND c.contype = 'f' AND c.conrelid <> c.confrelid`,
    schema,
  );

  const pending = new Map(tables.map((t) => [t.name, new Set<string>()]));
  for (const { child, parent } of edges) pending.get(child)?.add(parent);

  const ordered: string[] = [];
  while (ordered.length < tables.length) {
    const ready = [...pending].filter(([, parents]) => parents.size === 0).map(([name]) => name);
    // A cycle would leave every remaining table waiting on another. Self-references are fine
    // and excluded above: an INSERT…SELECT checks them once, at the end of the statement.
    if (ready.length === 0) {
      throw new Error(`cycle in the foreign-key graph of "${schema}": ${[...pending.keys()]}`);
    }
    for (const name of ready) {
      ordered.push(name);
      pending.delete(name);
      for (const parents of pending.values()) parents.delete(name);
    }
  }
  return ordered;
}

/** Copy every row of `from` into the (already migrated, empty) schema `into`. */
export async function copyData(
  db: PrismaClient, from: string, into: string, order: string[],
): Promise<void> {
  await db.$transaction(async (tx) => {
    for (const table of order) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "${into}"."${table}" SELECT * FROM "${from}"."${table}"`,
      );
    }
  }, TX);
}

/** Drop every schema a previous run created, so a run always starts from a known state. */
export async function sweepTestSchemas(db: PrismaClient): Promise<number> {
  const stale = await db.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`, `${SCHEMA_PREFIX}%`,
  );
  for (const { nspname } of stale) await dropSchema(db, nspname);
  return stale.length;
}
