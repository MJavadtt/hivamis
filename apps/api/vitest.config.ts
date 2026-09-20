import { defineConfig } from 'vitest/config';

// Shared mode puts every file back on one database, where they must not overlap.
const isolated = process.env.HIVA_TEST_ISOLATION !== 'shared';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
    // Each file owns a schema of its own (tests/db-isolation.ts), so files no longer contend.
    // Order still matters *within* a file: 002 drives one entity through a whole lifecycle.
    fileParallelism: isolated,
    // 'stack' runs afterAll hooks in reverse registration order, so the setup file's teardown —
    // which drops the schema — runs after the test file's own, which closes the app.
    sequence: { concurrent: false, hooks: 'stack' },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    setupFiles: ['tests/setup.ts'],
    globalSetup: ['tests/global-setup.ts'],
  },
});
