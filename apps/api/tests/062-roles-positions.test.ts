import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ROLE_PERMISSIONS } from '@hiva/contracts';
import { call, closeApp, expectOk, get, login, patch, post, put } from './helpers.js';
import { prisma } from '../src/db.js';
import { hashPassword } from '../src/auth/password.js';
import { provisionOrganization } from '../src/setup/tenant.js';
import { tenancy } from '../src/lib/tenant.js';

/**
 * Audit F-3: roles the administrator makes — from scratch or as a copy — renames, recolours and
 * deletes, while the code's roles stay as they are; and a catalogue of positions a person's title
 * follows. Every change to a role is a new version of the permissions rule set.
 */

const del = (url: string, token: string) => call('DELETE', url, { token });
const permsVersions = () => prisma.ruleSetVersion.count({ where: { kind: 'permissions' } });

describe('Roles the organisation makes (audit F-3)', () => {
  let admin: string, designerId: string, code: string;
  let other: { token: string; userId: string };

  beforeAll(async () => {
    admin = await login('admin@hiva.local');
    designerId = (await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } })).id;
    // A second organisation on the installation, made the way the operator makes one.
    tenancy.mode = 'multi';
    const second = await provisionOrganization({ name: 'آژانس دیگر', slug: 'digar', admin: { email: 'boss@digar.ir', fullName: 'مدیر دیگر' } })
      .finally(() => { tenancy.mode = 'single'; });
    await prisma.user.update({ where: { id: second.admin.id }, data: { passwordHash: await hashPassword('Digar@Test2026!'), mustChangePassword: false, isActive: true } });
    const signed = await call('POST', '/auth/login', { payload: { email: 'boss@digar.ir', password: 'Digar@Test2026!' } });
    other = { token: signed.body.accessToken, userId: second.admin.id };
  });
  afterAll(closeApp);

  it('makes a role as a copy of another’s permissions here — a new rule-set version, audited', async () => {
    const before = await permsVersions();
    const made = expectOk(await post('/roles', admin, { nameFa: 'خلاقه', nameEn: 'Creative lead', color: '#7a69f2', copyFrom: 'UNIT_MANAGER' }), 'create');
    code = made.code;
    expect(code).toMatch(/^C_[A-Z0-9]{8}$/);
    expect(made.permissions.sort()).toEqual([...ROLE_PERMISSIONS.UNIT_MANAGER].sort());
    expect(await permsVersions()).toBe(before + 1);
    const latest = await prisma.ruleSetVersion.findFirstOrThrow({ where: { kind: 'permissions' }, orderBy: { version: 'desc' } });
    expect(latest.note).toContain('خلاقه');
    expect(await prisma.auditEvent.count({ where: { entityType: 'role', entityId: code, action: 'CREATE' } })).toBe(1);

    const listed = expectOk(await get('/roles', admin), 'roles').find((r: any) => r.code === code);
    expect(listed).toMatchObject({ nameFa: 'خلاقه', custom: true, color: '#7a69f2', userCount: 0 });
  });

  it('is granted like any role, and what it holds reaches the person who holds it', async () => {
    expectOk(await put(`/roles/${code}/permissions`, admin, { permissions: ['project.read', 'brand.manage'] }), 'grant');
    expectOk(await patch(`/users/${designerId}`, admin, { roleCodes: ['UNIT_MEMBER', code] }), 'assign');
    const designer = await login('designer@hiva.local');
    const me = expectOk(await get('/auth/me', designer), 'me');
    expect(me.roles).toContain(code);
    expect(me.permissions).toContain('brand.manage');
  });

  it('is invisible to another organisation: not listed, not found, not grantable', async () => {
    expect(expectOk(await get('/roles', other.token), 'roles').some((r: any) => r.code === code)).toBe(false);
    expect((await patch(`/roles/${code}`, other.token, { nameFa: 'ربوده' })).status).toBe(404);
    expect((await del(`/roles/${code}`, other.token)).status).toBe(404);
    expect((await put(`/roles/${code}/permissions`, other.token, { permissions: [] })).status).toBe(404);
    const assign = await patch(`/users/${other.userId}`, other.token, { roleCodes: ['SUPER_ADMIN', code] });
    expect(assign.status).toBe(400);
    expect(assign.body.error.code).toBe('UNKNOWN_ROLE');
  });

  it('renames and recolours its own roles; the code’s roles keep their names and cannot be deleted', async () => {
    const before = await permsVersions();
    expect(expectOk(await patch(`/roles/${code}`, admin, { nameFa: 'خلاقیت ارشد', color: '#3f84e8' }), 'rename')).toMatchObject({ nameFa: 'خلاقیت ارشد', color: '#3f84e8' });
    expect(await permsVersions()).toBe(before + 1);
    const renamed = await prisma.auditEvent.findFirstOrThrow({ where: { entityType: 'role', entityId: code, action: 'UPDATE' }, orderBy: { createdAt: 'desc' } });
    expect(renamed.before).toMatchObject({ nameFa: 'خلاقه' });
    for (const system of ['UNIT_MANAGER', 'SUPER_ADMIN', 'CEO']) {
      expect((await patch(`/roles/${system}`, admin, { nameFa: 'نام تازه' })).body.error.code, system).toBe('SYSTEM_ROLE');
      expect((await del(`/roles/${system}`, admin)).body.error.code, system).toBe('SYSTEM_ROLE');
    }
    expect((await patch(`/roles/${code}`, admin, { color: 'red' })).status).toBe(400);
  });

  it('is not deleted while anything names it — and says what — then goes with its grants', async () => {
    const held = await del(`/roles/${code}`, admin);
    expect(held.status).toBe(409);
    expect(held.body.error).toMatchObject({ code: 'ROLE_IN_USE', details: { holders: 1 } });

    expectOk(await patch(`/users/${designerId}`, admin, { roleCodes: ['UNIT_MEMBER'] }), 'unassign');
    expect((await del(`/roles/${code}`, admin)).status).toBe(204);
    expect(await prisma.role.findUnique({ where: { code } })).toBeNull();
    expect(await prisma.roleGrant.count({ where: { roleCode: code, supersededAt: null } })).toBe(0);
    expect(await prisma.roleGrant.count({ where: { roleCode: code } })).toBeGreaterThan(0);
    // The rules in force no longer name it. (They are the rules from before it was made, so that
    // version — same fingerprint — is the one in force again, rather than a copy of it.)
    const { registerRuleSets } = await import('../src/workflow/rules.js');
    const inForce = await prisma.ruleSetVersion.findUniqueOrThrow({ where: { id: (await registerRuleSets(prisma)).permissions } });
    expect(JSON.stringify(inForce.snapshot)).not.toContain(code);
    expect(await prisma.auditEvent.count({ where: { entityType: 'role', entityId: code, action: 'DELETE' } })).toBe(1);
    expect((await get('/roles', admin)).body.some((r: any) => r.code === code)).toBe(false);
  });

  it('is only the role administrator’s to make', async () => {
    const designer = await login('designer@hiva.local');
    expect((await post('/roles', designer, { nameFa: 'نقش من' })).status).toBe(403);
  });
});

