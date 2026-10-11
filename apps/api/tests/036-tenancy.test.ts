import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ALL_FORMS, DEPARTMENT_CODES, SLA_POLICIES } from '@hiva/contracts';
import { app, call, closeApp, expectOk, get, login, DEV_PASSWORD, refreshCookieOf, refreshWith } from './helpers.js';
import { prisma } from '../src/db.js';
import { tenancy } from '../src/lib/tenant.js';
import { provisionOrganization, updateOrganization } from '../src/setup/tenant.js';
import { syncReference } from '../src/setup/reference.js';
import { APP_VERSION } from '../src/version.js';

/**
 * Roadmap #50: several organisations on one installation, each with its own reference data and
 * its own address; an upgrade that brings every organisation up to the code without taking back
 * what each made its own; and the operator's tools to install, provision, back up and upgrade.
 */

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'nemooneh.example.com';

async function asHost(host: string, method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) {
  const res = await (await app()).inject({
    method, url: `/api/v1${url}`, payload: payload as never,
    headers: { host, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}

describe('Organisations on one installation', () => {
  let second: Awaited<ReturnType<typeof provisionOrganization>>;
  let first: { id: string };

  beforeAll(async () => {
    first = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  });
  afterEach(() => { tenancy.mode = 'single'; });
  afterAll(closeApp);

  it('will not add a second organisation to a one-organisation installation by mistake', async () => {
    await expect(provisionOrganization({ name: 'دوم', slug: 'dovom', admin: { email: 'boss@dovom.ir', fullName: 'مدیر' } }))
      .rejects.toMatchObject({ code: 'SINGLE_TENANT' });
  });

  it('provisions an organisation: its own units, SLA policies and forms, and an administrator with no password', async () => {
    tenancy.mode = 'multi';
    second = await provisionOrganization({ name: 'آژانس نمونه', slug: 'nemooneh', hosts: [HOST.toUpperCase()], admin: { email: 'Boss@Nemooneh.IR', fullName: 'پرستو نمونه' } });
    const id = second.organization.id;
    expect(second.organization).toMatchObject({ slug: 'nemooneh', hosts: [HOST] });
    expect(await prisma.department.count({ where: { organizationId: id } })).toBe(DEPARTMENT_CODES.length);
    expect(await prisma.slaPolicy.count({ where: { organizationId: id } })).toBe(SLA_POLICIES.length);
    expect(await prisma.formDefinition.count({ where: { organizationId: id } })).toBe(ALL_FORMS.length);
    // The same codes as the first organisation's, each its own row — before #50 they were unique across the installation.
    const lead = await prisma.formDefinition.findMany({ where: { code: 'A01_LEAD' }, select: { organizationId: true } });
    expect(new Set(lead.map((l) => l.organizationId))).toEqual(new Set([first.id, id]));

    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'boss@nemooneh.ir' }, include: { roles: { include: { role: true } }, department: true } });
    expect(admin.organizationId).toBe(id);
    expect(admin.roles.map((r) => r.role.code)).toEqual(['SUPER_ADMIN']);
    expect(admin.department?.code).toBe('M');
    expect(admin.passwordHash.startsWith('!')).toBe(true);
    expect(new URL(second.activation.url).host).toBe(HOST);
    expect(await prisma.auditEvent.count({ where: { action: 'ORG_PROVISION', entityId: id } })).toBe(1);
    expect(await prisma.systemUpgrade.count({ where: { trigger: 'provision' } })).toBe(1);
  });

  it('refuses what would collide: a taken short name or address, or a malformed one', async () => {
    tenancy.mode = 'multi';
    const base = { name: 'x', admin: { fullName: 'x', email: 'x@x.ir' } };
    await expect(provisionOrganization({ ...base, slug: 'nemooneh' })).rejects.toMatchObject({ code: 'SLUG_TAKEN' });
    await expect(provisionOrganization({ ...base, slug: 'Bad Slug' })).rejects.toMatchObject({ code: 'BAD_SLUG' });
    await expect(provisionOrganization({ ...base, slug: 'sevom', hosts: [HOST] })).rejects.toMatchObject({ code: 'HOST_TAKEN' });
    await expect(provisionOrganization({ ...base, slug: 'sevom', hosts: ['not a host'] })).rejects.toMatchObject({ code: 'BAD_HOST' });
    expect(await prisma.organization.count({ where: { slug: 'sevom' } })).toBe(0);
    // An email taken in another organisation is not a collision (audit LOG-4): 055 covers it.
  });

  it('keeps each organisation to itself: its administrator sets a password, signs in at its address and sees its own', async () => {
    tenancy.mode = 'multi';
    const token = second.activation.url.split('/activate/')[1]!;
    expectOk(await call('POST', `/auth/activation/${token}`, { payload: { password: DEV_PASSWORD } }), 'activate');
    const signedIn = await asHost(HOST, 'POST', '/auth/login', { email: 'boss@nemooneh.ir', password: DEV_PASSWORD });
    expect(signedIn.status).toBe(200);
    const boss = signedIn.body.accessToken as string;
    const theirs = expectOk(await get('/forms/definitions/A01_LEAD', boss), 'their lead form');
    const ceo = await login('ceo@hiva.local');
    const ours = expectOk(await get('/forms/definitions/A01_LEAD', ceo), 'our lead form');
    expect(theirs.id).not.toBe(ours.id);
    expect(theirs.organizationId).toBe(second.organization.id);
    expect(expectOk(await get('/projects', boss), 'projects').total).toBe(0);
    expect(expectOk(await get('/projects', ceo), 'projects').total).toBeGreaterThan(0);
  });

  it('finds the organisation of an anonymous request by its address, and signs nobody in at another’s', async () => {
    tenancy.mode = 'multi';
    expect((await asHost(HOST, 'GET', '/auth/methods')).body.organization).toBe('آژانس نمونه');
    expect((await asHost('unknown.example.com', 'GET', '/auth/methods')).status).toBe(404);
    // ceo@ belongs to the first organisation: at the second one's address, it is a wrong password.
    const wrong = await asHost(HOST, 'POST', '/auth/login', { email: 'ceo@hiva.local', password: DEV_PASSWORD });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.message).toBe('ایمیل یا رمز عبور نادرست است');
    // At the installation's own address, which names no organisation, and at its own, it signs in.
    expect((await asHost('hivamis.example.com', 'POST', '/auth/login', { email: 'ceo@hiva.local', password: DEV_PASSWORD })).status).toBe(200);
    await updateOrganization('nemooneh', { addHosts: ['Second.Example.com'] });
    expect((await prisma.organization.findUniqueOrThrow({ where: { slug: 'nemooneh' } })).hosts).toEqual([HOST, 'second.example.com']);
  });

  it('suspends an organisation: its sessions end, nobody signs in or refreshes, and resuming restores it', async () => {
    tenancy.mode = 'multi';
    const session = await asHost(HOST, 'POST', '/auth/login', { email: 'boss@nemooneh.ir', password: DEV_PASSWORD });
    await updateOrganization('nemooneh', { active: false });
    expect(await prisma.session.count({ where: { user: { organizationId: second.organization.id }, revokedAt: null } })).toBe(0);
    const refused = await asHost(HOST, 'POST', '/auth/login', { email: 'boss@nemooneh.ir', password: DEV_PASSWORD });
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('ORG_SUSPENDED');
    expect((await refreshWith(refreshCookieOf(session)!)).status).toBe(401);
    // The first organisation is untouched.
    expect((await call('POST', '/auth/login', { payload: { email: 'ceo@hiva.local', password: DEV_PASSWORD } })).status).toBe(200);
    await updateOrganization('nemooneh', { active: true });
    expect((await asHost(HOST, 'POST', '/auth/login', { email: 'boss@nemooneh.ir', password: DEV_PASSWORD })).status).toBe(200);
  });
});

