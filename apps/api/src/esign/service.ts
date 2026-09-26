/**
 * Contract e-signature (roadmap #36): send the exact contract PDF to a provider, follow it until
 * every signer has signed or someone declines, keep the signed PDF the provider returns, and sign
 * the contract through the workflow engine — as the person who sent it, so the Doc_H rules still
 * decide whether the contract may move.
 *
 * The provider is always asked again; a callback only says "look". Syncing is serialised on the
 * envelope row, so a callback and the polling job arriving together complete it once.
 */
import { randomBytes, createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { permissionsForRoles, type RoleCode } from '@hiva/contracts';
import type { Tx } from '../db.js';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.js';
import { nextCode } from '../lib/codes.js';
import { audit } from '../lib/audit.js';
import { notify } from '../mail/notify.js';
import { clientMail } from '../mail/client.js';
import { esc } from '../pdf/fmt.js';
import { formatJalali } from '../lib/jalali.js';
import { hashToken } from '../auth/tokens.js';
import { transition } from '../workflow/engine.js';
import { esignMode, httpProvider, type ESignProvider, type SignerState } from './provider.js';
import { SANDBOX_ISSUER, sandboxProvider } from './sandbox.js';

const DAY = 86_400_000;
const storageRoot = () => path.resolve(env.STORAGE_DIR);
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const appUrl = () => (env.PUBLIC_APP_URL || env.CORS_ORIGIN.split(',')[0]!.trim()).replace(/\/+$/, '');

/** The provider an envelope was sent through — never switched under an envelope already out. */
export function providerFor(name: string): ESignProvider {
  if (name === 'sandbox') return sandboxProvider;
  if (!env.ESIGN_URL) throw new AppError(503, 'ESIGN_NOT_CONFIGURED', 'نشانی ارائه‌دهندهٔ امضای الکترونیکی (ESIGN_URL) تنظیم نشده است.');
  return httpProvider({ baseUrl: env.ESIGN_URL, apiKey: env.ESIGN_API_KEY });
}

/** Someone who may sign for the organisation: active, and holding contract.sign in their own right. */
async function signatories(organizationId: string) {
  const users = await prisma.user.findMany({
    where: { organizationId, isActive: true, deletedAt: null },
    select: { id: true, fullName: true, email: true, roles: { select: { role: { select: { code: true } } } } },
    orderBy: { fullName: 'asc' },
  });
  return users.filter((u) => permissionsForRoles(u.roles.map((r) => r.role.code as RoleCode)).includes('contract.sign'))
    .map(({ roles: _r, ...u }) => u);
}

async function event(tx: Tx, envelopeId: string, kind: string, detail?: object) {
  await tx.signatureEvent.create({ data: { envelopeId, kind, detail: detail ?? undefined, at: new Date() } });
}

export interface Actor { id: string; organizationId: string; permissions: string[]; ipAddress?: string | null; requestId?: string | null }

export async function options(actor: Actor, contractId: string) {
  const c = await prisma.contract.findFirst({ where: { id: contractId, organizationId: actor.organizationId } });
  if (!c) throw notFound('قرارداد');
  const [documents, contacts, people, live] = await Promise.all([
    prisma.document.findMany({ where: { contractId, deletedAt: null, mimeType: 'application/pdf' }, orderBy: { createdAt: 'desc' }, select: { id: true, fileName: true, sizeBytes: true, createdAt: true } }),
    prisma.contact.findMany({ where: { companyId: c.companyId, deletedAt: null, email: { not: null } }, select: { id: true, fullName: true, email: true, jobTitle: true }, orderBy: [{ isPrimary: 'desc' }, { fullName: 'asc' }] }),
    signatories(actor.organizationId),
    prisma.signatureEnvelope.findFirst({ where: { contractId, status: 'SENT' }, select: { code: true } }),
  ]);
  return { mode: esignMode(), state: c.state, eligible: c.state === 'PENDING_SIGNATURE' && !live && esignMode() !== 'off', inFlight: live?.code ?? null, documents, contacts, signatories: people, mailOn: clientMail.enabled() };
}

export async function send(actor: Actor, contractId: string, input: { documentId: string; clientContactId: string; agencyUserId: string; expiresInDays: number }) {
  if (!actor.permissions.includes('contract.sign')) throw forbidden('برای فرستادن قرارداد به امضا به دسترسی «contract.sign» نیاز دارید.');
  const mode = esignMode();
  if (mode === 'off') throw new AppError(422, 'ESIGN_OFF', 'امضای الکترونیکی در این نصب خاموش است؛ امضا را دستی ثبت کنید.');
  const c = await prisma.contract.findFirst({ where: { id: contractId, organizationId: actor.organizationId }, include: { company: { select: { legalName: true } } } });
  if (!c) throw notFound('قرارداد');
  if (c.state !== 'PENDING_SIGNATURE') throw new AppError(422, 'ESIGN_WRONG_STATE', 'فقط قراردادِ «در انتظار امضا» را می‌توان برای امضای الکترونیکی فرستاد.');
  const live = await prisma.signatureEnvelope.findFirst({ where: { contractId, status: 'SENT' }, select: { code: true } });
  if (live) throw conflict('ESIGN_IN_FLIGHT', `پاکت ${live.code} هنوز در انتظار امضاست؛ نخست باطلش کنید.`);
  const doc = await prisma.document.findFirst({ where: { id: input.documentId, contractId, deletedAt: null } });
  if (!doc) throw new AppError(422, 'ESIGN_DOCUMENT', 'فایل باید از فایل‌های همین قرارداد باشد.');
  if (doc.mimeType !== 'application/pdf') throw new AppError(422, 'ESIGN_NOT_PDF', 'فقط فایل PDF قرارداد برای امضای الکترونیکی فرستاده می‌شود.');
  const content = await readFile(path.join(storageRoot(), doc.storedName)).catch(() => null);
  if (!content) throw new AppError(422, 'ESIGN_DOCUMENT_MISSING', `فایل «${doc.fileName}» در بایگانی نیست.`);
  const digest = sha256(content);
  if (doc.checksum && doc.checksum !== digest) throw new AppError(422, 'ESIGN_DOCUMENT_ALTERED', `فایل «${doc.fileName}» با اثر انگشت زمان بارگذاری‌اش نمی‌خواند.`);
  const contact = await prisma.contact.findFirst({ where: { id: input.clientContactId, companyId: c.companyId, deletedAt: null } });
  if (!contact?.email) throw new AppError(422, 'ESIGN_CLIENT_SIGNER', 'امضاکنندهٔ مشتری باید از مخاطبان همین مشتری و دارای ایمیل باشد.');
  const agency = (await signatories(actor.organizationId)).find((u) => u.id === input.agencyUserId);
  if (!agency) throw new AppError(422, 'ESIGN_AGENCY_SIGNER', 'امضاکنندهٔ سازمان باید کاربری فعال با دسترسی امضای قرارداد باشد.');

  const expiresAt = new Date(Date.now() + input.expiresInDays * DAY);
  // The client signs first, the organisation countersigns.
  const envelope = await prisma.$transaction(async (tx) => tx.signatureEnvelope.create({
    data: {
      organizationId: actor.organizationId, code: await nextCode(tx, 'signatureEnvelope'), contractId, provider: mode,
      documentId: doc.id, originalSha256: digest, expiresAt, createdById: actor.id,
      signers: { create: [
        { order: 1, party: 'CLIENT', name: contact.fullName, email: contact.email!.toLowerCase(), contactId: contact.id },
        { order: 2, party: 'AGENCY', name: agency.fullName, email: agency.email.toLowerCase(), userId: agency.id },
      ] },
    },
    include: { signers: { orderBy: { order: 'asc' } } },
  }));
  const provider = providerFor(mode);
  let sent: Awaited<ReturnType<ESignProvider['create']>>;
  try {
    sent = await provider.create({
      externalId: envelope.id, title: `${c.title} — ${c.code}`,
      document: { fileName: doc.fileName, content, sha256: digest },
      signers: envelope.signers.map((s) => ({ externalId: s.id, name: s.name, email: s.email, order: s.order })),
      callbackUrl: `${appUrl()}/api/v1/esign/callback`, expiresAt,
    });
  } catch (e) {
    // Never reached a signer: nothing to keep.
    await prisma.signatureEnvelope.delete({ where: { id: envelope.id } });
    throw new AppError(502, 'ESIGN_PROVIDER_FAILED', `ارائه‌دهندهٔ امضا درخواست را نپذیرفت: ${e instanceof Error ? e.message : String(e)}`);
  }
  await prisma.signatureEnvelope.update({ where: { id: envelope.id }, data: { providerRef: sent.id } });
  await event(prisma, envelope.id, 'SENT', { provider: mode, sha256: digest, fileName: doc.fileName });
  await audit({
    organizationId: actor.organizationId, actorId: actor.id, action: 'ESIGN_SENT', entityType: 'contract', entityId: contractId,
    after: { envelope: envelope.code, provider: mode, sha256: digest, signers: envelope.signers.map((s) => s.email) }, ipAddress: actor.ipAddress, requestId: actor.requestId,
  });

  const links = envelope.signers.map((s) => ({ signerId: s.id, name: s.name, email: s.email, url: sent.signers.find((x) => x.externalId === s.id)?.url ?? null }));
  const mailed = clientMail.enabled();
  if (mailed) {
    for (const l of links.filter((x) => x.url)) {
      await clientMail.deliver({
        to: l.email, subject: `امضای قرارداد: ${c.title}`,
        html: `<div dir="rtl"><p>${esc(l.name)} گرامی،</p><p>قرارداد «${esc(c.title)}» (${esc(c.code)}) برای امضای الکترونیکی شما آماده است.</p><p><a href="${esc(l.url!)}">مشاهده و امضا</a> — تا ${esc(formatJalali(expiresAt))}</p>${mode === 'sandbox' ? '<p><b>محیط آزمایشی — امضای حقوقی انجام نمی‌شود.</b></p>' : ''}</div>`,
        text: `قرارداد «${c.title}» برای امضای الکترونیکی شما آماده است: ${l.url}`,
      }).catch(() => undefined);
    }
  }
  const full = await prisma.signatureEnvelope.findUniqueOrThrow({ where: { id: envelope.id }, include: { signers: { orderBy: { order: 'asc' } } } });
  // With mail off, the signing links are handed to the sender once.
  return { envelope: publicEnvelope(full), links: mailed ? null : links };
}

export const publicEnvelope = <T extends { signers?: { tokenHash: string | null }[] }>(e: T) => ({
  ...e, signers: e.signers?.map(({ tokenHash: _t, ...s }) => s),
});

const sameState = (row: { status: string; signedAt: Date | null; declineReason: string | null }, s: SignerState) =>
  row.status === s.status && (row.signedAt?.toISOString() ?? null) === (s.signedAt ? new Date(s.signedAt).toISOString() : null) && row.declineReason === (s.declineReason ?? null);

/** Read the envelope back from its provider and act on what changed. */
export async function sync(envelopeId: string): Promise<{ status: string; applied?: boolean; error?: string | null }> {
  const e = await prisma.signatureEnvelope.findUnique({ where: { id: envelopeId } });
  if (!e) throw notFound('پاکت امضا');
  if (e.status !== 'SENT' || !e.providerRef) return { status: e.status };
  const provider = providerFor(e.provider);
  let st: Awaited<ReturnType<ESignProvider['status']>>;
  try { st = await provider.status(e.providerRef); }
  catch (err) { await event(prisma, e.id, 'SYNC_FAILED', { error: err instanceof Error ? err.message : String(err) }); return { status: e.status, error: 'SYNC_FAILED' }; }

  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM signature_envelopes WHERE id = ${e.id} FOR UPDATE`;
    const now = await tx.signatureEnvelope.findUniqueOrThrow({ where: { id: e.id }, include: { signers: true } });
    if (now.status !== 'SENT') return now.status;
    for (const s of st.signers) {
      const row = now.signers.find((x) => x.id === s.externalId);
      if (!row || sameState(row, s)) continue;
      await tx.signatureSigner.update({
        where: { id: row.id },
        data: { status: s.status, signedAt: s.signedAt ? new Date(s.signedAt) : null, declineReason: s.declineReason ?? null, ip: s.ip ?? row.ip, certificate: (s.certificate ?? row.certificate ?? undefined) as object | undefined },
      });
      if (s.status !== 'PENDING') await event(tx, e.id, s.status, { signer: row.email, certificate: s.certificate ?? null });
    }
    if (st.status === 'DECLINED' || st.status === 'EXPIRED') {
      await tx.signatureEnvelope.update({ where: { id: e.id }, data: { status: st.status } });
      await event(tx, e.id, st.status);
    }
    return st.status;
  });
  if (outcome === 'DECLINED') {
    await notify({ userId: e.createdById, kind: 'ESIGN_DECLINED', severity: 'WARNING', title: `امضای قرارداد رد شد — ${e.code}`, entityType: 'contract', entityId: e.contractId });
  }
  if (outcome !== 'COMPLETED') return { status: outcome };
  return complete(e.id, provider, e.providerRef);
}

/** Keep the signed PDF, close the envelope, and sign the contract through the engine. */
async function complete(envelopeId: string, provider: ESignProvider, providerRef: string) {
  const signed = await provider.signedDocument(providerRef);
  if (signed.subarray(0, 5).toString() !== '%PDF-') {
    await event(prisma, envelopeId, 'SYNC_FAILED', { error: 'signed document is not a PDF' });
    return { status: 'SENT', error: 'SIGNED_NOT_PDF' };
  }
  const storedName = `${randomBytes(16).toString('hex')}.pdf`;
  await writeFile(path.join(storageRoot(), storedName), signed);
  const done = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM signature_envelopes WHERE id = ${envelopeId} FOR UPDATE`;
    const e = await tx.signatureEnvelope.findUniqueOrThrow({ where: { id: envelopeId }, include: { contract: { select: { code: true } } } });
    if (e.status !== 'SENT') return null;
    const doc = await tx.document.create({
      data: {
        organizationId: e.organizationId, fileName: `${e.contract.code}-${e.code}-signed.pdf`, storedName, mimeType: 'application/pdf',
        sizeBytes: signed.length, checksum: sha256(signed), contractId: e.contractId, tags: ['e-signed'], uploadedById: e.createdById,
      },
    });
    const completedAt = new Date();
    const updated = await tx.signatureEnvelope.update({ where: { id: envelopeId }, data: { status: 'COMPLETED', signedDocumentId: doc.id, signedSha256: doc.checksum, completedAt } });
    await event(tx, envelopeId, 'COMPLETED', { signedSha256: doc.checksum });
    return updated;
  });
  if (!done) { await unlink(path.join(storageRoot(), storedName)).catch(() => undefined); return { status: 'COMPLETED' }; }

  const creator = await prisma.user.findUnique({ where: { id: done.createdById }, select: { isActive: true, deletedAt: true, roles: { select: { role: { select: { code: true } } } } } });
  const permissions = creator?.isActive && !creator.deletedAt ? permissionsForRoles(creator.roles.map((r) => r.role.code as RoleCode)) : [];
  let error: string | null = null;
  try {
    await transition({
      entity: 'contract', id: done.contractId, action: 'sign', reason: `امضای الکترونیکی — ${done.code}`,
      payload: { envelopeId: done.id, signedDate: done.completedAt!.toISOString() },
      actor: { id: done.createdById, organizationId: done.organizationId, permissions },
    });
    await event(prisma, done.id, 'APPLIED');
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    await prisma.signatureEnvelope.update({ where: { id: done.id }, data: { transitionError: error.slice(0, 1000) } });
  }
  await notify({
    userId: done.createdById, kind: 'ESIGN_COMPLETED', title: `قرارداد امضا شد — ${done.code}`,
    body: error ? `امضا کامل شد اما بر قرارداد اعمال نشد: ${error}` : null, entityType: 'contract', entityId: done.contractId,
  });
  return { status: 'COMPLETED', applied: !error, error };
}

