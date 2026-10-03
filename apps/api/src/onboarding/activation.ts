/**
 * First passwords for people brought in by the onboarding import (roadmap #48).
 *
 * A migration file never carries a password. Each person gets a one-time link instead: by email
 * when mail is on, otherwise shown once to the administrator to pass on (as a portal invitation
 * is, #34). The link is good for seven days and for one use; a new one cancels the old. Only the
 * SHA-256 of the token is kept, so the table cannot be read back into working links.
 */
import { createHash, randomBytes } from 'node:crypto';
import { prisma, type Tx } from '../db.js';
import { mailEnabled } from '../env.js';
import { audit } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';
import { hashPassword } from '../auth/password.js';
import { appUrl } from '../mail/notify.js';
import { enqueueMail, type MailJob } from '../jobs/runner.js';

export const ACTIVATION_DAYS = 7;
/** What an imported account's password hash starts as: it can never verify. */
export const PENDING_PREFIX = '!activation-pending:';

export interface Activation { url: string; expiresAt: Date; emailed: boolean; mail: MailJob | null }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createActivation(tx: Tx, userId: string, createdById: string): Promise<Activation> {
  const now = new Date();
  await tx.accountActivation.updateMany({ where: { userId, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + ACTIVATION_DAYS * 86_400_000);
  await tx.accountActivation.create({ data: { userId, tokenHash: sha(token), expiresAt, createdById } });
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, fullName: true, organization: { select: { name: true } } } });
  const url = appUrl(`/activate/${token}`);
  const days = new Intl.NumberFormat('fa-IR').format(ACTIVATION_DAYS);
  const mail: MailJob | null = mailEnabled ? {
    to: user.email,
    subject: `دعوت به هیوامیس — ${user.organization.name}`,
    text: `${user.fullName} عزیز،\n\nحساب شما در هیوامیس ${user.organization.name} ساخته شد. برای گذاشتن رمز عبور و ورود، این پیوند را باز کنید:\n${url}\n\nپیوند تا ${days} روز و فقط یک بار کار می‌کند.`,
    html: `<div dir="rtl" style="font-family:Tahoma,sans-serif"><p>${user.fullName} عزیز،</p><p>حساب شما در هیوامیس ${user.organization.name} ساخته شد. برای گذاشتن رمز عبور و ورود:</p><p><a href="${url}">گذاشتن رمز عبور</a></p><p style="color:#666">پیوند تا ${days} روز و فقط یک بار کار می‌کند.</p></div>`,
  } : null;
  return { url, expiresAt, emailed: !!mail, mail };
}

/** Sent after the row's transaction has committed — never an invitation to an account that was rolled back. */
export async function sendActivation(a: Activation): Promise<void> {
  if (a.mail) await enqueueMail(a.mail).catch(() => undefined);
}

async function usable(token: string) {
  const row = await prisma.accountActivation.findUnique({ where: { tokenHash: sha(token) } });
  if (!row || row.revokedAt) throw new AppError(404, 'ACTIVATION_INVALID', 'این پیوند معتبر نیست؛ از مدیر سیستم پیوند تازه بخواهید.');
  if (row.usedAt) throw new AppError(410, 'ACTIVATION_USED', 'با این پیوند پیش‌تر رمز گذاشته شده است؛ از صفحهٔ ورود وارد شوید.');
  if (row.expiresAt <= new Date()) throw new AppError(410, 'ACTIVATION_EXPIRED', 'مهلت این پیوند گذشته است؛ از مدیر سیستم پیوند تازه بخواهید.');
  const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { id: true, email: true, fullName: true, isActive: true, deletedAt: true, organizationId: true } });
  if (!user?.isActive || user.deletedAt) throw new AppError(404, 'ACTIVATION_INVALID', 'این حساب فعال نیست.');
  return { row, user };
}

export async function describeActivation(token: string) {
  const { row, user } = await usable(token);
  return { fullName: user.fullName, email: user.email, expiresAt: row.expiresAt };
}

export async function activate(token: string, password: string, meta: { ipAddress?: string | null }) {
  const { row, user } = await usable(token);
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (tx) => {
    // Spent once, even if two tabs submit at the same moment.
    const spent = await tx.accountActivation.updateMany({ where: { id: row.id, usedAt: null, revokedAt: null }, data: { usedAt: new Date() } });
    if (spent.count !== 1) throw new AppError(410, 'ACTIVATION_USED', 'با این پیوند پیش‌تر رمز گذاشته شده است.');
    await tx.accountActivation.updateMany({ where: { userId: user.id, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null } });
    await audit({ organizationId: user.organizationId, actorId: user.id, action: 'ACCOUNT_ACTIVATED', entityType: 'user', entityId: user.id, ipAddress: meta.ipAddress }, tx);
  });
  return { email: user.email };
}