describe('The upgrade path', () => {
  afterAll(closeApp);

  it('brings what the catalogue speaks for up to the code, and leaves what an organisation made its own', async () => {
    const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const admin = await login('admin@hiva.local');
    // The administrator sets one policy's hours; another is left as the catalogue has it.
    expectOk(await call('PATCH', '/sla-policies/SLA_ACCOUNT_QC', { token: admin, payload: { hours: 9 } }), 'own hours');
    const catalogue = SLA_POLICIES.find((p) => p.code === 'SLA_REVISION')!;
    await prisma.slaPolicy.update({ where: { organizationId_code: { organizationId: org.id, code: 'SLA_REVISION' } }, data: { hours: catalogue.hours + 5 } });
    // A form the catalogue still speaks for, as an older version left it; and one the organisation edited.
    await prisma.formDefinition.update({ where: { organizationId_code: { organizationId: org.id, code: 'A01_LEAD' } }, data: { schema: [] } });
    await prisma.formDefinition.update({ where: { organizationId_code: { organizationId: org.id, code: 'A02_OPPORTUNITY' } }, data: { schema: [], customizedAt: new Date() } });

    const s = await syncReference(prisma, { trigger: 'manual', appVersion: APP_VERSION, only: [org.id] });
    expect(s.organizations[0]).toMatchObject({ formsChanged: 1, slaUpdated: 1, slaKept: 1 });
    expect(Number((await prisma.slaPolicy.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org.id, code: 'SLA_ACCOUNT_QC' } } })).hours)).toBe(9);
    expect(Number((await prisma.slaPolicy.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org.id, code: 'SLA_REVISION' } } })).hours)).toBe(catalogue.hours);
    const lead = await prisma.formDefinition.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org.id, code: 'A01_LEAD' } } });
    expect((lead.schema as unknown[]).length).toBeGreaterThan(5);
    const kept = await prisma.formDefinition.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org.id, code: 'A02_OPPORTUNITY' } } });
    expect(kept.schema).toEqual([]);
  });

  it('runs one process at a time, and a start-up with nothing to do leaves no record', async () => {
    const org = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    await prisma.formDefinition.update({ where: { organizationId_code: { organizationId: org.id, code: 'A01_LEAD' } }, data: { schema: [] } });
    const before = await prisma.systemUpgrade.count();
    // Two replicas starting together: the change is made once.
    const both = await Promise.all([1, 2].map(() => syncReference(prisma, { trigger: 'startup', appVersion: APP_VERSION })));
    expect(both.reduce((n, s) => n + s.organizations.reduce((m, o) => m + o.formsChanged, 0), 0)).toBe(1);
    expect(await prisma.systemUpgrade.count()).toBe(before + 1);
    const idle = await syncReference(prisma, { trigger: 'startup', appVersion: APP_VERSION });
    expect(idle.recorded).toBe(false);
  });
});

