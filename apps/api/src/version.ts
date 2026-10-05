import { readFileSync } from 'node:fs';

/**
 * The running version (roadmap #50): `APP_VERSION` when the build sets it (a release tag, a commit),
 * else the API package's own version. Written into each reference sync, shown by the status page.
 */
export const APP_VERSION: string = process.env.APP_VERSION?.trim() || (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();
