import { describe, it, expect, afterAll, vi } from 'vitest';
import { call, closeApp, DEV_PASSWORD, get, login, patch, post, refreshWith, signIn } from './helpers.js';
import { prisma } from '../src/db.js';
import { signAccessToken } from '../src/auth/tokens.js';
import { claimsFor } from '../src/auth/claims.js';

/**
 * Audit SEC-3: an access token stops working the moment what it was issued on ends — its sign-in, its
 * holder's standing, their roles or password — not up to fifteen minutes later when it expires.
 */

const refresh = async (token: string) => {
  const r = await refreshWith(token);
  return { status: r.status, body: { ...r.body, refreshToken: r.refresh } };
};
/** Signing out as the app does: the bearer, and the session's cookie. */
const logout = (s: { access: string; refresh: string }) =>
  call('POST', '/auth/logout', { token: s.access, headers: { cookie: `hiva_refresh=${encodeURIComponent(s.refresh)}`, 'x-hiva-refresh': '1' } });
const me = (token: string) => get('/auth/me', token);
const idOf = async (email: string) => (await prisma.user.findUniqueOrThrow({ where: { email } })).id;

describe('Access tokens end with what they were issued on (audit SEC-3)', () => {
  afterAll(async () => { await closeApp(); });

  it('stops a signed-out token at once', async () => {
    const s = await signIn('designer@hiva.local');
    expect((await me(s.access)).status).toBe(200);
    expect((await logout(s)).status).toBe(204);
    const after = await me(s.access);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SESSION_REVOKED');
  });

  it('keeps a token good through its sign-in’s rotation, and ends both when that sign-in ends', async () => {
    const s = await signIn('designer@hiva.local');
    const next = await refresh(s.refresh);
    expect(next.status).toBe(200);
    // Another tab still holds the token from before the rotation: the sign-in goes on, so does it.
    expect((await me(s.access)).status).toBe(200);
    expect((await me(next.body.accessToken)).status).toBe(200);
    await logout({ access: next.body.accessToken, refresh: next.body.refreshToken! });
    expect((await me(s.access)).status).toBe(401);
    expect((await me(next.body.accessToken)).status).toBe(401);
  });

  it('stops a deactivated person’s token on their next request', async () => {
    const admin = await login('admin@hiva.local');
    const s = await signIn('media@hiva.local');
    expect((await me(s.access)).status).toBe(200);
    expect((await post(`/users/${await idOf('media@hiva.local')}/deactivate`, admin)).status).toBe(200);
    expect((await me(s.access)).body.error.code).toBe('SESSION_REVOKED');
  });

  it('stops a demoted person’s token at once; a fresh sign-in carries the new roles', async () => {
    const admin = await login('admin@hiva.local');
    const s = await signIn('digital@hiva.local');
    const id = await idOf('digital@hiva.local');
    expect((await patch(`/users/${id}`, admin, { roleCodes: ['UNIT_MEMBER'] })).status).toBe(200);
    expect((await me(s.access)).body.error.code).toBe('SESSION_REVOKED');
    expect((await refresh(s.refresh)).status).toBe(401);
    const fresh = await signIn('digital@hiva.local');
    expect((await me(fresh.access)).body.roles).toEqual(['UNIT_MEMBER']);
    // The change is in the audit trail with what the roles were and became.
    const row = await prisma.auditEvent.findFirstOrThrow({ where: { entityType: 'user', entityId: id, reason: { startsWith: 'roles changed' } } });
    expect(row.before).toMatchObject({ roles: ['UNIT_MANAGER'] });
    expect(row.after).toMatchObject({ roles: ['UNIT_MEMBER'] });
  });

  it('stops every token of a person who changed their password, this device’s included', async () => {
    const elsewhere = await signIn('legal@hiva.local');
    const here = await signIn('legal@hiva.local');
    const changed = await post('/auth/change-password', here.access, { currentPassword: DEV_PASSWORD, newPassword: 'Another#Pass2026x' });
    expect(changed.status).toBe(204);
    expect((await me(here.access)).status).toBe(401);
    expect((await me(elsewhere.access)).status).toBe(401);
    expect((await signIn('legal@hiva.local', 'Another#Pass2026x')).access).toBeTruthy();
  });

  it('takes a delegation’s borrowed powers back on the delegate’s next request', async () => {
    const ceo = await login('ceo@hiva.local');
    const delegate = await idOf('designer@hiva.local');
    const made = await post('/delegations', ceo, {
      toUserId: delegate, permissions: ['admin.users'], startsAt: new Date(Date.now() - 1000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(), reason: 'مرخصی',
    });
    expect(made.status).toBe(201);
    const s = await signIn('designer@hiva.local');
    expect((await get('/users', s.access)).status).toBe(200);
    expect((await post(`/delegations/${made.body.id}/revoke`, ceo)).status).toBe(200);
    expect((await get('/users', s.access)).status).toBe(401);
  });

  it('signs out one device, and “every other device” spares this one even after another tab rotated it', async () => {
    const phone = await signIn('finance@hiva.local');
    const laptop = await signIn('finance@hiva.local');
    const rotated = await refresh(laptop.refresh); // another tab on the laptop
    const profile = await get('/me/profile', laptop.access);
    const phoneRow = profile.body.sessions.find((x: { current: boolean }) => !x.current);
    // The laptop's sign-in is marked as this device, though its token names the row rotated away.
    expect(profile.body.sessions.filter((x: { current: boolean }) => x.current)).toHaveLength(1);
    expect((await call('DELETE', `/me/sessions/${phoneRow.id}`, { token: laptop.access })).status).toBe(200);
    expect((await me(phone.access)).status).toBe(401);

    const tablet = await signIn('finance@hiva.local');
    expect((await post('/me/sessions/revoke-others', laptop.access)).body.revoked).toBe(1);
    expect((await me(tablet.access)).status).toBe(401);
    expect((await me(laptop.access)).status).toBe(200);
    expect((await me(rotated.body.accessToken)).status).toBe(200);
  });

  it('refuses a locked person’s token while the lock lasts', async () => {
    const s = await signIn('strategy@hiva.local');
    const id = await idOf('strategy@hiva.local');
    await prisma.user.update({ where: { id }, data: { lockedUntil: new Date(Date.now() + 60_000) } });
    const { forgetStanding } = await import('../src/auth/standing.js');
    forgetStanding(id);
    expect((await me(s.access)).status).toBe(401);
    await prisma.user.update({ where: { id }, data: { lockedUntil: null } });
    forgetStanding(id);
    expect((await me(s.access)).status).toBe(200);
  });

  it('refuses a token naming no session, or a session that is not its holder’s', async () => {
    const { claims } = await claimsFor(await idOf('pmo@hiva.local'));
    expect((await me(await signAccessToken(claims))).status).toBe(401);
    const someoneElses = await prisma.session.findFirstOrThrow({ where: { revokedAt: null, user: { email: { not: 'pmo@hiva.local' } } } });
    expect((await me(await signAccessToken({ ...claims, sid: someoneElses.id }))).status).toBe(401);
  });

  it('reads standing at most five seconds old when another process made the change', async () => {
    const s = await signIn('account@hiva.local');
    expect((await me(s.access)).status).toBe(200);
    // Another API process ended it: this one has not been told, and serves its copy until the TTL.
    await prisma.session.updateMany({ where: { user: { email: 'account@hiva.local' }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'SIGNED_OUT' } });
    expect((await me(s.access)).status).toBe(200);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 5_001);
    try {
      expect((await me(s.access)).status).toBe(401);
    } finally { clock.mockRestore(); }
  });
});
