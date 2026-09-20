import nodemailer, { type Transporter } from 'nodemailer';
import { env, mailEnabled } from '../env.js';

/**
 * Lazy singleton, mirroring the Anthropic client in ai/service.ts: built on first use so a
 * deployment with mail disabled never opens a connection, and so a misconfigured SMTP host
 * fails at send time rather than at boot.
 */
let transporter: Transporter | null = null;

export function getTransport(): Transporter | null {
  if (!mailEnabled) return null;
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    // A slow relay must not hold a worker: the job retries rather than blocking.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transporter;
}

export async function closeTransport(): Promise<void> {
  transporter?.close();
  transporter = null;
}
