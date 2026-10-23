import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeApp, expectOk, get, login, mobile, post } from './helpers.js';
import { prisma } from '../src/db.js';

/**
 * The owner's report (2026-10-23), after the first round: "I still do not see every part of every
 * user, and cannot edit, approve or reject — I want full authority." The system administrator's
 * inbox was built from the stages' roles, which never name them, so nothing ever waited for them;
 * and a stage Doc_H declares refused even the executives. Now every pending form waits for the
 * system administrator, any of them is theirs to decide — a declared stage, a quorum, their own —
 * and anyone's queue is theirs to read. Recorded as theirs, in place of the stage's roles.
 */
const lead = () => ({ formCode: 'A01_LEAD', data: { name: 'سرنخ آزمون اختیار', companyName: 'شرکت آزمون', phone: mobile(), source: 'DIRECT', sourceChannel: 'PHONE' } });

/** The submission's current stage made one Doc_H declares, asking two of a role nobody here is. */
async function declare(id: string) {
  const s = await prisma.formSubmission.findUniqueOrThrow({ where: { id } });
  const stages = [{ id: 'unit-sign-off', labelFa: 'امضای مدیر واحد', roles: ['LEGAL_MANAGER'], quorum: 2, declared: true, state: 'PENDING', approvedBy: [] }];
  await prisma.formSubmission.update({ where: { id }, data: { state: 'PENDING_APPROVAL', stages, currentRoles: ['LEGAL_MANAGER'], requiredRoles: ['LEGAL_MANAGER'] } });
  return s;
}

describe('The system administrator’s full authority (owner’s report, 2026-10-23)', () => {
  let T: Record<string, string>;
  let id: Record<string, string>;
  beforeAll(async () => {
    T = { admin: await login('admin@hiva.local'), ceo: await login('ceo@hiva.local'), sales: await login('sales@hiva.local'), designer: await login('designer@hiva.local') };
    const users = await prisma.user.findMany({ where: { email: { in: ['admin@hiva.local', 'designer@hiva.local'] } }, select: { id: true, email: true } });
    id = Object.fromEntries(users.map((u) => [u.email.split('@')[0]!, u.id]));
  });
  afterAll(closeApp);

  it('waits for the system administrator with every pending form, and decides a declared stage alone — in place of its roles', async () => {
    const s = expectOk(await post('/forms/submissions', T.sales, lead()), 'submit');
    await declare(s.id);

    const inbox = (t: string) => get('/forms/submissions', t, { awaitingMe: 'true', pageSize: '100' }).then((r) => expectOk(r, 'inbox').items.map((x: { id: string }) => x.id));
    expect(await inbox(T.admin)).toContain(s.id);
    expect(await inbox(T.ceo)).not.toContain(s.id);
    // The managing director stands in for an ordinary stage, not for one Doc_H declares.
    expect((await post(`/forms/submissions/${s.id}/decision`, T.ceo, { decision: 'APPROVE' })).status).toBe(403);

    // The system administrator's single approval closes a stage asking two.
    const decided = expectOk(await post(`/forms/submissions/${s.id}/decision`, T.admin, { decision: 'APPROVE', comment: 'به جای مدیر حقوقی' }), 'approve');
    expect(decided.state).toBe('APPROVED');
    const row = await prisma.auditEvent.findFirstOrThrow({ where: { entityType: 'formSubmission', entityId: s.id, action: 'APPROVE' } });
    expect(row).toMatchObject({ actorId: id.admin, after: { asSystemAdministrator: true, inPlaceOf: ['LEGAL_MANAGER'], cleared: true } });
  });

  it('rejects and returns any form too, and decides one of their own', async () => {
    const r = expectOk(await post('/forms/submissions', T.sales, lead()), 'submit');
    await declare(r.id);
    expect(expectOk(await post(`/forms/submissions/${r.id}/decision`, T.admin, { decision: 'REJECT', comment: 'ناقص' }), 'reject').state).toBe('REJECTED');

    const mine = expectOk(await post('/forms/submissions', T.admin, lead()), 'own');
    await declare(mine.id);
    expect(expectOk(await post(`/forms/submissions/${mine.id}/decision`, T.admin, { decision: 'RETURN', comment: 'اصلاح شود' }), 'return').state).toBe('RETURNED');
  });

  it('reads anyone’s whole queue — the system administrator alone', async () => {
    const theirs = expectOk(await get('/me/work', T.admin, { for: id.designer }), 'queue');
    expect(theirs.person).toEqual({ id: id.designer, fullName: 'بهراد مهرنیا' });
    const own = expectOk(await get('/me/work', T.designer), 'own');
    expect(theirs.items.map((i: { entityId: string }) => i.entityId).sort()).toEqual(own.items.map((i: { entityId: string }) => i.entityId).sort());
    expect((await get('/me/work', T.ceo, { for: id.designer })).status).toBe(403);
    // The administrator's own queue holds every form waiting anywhere.
    const s = expectOk(await post('/forms/submissions', T.sales, lead()), 'submit');
    await declare(s.id);
    const queue = expectOk(await get('/me/work', T.admin), 'admin queue');
    expect(queue.items.some((i: { entityId: string; kind: string }) => i.entityId === s.id && i.kind === 'formApproval')).toBe(true);
  });
});
