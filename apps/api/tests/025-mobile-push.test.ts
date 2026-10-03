import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { app, call, closeApp, expectOk, get, login, move, post, tinyPdf, upload } from './helpers.js';
import { prisma } from '../src/db.js';
import { notify } from '../src/mail/notify.js';
import { b64u, encrypt, generateVapidKeys, vapidAuthorization } from '../src/push/crypto.js';
import { checkEndpoint, deliver, pushable, pushNotification, vapidKeys, type PushNet } from '../src/push/service.js';

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/** A browser, as far as Web Push is concerned: a P-256 key pair and a 16-byte auth secret. */
function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, p256dh: b64u.encode(ecdh.getPublicKey()), auth: b64u.encode(auth), authBytes: auth };
}

/** What the browser does with a push (RFC 8291 §3, from the receiving side). */
function decrypt(body: Buffer, b: ReturnType<typeof browser>): string {
  const salt = body.subarray(0, 16), idlen = body[20]!, asPublic = body.subarray(21, 21 + idlen), cipher = body.subarray(21 + idlen);
  const uaPublic = b.ecdh.getPublicKey();
  const ikm = hmac(hmac(b.authBytes, b.ecdh.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const d = createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
  d.setAuthTag(cipher.subarray(-16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, -16)), d.final()]);
  const end = plain.lastIndexOf(2);
  expect(plain.subarray(end + 1).every((x) => x === 0)).toBe(true);
  return plain.subarray(0, end).toString('utf8');
}

