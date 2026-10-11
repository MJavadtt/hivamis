import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { call, closeApp, get, login, post } from './helpers.js';
import { prisma } from '../src/db.js';

/**
 * Audit SEC-6: the SMS sandbox kept every sign-in code where anyone with `admin.settings` could read
 * it, and sign in as its owner. It is now a development stand-in only, and its outbox shows a code
 * only when it opens no account, or to the person whose account it opens.
 */

const API = path.resolve(__dirname, '..');
const start = (env: Record<string, string>) => {
  try {
    execFileSync(path.join(API, 'node_modules/.bin/tsx'), ['-e', "import('./src/env.js')"], { cwd: API, env: { ...process.env, ...env }, stdio: 'pipe' });
    return { code: 0, out: '' };
  } catch (e) {
    return { code: (e as { status?: number }).status ?? -1, out: String((e as { stderr?: Buffer }).stderr ?? '') };
  }
};

describe('The SMS sandbox (audit SEC-6)', () => {
  afterAll(async () => { await closeApp(); });

  it('is refused at start in production and with several organisations, and is not their default', () => {
    for (const env of [{ NODE_ENV: 'production' }, { TENANT_MODE: 'multi' }] as Record<string, string>[]) {
      const refused = start({ ...env, SMS_MODE: 'sandbox' });
      expect(refused.code).toBe(1);
      expect(refused.out).toContain('SMS_MODE=sandbox');
    }
    // Unset, they start with SMS off rather than in the sandbox.
    const { SMS_MODE: _unset, ...rest } = process.env;
    const out = execFileSync(path.join(API, 'node_modules/.bin/tsx'), ['-e', "import('./src/env.js').then((m) => console.log(m.smsMode))"], {
      cwd: API, env: { ...rest, TENANT_MODE: 'multi' }, stdio: 'pipe',
    }).toString().trim();
    expect(out).toBe('off');
  });

  it('shows the administrator a code to join, and their own — but never someone else’s sign-in code', async () => {
    const admin = await login('admin@hiva.local');
    const ceo = await prisma.user.findUniqueOrThrow({ where: { email: 'ceo@hiva.local' } });
    await prisma.user.update({ where: { id: ceo.id }, data: { phone: '09130000777', phoneVerifiedAt: new Date() } });

    // Someone signing in as the CEO by mobile: the code goes to the CEO's phone, and the outbox.
    expect((await call('POST', '/auth/phone/start', { payload: { phone: '09130000777' } })).status).toBe(202);
    // Someone asking to join: no account behind the code.
    expect((await call('POST', '/auth/signup/phone/start', { payload: { phone: '09130000888' } })).status).toBe(202);
    // The administrator proving their own mobile.
    expect((await post('/me/phone/start', admin, { phone: '09130000999' })).status).toBe(202);
    await new Promise((r) => setTimeout(r, 200)); // the sign-in code is sent in the background

    const outbox = (await get('/admin/sms-outbox', admin)).body as { mode: string; messages: { phone: string; text: string; purpose: string }[] };
    expect(outbox.mode).toBe('sandbox');
    const of = (phone: string) => outbox.messages.find((m) => m.phone === phone)!;
    expect(of('09130000777')).toMatchObject({ purpose: 'LOGIN' });
    expect(of('09130000777').text).not.toMatch(/\d{6}/);
    expect(of('09130000777').text).toContain('••••••');
    expect(of('09130000888').text).toMatch(/\d{6}/);
    expect(of('09130000999').text).toMatch(/\d{6}/);
    expect(outbox.messages.every((m) => !('userId' in m))).toBe(true);
  });

  it('masks what came before purposes were recorded', async () => {
    await prisma.smsMessage.create({ data: { phone: '09130000666', text: 'کد ورود شما به هیوامیس: 123456', provider: 'sandbox', status: 'SANDBOX' } });
    const outbox = (await get('/admin/sms-outbox', await login('admin@hiva.local'))).body as { messages: { phone: string; text: string }[] };
    expect(outbox.messages.find((m) => m.phone === '09130000666')!.text).toBe('کد ورود شما به هیوامیس: ••••••');
  });
});
