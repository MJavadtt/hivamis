import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom for the API client, which reads localStorage and fetch. The pure-logic suites do
    // not need it, but one environment for the whole project beats per-file annotations.
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
    // Jalali display and the business calendar both assume the organisation's own timezone;
    // pinning it keeps a CI runner in UTC from reading a different day than a user in Tehran.
    env: { TZ: 'Asia/Tehran' },
  },
});