/** The JWT a push service checks, verified the way it would be (RFC 8292). */
function checkVapid(header: string, endpointOrigin: string) {
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  expect(m).not.toBeNull();
  const [, h, p, sig, k] = m!;
  const pub = b64u.decode(k!);
  const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u.encode(pub.subarray(1, 33)), y: b64u.encode(pub.subarray(33)) } });
  expect(verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, b64u.decode(sig!))).toBe(true);
  expect(JSON.parse(b64u.decode(h!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(b64u.decode(p!).toString());
  expect(claims.aud).toBe(endpointOrigin);
  expect(claims.exp * 1000 - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
  expect(claims.sub).toMatch(/^(mailto:|https:)/);
  return k!;
}

describe('Web Push, as the RFCs have it', () => {
  it('encrypts exactly as RFC 8291’s worked example does', () => {
    const out = encrypt(Buffer.from('When I grow up, I want to be a watermelon'), {
      p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    }, { senderPrivate: b64u.decode('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: b64u.decode('DGv6ra1nlYgDCS1FRnbzlw') });
    expect(b64u.encode(out)).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  });

  it('signs a VAPID token a push service can verify, for its own origin only', () => {
    const keys = generateVapidKeys();
    const k = checkVapid(vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:ops@example.ir'), 'https://fcm.googleapis.com');
    expect(k).toBe(keys.publicKey);
  });

  it('calls only the browsers’ own push services — not an address a browser happens to name', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/QGx', 'https://wns2-db5p.notify.windows.com/w/?token=x']) {
      expect(checkEndpoint(ok).ok, ok).toBe(true);
    }
    for (const bad of ['http://fcm.googleapis.com/fcm/send/abc', 'https://fcm.googleapis.com.evil.example/x', 'https://evil.example/fcm.googleapis.com', 'https://169.254.169.254/latest/meta-data',
      'https://127.0.0.1/x', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'nonsense']) {
      expect(checkEndpoint(bad).ok, bad).toBe(false);
    }
  });

  it('puts on the phone only the three loops and their own clocks', () => {
    expect(pushable({ kind: 'WORK_ORDER_ISSUED' })).toBe(true);
    expect(pushable({ kind: 'QC_UNIT_REQUIRED' })).toBe(true);
    expect(pushable({ kind: 'FORM_APPROVAL_REQUIRED' })).toBe(true);
    expect(pushable({ kind: 'SLA_WARNING', entityType: 'workOrder', policyCode: 'SLA_TASK_ACCEPTANCE' })).toBe(true);
    expect(pushable({ kind: 'SLA_BREACH', entityType: 'formSubmission', policyCode: 'SLA_UNIT_QC' })).toBe(true);
    expect(pushable({ kind: 'SLA_WARNING', entityType: 'task', policyCode: 'SLA_TASK_ACCEPTANCE' })).toBe(false);
    expect(pushable({ kind: 'SLA_WARNING', entityType: 'workOrder', policyCode: 'SLA_CLARIFICATION' })).toBe(false);
    expect(pushable({ kind: 'FORM_FOR_INFORMATION', entityType: 'formSubmission' })).toBe(false);
    expect(pushable({ kind: 'OVERDUE_DIGEST' })).toBe(false);
  });
});

describe('Delivery, against a push service of the test’s own', () => {
  const received: { headers: http.IncomingHttpHeaders; body: Buffer; path: string }[] = [];
  let answers: number[] = [];
  let server: http.Server;
  let base = '';
  const local: PushNet = { hosts: [], allowPrivate: true, allowHttp: true };
  let designerId = '';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks), path: req.url ?? '' });
        res.statusCode = answers.shift() ?? 201;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    designerId = (await prisma.user.findUniqueOrThrow({ where: { email: 'designer@hiva.local' } })).id;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });

  const subscription = async (b: ReturnType<typeof browser>, path: string) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: designerId }, select: { organizationId: true } });
    return prisma.pushSubscription.create({ data: { organizationId: user.organizationId, userId: designerId, endpoint: `${base}${path}`, p256dh: b.p256dh, auth: b.auth } });
  };

  it('sends what only the phone can read, signed for the service, and records that the service took it', async () => {
    const b = browser();
    const sub = await subscription(b, '/push/one');
    const woId = '6f1d2b1e-0000-4000-8000-000000000049';
    const [id] = await pushNotification({ userId: designerId, kind: 'WORK_ORDER_ISSUED', title: 'سفارش کار تازه: پوستر', body: 'WO-9 — بپذیرید.', entityType: 'workOrder', entityId: woId });
    // Delivery is off in tests: recorded, not sent, until something sends it.
    expect(await prisma.pushMessage.findUniqueOrThrow({ where: { id: id! } })).toMatchObject({ status: 'QUEUED', attempts: 0, url: `/m?open=workOrder:${woId}` });

    expect(await deliver(id!, local)).toBe('SENT');
    const got = received.at(-1)!;
    expect(got.path).toBe('/push/one');
    expect(got.headers).toMatchObject({ 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '14400', urgency: 'normal' });
    expect(got.headers.topic).toMatch(/^[\w-]{1,32}$/);
    expect(checkVapid(String(got.headers.authorization), base)).toBe((await vapidKeys()).publicKey);
    expect(JSON.parse(decrypt(got.body, b))).toMatchObject({ id, kind: 'WORK_ORDER_ISSUED', title: 'سفارش کار تازه: پوستر', url: `/m?open=workOrder:${woId}`, tag: `workOrder:${woId}`, urgent: false });

    expect(await prisma.pushMessage.findUniqueOrThrow({ where: { id: id! } })).toMatchObject({ status: 'SENT', attempts: 1, statusCode: 201 });
    expect((await prisma.pushSubscription.findUniqueOrThrow({ where: { id: sub.id } })).lastSuccessAt).not.toBeNull();
    await prisma.pushSubscription.delete({ where: { id: sub.id } });
  });

  it('tries again when the service is busy, gives up after four, and switches off a browser the service forgot', async () => {
    const b = browser();
    const sub = await subscription(b, '/push/two');
    const [id] = await pushNotification({ userId: designerId, kind: 'SLA_BREACH', title: 'نقض SLA', entityType: 'workOrder', entityId: '6f1d2b1e-0000-4000-8000-000000000050', policyCode: 'SLA_TASK_ACCEPTANCE' });
    answers = [429, 503, 500, 502];
    expect(await deliver(id!, local)).toBe('QUEUED');
    expect(received.at(-1)!.headers).toMatchObject({ urgency: 'high', ttl: '3600' });
    expect(await deliver(id!, local)).toBe('QUEUED');
    expect(await deliver(id!, local)).toBe('QUEUED');
    expect(await deliver(id!, local)).toBe('FAILED');
    expect(await prisma.pushMessage.findUniqueOrThrow({ where: { id: id! } })).toMatchObject({ status: 'FAILED', attempts: 4, statusCode: 502 });
    expect((await prisma.pushSubscription.findUniqueOrThrow({ where: { id: sub.id } })).failures).toBe(1);
    // Sent is sent: a second call does nothing.
    expect(await deliver(id!, local)).toBeNull();

    const [gone] = await pushNotification({ userId: designerId, kind: 'QC_UNIT_REQUIRED', title: 'QC', entityType: 'deliverable', entityId: '6f1d2b1e-0000-4000-8000-000000000051' });
    answers = [410];
    expect(await deliver(gone!, local)).toBe('GONE');
    expect(await prisma.pushSubscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ disabledReason: 'GONE' });
    expect(await pushNotification({ userId: designerId, kind: 'QC_UNIT_REQUIRED', title: 'QC', entityType: 'deliverable', entityId: '6f1d2b1e-0000-4000-8000-000000000052' })).toEqual([]);
    await prisma.pushSubscription.delete({ where: { id: sub.id } });
  });

  it('switches off a browser whose service refuses our key, and one whose service is no longer allowed', async () => {
    const refused = await subscription(browser(), '/push/three');
    const [a] = await pushNotification({ userId: designerId, kind: 'FORM_APPROVAL_REQUIRED', title: 'فرم', entityType: 'formSubmission', entityId: '6f1d2b1e-0000-4000-8000-000000000053' });
    answers = [403];
    expect(await deliver(a!, local)).toBe('FAILED');
    expect(await prisma.pushSubscription.findUniqueOrThrow({ where: { id: refused.id } })).toMatchObject({ disabledReason: 'REJECTED' });
    await prisma.pushSubscription.delete({ where: { id: refused.id } });

    // With the real network rules, the test server's address is not a push service: nothing is sent.
    const elsewhere = await subscription(browser(), '/push/four');
    const before = received.length;
    const [c] = await pushNotification({ userId: designerId, kind: 'FORM_APPROVAL_REQUIRED', title: 'فرم', entityType: 'formSubmission', entityId: '6f1d2b1e-0000-4000-8000-000000000054' });
    expect(await deliver(c!)).toBe('FAILED');
    expect(received.length).toBe(before);
    expect(await prisma.pushSubscription.findUniqueOrThrow({ where: { id: elsewhere.id } })).toMatchObject({ disabledReason: 'NOT_ALLOWED' });
    await prisma.pushSubscription.delete({ where: { id: elsewhere.id } });
  });

  it('sends nothing to someone who has left', async () => {
    const sub = await subscription(browser(), '/push/five');
    await prisma.user.update({ where: { id: designerId }, data: { isActive: false } });
    try {
      expect(await pushNotification({ userId: designerId, kind: 'WORK_ORDER_ISSUED', title: 'x', entityType: 'workOrder', entityId: '6f1d2b1e-0000-4000-8000-000000000055' })).toEqual([]);
    } finally {
      await prisma.user.update({ where: { id: designerId }, data: { isActive: true } });
      await prisma.pushSubscription.delete({ where: { id: sub.id } });
    }
  });
});