export async function voidEnvelope(actor: Actor, id: string, reason: string) {
  if (!actor.permissions.includes('contract.sign')) throw forbidden('برای ابطال پاکت امضا به دسترسی «contract.sign» نیاز دارید.');
  const e = await prisma.signatureEnvelope.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!e) throw notFound('پاکت امضا');
  if (e.status !== 'SENT') throw conflict('ESIGN_CLOSED', 'فقط پاکتِ در انتظار امضا باطل می‌شود.');
  if (e.providerRef) await providerFor(e.provider).void(e.providerRef, reason);
  const updated = await prisma.signatureEnvelope.update({ where: { id }, data: { status: 'VOIDED', voidedAt: new Date(), voidReason: reason } });
  await event(prisma, id, 'VOIDED', { reason, by: actor.id });
  await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'ESIGN_VOIDED', entityType: 'contract', entityId: e.contractId, reason, after: { envelope: e.code }, ipAddress: actor.ipAddress, requestId: actor.requestId });
  return updated;
}

/** The job: ask after what is out, and let what has lapsed lapse. */
export async function runESign() {
  const out = await prisma.signatureEnvelope.findMany({ where: { status: 'SENT' }, select: { id: true, provider: true, expiresAt: true, providerRef: true }, take: 200 });
  let synced = 0, expired = 0;
  for (const e of out) {
    const r = await sync(e.id).catch(() => ({ status: 'SENT' }));
    synced++;
    if (r.status === 'SENT' && e.expiresAt <= new Date()) {
      if (e.provider !== 'sandbox' && e.providerRef) await providerFor(e.provider).void(e.providerRef, 'expired').catch(() => undefined);
      await prisma.signatureEnvelope.update({ where: { id: e.id }, data: { status: 'EXPIRED' } });
      await event(prisma, e.id, 'EXPIRED');
      expired++;
    }
  }
  return { synced, expired };
}

