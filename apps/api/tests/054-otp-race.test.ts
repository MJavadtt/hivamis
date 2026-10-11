import { describe, it, expect, afterAll } from 'vitest';
import { closeApp } from './helpers.js';
import { prisma } from '../src/db.js';
import { issueCode } from '../src/auth/otp.js';

/**
 * Audit LOG-2: two requests for a code a moment apart both read "none sent yet", and the number was
 * texted twice. Issuing is now one step under a lock on the (purpose, number) pair.
 */
describe('One code a minute, however many ask at once (audit LOG-2)', () => {
  afterAll(async () => { await closeApp(); });

  it('issues exactly one of many simultaneous requests, and tells the rest when to try again', async () => {
    const phone = '09130005400';
    const results = await Promise.all(Array.from({ length: 8 }, () => issueCode({ purpose: 'LOGIN', phone })));
    const issued = results.filter((r) => 'code' in r);
    expect(issued).toHaveLength(1);
    expect(results.filter((r) => 'retryAfterSeconds' in r && r.retryAfterSeconds > 0)).toHaveLength(7);
    expect(await prisma.otpCode.count({ where: { phone, purpose: 'LOGIN' } })).toBe(1);
  });

  it('keeps pairs apart: a number’s sign-in code does not hold up its sign-up code, nor another number', async () => {
    const [a, b, c] = await Promise.all([
      issueCode({ purpose: 'LOGIN', phone: '09130005401' }),
      issueCode({ purpose: 'SIGNUP', phone: '09130005401' }),
      issueCode({ purpose: 'LOGIN', phone: '09130005402' }),
    ]);
    expect(['code' in a, 'code' in b, 'code' in c]).toEqual([true, true, true]);
  });
});
