import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { changePasswordSchema } from '@hiva/contracts';
import { closeApp, get, login, signIn } from './helpers.js';
import { prisma } from '../src/db.js';
import { PENDING_PREFIX } from '../src/onboarding/activation.js';
import { temporaryPassword } from '../src/onboarding/passwords.js';
import { verifyPassword } from '../src/auth/password.js';
import { run } from '../src/cli.js';

/**
 * The owner's answer (2026-10-30), after the move from Mizito: "give me every user's username and
 * password". Nobody brought in has one, and none can be read back; so each who never had one gets a
 * temporary password, written to a file for the administrator and changed at the first sign-in.
 */
describe('Temporary first passwords (users:passwords)', () => {
  let admin: { id: string; organizationId: string; email: string };
  let dir: string;
  const waiting = ['امید منتظر', 'نسرین منتظر'];
  beforeAll(async () => {
    await login('admin@hiva.local');
    admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@hiva.local' }, select: { id: true, organizationId: true, email: true } });
    dir = await mkdtemp(path.join(tmpdir(), 'hivamis-passwords-'));
    const creative = await prisma.department.findFirstOrThrow({ where: { organizationId: admin.organizationId, code: 'CR' }, select: { id: true } });
    for (const [i, fullName] of waiting.entries()) {
      const user = await prisma.user.create({
        data: { organizationId: admin.organizationId, email: `waiting${i}@import.invalid`, fullName, passwordHash: `${PENDING_PREFIX}${i}`, departmentId: creative.id },
      });
      await prisma.accountActivation.create({ data: { userId: user.id, tokenHash: `test-${i}`, expiresAt: new Date(Date.now() + 86_400_000), createdById: admin.id } });
    }
  });
  afterAll(closeApp);

  it('makes passwords the policy accepts, with no letter that reads as another', () => {
    for (let i = 0; i < 50; i++) {
      const p = temporaryPassword();
      expect(changePasswordSchema.shape.newPassword.safeParse(p).success).toBe(true);
      expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}$/);
    }
  });

  it('runs only as the organisation’s system administrator', async () => {
    await expect(run(['users:passwords', '--as', 'pmo@hiva.local'])).rejects.toMatchObject({ code: 'NOT_SYSTEM_ADMIN' });
  });

  it('says who, and sets nothing, without --commit', async () => {
    const out = (await run(['users:passwords', '--as', admin.email])) as { dryRun: boolean; people: string[] };
    expect(out.dryRun).toBe(true);
    expect(out.people).toEqual(expect.arrayContaining(['امید منتظر → waiting0@import.invalid', 'نسرین منتظر → waiting1@import.invalid']));
    expect(out.people.join()).not.toContain('admin@hiva.local');
    expect(await prisma.user.count({ where: { email: { startsWith: 'waiting' }, passwordHash: { startsWith: PENDING_PREFIX } } })).toBe(2);
  });

  it('sets each one, writes it only to a new file of the administrator’s, and asks for a change at the first sign-in', async () => {
    const file = path.join(dir, 'passwords.csv');
    const out = (await run(['users:passwords', '--as', admin.email, '--commit', '--out', file])) as { count: number; file: string };
    expect(out).toMatchObject({ file, mustChangePassword: true });
    expect(JSON.stringify(out)).not.toMatch(/[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const lines = (await readFile(file, 'utf8')).split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('﻿"نام","نام کاربری (ایمیل)","رمز موقت","واحد"');
    expect(lines).toHaveLength(out.count + 1);
    const row = lines.find((l) => l.includes('waiting0@import.invalid'))!.split(',').map((f) => f.slice(1, -1));
    expect(row[0]).toBe('امید منتظر');
    const password = row[2]!;

    const user = await prisma.user.findFirstOrThrow({ where: { email: 'waiting0@import.invalid' } });
    expect(await verifyPassword(user.passwordHash, password)).toBe(true);
    expect(user.mustChangePassword).toBe(true);
    // The link sent before cannot set another password over this one.
    expect(await prisma.accountActivation.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { entityId: user.id, action: 'PASSWORD_SET', actorId: admin.id } })).toBe(1);

    const { access } = await signIn('waiting0@import.invalid', password);
    expect((await get('/auth/me', access)).body.mustChangePassword).toBe(true);
    // The administrator's own password, and everyone's who had one, is untouched.
    expect(await signIn('admin@hiva.local')).toBeTruthy();
  });

  it('finds nobody left the second time, and never overwrites a file', async () => {
    expect(((await run(['users:passwords', '--as', admin.email])) as { count: number }).count).toBe(0);
    const file = path.join(dir, 'kept.csv');
    await writeFile(file, 'kept');
    await expect(run(['users:passwords', '--as', admin.email, '--commit', '--out', file])).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(file, 'utf8')).toBe('kept');
  });
});

describe('Temporary passwords on a server (infrastructure/hivamis passwords)', () => {
  const env = { ...process.env, HIVAMIS_DRY_RUN: '1', HIVAMIS_ENV_FILE: '/dev/null' };
  const script = path.resolve(__dirname, '../../../infrastructure/hivamis');

  it('sets them in the container, brings the file out readable by its owner only, and leaves none behind', async () => {
    const { stdout } = await promisify(execFile)('bash', [script, 'passwords', '--as', 'admin@x.ir', '--out', '/tmp/hivamis-test-none.csv', '--commit'], { env });
    const at = (s: string) => stdout.indexOf(s);
    expect(stdout).toContain('users:passwords --as admin@x.ir --commit --out /tmp/hivamis-passwords.csv');
    expect(at('users:passwords')).toBeLessThan(at('cp api:/tmp/hivamis-passwords.csv /tmp/hivamis-test-none.csv'));
    expect(at('cp api:')).toBeLessThan(at('chmod 600 /tmp/hivamis-test-none.csv'));
    expect(at('chmod 600')).toBeLessThan(at('rm -f /tmp/hivamis-passwords.csv'));
    const dry = (await promisify(execFile)('bash', [script, 'passwords', '--as', 'admin@x.ir'], { env })).stdout;
    expect(dry).not.toContain('--commit');
  });

  it('refuses a file that is already there', async () => {
    await expect(promisify(execFile)('bash', [script, 'passwords', '--as', 'admin@x.ir', '--out', script, '--commit'], { env })).rejects.toMatchObject({ stderr: expect.stringContaining('already exists') });
  });
});
