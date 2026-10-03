import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { matchesCondition, describeCondition } from '@hiva/contracts';
import { Prisma } from '@prisma/client';
import { call, closeApp, get, login, move, post, put, expectOk, directLead } from './helpers.js';
import { prisma } from '../src/db.js';
import { nextCode } from '../src/lib/codes.js';
import {
  RegistryError, allGuards, attachGuard, effectsFor, guardOf, guardsFor, registerGuard,
} from '../src/workflow/registry.js';
import { installExtension, loadExtensions, uninstallExtension, type Extension } from '../src/extensions/loader.js';
import { registerRuleSets, resetRulesCache } from '../src/workflow/rules.js';
import { factsOf, fieldsOf } from '../src/workflow/custom.js';

const lead = async (token: string, extra: Record<string, unknown> = {}) =>
  expectOk(await post('/leads', token, { name: `سرنخ ${Math.random().toString(36).slice(2, 7)}`, companyName: 'شرکت آزمون', ...directLead(), ...extra }), 'lead');

describe('The engine’s rules come from a registry', () => {
  it('holds Doc_H’s guards and effects as core entries, and refuses to have one replaced', () => {
    const core = allGuards().filter((g) => g.source === 'core');
    expect(core.length).toBeGreaterThanOrEqual(27);
    expect(guardOf('deliverable.passesStageZero')).toMatchObject({ source: 'core', labelFa: expect.any(String) });
    expect(effectsFor('lead', 'disqualify').map((e) => [e.key, e.source])).toEqual([['lead.disqualify', 'core']]);
    expect(() => registerGuard({ key: 'brief.isComplete', labelFa: 'x', source: 'extension', run: async () => ({ ok: true }) })).toThrow(RegistryError);
    expect(() => registerGuard({ key: 'nonamespace', labelFa: 'x', source: 'extension', run: async () => ({ ok: true }) })).toThrow(/namespace/);
    expect(() => attachGuard({ entity: 'lead', action: 'teleport', guard: 'brief.isComplete', source: 'extension' })).toThrow(/no transition/);
  });

  it('reads the new comparisons of the condition language: the same as, and other than, another field', () => {
    const facts = { 'actor.id': 'u1', ownerId: 'u1', approvedById: 'u2' };
    expect(matchesCondition({ field: 'actor.id', op: 'eqField', value: 'ownerId' }, facts)).toBe(true);
    expect(matchesCondition({ field: 'actor.id', op: 'neField', value: 'approvedById' }, facts)).toBe(true);
    expect(matchesCondition({ field: 'actor.id', op: 'eqField', value: 'missing' }, facts)).toBe(false);
    expect(describeCondition({ field: 'actor.id', op: 'neField', value: 'ownerId' }, [{ key: 'actor.id', labelFa: 'انجام‌دهنده' }, { key: 'ownerId', labelFa: 'مالک' }] as never))
      .toBe('«انجام‌دهنده» غیر از مقدار فیلد «مالک» باشد');
  });

  it('sees a record as the condition language does: money as numbers, each date also as days from now', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const facts = factsOf({ id: 'x', plannedEnd: new Date('2026-10-11T00:00:00Z'), contractValue: new Prisma.Decimal('1500000'), notes: { a: 1 } }, 'u9', now);
    expect(facts).toMatchObject({ 'actor.id': 'u9', contractValue: 1_500_000, 'plannedEnd.daysFromNow': 10, plannedEnd: '2026-10-11T00:00:00.000Z' });
    expect(facts).not.toHaveProperty('notes');
    const fields = fieldsOf('project').map((f) => f.key);
    expect(fields).toEqual(expect.arrayContaining(['contractValue', 'plannedEnd', 'plannedEnd.daysFromNow', 'actor.id']));
    expect(fields).not.toContain('organizationId');
  });
});