/* ── the sandbox's signing page ─────────────────────────────────────────────── */

async function sandboxSigner(token: string) {
  if (esignMode() !== 'sandbox' || !/^[\w-]{20,100}$/.test(token)) throw notFound('پیوند امضا');
  const s = await prisma.signatureSigner.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { envelope: { include: { signers: { orderBy: { order: 'asc' } }, document: { select: { fileName: true, storedName: true } }, contract: { select: { title: true, code: true, organizationId: true } } } } },
  });
  if (!s || s.envelope.provider !== 'sandbox') throw notFound('پیوند امضا');
  return s;
}

export async function sandboxView(token: string) {
  const s = await sandboxSigner(token);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: s.envelope.contract.organizationId }, select: { name: true } });
  const waitingFor = s.envelope.signers.find((x) => x.order < s.order && x.status !== 'SIGNED');
  return {
    sandbox: true, issuer: SANDBOX_ISSUER, organization: org.name, envelope: s.envelope.code, status: s.envelope.status, expiresAt: s.envelope.expiresAt,
    contract: { title: s.envelope.contract.title, code: s.envelope.contract.code },
    document: { fileName: s.envelope.document.fileName, sha256: s.envelope.originalSha256 },
    signer: { name: s.name, email: s.email, party: s.party, status: s.status, signedAt: s.signedAt },
    signers: s.envelope.signers.map((x) => ({ order: x.order, name: x.name, party: x.party, status: x.status, signedAt: x.signedAt })),
    waitingFor: waitingFor?.name ?? null,
  };
}