describe('Positions (audit F-3)', () => {
  let admin: string, designerId: string;
  beforeAll(async () => {
    admin = await login('admin@hiva.local');
    designerId = (await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } })).id;
  });
  afterAll(closeApp);

  it('keeps a catalogue a person’s title follows: given, renamed, archived', async () => {
    const made = expectOk(await post('/positions', admin, { nameFa: 'طراح ارشد بصری', nameEn: 'Senior visual designer', departmentCode: 'CR', defaultRoleCodes: ['UNIT_MEMBER'] }), 'position');
    expect(made).toMatchObject({ departmentCode: 'CR', defaultRoleCodes: ['UNIT_MEMBER'], holders: 0 });
    expect((await post('/positions', admin, { nameFa: 'طراح ارشد بصری' })).body.error.code).toBe('POSITION_EXISTS');
    expect((await post('/positions', admin, { nameFa: 'سمت بی‌نقش', defaultRoleCodes: ['C_NOTAROLE'] })).body.error.code).toBe('UNKNOWN_ROLE');

    expectOk(await patch(`/users/${designerId}`, admin, { positionId: made.id }), 'give');
    expect(await prisma.user.findUniqueOrThrow({ where: { id: designerId } })).toMatchObject({ positionId: made.id, jobTitle: 'طراح ارشد بصری' });

    expectOk(await patch(`/positions/${made.id}`, admin, { nameFa: 'مدیر هنری' }), 'rename');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: designerId } })).jobTitle).toBe('مدیر هنری');

    expectOk(await patch(`/positions/${made.id}`, admin, { archived: true }), 'archive');
    expect((expectOk(await get('/positions', admin), 'list') as any[]).some((p) => p.id === made.id)).toBe(false);
    expect((await patch(`/users/${designerId}`, admin, { positionId: made.id })).body.error.code).toBe('UNKNOWN_POSITION');
    expect(await prisma.auditEvent.count({ where: { entityType: 'position', entityId: made.id } })).toBe(3);
  });

  it('is changed only by whoever manages people, and read by anyone choosing one', async () => {
    const designer = await login('designer@hiva.local');
    expect((await get('/positions', designer)).status).toBe(200);
    expect((await post('/positions', designer, { nameFa: 'سمت من' })).status).toBe(403);
  });
});
