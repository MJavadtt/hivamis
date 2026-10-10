import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { z } from 'zod';
import { closeApp, get, patch, post } from './helpers.js';
import { prisma } from '../src/db.js';
import { tenancy } from '../src/lib/tenant.js';
import { registerCrud } from '../src/lib/crud.js';
import { organizationWhere } from '../src/lib/scope.js';
import { twoOrgs, type TwoOrgs } from './helpers/two-orgs.js';

/**
 * Audit SEC-1 and SEC-12: the generic CRUD routes keep every model to its own organisation, and a
 * write cannot point at another organisation's record.
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
    expect(organizationWhere('role', 'o')).toBeNull();
    expect(organizationWhere('organization', 'o')).toEqual({ id: 'o' });
  });
});
