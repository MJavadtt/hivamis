import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { maySubmitForm, stageCategories, type FieldDef } from '@hiva/contracts';
import { closeApp, expectOk, get, login, post } from './helpers.js';
import { prisma } from '../src/db.js';

/**
 * Hivamis task 4b: a record's page offers the forms that point at it, the ones its stage calls for
 * first, ready to fill with the record and the ones it belongs to.
 */
const refsTo = (schema: unknown, entity: string) => (schema as FieldDef[]).filter((f) => f.type === 'entityRef' && f.entity === entity);

describe('Forms a page offers', () => {
  let pmo: string, sales: string;
  let project: { id: string; state: string; companyId: string };
  beforeAll(async () => {
    pmo = await login('pmo@hiva.local');
    sales = await login('sales@hiva.local');
    project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' }, select: { id: true, state: true, companyId: true } });
  });
  afterAll(async () => { await closeApp(); });

  it("offers every form about a project that the reader's unit may send, the stage's own first", async () => {
    const res = expectOk(await get('/forms/suggest', pmo, { entity: 'project', id: project.id, limit: '30' }), 'suggest');
    const defs = await prisma.formDefinition.findMany({ where: { isActive: true } });
    const expected = defs.filter((d) => refsTo(d.schema, 'project').length && maySubmitForm(d.senderDepts, 'OP', ['PMO_MANAGER'])).map((d) => d.code).sort();
    expect(res.total).toBe(expected.length);
    expect(res.forms.length).toBe(Math.min(30, expected.length));
    expect(res.forms.every((f: any) => expected.includes(f.code))).toBe(true);
    // The stage's categories, in its order, before the rest.
    const stage = stageCategories('project', project.state);
    const rank = (c: string) => (stage.indexOf(c) === -1 ? stage.length : stage.indexOf(c));
    const ranks = res.forms.map((f: any) => rank(f.category));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(res.forms[0].fitsStage).toBe(true);
  });

  it('fills the project, and the client it belongs to, in every form that asks for them', async () => {
    const res = expectOk(await get('/forms/suggest', pmo, { entity: 'project', id: project.id, limit: '30' }), 'suggest');
    for (const f of res.forms) {
      const def = await prisma.formDefinition.findUniqueOrThrow({ where: { code: f.code } });
      for (const field of refsTo(def.schema, 'project')) expect(f.prefill[field.key]).toBe(project.id);
      for (const field of refsTo(def.schema, 'company')) expect(f.prefill[field.key]).toBe(project.companyId);
    }
  });

  it('says when a form was last sent about this record', async () => {
    const res = expectOk(await get('/forms/suggest', pmo, { entity: 'project', id: project.id, limit: '30' }), 'before');
    // A status report: sent again and again about the same project.
    const report = res.forms.find((f: any) => f.code.startsWith('K')) ?? res.forms[0];
    const draft = expectOk(await post('/forms/submissions', pmo, { formCode: report.code, data: report.prefill, asDraft: true }), 'draft');
    expect(draft.id).toBeTruthy();
    const after = expectOk(await get('/forms/suggest', pmo, { entity: 'project', id: project.id, limit: '30' }), 'after');
    expect(after.forms.find((f: any) => f.code === report.code).lastForRecord).not.toBeNull();
  });

  it("offers nothing about a record the reader may not see, and refuses what is not a record", async () => {
    const legal = await login('legal@hiva.local');
    expect((await get('/forms/suggest', sales, { entity: 'nonsense', id: project.id })).status).toBe(400);
    expect((await get('/forms/suggest', pmo, { entity: 'project', id: '00000000-0000-4000-8000-00000000dead' })).status).toBe(404);
    // A unit that sends none of a project's forms is offered none.
    const res = expectOk(await get('/forms/suggest', legal, { entity: 'project', id: project.id, limit: '30' }), 'legal');
    for (const f of res.forms) {
      const def = await prisma.formDefinition.findUniqueOrThrow({ where: { code: f.code } });
      expect(maySubmitForm(def.senderDepts, 'LG', ['LEGAL_MANAGER'])).toBe(true);
    }
  });

  it('puts the forms a person sends most within one click', async () => {
    const before = expectOk(await get('/forms/suggest', sales, { limit: '5' }), 'frequent');
    expect(before.forms.length).toBe(5);
    // Each is one the person's unit may send.
    for (const f of before.forms) {
      const def = await prisma.formDefinition.findUniqueOrThrow({ where: { code: f.code } });
      expect(maySubmitForm(def.senderDepts, 'S', ['SALES_REP'])).toBe(true);
    }
    const pick = (await prisma.formDefinition.findMany({ where: { isActive: true, senderDepts: { has: 'S' } }, orderBy: { no: 'desc' } }))[0]!;
    for (let i = 0; i < 2; i++) expectOk(await post('/forms/submissions', sales, { formCode: pick.code, data: {}, asDraft: true }), 'draft');
    const after = expectOk(await get('/forms/suggest', sales, { limit: '5' }), 'frequent');
    expect(after.forms[0].code).toBe(pick.code);
  });

  it('tells the form page whether the reader may send it', async () => {
    const lead = expectOk(await get('/forms/definitions/A01_LEAD', sales), 'A01');
    expect(lead.canSubmit).toBe(true);
    expect(expectOk(await get('/forms/definitions/A01_LEAD', pmo), 'A01 pmo').canSubmit).toBe(false);
  });
});
