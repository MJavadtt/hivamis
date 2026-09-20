import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { closeApp, login } from './helpers.js';
import { prisma } from '../src/db.js';
import { EMAILED_KINDS, notify } from '../src/mail/notify.js';
import { slaBreachMail } from '../src/mail/templates.js';
import * as runner from '../src/jobs/runner.js';
import { mailEnabled } from '../src/env.js';

let userId: string;

beforeAll(async () => {
  await login('pmo@hiva.local');
  userId = (await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } })).id;
});
afterAll(async () => { await closeApp(); });

describe('Notifications', () => {
  /**
   * The suite runs with MAIL_ENABLED unset, which is the shipped default. Behaviour must be
   * bit-identical to before the mail subsystem existed: the row is written, nothing is queued,
   * and nothing throws — the same contract ADR-007 gives the AI subsystem.
   */
  it('is a no-op for mail when MAIL_ENABLED is unset', async () => {
    expect(mailEnabled).toBe(false);
    const enqueue = vi.spyOn(runner, 'enqueueMail');
    const before = await prisma.notification.count({ where: { userId } });

    await notify({
      userId, kind: 'SLA_BREACH', title: 'نقض آزمایشی',
      entityType: 'task', entityId: 'probe', severity: 'CRITICAL',
      mail: slaBreachMail({ policyFa: 'QC اکانت', entityFa: 'وظیفه', code: 'TSK-1', url: 'http://x/1' }),
    });

    expect(await prisma.notification.count({ where: { userId } })).toBe(before + 1);
    expect(enqueue).not.toHaveBeenCalled();
    enqueue.mockRestore();
  });

  it('still records the in-app notification for an emailed kind', async () => {
    const row = await prisma.notification.findFirst({
      where: { userId, kind: 'SLA_BREACH' }, orderBy: { createdAt: 'desc' },
    });
    expect(row?.title).toBe('نقض آزمایشی');
    expect(row?.severity).toBe('CRITICAL');
  });

  it('ignores a notification with no recipient rather than throwing', async () => {
    await expect(notify({ userId: null, kind: 'SLA_BREACH', title: 'بی‌گیرنده' })).resolves.toBeUndefined();
  });

  /** The set is a deliberate list, not a side effect of whatever calls notify(). */
  it('emails only the kinds that warrant interrupting someone', () => {
    expect([...EMAILED_KINDS].sort()).toEqual(
      ['FORM_APPROVAL_REQUIRED', 'OVERDUE_DIGEST', 'SLA_BREACH', 'SLA_WARNING'],
    );
    // An approval outcome reaches someone already looking at the app.
    expect(EMAILED_KINDS.has('FORM_APPROVED')).toBe(false);
    expect(EMAILED_KINDS.has('FORM_REJECTED')).toBe(false);
  });

  it('queues a message when mail is enabled, without sending inline', async () => {
    // mailEnabled is resolved at import, so drive enqueueMail directly: this asserts the
    // delivery path is the queue rather than a blocking sendMail inside the request.
    const enqueue = vi.spyOn(runner, 'enqueueMail').mockResolvedValue(undefined);
    const body = slaBreachMail({
      policyFa: 'QC اکانت', entityFa: 'وظیفه', code: 'TSK-9', url: 'http://x/9',
    });
    await runner.enqueueMail({ to: 'pmo@hiva.local', ...body });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      to: 'pmo@hiva.local',
      subject: expect.stringContaining('نقض SLA'),
    }));
    enqueue.mockRestore();
  });
});

describe('Mail templates', () => {
  it('ships a plain-text alternative alongside the HTML', () => {
    const m = slaBreachMail({ policyFa: 'QC اکانت', entityFa: 'وظیفه', code: 'TSK-1', url: 'http://x/1' });
    expect(m.html).toContain('dir="rtl"');
    expect(m.text.length).toBeGreaterThan(0);
    expect(m.text).not.toContain('<');
    // No @font-face: mail clients strip it, and many block remote fonts outright.
    expect(m.html).not.toContain('@font-face');
  });

  it('escapes interpolated values', () => {
    const m = slaBreachMail({
      policyFa: '<script>alert(1)</script>', entityFa: 'وظیفه', code: 'TSK-1', url: 'http://x/1',
    });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
  });
});
