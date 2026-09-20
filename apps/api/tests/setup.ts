/**
 * Per-file setup. Vitest evaluates this module once per test file, before the file's own
 * imports, which is the only window in which DATABASE_URL can still be changed: src/env.ts
 * validates at import time and src/db.ts constructs its PrismaClient at import time.
 *
 * The schema itself already exists — global-setup.ts builds every one of them before any
 * worker starts, so that no DDL runs while tests are in flight. All this does is point the
 * process at the right one.
 */
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, expect } from 'vitest';
import { baseUrl, isolationMode, loadTestEnv, schemaNameFor, urlForSchema } from './db-isolation.js';

loadTestEnv();

/** Which test file this copy of the setup belongs to. */
function currentTestFile(): string {
  const fromExpect = (expect as unknown as { getState?: () => { testPath?: string } })
    .getState?.().testPath;
  const fromWorker = (globalThis as { __vitest_worker__?: { filepath?: string } })
    .__vitest_worker__?.filepath;
  const testPath = fromExpect ?? fromWorker;
  if (!testPath) {
    throw new Error('cannot determine the current test file; database isolation needs it');
  }
  return testPath;
}

if (isolationMode() === 'isolated') {
  const schema = schemaNameFor(currentTestFile());
  process.env.DATABASE_URL = urlForSchema(baseUrl(), schema);

  // Uploads are written to disk, so files running in parallel need their own root or one
  // file's document listing can see another's.
  const storage = path.resolve(process.env.STORAGE_DIR ?? './storage-test', schema);
  mkdirSync(storage, { recursive: true });
  process.env.STORAGE_DIR = storage;

  afterAll(() => rmSync(storage, { recursive: true, force: true }));
}
