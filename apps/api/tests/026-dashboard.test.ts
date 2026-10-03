import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeApp, expectOk, get, login } from './helpers.js';
import { prisma } from '../src/db.js';

/**
 * The landing dashboard splits "my projects" in two (Hivamis task 1): what is being executed, and
 * what is still being sold — the opportunities the person owns, for whoever may read the pipeline.
 */
describe('My dashboard', () => {
  let T: Record<string, string>;
  beforeAll(async () => {
    T = { sales: await login('sales@hiva.local'), designer: await login('designer@hiva.local') };
  });
  afterAll(async () => { await closeApp(); });

  it('gives a seller the opportunities they own and have not won or lost, nearest close first', async () => {
    const sales = await prisma.user.findUniqueOrThrow({ where: { email: 'sales@hiva.local' } });
    const open = await prisma.opportunity.findMany({ where: { ownerId: sales.id, deletedAt: null, state: { notIn: ['WON', 'LOST'] } } });
    expect(open.length).toBeGreaterThan(0);
    // One of theirs that is lost must not appear.
    const lost = await prisma.opportunity.update({ where: { id: open[0]!.id }, data: { state: 'LOST', lostReason: 'آزمون' } });

    const data = expectOk(await get('/reports/my-dashboard', T.sales), 'dashboard');
    expect(data.opportunities.map((o: any) => o.id).sort()).toEqual(open.slice(1).map((o) => o.id).sort());
    expect(data.opportunities.some((o: any) => o.id === lost.id)).toBe(false);
    for (const o of data.opportunities) {
      expect(o).toMatchObject({ code: expect.any(String), title: expect.any(String), company: { legalName: expect.any(String) } });
      expect(['WON', 'LOST']).not.toContain(o.state);
    }
    const dates = data.opportunities.map((o: any) => o.expectedCloseDate).filter(Boolean);
    expect(dates).toEqual([...dates].sort());
    await prisma.opportunity.update({ where: { id: lost.id }, data: { state: open[0]!.state, lostReason: null } });
  });

  it('gives no sales half to someone who may not read the pipeline', async () => {
    const data = expectOk(await get('/reports/my-dashboard', T.designer), 'dashboard');
    expect(data.opportunities).toBeNull();
    expect(Array.isArray(data.projects)).toBe(true);
  });
});
