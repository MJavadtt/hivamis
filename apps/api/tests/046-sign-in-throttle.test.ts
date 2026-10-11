import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { app, closeApp, DEV_PASSWORD } from './helpers.js';
import { prisma } from '../src/db.js';
import { BLOCK_AT, networkOf } from '../src/auth/throttle.js';
import { scanOrganization } from '../src/security/scan.js';

/**
 * Audit SEC-10: five wrong passwords no longer lock an account — which let anyone keep its owner out —
 * and an address with no account answers exactly as one with an account, in what and in how long.
 */

const signIn = (email: string, password: string, remoteAddress = '203.0.113.7') =>
  app().then((a) => a.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress, payload: { email, password } }));

describe('Wrong passwords slow their network, not the account (audit SEC-10)', () => {
  beforeEach(async () => { await prisma.signInFailure.deleteMany({}); });
  afterAll(async () => { await prisma.signInFailure.deleteMany({}); await closeApp(); });

  it('groups an address with its neighbours: an IPv4 /24, an IPv6 /64', () => {
    expect(networkOf('203.0.113.7')).toBe('203.0.113.0/24');
    expect(networkOf('::ffff:203.0.113.200')).toBe('203.0.113.0/24');
    expect(networkOf('2001:db8:abcd:12:1:2:3:4')).toBe('2001:db8:abcd:12::/64');
    expect(networkOf('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });

  it('lets three wrong tries pass, then makes each wait longer — and an unknown address the same', async () => {
    const run = async (email: string) => {
      const out: (number | string)[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await signIn(email, `Wrong-${i}-Password`);
        out.push(res.statusCode === 429 ? `429:${res.json().error.details.retryAfterSeconds}` : res.statusCode);
      }
      return out;
    };
    expect(await run('designer@hiva.local')).toEqual([401, 401, 401, 401, '429:1']);
    expect(await run('nobody-here@hiva.local')).toEqual([401, 401, 401, 401, '429:1']);
  });

  it('blocks the pair at ten failures for fifteen minutes — and only the pair', async () => {
    await prisma.signInFailure.createMany({ data: Array.from({ length: BLOCK_AT }, () => ({ identifier: 'designer@hiva.local', network: '203.0.113.0/24' })) });
    const blocked = await signIn('designer@hiva.local', DEV_PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.details.retryAfterSeconds).toBeGreaterThan(14 * 60);
    // Even the right password waits: the block is checked before any password is.
    // The owner, from their own network, is in at once — nothing locked the account.
    expect((await signIn('designer@hiva.local', DEV_PASSWORD, '198.51.100.4')).statusCode).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: 'designer@hiva.local' } })).lockedUntil).toBeNull();
  });

  it('clears the pair when its owner gets in', async () => {
    for (let i = 0; i < 3; i++) await signIn('media@hiva.local', 'Wrong-Password-1');
    expect((await signIn('media@hiva.local', DEV_PASSWORD)).statusCode).toBe(200);
    expect(await prisma.signInFailure.count({ where: { identifier: 'media@hiva.local' } })).toBe(0);
  });

  it('takes as long for an address with no account as for a wrong password', async () => {
    const time = async (email: string) => {
      const t: number[] = [];
      for (let i = 0; i < 5; i++) {
        await prisma.signInFailure.deleteMany({});
        const start = performance.now();
        await signIn(email, 'Wrong-Password-1', `192.0.2.${i + 10}`);
        t.push(performance.now() - start);
      }
      return t.sort((a, b) => a - b)[2]!;
    };
    const existing = await time('finance@hiva.local');
    const missing = await time('no-such-person@hiva.local');
    // Both pay for an Argon2 check; before, the missing address answered without one.
    expect(missing).toBeGreaterThan(existing * 0.5);
    expect(missing).toBeLessThan(existing * 2);
  });

  it('raises a security alert for an account tried fifty times in an hour, from wherever — instead of locking it', async () => {
    const legal = await prisma.user.findUniqueOrThrow({ where: { email: 'legal@hiva.local' } });
    await prisma.auditEvent.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        organizationId: legal.organizationId, actorId: legal.id, action: 'LOGIN_FAILED', entityType: 'user', entityId: legal.id,
        reason: 'bad-password', ipAddress: `198.18.${i}.1`,
      })),
    });
    await scanOrganization(legal.organizationId);
    const alert = await prisma.securityAlert.findFirstOrThrow({ where: { kind: 'LOGIN_FAILURES', actorId: legal.id } });
    expect(alert.severity).toBe('HIGH');
    expect(alert.evidence).toMatchObject({ count: 50, addresses: 50 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: legal.id } })).lockedUntil).toBeNull();
  });
});