describe('Subscribing a browser', () => {
  let T: Record<string, string>;
  beforeAll(async () => {
    await app();
    T = { designer: await login('designer@hiva.local'), creative: await login('creative@hiva.local') };
  });

  const endpoint = 'https://fcm.googleapis.com/fcm/send/dGVzdC1icm93c2VyLTQ5';

  it('takes a real browser’s subscription and refuses anything else', async () => {
    const key = expectOk(await get('/push/key', T.designer), 'key');
    expect(b64u.decode(key.publicKey)).toHaveLength(65);
    expect(key.delivery).toBe('off');

    const b = browser();
    const keys = { p256dh: b.p256dh, auth: b.auth };
    expect((await post('/push/subscriptions', T.designer, { endpoint: 'https://evil.example/x', keys })).body.error.code).toBe('PUSH_ENDPOINT');
    expect((await post('/push/subscriptions', T.designer, { endpoint: 'https://169.254.169.254/x', keys })).body.error.code).toBe('PUSH_ENDPOINT');
    const offCurve = b64u.encode(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]));
    expect((await post('/push/subscriptions', T.designer, { endpoint, keys: { ...keys, p256dh: offCurve } })).body.error.code).toBe('PUSH_KEYS');
    expect((await post('/push/subscriptions', T.designer, { endpoint, keys: { ...keys, auth: b64u.encode(randomBytes(8)) } })).body.error.code).toBe('PUSH_KEYS');

    expect((await post('/push/subscriptions', T.designer, { endpoint, keys, userAgent: 'Android Chrome' })).status).toBe(201);
    expect((await post('/push/subscriptions', T.designer, { endpoint, keys })).status).toBe(200);
    expect(expectOk(await get('/push/subscriptions', T.designer), 'mine')).toMatchObject([{ host: 'fcm.googleapis.com', userAgent: null, disabledAt: null }]);
  });

  it('moves a browser to whoever signs in on it, and lets each remove only their own', async () => {
    const b = browser();
    const designer = await prisma.user.findUniqueOrThrow({ where: { email: 'designer@hiva.local' } });
    expect((await post('/push/subscriptions', T.creative, { endpoint, keys: { p256dh: b.p256dh, auth: b.auth } })).status).toBe(200);
    expect(expectOk(await get('/push/subscriptions', T.designer), 'designer')).toEqual([]);
    const [mine] = expectOk(await get('/push/subscriptions', T.creative), 'creative');
    const trail = await prisma.auditEvent.findFirst({ where: { entityType: 'pushSubscription', entityId: mine.id }, orderBy: { createdAt: 'desc' } });
    expect(trail?.after).toMatchObject({ host: 'fcm.googleapis.com', tookOverFrom: designer.id });

    expect(expectOk(await call('DELETE', '/push/subscriptions', { token: T.designer, payload: { endpoint } }), 'not theirs')).toEqual({ removed: 0 });
    expect((await call('DELETE', `/push/subscriptions/${mine.id}`, { token: T.designer })).status).toBe(404);
    expect(expectOk(await post('/push/test', T.creative), 'test')).toEqual({ delivery: 'off', results: [{ subscriptionId: mine.id, host: 'fcm.googleapis.com', status: 'OFF', error: null }] });
    expect(expectOk(await call('DELETE', '/push/subscriptions', { token: T.creative, payload: { endpoint } }), 'signing out')).toEqual({ removed: 1 });
  });
});

