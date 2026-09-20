import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The suite starts with pure logic — conversion, the API client's refresh flow, label
    // completeness — none of which needs a DOM. Component tests can add jsdom when they arrive.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Jalali display and the business calendar both assume the organisation's own timezone;
    // pinning it keeps a CI runner in UTC from reading a different day than a user in Tehran.
    env: { TZ: 'Asia/Tehran' },
  },
});
