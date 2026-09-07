import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

/**
 * Runs once before the suite: applies migrations and loads reference data
 * (departments, roles, permissions, SLA policies, all 130 form definitions) plus demo data.
 *
 * Deliberately non-destructive — no `migrate reset`. The seed is idempotent (it upserts
 * reference data and skips demo data that already exists), and every record the tests create
 * takes its business code from the atomic counter, so repeated runs never collide.
 */
export default async function setup() {
  const apiDir = path.resolve(import.meta.dirname, '..');
  const envPath = path.join(apiDir, '.env.test');
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }

  execSync('pnpm exec prisma migrate deploy', { cwd: apiDir, stdio: 'pipe', env: process.env });
  execSync('pnpm exec tsx --env-file=.env.test prisma/seed.ts', {
    cwd: apiDir, stdio: 'pipe', env: process.env,
  });
}
