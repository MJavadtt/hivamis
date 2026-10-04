import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DEFAULT_UNIT_COLORS, DEPARTMENT_CODES, contrastRatio, textOn } from '@hiva/contracts';
import { closeApp, expectOk, get, login, patch } from './helpers.js';
import { prisma } from '../src/db.js';

/**
 * Hivamis task 9: the system administrator sets each unit's tag colour — the colour that unit's tag
 * has on every screen. Until then a unit shows its default, and every colour stays legible.
 */
describe("Each unit's tag colour", () => {
  let admin: string, sales: string;
  beforeAll(async () => { admin = await login('admin@hiva.local'); sales = await login('sales@hiva.local'); });
  afterAll(async () => { await closeApp(); });

  it('shows every unit in its default colour until one is chosen', async () => {
    const units = expectOk(await get('/departments', sales), 'units');
    for (const u of units) {
      expect(u.tagColor, u.code).toBeNull();
      expect(u.color, u.code).toBe(DEFAULT_UNIT_COLORS[u.code as keyof typeof DEFAULT_UNIT_COLORS]);
    }
    // Ten distinct defaults: two units side by side never read as one.
    expect(new Set(Object.values(DEFAULT_UNIT_COLORS)).size).toBe(DEPARTMENT_CODES.length);
  });

  it('lets the system administrator choose a colour, seen by everyone and recorded', async () => {
    const set = expectOk(await patch('/departments/CR/color', admin, { color: '#AB12CD' }), 'set');
    expect(set).toEqual({ code: 'CR', tagColor: '#ab12cd', color: '#ab12cd' });
    const units = expectOk(await get('/departments', sales), 'units');
    expect(units.find((u: any) => u.code === 'CR').color).toBe('#ab12cd');
    const cr = await prisma.department.findFirstOrThrow({ where: { code: 'CR', organization: { users: { some: { email: 'admin@hiva.local' } } } } });
    const trail = await prisma.auditEvent.findFirst({ where: { entityType: 'department', entityId: cr.id, reason: 'tag colour' }, orderBy: { createdAt: 'desc' } });
    expect(trail).toMatchObject({ before: { tagColor: null }, after: { tagColor: '#ab12cd' } });

    // null returns the unit to its default.
    expect(expectOk(await patch('/departments/CR/color', admin, { color: null }), 'reset')).toEqual({ code: 'CR', tagColor: null, color: DEFAULT_UNIT_COLORS.CR });
  });

  it('accepts only a #rrggbb colour, only from an administrator, only for a real unit', async () => {
    expect((await patch('/departments/CR/color', admin, { color: 'red' })).status).toBe(400);
    expect((await patch('/departments/CR/color', admin, { color: '#12345' })).status).toBe(400);
    expect((await patch('/departments/CR/color', admin, {})).status).toBe(400);
    expect((await patch('/departments/CR/color', sales, { color: '#123456' })).status).toBe(403);
    expect((await patch('/departments/NOPE/color', admin, { color: '#123456' })).status).toBe(404);
    // The database refuses anything else, whatever writes it.
    await expect(prisma.department.updateMany({ where: { code: 'CR' }, data: { tagColor: 'blue' } })).rejects.toThrow();
  });

  it('keeps any chosen colour legible: black or white text, whichever reads at least 4.5:1', () => {
    for (const bg of ['#ffff00', '#777777', '#7f7f7f', '#0000ff', '#00ff00', '#ff0000', '#ffffff', '#000000', ...Object.values(DEFAULT_UNIT_COLORS)]) {
      expect(contrastRatio(bg, textOn(bg)), bg).toBeGreaterThanOrEqual(4.5);
    }
  });
});
