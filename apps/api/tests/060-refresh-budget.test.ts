import { describe, it, expect, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { hashToken } from '../src/auth/tokens.js';
import { closeApp, refreshCookieOf, signIn } from './helpers.js';

/**
 * Found by the visual pass (audit UI-V): renewing a session was limited per address, ten a minute.
 * An office behind one NAT address shares one — so at nine in the morning, the eleventh person to
 * open the app saw «سرور در دسترس نیست». The budget is now each session's own; the address keeps
 * the general limit.
 */

const LIMIT = 3;
let limited: FastifyInstance;

const renew = (refresh: string) => limited.inject({
  method: 'POST', url: '/api/v1/auth/refresh',
  headers: { cookie: `hiva_refresh=${encodeURIComponent(refresh)}`, 'x-hiva-refresh': '1' },
});

describe('Renewing a session (audit UI-V)', () => {
  afterAll(async () => { await limited?.close(); await closeApp(); });

  it('lets a whole office behind one address renew, however many there are', async () => {
    const was = env.LOGIN_RATE_LIMIT_MAX;
    (env as { LOGIN_RATE_LIMIT_MAX: number }).LOGIN_RATE_LIMIT_MAX = LIMIT;
    try { limited = await buildApp(); await limited.ready(); } finally { (env as { LOGIN_RATE_LIMIT_MAX: number }).LOGIN_RATE_LIMIT_MAX = was; }
    // Signed in beforehand; each now opens the app from the same address, one renewal each.
    const office = ['sales@hiva.local', 'account@hiva.local', 'designer@hiva.local', 'pmo@hiva.local', 'finance@hiva.local', 'legal@hiva.local'];
    const sessions = await Promise.all(office.map((e) => signIn(e)));
    const codes = [];
    for (const s of sessions) codes.push((await renew(s.refresh)).statusCode);
    expect(codes).toEqual(office.map(() => 200));
  });

  it('still limits one session that renews too often — and leaves it working', async () => {
    let { refresh } = await signIn('creative@hiva.local');
    const was = env.LOGIN_RATE_LIMIT_MAX;
    (env as { LOGIN_RATE_LIMIT_MAX: number }).LOGIN_RATE_LIMIT_MAX = LIMIT;
    try {
      for (let i = 0; i < LIMIT; i++) {
        const r = await renew(refresh);
        expect(r.statusCode).toBe(200);
        refresh = refreshCookieOf(r)!;
      }
      const refused = await renew(refresh);
      expect(refused.statusCode).toBe(429);
      expect(refused.json().error.code).toBe('RATE_LIMITED');
      // Refused before it was spent: the cookie the browser holds is still the live one, and the
      // refusal does not tell the browser to drop it.
      expect(refreshCookieOf(refused)).toBeUndefined();
      expect(await prisma.session.findUniqueOrThrow({ where: { refreshTokenHash: hashToken(refresh) } })).toMatchObject({ revokedAt: null });
    } finally {
      (env as { LOGIN_RATE_LIMIT_MAX: number }).LOGIN_RATE_LIMIT_MAX = was;
    }
  });
});
