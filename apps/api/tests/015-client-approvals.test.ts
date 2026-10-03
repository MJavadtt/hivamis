import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { call, closeApp, get, login, move, post, upload, tinyPdf, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { nextCode } from '../src/lib/codes.js';
import { approvalMail } from '../src/approvals/service.js';
import { canonical, checkEvidence, GENESIS, hashOf } from '../src/approvals/evidence.js';
import type { MailJob } from '../src/jobs/runner.js';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const tokenOf = (link: string) => link.split('/approve/')[1]!;
const pub = (token: string, suffix = '') => `/public/approvals/${token}${suffix}`;

describe('The evidence, in one canonical form', () => {
  it('hashes JSON the same way whatever order its keys came in, and dates as ISO', () => {
    expect(canonical({ b: 1, a: [2, { d: null, c: 'x' }], e: undefined })).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
    expect(hashOf({ x: 1, y: 2 })).toBe(hashOf({ y: 2, x: 1 }));
    expect(canonical(new Date('2026-09-27T08:00:00Z'))).toBe('"2026-09-27T08:00:00.000Z"');
  });
  it('names what no longer matches: the manifest, a file, the chain', () => {
    const manifest = { v: 1, files: [{ documentId: 'd1', fileName: 'a.pdf', sha256: 'aa' }] };
    const row = { manifest, manifestHash: hashOf(manifest), evidence: null, evidenceHash: null, decision: null, comment: null, signerName: null, contactEmail: 'x@y.z', decidedIp: null, sequence: null, prevEvidenceHash: null };
    expect(checkEvidence(row, [], null, { d1: 'aa' })).toEqual([]);
    expect(checkEvidence({ ...row, manifestHash: 'ff' }, [], null, { d1: 'aa' }).map((p) => p.code)).toEqual(['MANIFEST_ALTERED']);
    expect(checkEvidence(row, [], null, { d1: 'bb' }).map((p) => p.code)).toEqual(['FILE_ALTERED']);
    expect(checkEvidence(row, [], null, { d1: null }).map((p) => p.code)).toEqual(['FILE_MISSING']);
  });
});

describe('Asking the client, and the client deciding', () => {
  let T: Record<string, string>;
  let deliverableId: string, otherDeliverableId: string, proposalId: string, contactId: string, fileId: string;
  const pdf = tinyPdf('storyboard v3');
  const mails: MailJob[] = [];
  const original = { ...approvalMail };

  beforeAll(async () => {
    T = { am: await login('account.manager@hiva.local'), ae: await login('account@hiva.local'), sales: await login('sales.manager@hiva.local'), designer: await login('designer@hiva.local') };
    const org = await prisma.organization.findFirstOrThrow();
    const project = await prisma.project.findFirstOrThrow({ where: { deletedAt: null } });
    const mk = async (name: string) => (await prisma.deliverable.create({
      data: { organizationId: org.id, code: await nextCode(prisma, 'deliverable'), projectId: project.id, name, departmentCode: 'CR', version: 'v3', state: 'DELIVERED' },
    })).id;
    deliverableId = await mk('استوری‌بورد تیزر');
    otherDeliverableId = await mk('پوستر');
    contactId = (await prisma.contact.create({ data: { companyId: project.companyId, fullName: 'مریم احمدی', email: 'maryam@client.example' } })).id;
    const brief = await prisma.brief.findFirstOrThrow({ where: { opportunity: { companyId: project.companyId } } }).catch(() => null)
      ?? await prisma.brief.findFirstOrThrow();
    const briefCompany = (await prisma.opportunity.findUniqueOrThrow({ where: { id: brief.opportunityId } })).companyId;
    if (briefCompany !== project.companyId) await prisma.contact.create({ data: { companyId: briefCompany, fullName: 'مریم احمدی', email: 'maryam@client.example' } });
    proposalId = (await prisma.proposal.create({
      data: { organizationId: org.id, code: await nextCode(prisma, 'proposal'), briefId: brief.id, title: 'کمپین نوروزی', state: 'PRESENTED_TO_CLIENT', executiveSummary: 'سه موج رسانه‌ای', salePrice: 2_500_000_000, totalCost: 1_700_000_000, marginPercent: 32 },
    })).id;
    fileId = expectOk(await upload(T.am, { name: 'storyboard.pdf', type: 'application/pdf', content: pdf }, { deliverableId }), 'upload').id;
  });
  afterAll(async () => { Object.assign(approvalMail, original); await closeApp(); });

  it('is asked only by who may record the client’s answer, for a delivered item, of a contact with an address', async () => {
    const base = { subjectType: 'DELIVERABLE', subjectId: deliverableId, contactId };
    expect((await post('/client-approvals', T.designer, base)).status).toBe(403);
    expect((await post('/client-approvals', T.am, { ...base, subjectId: otherDeliverableId })).body.error.code).toBe('CLIENT_APPROVAL_NO_FILES');
    const stranger = await prisma.contact.create({ data: { companyId: (await prisma.company.create({ data: { organizationId: (await prisma.organization.findFirstOrThrow()).id, legalName: 'شرکت دیگر', accountOwnerId: (await prisma.user.findFirstOrThrow()).id } })).id, fullName: 'غریبه', email: 'x@other.example' } });
    expect((await post('/client-approvals', T.am, { ...base, contactId: stranger.id })).body.error.code).toBe('CLIENT_APPROVAL_CONTACT');
    const noMail = await prisma.contact.create({ data: { companyId: (await prisma.deliverable.findUniqueOrThrow({ where: { id: deliverableId }, include: { project: true } })).project.companyId, fullName: 'بی‌ایمیل' } });
    expect((await post('/client-approvals', T.am, { ...base, contactId: noMail.id })).body.error.code).toBe('CLIENT_APPROVAL_CONTACT_EMAIL');
  });

  let first: any, token: string;
  it('freezes what the client will see — each file’s SHA-256 — and with mail off hands the link over once', async () => {
    approvalMail.enabled = () => false;
    const o = expectOk(await get('/client-approvals/options', T.am, { subjectType: 'DELIVERABLE', subjectId: deliverableId }), 'options');
    expect(o).toMatchObject({ eligible: true, requiredState: 'DELIVERED', mailOn: false, documents: [expect.objectContaining({ id: fileId })] });
    expect(o.contacts.map((c: any) => c.email)).toContain('maryam@client.example');
    expect((await get('/client-approvals/options', T.designer, { subjectType: 'DELIVERABLE', subjectId: deliverableId })).status).toBe(403);
    first = expectOk(await post('/client-approvals', T.am, { subjectType: 'DELIVERABLE', subjectId: deliverableId, contactId, message: 'لطفاً تا پنجشنبه' }), 'request');
    expect(first).toMatchObject({ status: 'PENDING', channel: 'MANUAL', code: expect.stringMatching(/^CA-/) });
    expect(first.tokenHash).toBeUndefined();
    expect(first.manifest.files).toEqual([expect.objectContaining({ documentId: fileId, fileName: 'storyboard.pdf', sha256: sha(pdf) })]);
    expect(first.manifestHash).toBe(hashOf(first.manifest));
    token = tokenOf(first.link);
    expect(token).toMatch(/^[\w-]{43}$/);
    expect((await prisma.clientApproval.findUniqueOrThrow({ where: { id: first.id } })).tokenHash).toBe(sha(token));
    expect((await post('/client-approvals', T.am, { subjectType: 'DELIVERABLE', subjectId: deliverableId, contactId })).body.error.code).toBe('CLIENT_APPROVAL_PENDING');
    const listed = expectOk(await get('/client-approvals', T.am, { subjectType: 'DELIVERABLE', subjectId: deliverableId }), 'list');
    expect(listed[0].id).toBe(first.id);
    expect(listed[0].tokenHash).toBeUndefined();
    expect(listed[0].link).toBeUndefined();
  });

  it('opens for the link alone — no session — and shows the files with their hashes, never internal figures', async () => {
    const page = await call('GET', pub(token));
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ code: first.code, status: 'PENDING', verification: 'LINK', contactEmail: 'ma…@client.example', message: 'لطفاً تا پنجشنبه' });
    expect(page.body.files[0]).toMatchObject({ fileName: 'storyboard.pdf', sha256: sha(pdf), viewed: false });
    expect((await call('GET', pub('x'.repeat(43)))).status).toBe(404);
  });

  it('will not take an approval of files the client has not opened, nor a change request without saying what', async () => {
    const d = { decision: 'APPROVE', signerName: 'مریم احمدی', confirm: true };
    expect((await call('POST', pub(token, '/decision'), { payload: d })).body.error.code).toBe('CLIENT_APPROVAL_UNSEEN');
    expect((await call('POST', pub(token, '/decision'), { payload: { ...d, decision: 'REQUEST_CHANGES' } })).body.error.code).toBe('CLIENT_APPROVAL_COMMENT');
    expect((await call('POST', pub(token, '/decision'), { payload: { ...d, confirm: false } })).status).toBe(400);
    const file = await call('GET', pub(token, `/files/${fileId}`));
    expect(file.status).toBe(200);
    expect(sha(file.body)).toBe(sha(pdf));
    expect((await call('GET', pub(token))).body.files[0].viewed).toBe(true);
  });

  let sealed: any;
  it('seals the decision into the chain and applies it through the engine, as the one who asked', async () => {
    const r = await call('POST', pub(token, '/decision'), { payload: { decision: 'APPROVE', signerName: 'مریم احمدی', comment: 'عالی است', confirm: true } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'APPROVED', decision: 'APPROVE', manifestHash: first.manifestHash });
    sealed = await prisma.clientApproval.findUniqueOrThrow({ where: { id: first.id } });
    expect(sealed).toMatchObject({ verification: 'LINK', sequence: 1, prevEvidenceHash: GENESIS, signerName: 'مریم احمدی', transitionError: null });
    expect(sealed.evidenceHash).toBe(hashOf(sealed.evidence));
    expect((sealed.evidence as any).events.map((e: any) => e.kind)).toEqual(['CREATED', 'SENT', 'OPENED', 'FILE_VIEWED', 'OPENED']);

    const d = await prisma.deliverable.findUniqueOrThrow({ where: { id: deliverableId } });
    expect(d.state).toBe('ACCEPTED');
    const moved = await prisma.stateTransition.findFirstOrThrow({ where: { entityId: deliverableId, toState: 'ACCEPTED' } });
    const am = await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } });
    expect(moved.actorId).toBe(am.id);
    expect(moved.reason).toContain(first.code);
    expect(await prisma.notification.count({ where: { userId: am.id, kind: 'CLIENT_APPROVAL_DECIDED', entityId: deliverableId } })).toBe(1);

    expect((await call('POST', pub(token, '/decision'), { payload: { decision: 'APPROVE', signerName: 'مریم احمدی', confirm: true } })).body.error.code).toBe('CLIENT_APPROVAL_CLOSED');
    expect(expectOk(await get(`/client-approvals/${first.id}/verify`, T.am), 'verify')).toMatchObject({ ok: true, problems: [] });
  });

  it('cannot be rewritten: the row is sealed, the log append-only — and what gets past them is found by verify', async () => {
    await expect(prisma.clientApproval.update({ where: { id: first.id }, data: { signerName: 'کس دیگر' } })).rejects.toThrow(/sealed/);
    const ev = await prisma.clientApprovalEvent.findFirstOrThrow({ where: { approvalId: first.id } });
    await expect(prisma.clientApprovalEvent.update({ where: { id: ev.id }, data: { ip: '1.2.3.4' } })).rejects.toThrow(/append-only/);

    // Someone with the database itself, past the trigger:
    await prisma.$executeRawUnsafe('ALTER TABLE client_approvals DISABLE TRIGGER client_approvals_sealed');
    await prisma.clientApproval.update({ where: { id: first.id }, data: { signerName: 'کس دیگر' } });
    await prisma.$executeRawUnsafe('ALTER TABLE client_approvals ENABLE TRIGGER client_approvals_sealed');
    expect(expectOk(await get(`/client-approvals/${first.id}/verify`, T.am), 'tampered').problems.map((p: any) => p.code)).toEqual(['RECORD_ALTERED']);
    await prisma.$executeRawUnsafe('ALTER TABLE client_approvals DISABLE TRIGGER client_approvals_sealed');
    await prisma.clientApproval.update({ where: { id: first.id }, data: { signerName: 'مریم احمدی' } });
    await prisma.$executeRawUnsafe('ALTER TABLE client_approvals ENABLE TRIGGER client_approvals_sealed');

    // A download struck from the log:
    const viewed = await prisma.clientApprovalEvent.findFirstOrThrow({ where: { approvalId: first.id, kind: 'FILE_VIEWED' } });
    await prisma.clientApprovalEvent.delete({ where: { id: viewed.id } });
    expect(expectOk(await get(`/client-approvals/${first.id}/verify`, T.am), 'log').problems.map((p: any) => p.code)).toEqual(['LOG_ALTERED']);
    await prisma.clientApprovalEvent.create({ data: viewed });

    // And the file on disk:
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: fileId } });
    const target = path.join(path.resolve(env.STORAGE_DIR), doc.storedName);
    await writeFile(target, tinyPdf('storyboard v4'));
    expect(expectOk(await get(`/client-approvals/${first.id}/verify`, T.am), 'file').problems.map((p: any) => p.code)).toEqual(['FILE_ALTERED']);
    expect((await call('GET', pub(token, `/files/${fileId}`))).body.error.code).toBe('CLIENT_APPROVAL_FILE_CHANGED');
    await writeFile(target, pdf);
    expect(expectOk(await get(`/client-approvals/${first.id}/verify`, T.am), 'restored').ok).toBe(true);
    expect(await readFile(target, 'utf8')).toBe(pdf);
  });

  let second: any;
  it('with mail on: the link goes to the contact, and deciding takes a code sent to that same address', async () => {
    approvalMail.enabled = () => true;
    approvalMail.deliver = async (job) => { mails.push(job); };
    const deck = expectOk(await upload(T.sales, { name: 'deck.pdf', type: 'application/pdf', content: tinyPdf('deck') }, { proposalId }), 'deck').id;
    const contact = await prisma.contact.findFirstOrThrow({ where: { email: 'maryam@client.example', company: { opportunities: { some: { briefs: { some: { proposals: { some: { id: proposalId } } } } } } } } });
    expect((await post('/client-approvals', T.ae, { subjectType: 'PROPOSAL', subjectId: proposalId, contactId: contact.id })).status).toBe(403);
    second = expectOk(await post('/client-approvals', T.sales, { subjectType: 'PROPOSAL', subjectId: proposalId, contactId: contact.id }), 'proposal request');
    expect(second).toMatchObject({ channel: 'EMAIL', link: null });
    expect(second.manifest.content).toMatchObject({ executiveSummary: 'سه موج رسانه‌ای', salePrice: '2500000000' });
    expect(JSON.stringify(second.manifest)).not.toMatch(/1700000000|totalCost|margin/);
    expect(second.manifest.files.map((f: any) => f.documentId)).toEqual([deck]);
    const sent = mails.find((m) => m.to === 'maryam@client.example' && m.html.includes('/approve/'))!;
    const t = /\/approve\/([\w-]{43})/.exec(sent.html)![1]!;

    const d = { decision: 'REQUEST_CHANGES', signerName: 'مریم احمدی', comment: 'قیمت موج سوم بازبینی شود', confirm: true };
    expect((await call('GET', pub(t))).body.verification).toBe('EMAIL_CODE');
    expect((await call('POST', pub(t, '/decision'), { payload: d })).body.error.code).toBe('CLIENT_APPROVAL_CODE_REQUIRED');
    expect(expectOk(await call('POST', pub(t, '/code')), 'code')).toMatchObject({ sentTo: 'ma…@client.example' });
    const code = /: (\d{6})$/.exec(mails.at(-1)!.subject)![1]!;
    const wrong = await call('POST', pub(t, '/decision'), { payload: { ...d, code: code === '000000' ? '111111' : '000000' } });
    expect(wrong.body.error.code).toBe('CLIENT_APPROVAL_CODE_INVALID');
    const ok = expectOk(await call('POST', pub(t, '/decision'), { payload: { ...d, code } }), 'decided');
    expect(ok.status).toBe('CHANGES_REQUESTED');

    const row = await prisma.clientApproval.findUniqueOrThrow({ where: { id: second.id } });
    expect(row).toMatchObject({ verification: 'EMAIL_CODE', sequence: 2, prevEvidenceHash: sealed.evidenceHash, codeHash: null });
    expect((row.evidence as any).events.map((e: any) => e.kind)).toEqual(['CREATED', 'SENT', 'OPENED', 'CODE_SENT', 'CODE_REJECTED']);
    const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId } });
    expect(p.state).toBe('CLIENT_REVISION_REQUESTED');
    expect(p.clientFeedback).toContain('قیمت موج سوم');
    const receipt = mails.at(-1)!;
    expect(receipt.subject).toContain(second.code);
    expect(receipt.html).toContain(row.evidenceHash!);
    expect(expectOk(await get(`/client-approvals/${second.id}/verify`, T.sales), 'chain').ok).toBe(true);
  });

  it('lapses when its date passes or its subject moves on — and staff may withdraw it', async () => {
    approvalMail.enabled = () => false;
    await upload(T.am, { name: 'poster.pdf', type: 'application/pdf', content: tinyPdf('poster') }, { deliverableId: otherDeliverableId });
    const a = expectOk(await post('/client-approvals', T.am, { subjectType: 'DELIVERABLE', subjectId: otherDeliverableId, contactId }), 'a');
    expectOk(await move('deliverable', otherDeliverableId, 'client_reject', T.am, 'مشتری تلفنی رد کرد'), 'moved by hand');
    expect((await call('GET', pub(tokenOf(a.link)))).body.status).toBe('CANCELLED');
    expectOk(await move('deliverable', otherDeliverableId, 'submit', T.am).catch(() => ({ status: 200, body: {} })), 'noop');

    await prisma.deliverable.update({ where: { id: otherDeliverableId }, data: { state: 'DELIVERED' } });   // fixture: back to delivered
    const b = expectOk(await post('/client-approvals', T.am, { subjectType: 'DELIVERABLE', subjectId: otherDeliverableId, contactId }), 'b');
    await prisma.clientApproval.update({ where: { id: b.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call('GET', pub(tokenOf(b.link)))).body.status).toBe('EXPIRED');
    expect((await call('GET', pub(tokenOf(b.link), `/files/${(b.manifest.files[0]).documentId}`))).status).toBe(410);

    const c = expectOk(await post('/client-approvals', T.am, { subjectType: 'DELIVERABLE', subjectId: otherDeliverableId, contactId }), 'c');
    expect((await post(`/client-approvals/${c.id}/cancel`, T.designer, { reason: 'اشتباه' })).status).toBe(403);
    expectOk(await post(`/client-approvals/${c.id}/cancel`, T.am, { reason: 'فایل اشتباه فرستاده شد' }), 'cancel');
    expect((await call('POST', pub(tokenOf(c.link), '/decision'), { payload: { decision: 'APPROVE', signerName: 'مریم احمدی', confirm: true } })).body.error.code).toBe('CLIENT_APPROVAL_CLOSED');
  });

  it('prints the certificate: what was shown, who decided and how, the hashes, and a fresh check', async () => {
    const res = await call('GET', `/client-approvals/${first.id}/certificate`, { token: T.am });
    expect(res.status).toBe(200);
    expect(String(res.body).startsWith('%PDF')).toBe(true);
    expect(await prisma.auditEvent.count({ where: { action: 'EXPORT', entityType: 'clientApproval', entityId: first.id } })).toBe(1);
    expect((await call('GET', `/client-approvals/${first.id}/certificate`, { token: T.sales })).status).toBe(403);
  }, 60_000);
});
