import { describe, it, expect, afterAll } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeApp } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { demoAccountGate, deactivateDemoAccounts, findActiveDemoAccounts } from '../src/lib/demo-accounts.js';
import { provisionOrganization } from '../src/setup/tenant.js';

/**
 * Audit SEC-8: a production API does not start while an account anyone holding the README can sign
 * in to is active — unless the operator says so, and then it says so too, at fatal, every boot.
 */

const API = path.resolve(__dirname, '..');
const ROOT = path.resolve(API, '../..');
const run = promisify(execFile);

/** Starts the real server in production mode on this file's schema; resolves with its exit code and output. */
function boot(extra: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(path.join(API, 'node_modules/.bin/tsx'), ['src/server.ts'], {
      cwd: API,
      env: { ...process.env, NODE_ENV: 'production', PORT: '0', HOST: '127.0.0.1', REFERENCE_SYNC: 'off', JOBS_ENABLED: 'false', LOG_LEVEL: 'info', ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const take = (b: Buffer) => {
      out += b.toString();
      // Started: that is all the allowed case needs to show; stop it rather than leave it serving.
      if (/listening on/.test(out)) child.kill('SIGTERM');
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

describe('Demo accounts in production (audit SEC-8)', () => {
  afterAll(async () => { await closeApp(); });

  it('refuses to start while a demo account is active, and names the command that clears them', async () => {
    expect((await findActiveDemoAccounts()).count).toBeGreaterThan(0);
    const { code, out } = await boot({});
    expect(code).toBe(1);
    expect(out).toContain('Refusing to start');
    expect(out).toContain('demo:deactivate');
    expect(out).not.toMatch(/listening on/);
  }, 90_000);

  it('starts with ALLOW_DEMO_ACCOUNTS=true — saying so at fatal before it listens', async () => {
    const { out } = await boot({ ALLOW_DEMO_ACCOUNTS: 'true' });
    const fatal = out.split('\n').find((l) => l.includes('ALLOW_DEMO_ACCOUNTS=true'));
    expect(fatal).toBeDefined();
    expect(JSON.parse(fatal!).level).toBe(60); // pino's fatal
    expect(out.indexOf('ALLOW_DEMO_ACCOUNTS=true')).toBeLessThan(out.search(/listening on/));
  }, 90_000);

  it('clears them with demo:deactivate — sessions ended, each change in the audit trail — and then starts', async () => {
    const before = await prisma.user.findMany({ where: { email: { endsWith: '@hiva.local' }, isActive: true }, select: { id: true } });
    const { deactivated } = await deactivateDemoAccounts();
    expect(deactivated).toHaveLength(before.length);
    const ids = before.map((u) => u.id);
    expect(await prisma.session.count({ where: { userId: { in: ids }, revokedAt: null } })).toBe(0);
    const rows = await prisma.auditEvent.findMany({ where: { entityType: 'user', entityId: { in: ids }, reason: { contains: 'SEC-8' } } });
    expect(rows).toHaveLength(ids.length);
    expect(rows[0]).toMatchObject({ before: { isActive: true }, after: { isActive: false } });

    const fatal: string[] = [];
    const gate = await demoAccountGate({ fatal: (_o, m) => fatal.push(m), error: () => {} }, false);
    expect(gate.refuse).toBe(false);
    expect(fatal).toEqual([]);
    const { out } = await boot({});
    expect(out).toMatch(/listening on/);
  }, 90_000);

  it('will not make a demo-domain address the first administrator: neither the installer nor, in production, the API', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hivamis-'));
    try {
      const envs = { ...process.env, HIVAMIS_DRY_RUN: '1', HIVAMIS_ENV_FILE: path.join(dir, '.env') };
      const script = path.join(ROOT, 'infrastructure/hivamis');
      const refused = await run('bash', [script, 'install', '--org-name', 'x', '--org-slug', 'xx', '--admin-email', 'Admin@Hiva.Local', '--admin-name', 'x'], { env: envs }).catch((e) => e);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('@hiva.local');

      // A real install: no seed among its commands, and the settings it writes keep demo data off.
      const { stdout } = await run('bash', [script, 'install', '--org-name', 'x', '--org-slug', 'xx', '--admin-email', 'a@x.ir', '--admin-name', 'x'], { env: envs });
      expect(stdout).not.toMatch(/seed/i);
      const written = readFileSync(path.join(dir, '.env'), 'utf8');
      expect(written).toMatch(/^SEED_DEMO_DATA=false$/m);
      expect(written).toMatch(/^ALLOW_DEMO_ACCOUNTS=false$/m);
    } finally { rmSync(dir, { recursive: true, force: true }); }

    const was = env.NODE_ENV;
    (env as { NODE_ENV: string }).NODE_ENV = 'production';
    try {
      await expect(provisionOrganization({ name: 'x', slug: 'demo-x', admin: { email: 'boss@hiva.local', fullName: 'x' } }))
        .rejects.toMatchObject({ code: 'DEMO_EMAIL' });
    } finally { (env as { NODE_ENV: string }).NODE_ENV = was; }
  });
});