export async function sandboxDocument(token: string) {
  const s = await sandboxSigner(token);
  const content = await readFile(path.join(storageRoot(), s.envelope.document.storedName));
  if (sha256(content) !== s.envelope.originalSha256) throw conflict('ESIGN_DOCUMENT_CHANGED', 'فایل قرارداد با نسخه‌ای که برای امضا فرستاده شد یکی نیست.');
  return { content, fileName: s.envelope.document.fileName };
}

export async function sandboxAct(token: string, act: { sign: string } | { decline: string }, ip: string | null) {
  const s = await sandboxSigner(token);
  if (s.envelope.status !== 'SENT' || s.envelope.expiresAt <= new Date()) throw conflict('ESIGN_CLOSED', 'این پاکت دیگر امضا نمی‌پذیرد.');
  if (s.status !== 'PENDING') throw conflict('ESIGN_ALREADY', 'تصمیم شما پیش‌تر ثبت شده است.');
  const before = s.envelope.signers.find((x) => x.order < s.order && x.status !== 'SIGNED');
  if (before) throw new AppError(422, 'ESIGN_ORDER', `نخست ${before.name} باید امضا کند.`);
  if ('sign' in act) {
    const certificate = { subject: `${act.sign} <${s.email}>`, serial: randomBytes(8).toString('hex').toUpperCase(), issuer: SANDBOX_ISSUER, sandbox: true };
    await prisma.signatureSigner.update({ where: { id: s.id }, data: { status: 'SIGNED', signedAt: new Date(), ip, certificate } });
    await event(prisma, s.envelopeId, 'SIGNED', { signer: s.email, certificate });
  } else {
    await prisma.signatureSigner.update({ where: { id: s.id }, data: { status: 'DECLINED', declineReason: act.decline, ip } });
    await event(prisma, s.envelopeId, 'DECLINED', { signer: s.email, reason: act.decline });
  }
  // What a provider's callback would do: look again.
  return sync(s.envelopeId);
}
