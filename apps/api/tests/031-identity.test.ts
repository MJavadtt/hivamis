import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { app, call, closeApp, expectOk, get, login, patch, post, refreshCookieOf, refreshWith, signIn } from './helpers.js';
import { prisma } from '../src/db.js';
import { google } from '../src/auth/google.js';
import { MAX_ATTEMPTS } from '../src/auth/otp.js';

/**
 * Hivamis task 4: signing in with a mobile number or a Google account, asking to join, and a page
 * for every person. Signing in proves who someone is; what they may do is still the administrator's.
 */

const del = (url: string, token: string) => call('DELETE', url, { token });
/** The SMS sandbox keeps the text; the code is its six digits. */
async function lastCode(phone: string): Promise<string> {
  const m = await prisma.smsMessage.findFirst({ where: { phone }, orderBy: { createdAt: 'desc' } });
  const code = /\d{6}/.exec(m?.text ?? '')?.[0];
  if (!code) throw new Error(`no code sent to ${phone}`);
  return code;
}
/** A sign-in code is sent in the background; wait for the message that follows `since`. */
async function codeSentAfter(phone: string, since: Date): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const m = await prisma.smsMessage.findFirst({ where: { phone, createdAt: { gt: since } }, orderBy: { createdAt: 'desc' } });
    const code = /\d{6}/.exec(m?.text ?? '')?.[0];
    if (code) return code;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no code sent to ${phone}`);
}
/** Starts a sign-in by mobile and returns the code it sent. */
async function signInCode(phone: string): Promise<string> {
  const since = new Date(Date.now() - 1);
  expect((await call('POST', '/auth/phone/start', { payload: { phone } })).status).toBe(202);
  return codeSentAfter(phone, since);
}
/** Codes are one a minute per number; a test that needs another moves the last one back in time. */
const ageCodes = (phone: string) => prisma.otpCode.updateMany({ where: { phone }, data: { createdAt: new Date(Date.now() - 2 * 60_000) } });

describe('Signing in by mobile', () => {
  let pmo: string;
  const phone = '09130000101';
  beforeAll(async () => { pmo = await login('pmo@hiva.local'); });

  it('says which ways in this installation offers', async () => {
    const m = expectOk(await call('GET', '/auth/methods'), 'methods');
    expect(m).toMatchObject({ password: true, phone: true, google: false, signup: { open: true, phone: true, google: false } });
  });

  it('lets a person prove their mobile, then sign in with a code sent to it', async () => {
    expectOk(await post('/me/phone/start', pmo, { phone: '0913 000 0101' }), 'start');
    expectOk(await post('/me/phone/verify', pmo, { phone, code: await lastCode(phone) }), 'verify');
    const me = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    expect(me.phone).toBe(phone);
    expect(me.phoneVerifiedAt).not.toBeNull();

    await ageCodes(phone);
    const code = await signInCode(phone);
    const raw = await call('POST', '/auth/phone/verify', { payload: { phone, code: code.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]!) } });
    const res = expectOk(raw, 'sign in');
    expect(res.user.email).toBe('pmo@hiva.local');
    // Audit SEC-4: the refresh token is in the cookie, not the body.
    expect(res).not.toHaveProperty('refreshToken');
    expect(refreshCookieOf(raw)).toBeTruthy();
    expect(expectOk(await get('/auth/me', res.accessToken), 'me').email).toBe('pmo@hiva.local');
    const trail = await prisma.auditEvent.findFirst({ where: { actorId: me.id, action: 'LOGIN' }, orderBy: { createdAt: 'desc' } });
    expect(trail?.reason).toBe('phone');
    // One use.
    expect((await call('POST', '/auth/phone/verify', { payload: { phone, code } })).status).toBe(401);
  });

  it('answers the same for a number nobody has, and sends it nothing', async () => {
    const before = await prisma.smsMessage.count();
    const res = await call('POST', '/auth/phone/start', { payload: { phone: '09139999999' } });
    expect({ status: res.status, body: res.body }).toEqual({ status: 202, body: { sent: true, resendAfterSeconds: 60 } });
    expect(await prisma.smsMessage.count()).toBe(before);
    expect((await call('POST', '/auth/phone/verify', { payload: { phone: '09139999999', code: '123456' } })).status).toBe(401);
  });

  it('spends a code after five wrong tries, and slows the network down — without locking the account', async () => {
    await ageCodes(phone);
    const code = await signInCode(phone);
    const wrong = code === '000000' ? '111111' : '000000';
    const verify = (c: string, remoteAddress?: string) => app().then((a) => a.inject({ method: 'POST', url: '/api/v1/auth/phone/verify', payload: { phone, code: c }, ...(remoteAddress ? { remoteAddress } : {}) }));
    // Each wrong try from its own network, so the code's five tries are what is spent here.
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect((await verify(wrong, `203.0.${i}.1`)).statusCode).toBe(401);
    expect((await verify(code, '203.0.9.1')).statusCode).toBe(401);
    const me = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    expect(me.lockedUntil).toBeNull();
    // Audit SEC-10: from one network, the fourth wrong try in a row is made to wait.
    await ageCodes(phone);
    await signInCode(phone);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await verify(wrong, '203.0.113.9')).statusCode);
    expect(statuses).toEqual([401, 401, 401, 401, 429]);
    await prisma.signInFailure.deleteMany({ where: { identifier: phone } });
  });

  it('sends one code a minute to a number, whoever asks', async () => {
    await ageCodes(phone);
    await signInCode(phone);
    const count = await prisma.otpCode.count({ where: { phone } });
    expect((await call('POST', '/auth/phone/start', { payload: { phone } })).status).toBe(202);
    expect(await prisma.otpCode.count({ where: { phone } })).toBe(count);
  });

  it('never keeps a mobile that belongs to someone else', async () => {
    const legal = await login('legal@hiva.local');
    expect((await post('/me/phone/start', legal, { phone })).body.error.code).toBe('PHONE_TAKEN');
  });
});

describe('Asking to join', () => {
  let admin: string, sales: string;
  const phone = '09130000202';
  beforeAll(async () => { admin = await login('admin@hiva.local'); sales = await login('sales@hiva.local'); });

  const ask = async (email: string, code?: string) => call('POST', '/auth/signup', {
    payload: { fullName: 'نیلوفر احمدی', email, phone, code: code ?? await lastCode(phone), departmentCode: 'S', note: 'کارشناس فروش تازه' },
  });

  it('records a request with a proved mobile, tells the administrators, and grants nothing yet', async () => {
    expect((await call('POST', '/auth/signup/phone/start', { payload: { phone } })).status).toBe(202);
    expect((await ask('new.person@example.com', '000000')).body.error?.code ?? 'ok').toMatch(/BAD_CODE|ok/);
    await ageCodes(phone);
    await call('POST', '/auth/signup/phone/start', { payload: { phone } });
    expect((await ask('NEW.person@example.com')).status).toBe(201);
    const request = await prisma.signupRequest.findFirstOrThrow({ where: { email: 'new.person@example.com' } });
    expect(request).toMatchObject({ status: 'PENDING', method: 'PHONE', phone, departmentCode: 'S', userId: null });
    expect(await prisma.user.findFirst({ where: { email: 'new.person@example.com' } })).toBeNull();
    const adminUser = await prisma.user.findFirstOrThrow({ where: { email: 'admin@hiva.local' } });
    expect(await prisma.notification.count({ where: { userId: adminUser.id, kind: 'SIGNUP_REQUESTED', entityId: request.id } })).toBe(1);

    // The same address again, while it waits.
    await ageCodes(phone);
    await call('POST', '/auth/signup/phone/start', { payload: { phone } });
    expect((await ask('new.person@example.com')).body.error.code).toBe('ALREADY_PENDING');
  });

  it('keeps the queue to the administrators of users', async () => {
    expect((await get('/signup-requests', sales)).status).toBe(403);
    const list = expectOk(await get('/signup-requests', admin, { status: 'PENDING' }), 'list');
    expect(list.some((r: any) => r.email === 'new.person@example.com')).toBe(true);
  });

  it('approves with the unit and roles the administrator chooses — never system administration', async () => {
    const request = await prisma.signupRequest.findFirstOrThrow({ where: { email: 'new.person@example.com' } });
    expect((await post(`/signup-requests/${request.id}/approve`, admin, { departmentCode: 'S', roles: ['SUPER_ADMIN'] })).status).toBe(400);
    expect((await post(`/signup-requests/${request.id}/approve`, sales, { departmentCode: 'S', roles: ['SALES_REP'] })).status).toBe(403);
    expectOk(await post(`/signup-requests/${request.id}/approve`, admin, { departmentCode: 'S', roles: ['SALES_REP'], jobTitle: 'کارشناس فروش' }), 'approve');
    expect((await post(`/signup-requests/${request.id}/approve`, admin, { departmentCode: 'S', roles: ['SALES_REP'] })).body.error.code).toBe('ALREADY_DECIDED');

    const user = await prisma.user.findFirstOrThrow({ where: { email: 'new.person@example.com' }, include: { roles: { include: { role: true } }, department: true } });
    expect(user.roles.map((r) => r.role.code)).toEqual(['SALES_REP']);
    expect(user.department?.code).toBe('S');
    expect(user.phoneVerifiedAt).not.toBeNull();
    expect(user.passwordHash.startsWith('!')).toBe(true);

    // In with the mobile they proved.
    await ageCodes(phone);
    const session = expectOk(await call('POST', '/auth/phone/verify', { payload: { phone, code: await signInCode(phone) } }), 'sign in');
    expect(session.user.roles).toEqual(['SALES_REP']);

    // Their only way in cannot be taken away; a first password can be set, and then it can.
    expect((await del('/me/phone', session.accessToken)).body.error.code).toBe('LAST_WAY_IN');
    expect((await post('/me/password', session.accessToken, { newPassword: 'Tazeh-Ramz-2026' })).status).toBe(204);
    expect((await post('/me/password', session.accessToken, { newPassword: 'Digar-Ramz-2026' })).body.error.code).toBe('HAS_PASSWORD');
    expect(expectOk(await del('/me/phone', session.accessToken), 'remove mobile')).toMatchObject({ phoneVerified: false });
  });

  it('rejects with a reason', async () => {
    const r = await prisma.signupRequest.create({ data: { organizationId: (await prisma.organization.findFirstOrThrow()).id, method: 'PHONE', fullName: 'درخواست آزمون', email: 'reject.me@example.com', phone: '09130000303' } });
    expect((await post(`/signup-requests/${r.id}/reject`, admin, { note: '' })).status).toBe(400);
    expectOk(await post(`/signup-requests/${r.id}/reject`, admin, { note: 'در سازمان شناخته نشد' }), 'reject');
    expect(await prisma.signupRequest.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: 'REJECTED', decisionNote: 'در سازمان شناخته نشد' });
  });

  it('closes when the administrator closes it', async () => {
    expect((await patch('/settings/signup', sales, { enabled: false })).status).toBe(403);
    expectOk(await patch('/settings/signup', admin, { enabled: false }), 'close');
    expect(expectOk(await call('GET', '/auth/methods'), 'methods').signup.open).toBe(false);
    expect((await call('POST', '/auth/signup/phone/start', { payload: { phone: '09130000404' } })).body.error.code).toBe('SIGNUP_CLOSED');
    expectOk(await patch('/settings/signup', admin, { enabled: true }), 'open');
  });

  it('refuses a request whose code is wrong, and the database refuses a request without its proof', async () => {
    await expect(prisma.signupRequest.create({ data: { organizationId: (await prisma.organization.findFirstOrThrow()).id, method: 'PHONE', fullName: 'بی‌شماره', email: 'x@example.com' } })).rejects.toThrow();
  });
});

describe('A page for every person', () => {
  let pmo: string, sales: string, admin: string;
  beforeAll(async () => { pmo = await login('pmo@hiva.local'); sales = await login('sales@hiva.local'); admin = await login('admin@hiva.local'); });

  it('shows a colleague who they are, and keeps their mobile and sign-ins to themselves and administrators', async () => {
    const pmoUser = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    const seen = expectOk(await get(`/people/${pmoUser.id}`, sales), 'colleague');
    expect(seen).toMatchObject({ fullName: pmoUser.fullName, email: 'pmo@hiva.local', self: false, private: null });
    expect(seen.department.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(expectOk(await get(`/people/${pmoUser.id}`, pmo), 'self').private).toMatchObject({ phoneVerified: true });
    expect(expectOk(await get(`/people/${pmoUser.id}`, admin), 'admin').private).not.toBeNull();
    const directory = expectOk(await get('/people', sales, { q: pmoUser.fullName.split(' ')[0]! }), 'directory');
    expect(directory.some((p: any) => p.id === pmoUser.id)).toBe(true);
    expect((await get('/people/00000000-0000-4000-8000-00000000dead', sales)).status).toBe(404);
  });

  it('lists one’s own devices, marks this one, and signs the others out', async () => {
    const a = await signIn('finance@hiva.local');
    const b = await signIn('finance@hiva.local');
    const mine = expectOk(await get('/me/profile', b.access), 'profile');
    expect(mine.sessions.filter((s: any) => s.current)).toHaveLength(1);
    expect(mine.hasPassword).toBe(true);
    expectOk(await post('/me/sessions/revoke-others', b.access), 'others');
    // The signed-out device is simply out; this one stays in. Before session ends had reasons, the
    // other device's next refresh read as theft and signed everyone out.
    expect((await refreshWith(a.refresh)).status).toBe(401);
    expect((await refreshWith(b.refresh)).status).toBe(200);
    const financeUser = await prisma.user.findFirstOrThrow({ where: { email: 'finance@hiva.local' } });
    expect(await prisma.auditEvent.count({ where: { actorId: financeUser.id, action: 'REFRESH_TOKEN_REUSE' } })).toBe(0);
  });

  it('still treats a rotated token presented again as stolen, and ends every session', async () => {
    const first = await signIn('designer@hiva.local');
    const rotated = await refreshWith(first.refresh);
    expect(rotated.status).toBe(200);
    expect((await refreshWith(first.refresh)).status).toBe(401);
    expect((await refreshWith(rotated.refresh!)).status).toBe(401);
    const designer = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    expect(await prisma.auditEvent.count({ where: { actorId: designer.id, action: 'REFRESH_TOKEN_REUSE' } })).toBe(1);
  });
});

describe('Signing in with Google', () => {
  let server: http.Server;
  let nextToken: (nonce: string) => Promise<string>;
  let lastNonce = '';
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  const saved = { ...google };

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/jwks')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); return; }
      if (req.url?.startsWith('/token')) {
        void nextToken(lastNonce).then((t) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id_token: t })); });
        return;
      }
      res.statusCode = 404; res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    Object.assign(google, { clientId: 'test-client', clientSecret: 'test-secret', authUrl: `${base}/auth`, tokenUrl: `${base}/token`, jwksUrl: `${base}/jwks`, issuer: 'https://accounts.google.com', allowedDomains: [] });
  });
  afterAll(async () => { Object.assign(google, saved); server.close(); await closeApp(); });

  const idToken = (claims: Record<string, unknown>) => async (nonce: string) =>
    new SignJWT({ nonce, email_verified: true, ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://accounts.google.com').setAudience('test-client').setIssuedAt().setExpirationTime('5m').sign(privateKey);

  const bindingOf = (res: { headers: Record<string, unknown> }) => {
    const raw = res.headers['set-cookie'];
    const line = (Array.isArray(raw) ? raw : [String(raw ?? '')]).find((c) => c.startsWith('hiva_oauth='));
    return line?.split(';')[0]!.slice('hiva_oauth='.length);
  };
  /** Google's answer arriving in a browser: this one's cookie, another's, or none. */
  const callback = (state: string, binding: string | undefined) =>
    app().then((a) => a.inject({ method: 'GET', url: `/api/v1/auth/google/callback?code=c&state=${state}`, headers: binding ? { cookie: `hiva_oauth=${binding}` } : {} }));
  const where = (res: { headers: Record<string, unknown> }) => {
    const location = new URL(res.headers.location as string);
    return { path: location.pathname, fragment: new URLSearchParams(location.hash.slice(1)) };
  };

  /** Starts a flow, lets "Google" answer with these claims, and returns where the browser is sent. */
  async function roundTrip(start: () => Promise<{ status: number; body: any; headers: Record<string, unknown> }>, claims: Record<string, unknown>, tamper?: (nonce: string) => string, browser?: (own: string) => string | undefined) {
    const started = await start();
    const url = new URL(expectOk(started, 'start').url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const own = bindingOf(started)!;
    expect(own).toBeTruthy();
    const state = url.searchParams.get('state')!;
    lastNonce = tamper ? tamper(url.searchParams.get('nonce')!) : url.searchParams.get('nonce')!;
    nextToken = idToken(claims);
    const res = await callback(state, browser ? browser(own) : own);
    expect(res.statusCode).toBe(302);
    return { ...where(res), state, binding: own };
  }

  it('links a work address Google has verified only once its owner proves the account — then signs in by ticket', async () => {
    const out = await roundTrip(() => call('GET', '/auth/google/start', { query: { mode: 'login' } }), { sub: 'g-legal', email: 'Legal@Hiva.local', name: 'Legal' });
    expect(out.path).toBe('/auth/google');
    // Audit SEC-5: not linked on the address alone, and nobody signed in yet.
    expect(out.fragment.get('ticket')).toBeNull();
    const link = out.fragment.get('link')!;
    expect(await prisma.userIdentity.count({ where: { provider: 'google', subject: 'g-legal' } })).toBe(0);
    expect(expectOk(await call('POST', '/auth/google/offer', { payload: { token: link } }), 'offer')).toMatchObject({ email: 'legal@hiva.local', password: true });

    const wrong = await call('POST', '/auth/google/offer/confirm', { payload: { token: link, password: 'not-it-at-all' } });
    expect(wrong.status).toBe(401);
    const raw = await call('POST', '/auth/google/offer/confirm', { payload: { token: link, password: 'Hiva@Dev2026!' } });
    const session = expectOk(raw, 'confirm');
    expect(session.user.email).toBe('legal@hiva.local');
    expect(refreshCookieOf(raw)).toBeTruthy();
    const identity = await prisma.userIdentity.findUniqueOrThrow({ where: { provider_subject: { provider: 'google', subject: 'g-legal' } } });
    const trail = await prisma.auditEvent.findFirstOrThrow({ where: { entityType: 'userIdentity', entityId: identity.id } });
    expect(trail).toMatchObject({ action: 'CREATE', reason: 'google linked after proof', after: { provider: 'google', email: 'legal@hiva.local', proof: 'password' } });
    // Spent.
    expect((await call('POST', '/auth/google/offer/confirm', { payload: { token: link, password: 'Hiva@Dev2026!' } })).status).toBe(410);

    // Linked now: the next sign-in with Google goes straight through, by a ticket — no token in the URL.
    const next = await roundTrip(() => call('GET', '/auth/google/start', { query: { mode: 'login' } }), { sub: 'g-legal', email: 'legal@hiva.local', name: 'Legal' });
    const ticket = next.fragment.get('ticket')!;
    expect(expectOk(await call('POST', '/auth/ticket', { payload: { ticket } }), 'ticket').user.email).toBe('legal@hiva.local');
    expect((await call('POST', '/auth/ticket', { payload: { ticket } })).status).toBe(401);
    // The state is spent with the first answer.
    expect(where(await callback(next.state, next.binding)).fragment.get('error')).toBe('GOOGLE_STATE');
  });

  it('honours Google’s answer only in the browser that asked — someone else’s link lands nobody anywhere', async () => {
    const elsewhere = await roundTrip(() => call('GET', '/auth/google/start', { query: { mode: 'login' } }), { sub: 'g-legal', email: 'legal@hiva.local' }, undefined, () => 'another-browsers-nonce');
    expect(elsewhere.fragment.get('error')).toBe('GOOGLE_BROWSER');
    const none = await roundTrip(() => call('GET', '/auth/google/start', { query: { mode: 'login' } }), { sub: 'g-legal', email: 'legal@hiva.local' }, undefined, () => undefined);
    expect(none.fragment.get('error')).toBe('GOOGLE_BROWSER');
    // Refused before anything was spent: the browser that did ask can still finish.
    expect(where(await callback(none.state, none.binding)).fragment.get('ticket')).toBeTruthy();
  });

  it('holds the allowed domains at sign-in and at linking, not only at asking to join', async () => {
    google.allowedDomains = ['hiva.local'];
    try {
      const outside = await roundTrip(() => call('GET', '/auth/google/start', { query: { mode: 'login' } }), { sub: 'g-legal', email: 'legal@hiva.local' });
      expect(outside.fragment.get('ticket')).toBeTruthy();
      const gmail = await roundTrip(() => call('GET', '/auth/google/start', { query: { mode: 'login' } }), { sub: 'g-gmail', email: 'someone@gmail.com' });
      expect(gmail.fragment.get('error')).toBe('DOMAIN');
      const media = await login('media@hiva.local');
      const linking = await roundTrip(() => post('/me/google/link', media), { sub: 'g-media', email: 'media.private@gmail.com' });
      expect([linking.path, linking.fragment.get('error')]).toEqual(['/me', 'DOMAIN']);
    } finally { google.allowedDomains = []; }
  });

  it('takes a code to the account’s mobile as proof, and five wrong proofs spend the offer', async () => {
    const pmo = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    expect(pmo.phoneVerifiedAt).not.toBeNull(); // proved in «Signing in by mobile» above
    const out = await roundTrip(() => call('GET', '/auth/google/start', { query: { mode: 'login' } }), { sub: 'g-pmo', email: 'pmo@hiva.local' });
    const link = out.fragment.get('link')!;
    expect(expectOk(await call('POST', '/auth/google/offer', { payload: { token: link } }), 'offer').phone).toMatch(/^•+01$/);
    await ageCodes(pmo.phone!);
    const since = new Date(Date.now() - 1);
    expect((await call('POST', '/auth/google/offer/code', { payload: { token: link } })).status).toBe(202);
    const code = await codeSentAfter(pmo.phone!, since);
    expect(expectOk(await call('POST', '/auth/google/offer/confirm', { payload: { token: link, code } }), 'confirm').user.email).toBe('pmo@hiva.local');
    expect(await prisma.userIdentity.count({ where: { provider: 'google', subject: 'g-pmo' } })).toBe(1);

    const again = await roundTrip(() => call('GET', '/auth/google/start', { query: { mode: 'login' } }), { sub: 'g-creative', email: 'creative@hiva.local' });
    const offer = again.fragment.get('link')!;
    // Each from its own network: one network is slowed down sooner (audit SEC-10); this is the offer's own limit.
    const confirm = (password: string, remoteAddress: string) =>
      app().then((a) => a.inject({ method: 'POST', url: '/api/v1/auth/google/offer/confirm', remoteAddress, payload: { token: offer, password } }));
    for (let i = 0; i < 5; i++) expect((await confirm(`wrong-${i}`, `198.18.${i}.1`)).statusCode).toBe(401);
    expect((await confirm('Hiva@Dev2026!', '198.18.9.1')).statusCode).toBe(410);
    expect(await prisma.userIdentity.count({ where: { provider: 'google', subject: 'g-creative' } })).toBe(0);
    // The wrong proofs slowed this network down as wrong passwords do; clear that for the tests after.
    await prisma.signInFailure.deleteMany({ where: { identifier: 'creative@hiva.local' } });
  });

  it('refuses an answer that is not for this request, or an address Google has not verified', async () => {
    const forged = await roundTrip(() => call('GET', '/auth/google/start', { query: { mode: 'login' } }), { sub: 'g-legal', email: 'legal@hiva.local' }, () => 'another-nonce');
    expect(forged.fragment.get('error')).toBe('GOOGLE_TOKEN');
    const unverified = await roundTrip(() => call('GET', '/auth/google/start', { query: { mode: 'login' } }), { sub: 'g-x', email: 'x@example.com', email_verified: false });
    expect(unverified.fragment.get('error')).toBe('GOOGLE_EMAIL');
    const stranger = await roundTrip(() => call('GET', '/auth/google/start', { query: { mode: 'login' } }), { sub: 'g-stranger', email: 'stranger@example.com' });
    expect(stranger.fragment.get('error')).toBe('NO_ACCOUNT');
  });

  it('turns a stranger asking to join into a request, and links an account for someone signed in', async () => {
    const asked = await roundTrip(() => call('GET', '/auth/google/start', { query: { mode: 'signup' } }), { sub: 'g-new', email: 'joiner@example.com', name: 'Joiner' });
    expect([asked.path, asked.fragment.get('done')]).toEqual(['/signup', 'sent']);
    expect(await prisma.signupRequest.findFirst({ where: { email: 'joiner@example.com' } })).toMatchObject({ method: 'GOOGLE', googleSubject: 'g-new', status: 'PENDING' });

    const finance = await login('finance@hiva.local');
    const linked = await roundTrip(() => post('/me/google/link', finance), { sub: 'g-finance', email: 'someone.else@gmail.com' });
    expect([linked.path, linked.fragment.get('linked')]).toEqual(['/me', 'google']);
    const profile = expectOk(await get('/me/profile', finance), 'profile');
    expect(profile.identities).toEqual([expect.objectContaining({ provider: 'google', email: 'someone.else@gmail.com' })]);
    const creative = await login('creative@hiva.local');
    const stolen = await roundTrip(() => post('/me/google/link', creative), { sub: 'g-finance', email: 'someone.else@gmail.com' });
    expect(stolen.fragment.get('error')).toBe('LINKED_ELSEWHERE');
  });
});