describe('The operator’s tools', () => {
  afterAll(closeApp);

  it('reports the installation’s status, and refuses a command missing what it needs', async () => {
    const tsx = path.resolve(__dirname, '../node_modules/.bin/tsx');
    const { stdout } = await run(tsx, [path.resolve(__dirname, '../src/cli.ts'), 'status'], { env: process.env }).catch((e) => { throw new Error(e.stderr || e.message); });
    const status = JSON.parse(stdout);
    expect(status.version).toBe(APP_VERSION);
    expect(status.migrations).toHaveProperty('applied');
    expect(status.organizations.length).toBeGreaterThan(0);
    const failed = await run(tsx, [path.resolve(__dirname, '../src/cli.ts'), 'tenant:create', '--name', 'x'], { env: process.env }).catch((e) => e);
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stderr).error.code).toBe('MISSING_FLAG');
  }, 60_000);

  it('installs: secrets generated, readable only by the owner, the address and mode set — and never over an existing installation', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hivamis-'));
    const env = { ...process.env, HIVAMIS_DRY_RUN: '1', HIVAMIS_ENV_FILE: path.join(dir, '.env'), HIVAMIS_BACKUP_DIR: path.join(dir, 'b') };
    const script = path.join(ROOT, 'infrastructure/hivamis');
    const { stdout } = await run('bash', [script, 'install', '--org-name', 'آژانس', '--org-slug', 'ajans', '--admin-email', 'a@ajans.ir', '--admin-name', 'مدیر', '--domain', 'hiva.ajans.ir', '--multi'], { env });
    expect(stdout).toContain('up -d --build');
    expect(stdout).toContain('node dist/cli.js tenant:create --name آژانس --slug ajans --admin-email a@ajans.ir --admin-name مدیر --host hiva.ajans.ir');
    const written = readFileSync(path.join(dir, '.env'), 'utf8');
    const val = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(written)?.[1];
    expect(val('JWT_SECRET')!.length).toBeGreaterThanOrEqual(48);
    expect(val('POSTGRES_PASSWORD')!.length).toBeGreaterThanOrEqual(32);
    expect(val('POSTGRES_PASSWORD')).not.toBe('CHANGE_ME');
    expect([val('PUBLIC_APP_URL'), val('CORS_ORIGIN'), val('TENANT_MODE')]).toEqual(['https://hiva.ajans.ir', 'https://hiva.ajans.ir', 'multi']);
    expect(written.match(/^PUBLIC_APP_URL=/gm)).toHaveLength(1);
    expect(statSync(path.join(dir, '.env')).mode & 0o077).toBe(0);

    const again = await run('bash', [script, 'install', '--org-name', 'x', '--org-slug', 'xx', '--admin-email', 'x@x.ir', '--admin-name', 'x'], { env }).catch((e) => e);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already exists');
  }, 60_000);

  it('backs up the database and the files from inside the containers, and restores only when told to', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hivamis-'));
    writeFileSync(path.join(dir, '.env'), 'POSTGRES_USER=hiva\nPOSTGRES_DB=hiva_os\n');
    const env = { ...process.env, HIVAMIS_DRY_RUN: '1', HIVAMIS_ENV_FILE: path.join(dir, '.env'), HIVAMIS_BACKUP_DIR: path.join(dir, 'b') };
    const script = path.join(ROOT, 'infrastructure/hivamis');
    const backup = (await run('bash', [script, 'backup'], { env })).stdout;
    expect(backup).toMatch(/exec -T db pg_dump --format=custom --no-owner --no-acl -U hiva hiva_os > .*hiva-db-\d{8}-\d{6}\.dump/);
    expect(backup).toMatch(/exec -T api tar -czf - -C \/app storage > .*hiva-storage-\d{8}-\d{6}\.tar\.gz/);
    const unconfirmed = await run('bash', [script, 'restore', '--db', 'x.dump'], { env }).catch((e) => e);
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.stderr).toContain('--yes');
    const restore = (await run('bash', [script, 'restore', '--db', 'x.dump', '--storage', 's.tar.gz', '--yes'], { env })).stdout;
    expect(restore.indexOf('stop web api')).toBeLessThan(restore.indexOf('pg_restore'));
    expect(restore).toContain('pg_restore --clean --if-exists --no-owner --no-acl -U hiva -d hiva_os < x.dump');
    expect(restore).toContain('< s.tar.gz');
    const upgrade = (await run('bash', [script, 'upgrade'], { env })).stdout;
    // A way back before anything changes.
    expect(upgrade.indexOf('pg_dump')).toBeLessThan(upgrade.indexOf('build'));
    expect(upgrade).toContain('node dist/cli.js status');
  }, 60_000);
});