describe('Who hears about the three loops', () => {
  let T: Record<string, string>;
  const ids: Record<string, string> = {};
  const endpointOf = (who: string) => `https://fcm.googleapis.com/fcm/send/${who}-49`;

  beforeAll(async () => {
    T = {
      accountManager: await login('account.manager@hiva.local'), creative: await login('creative@hiva.local'),
      designer: await login('designer@hiva.local'), sales: await login('sales@hiva.local'), admin: await login('admin@hiva.local'),
    };
    for (const email of ['creative', 'designer', 'strategy', 'account.manager']) ids[email] = (await prisma.user.findUniqueOrThrow({ where: { email: `${email}@hiva.local` } })).id;
    for (const [who, token] of [['creative', T.creative], ['designer', T.designer], ['account.manager', T.accountManager]] as const) {
      const b = browser();
      expectOk(await post('/push/subscriptions', token, { endpoint: endpointOf(who), keys: { p256dh: b.p256dh, auth: b.auth } }), `subscribe ${who}`);
    }
  });
  afterAll(async () => { await closeApp(); });

  const pushesTo = (userId: string, kind: string) => prisma.pushMessage.findMany({ where: { userId, kind }, orderBy: { createdAt: 'asc' } });

  it('tells a work order’s owner it has arrived, with the deadline its clock has, and again when an ambiguity is answered', async () => {
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    const wo = expectOk(await post('/work-orders', T.accountManager, {
      projectId: project.id, proposalId: project.proposalId, targetDepartmentCode: 'CR', title: 'پوستر سر صحنه',
      scopeOfWork: 'طراحی', brief: 'بریف', expectedOutput: 'فایل', outputFormat: 'PDF',
      deadline: new Date(Date.now() + 10 * 86_400_000).toISOString(), ownerId: ids.creative, budget: 1, priority: 'NORMAL',
    }), 'create');
    expectOk(await move('workOrder', wo.id, 'issue', T.accountManager), 'issue');

    const note = await prisma.notification.findFirstOrThrow({ where: { userId: ids.creative, kind: 'WORK_ORDER_ISSUED', entityId: wo.id } });
    expect(note.title).toBe('سفارش کار تازه: پوستر سر صحنه');
    expect(note.body).toContain('مهلت پذیرش:');
    const [push] = await pushesTo(ids.creative!, 'WORK_ORDER_ISSUED');
    expect(push).toMatchObject({ url: `/m?open=workOrder:${wo.id}`, tag: `workOrder:${wo.id}`, status: 'QUEUED' });
    // The one who issued it is not told about their own move.
    expect(await pushesTo(ids['account.manager']!, 'WORK_ORDER_ISSUED')).toEqual([]);

    expectOk(await move('workOrder', wo.id, 'request_clarification', T.creative, 'ابعاد مشخص نیست'), 'ask');
    expectOk(await move('workOrder', wo.id, 'clarify', T.accountManager), 'answer');
    expect(await prisma.notification.findFirst({ where: { userId: ids.creative, kind: 'WORK_ORDER_CLARIFIED', entityId: wo.id } })).not.toBeNull();
    expect(await pushesTo(ids.creative!, 'WORK_ORDER_CLARIFIED')).toHaveLength(1);

    // A move the rules refuse tells nobody anything.
    const before = await prisma.notification.count({ where: { userId: ids.creative } });
    expect((await move('workOrder', wo.id, 'complete', T.accountManager)).status).toBeGreaterThanOrEqual(400);
    expect(await prisma.notification.count({ where: { userId: ids.creative } })).toBe(before);
    ids.workOrder = wo.id;
  });

  it('tells the unit’s manager — not every member, not the author — that a deliverable waits for level-1 QC', async () => {
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    const d = expectOk(await post('/deliverables', T.accountManager, {
      projectId: project.id, proposalId: project.proposalId ?? undefined, name: 'پوستر نهایی ۴۹', departmentCode: 'CR', format: 'PDF',
      dueDate: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    }), 'deliverable');
    expectOk(await upload(T.accountManager, { name: 'poster.pdf', type: 'application/pdf', content: tinyPdf('poster') }, { projectId: project.id, deliverableId: d.id }), 'file');
    expectOk(await move('deliverable', d.id, 'start', T.designer), 'start');
    expectOk(await move('deliverable', d.id, 'submit', T.designer), 'submit');

    const [push] = await pushesTo(ids.creative!, 'QC_UNIT_REQUIRED');
    expect(push).toMatchObject({ url: `/m?open=deliverable:${d.id}`, title: 'QC واحد: پوستر نهایی ۴۹' });
    expect(await pushesTo(ids.designer!, 'QC_UNIT_REQUIRED')).toEqual([]);
    expect(await prisma.notification.count({ where: { kind: 'QC_UNIT_REQUIRED', entityId: d.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: ids.strategy, kind: 'QC_UNIT_REQUIRED' } })).toBe(0);

    const queue = expectOk(await get('/me/work', T.creative), 'queue');
    expect(queue.items.find((i: any) => i.entityId === d.id)).toMatchObject({ kind: 'qcUnit' });
    ids.deliverable = d.id;
  });

  it('puts a form awaiting decision on the approver’s phone, and an SLA notice only for the loops’ own clocks', async () => {
    const brief = await prisma.brief.findFirstOrThrow({ where: { state: 'UNDER_REVIEW' } });
    const form = expectOk(await post('/forms/submissions', T.sales, { formCode: 'B10_BRIEF_COMPLETION', data: { briefId: brief.id, addedInformation: 'x' } }), 'form');
    const [push] = await pushesTo(ids['account.manager']!, 'FORM_APPROVAL_REQUIRED');
    expect(push).toMatchObject({ url: `/m?open=formSubmission:${form.id}` });

    await notify({ userId: ids.creative!, kind: 'SLA_WARNING', title: 'هشدار', entityType: 'task', entityId: ids.workOrder!, policyCode: 'SLA_TASK_ACCEPTANCE' });
    expect(await pushesTo(ids.creative!, 'SLA_WARNING')).toEqual([]);
    await notify({ userId: ids.creative!, kind: 'SLA_WARNING', title: 'هشدار', entityType: 'workOrder', entityId: ids.workOrder!, policyCode: 'SLA_TASK_ACCEPTANCE' });
    expect(await pushesTo(ids.creative!, 'SLA_WARNING')).toHaveLength(1);
  });

  it('records a level-1 QC from the set with its photo — the review’s evidence, not the deliverable’s file', async () => {
    const review = expectOk(await post('/qc-reviews', T.creative, {
      level: 'UNIT', deliverableId: ids.deliverable, verdict: 'PASSED',
      checklist: { matchesBrief: true, technicallySound: true, brandCompliant: true, completeDeliverable: true },
    }), 'review');
    // Reviewed since it was submitted: out of the queue.
    const queue = expectOk(await get('/me/work', T.creative), 'queue');
    expect(queue.items.some((i: any) => i.entityId === ids.deliverable)).toBe(false);

    const photo = { name: 'set.jpg', type: 'image/jpeg', content: readFileSync(new URL('./fixtures/brand/baseline.jpg', import.meta.url)) };
    expect((await upload(T.designer, photo, { qcReviewId: review.review.id })).status).toBe(403);
    expect((await upload(T.creative, photo, { qcReviewId: review.review.id, deliverableId: ids.deliverable! })).body.error.code).toBe('QC_EVIDENCE_ALONE');
    expect((await upload(T.creative, { name: 'x.pdf', type: 'application/pdf', content: tinyPdf('x') }, { qcReviewId: review.review.id })).body.error.code).toBe('QC_EVIDENCE_IMAGE');
    const doc = expectOk(await upload(T.creative, photo, { qcReviewId: review.review.id }), 'photo');
    expect(doc).toMatchObject({ qcReviewId: review.review.id, deliverableId: null, projectId: null });

    const listed = expectOk(await get('/qc-reviews', T.creative, { deliverableId: ids.deliverable! }), 'reviews');
    expect(listed.items[0].documents).toEqual([{ id: doc.id, fileName: 'set.jpg', mimeType: 'image/jpeg' }]);
    const files = expectOk(await get('/documents', T.creative, { deliverableId: ids.deliverable! }), 'files');
    expect(files.some((f: any) => f.id === doc.id)).toBe(false);
    // Account's console shows the unit's check, and what it was made on, beside the deliverable.
    const console_ = expectOk(await get('/qc/queue', T.accountManager), 'qc queue');
    expect(console_.unit.find((d: any) => d.id === ids.deliverable).qcReviews[0]).toMatchObject({
      code: review.review.code, verdict: 'PASSED', reviewer: { fullName: 'سپیده آذر' }, documents: [{ id: doc.id, fileName: 'set.jpg', mimeType: 'image/jpeg' }],
    });

    // What was seen that day stays: no new version, and nobody else takes it back.
    expect((await upload(T.creative, photo, { replacesId: doc.id })).body.error.code).toBe('QC_EVIDENCE_FIXED');
    expect((await call('DELETE', `/documents/${doc.id}`, { token: T.admin })).status).toBe(409);
    await prisma.qcReview.update({ where: { id: review.review.id }, data: { reviewedAt: new Date(Date.now() - 25 * 3600_000) } });
    expect((await upload(T.creative, photo, { qcReviewId: review.review.id })).body.error.code).toBe('QC_EVIDENCE_LATE');
  });
});
