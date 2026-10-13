import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { z } from 'zod';
import { call, closeApp, get, patch, post } from './helpers.js';
import { prisma } from '../src/db.js';
import { tenancy } from '../src/lib/tenant.js';
import { registerCrud } from '../src/lib/crud.js';
import { organizationWhere } from '../src/lib/scope.js';
import { twoOrgs, type TwoOrgs } from './helpers/two-orgs.js';

/**
 * Audit SEC-1 and SEC-12: the generic CRUD routes keep every model to its own organisation, and a
 * write cannot point at another organisation's record. Audit SEC-2: allocations, which reach their
 * organisation through their project, likewise.
 */

describe('CRUD scoping (audit SEC-1, SEC-12)', () => {
  let orgs: TwoOrgs;
  let bCompany: { id: string };
  let bContact: { id: string };

  beforeAll(async () => {
    orgs = await twoOrgs();
    bCompany = await prisma.company.findFirstOrThrow({ where: { organizationId: orgs.b.id } });
    bContact = await prisma.contact.findFirstOrThrow({ where: { organizationId: orgs.b.id, deletedAt: null } });
  }, 120_000);
  afterAll(async () => { tenancy.mode = 'single'; await closeApp(); });

  it('lists, shows and edits only the caller’s contacts', async () => {
    const theirs = await get('/contacts', orgs.a.full.token);
    expect(theirs.status).toBe(200);
    expect(theirs.body.items.map((c: { id: string }) => c.id)).not.toContain(bContact.id);
    expect((await get(`/contacts/${bContact.id}`, orgs.a.full.token)).status).toBe(404);
    expect((await patch(`/contacts/${bContact.id}`, orgs.a.full.token, { notes: 'x' })).status).toBe(404);
    // B still sees its own.
    expect((await get(`/contacts/${bContact.id}`, orgs.b.full.token)).status).toBe(200);
  });

  it('refuses a contact filed under another organisation’s company: the same 422 as no company at all', async () => {
    const foreign = await post('/contacts', orgs.a.full.token, { companyId: bCompany.id, fullName: 'نفوذی' });
    expect(foreign.status).toBe(422);
    expect(foreign.body.error).toMatchObject({ code: 'UNKNOWN_REFERENCE', details: { field: 'companyId' } });
    const missing = await post('/contacts', orgs.a.full.token, { companyId: '00000000-0000-4000-8000-000000000000', fullName: 'هیچ' });
    expect(missing.body.error).toMatchObject({ code: 'UNKNOWN_REFERENCE' });
    expect(await prisma.contact.count({ where: { fullName: 'نفوذی' } })).toBe(0);

    // An edit cannot move a record into another organisation's either: a project to B's client.
    const project = await prisma.project.findFirst({ where: { organizationId: orgs.a.id } });
    if (project) expect((await patch(`/projects/${project.id}`, orgs.a.full.token, { companyId: bCompany.id })).body.error.code).toBe('UNKNOWN_REFERENCE');
  });

  it('has the database refuse a contact whose organisation is not its company’s', async () => {
    await expect(prisma.contact.create({ data: { organizationId: orgs.a.id, companyId: bCompany.id, fullName: 'ناهمخوان' } }))
      .rejects.toMatchObject({ code: 'P2003' });
  });

  it('will not register a model that reaches no organisation without saying how', async () => {
    const server = Fastify();
    server.decorate('authenticate', async () => {});
    server.decorate('requirePermissions', () => async () => {});
    const opts = {
      path: 'milestones', model: 'milestone', permissions: { read: 'project.read', write: 'project.write' },
      createSchema: z.object({}), updateSchema: z.object({}),
    } as const;
    expect(() => registerCrud(server as never, opts)).toThrow(/no organizationId and no scope/);
    expect(() => registerCrud(server as never, { ...opts, scope: (organizationId) => ({ project: { organizationId } }) })).not.toThrow();
    await server.close();
  });

  it('works out how a child reaches its organisation from the schema', () => {
    expect(organizationWhere('contact', 'o')).toEqual({ organizationId: 'o' });
    expect(organizationWhere('milestone', 'o')).toEqual({ project: { organizationId: 'o' } });
    // A role is the code's (no organisation, everyone's) or one organisation's own (audit F-3).
    expect(organizationWhere('role', 'o')).toEqual({ OR: [{ organizationId: null }, { organizationId: 'o' }] });
    expect(organizationWhere('permission', 'o')).toBeNull();
    expect(organizationWhere('organization', 'o')).toEqual({ id: 'o' });
  });

  it('keeps allocations to their organisation: listed, created and deleted (audit SEC-2)', async () => {
    const bProject = await prisma.project.findFirstOrThrow({ where: { organizationId: orgs.b.id } });
    const bUser = await prisma.user.findFirstOrThrow({ where: { organizationId: orgs.b.id } });
    const bAllocation = await prisma.allocation.create({
      data: { projectId: bProject.id, userId: bUser.id, fromDate: new Date('2026-11-01'), toDate: new Date('2026-11-30'), hoursPerDay: 4, createdById: bUser.id },
    });
    const listed = await get('/allocations', orgs.a.full.token);
    expect(listed.status).toBe(200);
    expect(listed.body.map((x: { id: string }) => x.id)).not.toContain(bAllocation.id);
    // Filtering by B's project finds nothing, rather than B's rows.
    expect((await get('/allocations', orgs.a.full.token, { projectId: bProject.id })).body).toEqual([]);

    const made = await post('/allocations', orgs.a.full.token, { projectId: bProject.id, userId: bUser.id, fromDate: '2026-11-01', toDate: '2026-11-02', hoursPerDay: 2 });
    expect(made.status).toBe(422);
    expect(made.body.error.code).toBe('UNKNOWN_REFERENCE');

    expect((await call('DELETE', `/allocations/${bAllocation.id}`, { token: orgs.a.full.token })).status).toBe(404);
    expect(await prisma.allocation.count({ where: { id: bAllocation.id } })).toBe(1);

    // B's own, through the route: created and removed, each with an audit row.
    const own = await post('/allocations', orgs.b.full.token, { projectId: bProject.id, userId: bUser.id, fromDate: '2026-12-01', toDate: '2026-12-02', hoursPerDay: 2 });
    expect(own.status).toBe(201);
    expect((await call('DELETE', `/allocations/${own.body.id}`, { token: orgs.b.full.token })).status).toBe(204);
    expect(await prisma.auditEvent.count({ where: { entityType: 'allocation', entityId: own.body.id, organizationId: orgs.b.id } })).toBe(2);
  });
});
