/**
 * The e-signature stand-in (roadmap #36, ESIGN_MODE=sandbox). It walks the whole lifecycle —
 * links, signing in order, declining, completion, a signed PDF returned — for training and for
 * testing, and says on every surface that it is not a signature: its "certificate" names a sandbox
 * issuer, and the PDF it returns ends with a page stating that no legal signature was made.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { hashToken } from '../auth/tokens.js';
import { renderPdf } from '../pdf/renderer.js';
import { dateTime, esc, table } from '../pdf/fmt.js';
import { docHeader, ruleNote, section } from '../pdf/sections.js';
import type { ESignProvider } from './provider.js';

export const SANDBOX_ISSUER = 'Hiva Sandbox CA — آزمایشی، بدون اعتبار حقوقی';

const appUrl = () => (env.PUBLIC_APP_URL || env.CORS_ORIGIN.split(',')[0]!.trim()).replace(/\/+$/, '');
export const sandboxLink = (token: string) => `${appUrl()}/esign-sandbox/${token}`;

export const sandboxProvider: ESignProvider = {
  name: 'sandbox',
  async create(req) {
    const signers = [];
    for (const s of req.signers) {
      const token = randomBytes(32).toString('base64url');
      await prisma.signatureSigner.update({ where: { id: s.externalId }, data: { tokenHash: hashToken(token) } });
      signers.push({ externalId: s.externalId, url: sandboxLink(token) });
    }
    return { id: req.externalId, signers };
  },
  async status(id) {
    const e = await prisma.signatureEnvelope.findUniqueOrThrow({ where: { id }, include: { signers: { orderBy: { order: 'asc' } } } });
    const signers = e.signers.map((s) => ({
      externalId: s.id, status: s.status as 'PENDING' | 'SIGNED' | 'DECLINED', signedAt: s.signedAt?.toISOString() ?? null,
      declineReason: s.declineReason, ip: s.ip, certificate: s.certificate as never,
    }));
    const status = signers.some((s) => s.status === 'DECLINED') ? 'DECLINED'
      : signers.every((s) => s.status === 'SIGNED') ? 'COMPLETED'
      : e.expiresAt <= new Date() ? 'EXPIRED' : 'SENT';
    return { status, signers };
  },
  async signedDocument(id) {
    const e = await prisma.signatureEnvelope.findUniqueOrThrow({
      where: { id },
      include: { document: true, signers: { orderBy: { order: 'asc' } }, contract: { select: { code: true, title: true } } },
    });
    const original = await readFile(path.join(path.resolve(env.STORAGE_DIR), e.document.storedName));
    const page = await renderPdf([
      docHeader({ title: 'صفحهٔ امضای آزمایشی', code: e.code, subtitle: `${e.contract.title} — ${e.contract.code}` }),
      ruleNote('این سند در محیط آزمایشی امضای الکترونیکی «امضا» شده است. هیچ امضای الکترونیکی با گواهی معتبر روی آن انجام نشده و اعتبار حقوقی ندارد.'),
      section('امضاکنندگان', table(['ترتیب', 'نام', 'ایمیل', 'زمان', 'صادرکنندهٔ گواهی'], e.signers.map((s) => [
        String(s.order), esc(s.name), `<span dir="ltr">${esc(s.email)}</span>`, dateTime(s.signedAt), esc(SANDBOX_ISSUER),
      ]))),
      section('سند اصلی', `<p>SHA-256 فایلی که برای امضا فرستاده شد: <span dir="ltr" style="font-family:monospace">${e.originalSha256}</span></p>`),
    ].join(''), { headerRight: e.code, footerNote: 'محیط آزمایشی — بدون اعتبار حقوقی' });
    const out = await PDFDocument.load(original);
    const extra = await PDFDocument.load(page);
    for (const p of await out.copyPages(extra, extra.getPageIndices())) out.addPage(p);
    return Buffer.from(await out.save());
  },
  async void() { /* nothing outside to tell */ },
};
