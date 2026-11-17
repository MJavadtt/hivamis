import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { documentCode, normalizeIranPhone } from '@hiva/contracts';
import { app, closeApp, get, login, patch, post, expectOk, directLead } from './helpers.js';
import { prisma } from '../src/db.js';

/**
 * The owner (2026-11-16): units and teams could not be added or deleted; a landline could not be
 * entered; and the units' codes follow the coding instruction QA-WI-001/00 (ADR-133).
 */
let T: Record<string, string>;
const del = async (url: string, token: string) => {
  const res = await (await app()).inject({ method: 'DELETE', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
  return { status: res.statusCode, body: res.json() };
};

beforeAll(async () => {
  await app();
  T = { admin: await login('admin@hiva.local'), sales: await login('sales@hiva.local') };
});
afterAll(closeApp);

describe('Units and teams (ADR-133)', () => {
  it('each process unit has its two letters by the instruction, and the instruction\'s other units exist', async () => {
    const units = expectOk(await get('/departments', T.admin), 'units') as { code: string; shortCode: string; custom: boolean; nameFa: string }[];
    const short = Object.fromEntries(units.map((u) => [u.code, u.shortCode]));
    expect(short).toMatchObject({ M: 'MA', S: 'SA', A: 'AC', ST: 'QC', CR: 'IC', ME: 'MD', DM: 'PM', FI: 'FA' });
    expect(units.filter((u) => u.custom).map((u) => u.shortCode).sort()).toEqual(['CO', 'HR', 'IT', 'QA', 'ST', 'VP']);
    expect(units.find((u) => u.shortCode === 'ST')!.nameFa).toBe('انبار');
  });

  it('a unit is added, given people and a team, renamed in code, and deleted once empty; a process unit is not', async () => {
    expect((await post('/departments', T.sales, { shortCode: 'RD', nameFa: 'تحقیق و توسعه' })).status).toBe(403);
    const unit = expectOk(await post('/departments', T.admin, { shortCode: 'rd', nameFa: 'تحقیق و توسعه' }), 'unit');
    expect(unit).toMatchObject({ shortCode: 'RD', code: 'XRD' });
    expect((await post('/departments', T.admin, { shortCode: 'QA', nameFa: 'تکراری' })).status).toBe(409);
    expect((await post('/departments', T.admin, { shortCode: 'Q1', nameFa: 'نادرست' })).status).toBe(400);

    // A person moves in; a team is made in it.
    const person = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    expectOk(await patch(`/users/${person.id}`, T.admin, { departmentCode: 'XRD' }), 'move');
    const team = expectOk(await post('/teams', T.admin, { departmentCode: 'XRD', nameFa: 'آزمایشگاه' }), 'team');
    const refused = await del('/departments/XRD', T.admin);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('UNIT_HAS_PEOPLE');

    expectOk(await patch('/departments/XRD', T.admin, { shortCode: 'RN' }), 'recode');
    expect((await prisma.department.findFirstOrThrow({ where: { code: 'XRD' } })).shortCode).toBe('RN');

    expectOk(await del(`/teams/${team.id}`, T.admin), 'delete team');
    expect(await prisma.team.findUnique({ where: { id: team.id } })).toBeNull();
    expectOk(await patch(`/users/${person.id}`, T.admin, { departmentCode: 'CR' }), 'move back');
    expectOk(await del('/departments/XRD', T.admin), 'delete unit');
    expect(await prisma.department.count({ where: { code: 'XRD' } })).toBe(0);

    const process = await del('/departments/CR', T.admin);
    expect(process.status).toBe(409);
    expect(process.body.error.code).toBe('PROCESS_UNIT');
  });
});

describe('A client\'s phone, mobile or landline', () => {
  it('reads both, however typed, and refuses what is neither', () => {
    expect(normalizeIranPhone('۰۹۱۲ ۱۲۳ ۴۵۶۷')).toBe('09121234567');
    expect(normalizeIranPhone('021-8877 6655')).toBe('02188776655');
    expect(normalizeIranPhone('(۰۲۱) ۸۸۷۷۶۶۵۵')).toBe('02188776655');
    expect(normalizeIranPhone('+98 21 88776655')).toBe('02188776655');
    expect(normalizeIranPhone('88776655')).toBe('88776655');
    expect(normalizeIranPhone('1819')).toBe('1819');
    for (const bad of ['', '123', '0218877665', '021887766554', 'abc', '09121234']) expect(normalizeIranPhone(bad), bad).toBeNull();
  });

  it('a lead is registered with a landline, and the same landline is then known', async () => {
    const lead = expectOk(await post('/leads', T.sales, { name: 'سرنخ با تلفن ثابت', companyName: 'شرکت ثابت', ...directLead(), phone: '۰۲۱-۸۸۷۷۶۶۵۵' }), 'lead');
    expect(lead.phone).toBe('02188776655');
    const dup = expectOk(await get('/leads/duplicates', T.sales, { phone: '(021) 88776655' }), 'dup');
    expect(dup.leads.map((l: any) => l.id)).toContain(lead.id);
    expect((await post('/leads', T.sales, { name: 'نادرست', companyName: 'شرکت', ...directLead(), phone: '12' })).status).toBe(400);
  });
});

describe('Document codes (QA-WI-001/00)', () => {
  it('are unit, kind, serial and revision', () => {
    expect(documentCode('QA', 'FR', 7, 1)).toBe('QA-FR-007/01');
    expect(documentCode('sa', 'WI', 1)).toBe('SA-WI-001/00');
  });

  it('every form carries one, unique, beginning with its owner unit\'s letters', async () => {
    const { definitions } = expectOk(await get('/forms/definitions', T.admin), 'forms') as { definitions: { code: string; docCode: string; senderDepts: string[]; version: number }[] };
    expect(definitions.length).toBeGreaterThan(50);
    for (const d of definitions) expect(d.docCode, d.code).toMatch(/^[A-Z]{2}-FR-\d{3}\/\d{2}$/);
    expect(new Set(definitions.map((d) => d.docCode.slice(0, 9))).size).toBe(definitions.length);
    const lead = definitions.find((d) => d.code === 'A01_LEAD')!;
    expect(lead.docCode).toBe('SA-FR-001/00');
  });
});
