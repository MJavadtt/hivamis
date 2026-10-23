import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { call, closeApp, signIn } from './helpers.js';
import { prisma } from '../src/db.js';
import { run } from '../src/cli.js';
import { KEEP, WIPED, planReset, resetOrganization } from '../src/setup/reset.js';
import { provisionOrganization } from '../src/setup/tenant.js';
import { tenancy } from '../src/lib/tenant.js';

/**
 * The owner's report (2026-10-23): a clean start — every person and record of the organisation but
 * one system administrator, whose password the operator may set; the history kept (the owner's answer).
 */
describe('A clean start for an organisation (owner’s report, 2026-10-23)', () => {
  let orgId: string;
  let other: { id: string; companyId: string };
  const before: Record<string, number> = {};

  beforeAll(async () => {
    orgId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@hiva.local' }, select: { organizationId: true } })).organizationId;
    await prisma.organization.update({ where: { id: orgId }, data: { slug: 'hiva' } });
    // A second organisation on the same installation, which a clean start of the first must not touch.
    const mode = tenancy.mode;
    tenancy.mode = 'multi';
    const made = await provisionOrganization({ name: 'سازمان دیگر', slug: 'other-org', hosts: ['other.example'], admin: { email: 'admin@other.example', fullName: 'مدیر دیگر' } })
      .finally(() => { tenancy.mode = mode; });
    const otherId = (made as { organization: { id: string } }).organization.id;
    const company = await prisma.company.create({ data: { organizationId: otherId, legalName: 'مشتری سازمان دیگر' } });
    other = { id: otherId, companyId: company.id };
    for (const m of ['department', 'role', 'formDefinition', 'slaPolicy', 'auditEvent', 'stateTransition', 'counter'] as const) {
      before[m] = await (prisma[m] as unknown as { count(a: unknown): Promise<number> }).count({ where: m === 'role' || m === 'counter' ? {} : { organizationId: orgId } });
    }
    await signIn('sales@hiva.local'); // history of their own, so their name stays in it
  });
  afterAll(closeApp);

  it('keeps what the organisation is and its history, and empties everything else', () => {
    for (const m of ['Department', 'Role', 'FormDefinition', 'SlaPolicy', 'AuditEvent', 'StateTransition', 'Counter', 'Team']) expect(KEEP.has(m), m).toBe(true);
    for (const m of ['Company', 'Project', 'Task', 'Document', 'FormSubmission', 'Notification', 'ChatMessage', 'Booking', 'TimeEntry', 'Delegation']) expect(WIPED, m).toContain(m);
  });

  it('says what it would delete, and refuses anyone but a system administrator', async () => {
    const plan = await planReset(orgId, 'Admin@Hiva.local');
    expect(plan.admin.email).toBe('admin@hiva.local');
    expect(plan.records.Company).toBeGreaterThan(0);
    expect(plan.people).toBeGreaterThan(5);
    const dry = await run(['org:reset', '--slug', 'hiva', '--keep-admin', 'admin@hiva.local']) as { dryRun: boolean };
    expect(dry.dryRun).toBe(true);
    expect(await prisma.company.count({ where: { organizationId: orgId } })).toBe(plan.records.Company);
    await expect(planReset(orgId, 'ceo@hiva.local')).rejects.toMatchObject({ code: 'NOT_A_SYSTEM_ADMIN' });
    await expect(resetOrganization(orgId, 'admin@hiva.local', 'short')).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
  });

  it('starts the organisation again with its administrator alone, the password they were given, and the history', async () => {
    const out = await resetOrganization(orgId, 'admin@hiva.local', 'Fresh-Start-2026!');
    expect(out).toMatchObject({ kept: 'admin@hiva.local', passwordSet: true });
    expect(out.peopleRemoved + out.peopleDeleted).toBeGreaterThan(5);

    for (const m of ['company', 'project', 'task', 'document', 'formSubmission', 'lead', 'invoice', 'booking'] as const) {
      expect(await (prisma[m] as unknown as { count(a: unknown): Promise<number> }).count({ where: { organizationId: orgId } }), m).toBe(0);
    }
    // What the organisation is, unchanged; the history, all there and one row longer.
    for (const m of ['department', 'role', 'formDefinition', 'slaPolicy', 'stateTransition', 'counter'] as const) {
      expect(await (prisma[m] as unknown as { count(a: unknown): Promise<number> }).count({ where: m === 'role' || m === 'counter' ? {} : { organizationId: orgId } }), m).toBe(before[m]);
    }
    expect(await prisma.auditEvent.count({ where: { organizationId: orgId } })).toBeGreaterThan(before.auditEvent!);
    expect(await prisma.auditEvent.findFirstOrThrow({ where: { action: 'ORGANIZATION_RESET', entityId: orgId } })).toMatchObject({ after: { kept: 'admin@hiva.local', passwordSet: true } });

    // One person signs in, with the new password; the rest are gone, their names kept where the history names them.
    const people = await prisma.user.findMany({ where: { organizationId: orgId, deletedAt: null } });
    expect(people.map((p) => p.email)).toEqual(['admin@hiva.local']);
    expect((await call('POST', '/auth/login', { payload: { email: 'admin@hiva.local', password: 'Hiva@Dev2026!' } })).status).toBe(401);
    expect((await signIn('admin@hiva.local', 'Fresh-Start-2026!')).body.mustChangePassword).toBe(false);
    expect((await call('POST', '/auth/login', { payload: { email: 'sales@hiva.local', password: 'Hiva@Dev2026!' } })).status).toBe(401);
    expect(await prisma.user.findFirst({ where: { organizationId: orgId, fullName: 'الهام کریمی' }, select: { deletedAt: true } })).toMatchObject({ deletedAt: expect.any(Date) });

    // The other organisation, untouched.
    expect(await prisma.company.findUnique({ where: { id: other.companyId } })).not.toBeNull();
    expect(await prisma.user.count({ where: { organizationId: other.id, deletedAt: null } })).toBe(1);
  }, 300_000);

  it('runs on the server as `hivamis reset`: what it deletes, a backup, and only then the clean start', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hivamis-reset-'));
    try {
      writeFileSync(path.join(dir, '.env'), '');
      const env = { ...process.env, HIVAMIS_DRY_RUN: '1', HIVAMIS_ENV_FILE: path.join(dir, '.env'), HIVAMIS_BACKUP_DIR: path.join(dir, 'b') };
      const r = await promisify(execFile)('bash', [path.resolve(__dirname, '../../../infrastructure/hivamis'), 'reset', '--admin', 'info@example.org', '--yes'], { env });
      const at = (t: string) => { const i = r.stdout.indexOf(t); expect(i, t).toBeGreaterThan(-1); return i; };
      expect(at('org:reset --keep-admin info@example.org\n')).toBeLessThan(at('pg_dump'));
      expect(at('pg_dump')).toBeLessThan(at('org:reset --keep-admin info@example.org --yes'));
      const refused = await promisify(execFile)('bash', [path.resolve(__dirname, '../../../infrastructure/hivamis'), 'reset'], { env }).catch((e) => e);
      expect(refused.stderr).toContain('reset needs --admin EMAIL');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