describe('An extension, installed without forking', () => {
  let T: Record<string, string>;
  beforeAll(async () => {
    T = { sales: await login('sales@hiva.local'), ceo: await login('ceo@hiva.local'), admin: await login('admin@hiva.local') };
  });
  afterEach(() => { for (const name of ['testx', 'testbad', 'broken', 'acme']) uninstallExtension(name); resetRulesCache(); });

  const testx: Extension = {
    name: 'testx', version: '0.1.0',
    register(api) {
      api.registerGuard({
        key: 'testx.needsContact', labelFa: 'نام تماس سرنخ ثبت شده باشد',
        async run({ record }) { return record.contactName ? { ok: true } : { ok: false, rule: 'testx', messageFa: 'پیش از تماس، نام فرد تماس را ثبت کنید.' }; },
      });
      api.attachGuard('lead', 'contact', 'testx.needsContact');
      api.registerEffect({ key: 'testx.noteNeed', entity: 'lead', action: 'contact', labelFa: 'نیاز پیش‌فرض', async run({ record }) { return record.need ? {} : { need: 'در تماس اول پرسیده شود' }; } });
    },
  };

  it('adds its guard on top of Doc_H’s, enforced, explained in preflight, and waivable like any other', async () => {
    await installExtension(testx);
    expect(guardsFor('lead', 'contact', [])).toEqual(['testx.needsContact']);
    const bare = await lead(T.sales);
    const pre = expectOk(await get(`/workflow/lead/${bare.id}/preflight`, T.sales), 'preflight');
    const contact = pre.transitions.find((t: any) => t.action === 'contact');
    expect(contact).toMatchObject({ ready: false, checks: [{ guard: 'testx.needsContact', labelFa: 'نام تماس سرنخ ثبت شده باشد', ok: false }] });
    const refused = await move('lead', bare.id, 'contact', T.sales);
    expect([refused.status, refused.body.error.message]).toEqual([422, 'پیش از تماس، نام فرد تماس را ثبت کنید.']);
    const blocked = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'TRANSITION_BLOCKED', entityId: bare.id } });
    expect((blocked.after as any).guard).toBe('testx.needsContact');

    // The governed exception of #7 covers an extension's guard too.
    expectOk(await post('/waivers', T.ceo, { entityType: 'lead', entityId: bare.id, guard: 'testx.needsContact', reason: 'شمارهٔ دفتر مرکزی؛ نام فرد را در تماس می‌پرسیم' }), 'waiver');
    expectOk(await move('lead', bare.id, 'contact', T.sales), 'contact under waiver');

    // Its effect runs after the core effect and adds to the update.
    const withPhone = await lead(T.sales, { contactName: 'خانم رضایی' });
    expectOk(await move('lead', withPhone.id, 'contact', T.sales), 'contact');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: withPhone.id } })).need).toBe('در تماس اول پرسیده شود');
  });

  it('may add to a move but never write its state, nor rewrite what the core effect set', async () => {
    await installExtension({
      name: 'testbad', version: '0.0.1',
      register(api) {
        api.registerEffect({ key: 'testbad.jump', entity: 'lead', action: 'qualify', labelFa: 'x', async run() { return { state: 'CONVERTED' }; } });
        api.registerEffect({ key: 'testbad.reason', entity: 'lead', action: 'disqualify', labelFa: 'x', async run() { return { disqualifyReason: 'بازنویسی' }; } });
      },
    });
    const l = await lead(T.sales);
    expectOk(await move('lead', l.id, 'contact', T.sales), 'contact');
    const jump = await move('lead', l.id, 'qualify', T.sales);
    expect([jump.status, jump.body.error.code]).toEqual([500, 'EFFECT_REFUSED']);
    const rewrite = await move('lead', l.id, 'disqualify', T.sales, 'بودجه ندارد');
    expect(rewrite.body.error.code).toBe('EFFECT_REFUSED');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).state).toBe('CONTACTED');   // nothing happened
  });

  it('fails closed: a broken extension is not half-installed, and cannot reach outside its name', async () => {
    await expect(installExtension({ name: 'broken', version: '1', register(api) { api.registerGuard({ key: 'broken.a', labelFa: 'a', run: async () => ({ ok: true }) }); throw new Error('boom'); } }))
      .rejects.toThrow('broken: boom');
    expect(guardOf('broken.a')).toBeUndefined();
    await expect(installExtension({ name: 'broken', version: '1', register(api) { api.registerGuard({ key: 'brief.sneaky', labelFa: 'x', run: async () => ({ ok: true }) }); } }))
      .rejects.toThrow(/must be named under "broken\."/);
    await expect(installExtension({ name: 'broken', version: '1', register(api) { api.attachGuard('lead', 'contact', 'broken.missing'); } }))
      .rejects.toThrow(/not registered/);
    await expect(installExtension({ name: 'Bad Name', version: '1', register() {} })).rejects.toThrow(/lower-case/);
  });

  it('loads from a directory at boot — the shipped example — and its rules work', async () => {
    const [acme] = await loadExtensions(new URL('../extensions/examples', import.meta.url).pathname);
    expect(acme).toMatchObject({ name: 'acme', version: '1.0.0', guards: ['acme.budgetWithinContract'], attachments: ['project.activate+acme.budgetWithinContract'], effects: ['deliverable.deliver+acme.shareDeliveredFiles'] });
    expect(guardsFor('project', 'activate', ['project.isAuthorized'])).toEqual(['project.isAuthorized', 'acme.budgetWithinContract']);
    const guard = guardOf('acme.budgetWithinContract')!;
    expect((await guard.run({ record: { plannedBudget: 900, contractValue: 1000 } } as never)).ok).toBe(true);
    expect(await guard.run({ record: { plannedBudget: 1200, contractValue: 1000 } } as never)).toMatchObject({ ok: false, details: { plannedBudget: 1200 } });

    // The effect, on a real deliverable: its current files become visible in the client portal.
    const org = (await prisma.organization.findFirstOrThrow()).id;
    const project = await prisma.project.findFirstOrThrow({ where: { deletedAt: null } });
    const d = await prisma.deliverable.create({ data: { organizationId: org, code: await nextCode(prisma, 'deliverable'), projectId: project.id, name: 'تحویل آزمون', departmentCode: 'CR', state: 'APPROVED' } });
    const uploader = (await prisma.user.findFirstOrThrow({ where: { email: 'creative@hiva.local' } })).id;
    await prisma.document.create({ data: { organizationId: org, fileName: 'x.pdf', storedName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 1, deliverableId: d.id, uploadedById: uploader } });
    const effect = effectsFor('deliverable', 'deliver').find((e) => e.key === 'acme.shareDeliveredFiles')!;
    await prisma.$transaction((tx) => effect.run({ tx, id: d.id, record: d, payload: {}, actorId: uploader, organizationId: org }));
    expect((await prisma.document.findFirstOrThrow({ where: { deliverableId: d.id } })).clientVisible).toBe(true);
  });

  it('is a change of the rules: installing one is a new version, and removing it returns to the old', async () => {
    resetRulesCache();
    const before = await registerRuleSets(prisma);
    await installExtension(testx);
    resetRulesCache();
    const withIt = await registerRuleSets(prisma, undefined, 'test: testx installed');
    expect(withIt.registered).toEqual(['workflows']);
    const diff = expectOk(await get('/rules/diff', T.admin, { kind: 'workflows' }), 'diff');
    expect(diff.changes).toEqual(expect.arrayContaining([
      'افزونه: قانون «testx:testx.needsContact» اضافه شد',
      'افزونه: قانون روی انتقال «lead.contact+testx.needsContact» اضافه شد',
      'افزونه: اثر «lead.contact+testx.noteNeed» اضافه شد',
    ]));
    uninstallExtension('testx');
    resetRulesCache();
    const after = await registerRuleSets(prisma);
    expect(after.registered).toEqual([]);
    expect(after.workflows).toBe(before.workflows);                    // the same fingerprint as before it
  });

  it('lists every rule on the workflows by where it comes from', async () => {
    await installExtension(testx);
    const r = expectOk(await get('/rules/registry', T.sales), 'registry');
    expect(r.extensions.map((e: any) => e.name)).toEqual(['testx']);
    expect(r.guards.find((g: any) => g.key === 'testx.needsContact')).toMatchObject({ source: 'extension', extension: 'testx' });
    expect(r.attachments).toEqual([expect.objectContaining({ entity: 'lead', action: 'contact', guard: 'testx.needsContact', transitionFa: expect.any(String) })]);
    expect(r.effects.map((e: any) => e.key)).toEqual(['testx.noteNeed']);
  });
});

