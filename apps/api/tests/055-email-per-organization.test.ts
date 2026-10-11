import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app, closeApp, DEV_PASSWORD } from './helpers.js';
import { prisma } from '../src/db.js';
import { tenancy } from '../src/lib/tenant.js';
import { hashPassword } from '../src/auth/password.js';
import { provisionOrganization } from '../src/setup/tenant.js';

/**
 * Audit LOG-4: an email was unique across the installation, so a person who works for two
 * organisations on it could have an account in only one. It is now unique within an organisation;
 * an organisation's own address says which account a sign-in is for.
 */

const HOST = 'dovom.example.com';
const signIn = (host: string, email: string, password: string) =>
  app().then((a) => a.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host }, payload: { email, password } }));

describe('An email is unique within its organisation (audit LOG-4)', () => {
  let first: string, second: string;

  beforeAll(async () => {
    tenancy.mode = 'multi';
    first = (await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } })).id;
    await prisma.organization.update({ where: { id: first }, data: { hosts: ['yekom.example.com'] } });
    // The first organisation's managing director also runs the second — under the same address.
    const made = await provisionOrganization({ name: 'سازمان دوم', slug: 'dovom', hosts: [HOST], admin: { fullName: 'سارا مدیری', email: 'ceo@hiva.local' } });
    second = made.organization.id;
    await prisma.user.updateMany({ where: { organizationId: second, email: 'ceo@hiva.local' }, data: { passwordHash: await hashPassword('Second-Org-Pass-1') } });
  }, 120_000);
  afterAll(async () => { tenancy.mode = 'single'; await closeApp(); });

  it('lets two organisations each have the address, and refuses it twice in one', async () => {
    expect(await prisma.user.count({ where: { email: 'ceo@hiva.local' } })).toBe(2);
    const someone = await prisma.user.findFirstOrThrow({ where: { organizationId: second } });
    await expect(prisma.user.create({ data: { organizationId: second, email: 'ceo@hiva.local', fullName: 'تکراری', passwordHash: 'x', departmentId: someone.departmentId } }))
      .rejects.toMatchObject({ code: 'P2002' });
  });

  it('signs in at an organisation’s own address to that organisation’s account', async () => {
    const atFirst = await signIn('yekom.example.com', 'ceo@hiva.local', DEV_PASSWORD);
    expect(atFirst.statusCode).toBe(200);
    expect(await prisma.user.findFirstOrThrow({ where: { id: atFirst.json().user.id } })).toMatchObject({ organizationId: first });
    const atSecond = await signIn(HOST, 'ceo@hiva.local', 'Second-Org-Pass-1');
    expect(atSecond.statusCode).toBe(200);
    expect(await prisma.user.findFirstOrThrow({ where: { id: atSecond.json().user.id } })).toMatchObject({ organizationId: second });
    // The other organisation's password at this address is just a wrong password.
    expect((await signIn(HOST, 'ceo@hiva.local', DEV_PASSWORD)).statusCode).toBe(401);
  });

  it('at the installation’s own address lets the password say which — and asks for the organisation’s address when it cannot', async () => {
    const byPassword = await signIn('hivamis.example.com', 'ceo@hiva.local', 'Second-Org-Pass-1');
    expect(byPassword.statusCode).toBe(200);
    expect(await prisma.user.findFirstOrThrow({ where: { id: byPassword.json().user.id } })).toMatchObject({ organizationId: second });
    // The same password in both: nothing here can tell them apart.
    await prisma.user.updateMany({ where: { organizationId: second, email: 'ceo@hiva.local' }, data: { passwordHash: await hashPassword(DEV_PASSWORD) } });
    const both = await signIn('hivamis.example.com', 'ceo@hiva.local', DEV_PASSWORD);
    expect([both.statusCode, both.json().error.code]).toEqual([409, 'SEVERAL_ACCOUNTS']);
  });
});