describe('An organisation’s own rules, written without code', () => {
  let T: Record<string, string>;
  let managerId: string;
  beforeAll(async () => {
    T = { sales: await login('sales@hiva.local'), ceo: await login('ceo@hiva.local'), pmo: await login('pmo@hiva.local') };
    managerId = (await prisma.user.findFirstOrThrow({ where: { email: 'sales.manager@hiva.local' } })).id;
  });
  afterAll(async () => { await closeApp(); });

  const floor = { kind: 'GUARD', entity: 'lead', action: 'qualify', labelFa: 'ارزش برآوردی دست‌کم یک میلیارد ریال', when: { field: 'estimatedValue', op: 'gte', value: 1_000_000_000 } };
  let code: string;

  it('is written by who keeps the rules, checked against the schema, and read by everyone', async () => {
    expect((await post('/rules/custom', T.sales, floor)).status).toBe(403);
    const bad = await post('/rules/custom', T.pmo, { ...floor, when: { field: 'budgett', op: 'gte', value: 1 } });
    expect([bad.status, bad.body.error.code]).toEqual([422, 'RULE_INVALID']);
    expect(bad.body.error.message).toContain('budgett');
    expect((await post('/rules/custom', T.pmo, { ...floor, action: 'teleport' })).body.error.message).toContain('teleport');
    expect((await post('/rules/custom', T.pmo, { ...floor, when: undefined })).status).toBe(400);
    const r = expectOk(await post('/rules/custom', T.pmo, floor), 'create');
    expect(r).toMatchObject({ code: expect.stringMatching(/^RUL-\d{6}$/), version: 1, current: true, whenFa: '«ارزش برآوردی» بزرگ‌تر یا مساوی 1000000000 باشد' });
    code = r.code;
    const vocab = expectOk(await get('/rules/custom/vocabulary', T.sales), 'vocabulary');
    expect(vocab.entities.find((e: any) => e.entity === 'lead').fields.map((f: any) => f.key)).toEqual(expect.arrayContaining(['estimatedValue', 'phone', 'actor.id']));
    expect(expectOk(await get('/rules/custom', T.sales), 'list').map((x: any) => x.code)).toEqual([code]);
  });

  it('holds the move it guards — in preflight, at the move, in the trail — and yields to a waiver', async () => {
    const small = await lead(T.sales, { estimatedValue: 5_000_000 });
    expectOk(await move('lead', small.id, 'contact', T.sales), 'contact');
    const pre = expectOk(await get(`/workflow/lead/${small.id}/preflight`, T.sales), 'preflight');
    expect(pre.transitions.find((t: any) => t.action === 'qualify')).toMatchObject({ ready: false, checks: [{ guard: `custom:${code}`, labelFa: 'ارزش برآوردی دست‌کم یک میلیارد ریال', ok: false }] });
    const refused = await move('lead', small.id, 'qualify', T.sales);
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toBe('«ارزش برآوردی دست‌کم یک میلیارد ریال» برقرار نیست: «ارزش برآوردی» بزرگ‌تر یا مساوی 1000000000 باشد');
    expect(refused.body.error.details.rule).toBe(`قانون سازمان ${code} (نسخهٔ 1)`);

    const big = await lead(T.sales, { estimatedValue: 2_000_000_000 });
    expectOk(await move('lead', big.id, 'contact', T.sales), 'contact');
    expectOk(await move('lead', big.id, 'qualify', T.sales), 'qualify');
    const audited = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'STATE_TRANSITION', entityId: big.id, after: { path: ['state'], equals: 'QUALIFIED' } } });
    expect((audited.after as any).customRules).toEqual({ guards: [`${code}@1`], notified: [] });

    expectOk(await post('/waivers', T.ceo, { entityType: 'lead', entityId: small.id, guard: `custom:${code}`, reason: 'مشتری راهبردی است؛ ارزش پس از جلسه دوم مشخص می‌شود' }), 'waiver');
    const waivers = expectOk(await get('/waivers', T.ceo, { entityId: small.id }), 'register');
    expect(waivers[0].guardLabelFa).toBe('ارزش برآوردی دست‌کم یک میلیارد ریال');
    expectOk(await move('lead', small.id, 'qualify', T.sales), 'under waiver');
  });

  it('changes by new versions — the old one kept, and never editable — and can be retired', async () => {
    const v2 = expectOk(await put(`/rules/custom/${code}`, T.pmo, { ...floor, when: { field: 'estimatedValue', op: 'gte', value: 100_000_000 } }), 'v2');
    expect(v2).toMatchObject({ code, version: 2 });
    const history = expectOk(await get(`/rules/custom/${code}`, T.sales), 'history');
    expect(history.map((h: any) => [h.version, h.current])).toEqual([[2, true], [1, false]]);
    const v1 = await prisma.customRule.findFirstOrThrow({ where: { code, version: 1 } });
    expect(v1.supersededById).toBe(v2.id);
    await expect(prisma.customRule.update({ where: { id: v1.id }, data: { labelFa: 'بازنویسی' } })).rejects.toThrow(/never edited/);
    const mid = await lead(T.sales, { estimatedValue: 500_000_000 });
    expectOk(await move('lead', mid.id, 'contact', T.sales), 'contact');
    expectOk(await move('lead', mid.id, 'qualify', T.sales), 'v2 lets it through');

    expect((await post(`/rules/custom/${code}/retire`, T.pmo, {})).status).toBe(400);
    expectOk(await post(`/rules/custom/${code}/retire`, T.pmo, { reason: 'سیاست فروش عوض شد' }), 'retire');
    expect(expectOk(await get('/rules/custom', T.sales), 'list')).toEqual([]);
    const tiny = await lead(T.sales, { estimatedValue: 1 });
    expectOk(await move('lead', tiny.id, 'contact', T.sales), 'contact');
    expectOk(await move('lead', tiny.id, 'qualify', T.sales), 'no rule any more');
  });

  it('tells the roles a notice names, when its condition holds — but not the one who moved it', async () => {
    const notice = expectOk(await post('/rules/custom', T.pmo, {
      kind: 'NOTIFY', entity: 'lead', action: 'qualify', labelFa: 'سرنخ بزرگ واجد شرایط شد', messageFa: 'یک سرنخ بزرگ واجد شرایط شد؛ برای جلسهٔ اول هماهنگ کنید.',
      when: { field: 'estimatedValue', op: 'gt', value: 3_000_000_000 }, notifyRoles: ['SALES_MANAGER', 'SALES_REP'],
    }), 'notice');
    const big = await lead(T.sales, { estimatedValue: 4_000_000_000 });
    expectOk(await move('lead', big.id, 'contact', T.sales), 'contact');
    expectOk(await move('lead', big.id, 'qualify', T.sales), 'qualify');
    const told = await prisma.notification.findMany({ where: { kind: 'CUSTOM_RULE', entityId: big.id } });
    expect(told.map((n) => n.userId)).toContain(managerId);
    const salesId = (await prisma.user.findFirstOrThrow({ where: { email: 'sales@hiva.local' } })).id;
    expect(told.map((n) => n.userId)).not.toContain(salesId);                 // the one who moved it knows
    expect(told[0]).toMatchObject({ title: `سرنخ بزرگ واجد شرایط شد — ${big.code}`, body: 'یک سرنخ بزرگ واجد شرایط شد؛ برای جلسهٔ اول هماهنگ کنید.' });
    const small = await lead(T.sales, { estimatedValue: 10 });
    expectOk(await move('lead', small.id, 'contact', T.sales), 'contact');
    expectOk(await move('lead', small.id, 'qualify', T.sales), 'qualify');
    expect(await prisma.notification.count({ where: { kind: 'CUSTOM_RULE', entityId: small.id } })).toBe(0);
    await post(`/rules/custom/${notice.code}/retire`, T.pmo, { reason: 'پایان آزمون' });
  });

  it('can be tried on a record and against the past before it is published', async () => {
    const ownerOnly = { kind: 'GUARD', entity: 'lead', action: 'convert', labelFa: 'فقط مالک سرنخ آن را تبدیل کند', when: { field: 'actor.id', op: 'eqField', value: 'ownerId' } };
    const mine = await lead(T.sales);
    expect((await post('/rules/custom/test', T.sales, { rule: ownerOnly, recordId: mine.code })).status).toBe(403);   // reads others' records
    const tried = expectOk(await post('/rules/custom/test', T.pmo, { rule: ownerOnly, recordId: mine.code }), 'test');
    // The PMO is not the owner: tried as the PMO, the owner-only rule would hold the move back.
    expect(tried).toMatchObject({ holds: false, record: { code: mine.code }, whenFa: '«انجام‌دهندهٔ این انتقال» همان مقدار فیلد «مالک» باشد' });
    expect(tried.verdictFa).toContain('نگه می‌دارد');
    const byId = expectOk(await post('/rules/custom/test', T.pmo, { rule: { ...ownerOnly, when: { field: 'ownerId', op: 'isSet' } }, recordId: mine.id }), 'by id');
    expect(byId).toMatchObject({ holds: true, values: { ownerId: expect.any(String) } });

    const replay = expectOk(await post('/rules/custom/replay', T.pmo, { rule: { ...floor, action: 'qualify', when: { field: 'estimatedValue', op: 'gte', value: 3_000_000_000 } } }), 'replay');
    expect(replay.replayed).toBeGreaterThanOrEqual(5);
    expect(replay.count).toBeGreaterThanOrEqual(3);
    expect(replay.assumptionFa).toContain('امروز');
    expect((await call('POST', '/rules/custom/test', { token: T.pmo, payload: { rule: ownerOnly, recordId: 'nope' } })).status).toBe(404);
  });
});
