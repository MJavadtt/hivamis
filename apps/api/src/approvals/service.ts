/**
 * A client's approval, kept so it can be proved (roadmap #35).
 *
 * Staff ask a named contact of the client to approve a delivered deliverable or a presented
 * proposal. What the client will be shown is frozen then — the subject, its client-facing content,
 * each file and its SHA-256 — and a link with a secret goes to the contact's address (or, with mail
 * off, to the staff member to pass on). On the page the client downloads the files, and, when mail
 * is on, receives a one-time code at that same address before deciding. The decision is sealed —
 * who, when, from which address and browser, how they were verified, what they did first — into
 * the organisation's hash chain; then it is applied to the subject through the workflow engine,
 * as the staff member who asked, so the Doc_H rules still decide whether it may move.
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { Tx } from '../db.js';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { clientMail } from '../mail/client.js';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.js';
import { nextCode, nextNumber } from '../lib/codes.js';
import { audit } from '../lib/audit.js';
import { notify } from '../mail/notify.js';
import { transition } from '../workflow/engine.js';
import { esc } from '../pdf/fmt.js';
import { formatJalali } from '../lib/jalali.js';
import {
  checkEvidence, GENESIS, hashOf, hashStoredFile, sha256,
  type Evidence, type EvidenceEvent, type Manifest, type ManifestFile, type Problem,
} from './evidence.js';
import { permissionsFor } from '../auth/grants.js';

/** Where mail to the client goes, and whether it is on — shared with the portal (#34). */
export const approvalMail = clientMail;

const DAY = 86_400_000;
const CODE_TTL_MS = 10 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
const MAX_CODES = 5;

type SubjectType = 'DELIVERABLE' | 'PROPOSAL';
const SUBJECT = {
  DELIVERABLE: { entity: 'deliverable', state: 'DELIVERED', write: 'deliverable.deliver', read: 'deliverable.read', approve: 'client_accept', changes: 'client_reject', fa: 'خروجی' },
  PROPOSAL: { entity: 'proposal', state: 'PRESENTED_TO_CLIENT', write: 'proposal.record_feedback', read: 'proposal.read', approve: 'client_approve', changes: 'client_request_revision', fa: 'پروپوزال' },
} as const;
export const subjectPermission = (type: string, kind: 'read' | 'write') => SUBJECT[type as SubjectType]?.[kind];

export interface ClientContext { ip: string | null; userAgent: string | null }

const appUrl = () => (env.PUBLIC_APP_URL || env.CORS_ORIGIN.split(',')[0]!.trim()).replace(/\/+$/, '');
export const linkFor = (token: string) => `${appUrl()}/approve/${token}`;
const maskEmail = (e: string) => e.replace(/^(.{2}).*(@.*)$/, (_m, a: string, b: string) => `${a}…${b}`);
const DECISION_FA = { APPROVE: 'تأیید', REQUEST_CHANGES: 'درخواست اصلاح' } as const;

/* ── the request ────────────────────────────────────────────────────────────── */

interface LoadedSubject {
  state: string; companyId: string; documents: { id: string; fileName: string; storedName: string; mimeType: string; sizeBytes: number; checksum: string | null }[];
  subject: Manifest['subject']; content: Record<string, string | null>;
}

async function loadSubject(tx: Tx, organizationId: string, type: SubjectType, id: string): Promise<LoadedSubject> {
  if (type === 'DELIVERABLE') {
    const d = await tx.deliverable.findFirst({
      where: { id, organizationId },
      include: { project: { select: { code: true, name: true, companyId: true } }, documents: { where: { deletedAt: null, supersededAt: null } } },
    });
    if (!d) throw notFound('خروجی');
    return {
      state: d.state, companyId: d.project.companyId, documents: d.documents,
      subject: { type, id: d.id, code: d.code, title: d.name, version: d.version, context: `${d.project.code} — ${d.project.name}` },
      content: { description: d.description ?? null, format: d.format ?? null },
    };
  }
  const p = await tx.proposal.findFirst({
    where: { id, organizationId, deletedAt: null },
    include: { brief: { select: { title: true, opportunity: { select: { companyId: true } } } }, documents: { where: { deletedAt: null, supersededAt: null } } },
  });
  if (!p) throw notFound('پروپوزال');
  return {
    state: p.state, companyId: p.brief.opportunity.companyId, documents: p.documents,
    subject: { type, id: p.id, code: p.code, title: p.title, version: `v${p.version}`, context: p.brief.title },
    // The offer as the client reads it: what, how, when and for how much — never cost or margin.
    content: {
      executiveSummary: p.executiveSummary ?? null, approach: p.approach ?? null, deliverablesSummary: p.deliverablesSummary ?? null,
      timelineSummary: p.timelineSummary ?? null, salePrice: p.salePrice ? p.salePrice.toFixed(0) : null, paymentTerms: p.paymentTerms ?? null,
    },
  };
}

export interface RequestActor { id: string; organizationId: string; permissions: string[]; ipAddress?: string | null; userAgent?: string | null }

export async function createRequest(tx: Tx, actor: RequestActor, storageRoot: string, input: {
  subjectType: SubjectType; subjectId: string; contactId: string; documentIds?: string[]; message?: string; expiresInDays: number;
}) {
  const kind = SUBJECT[input.subjectType];
  if (!actor.permissions.includes(kind.write)) throw forbidden(`برای درخواست تأیید مشتری به دسترسی «${kind.write}» نیاز دارید.`);
  const s = await loadSubject(tx, actor.organizationId, input.subjectType, input.subjectId);
  if (s.state !== kind.state) {
    throw new AppError(422, 'CLIENT_APPROVAL_WRONG_STATE', input.subjectType === 'DELIVERABLE'
      ? 'فقط خروجیِ تحویل‌شده به مشتری را می‌توان برای تأیید فرستاد.'
      : 'فقط پروپوزالِ ارائه‌شده به مشتری را می‌توان برای تأیید فرستاد.');
  }
  const contact = await tx.contact.findFirst({ where: { id: input.contactId, companyId: s.companyId, deletedAt: null } });
  if (!contact) throw new AppError(422, 'CLIENT_APPROVAL_CONTACT', 'این شخص از مخاطبان همین مشتری نیست.');
  if (!contact.email) throw new AppError(422, 'CLIENT_APPROVAL_CONTACT_EMAIL', `برای «${contact.fullName}» ایمیلی ثبت نشده است؛ پیوند و کد تأیید به ایمیل فرستاده می‌شود.`);
  const pending = await tx.clientApproval.findFirst({ where: { subjectType: input.subjectType, subjectId: input.subjectId, status: 'PENDING', expiresAt: { gt: new Date() } }, select: { code: true } });
  if (pending) throw conflict('CLIENT_APPROVAL_PENDING', `درخواست ${pending.code} هنوز در انتظار مشتری است؛ نخست آن را لغو کنید.`);

  const chosen = input.documentIds ?? s.documents.map((d) => d.id);
  const docs = chosen.map((id) => s.documents.find((d) => d.id === id));
  if (docs.some((d) => !d)) throw new AppError(422, 'CLIENT_APPROVAL_FILES', `فایل‌های انتخاب‌شده باید از فایل‌های همین ${kind.fa} باشند.`);
  if (input.subjectType === 'DELIVERABLE' && !docs.length) throw new AppError(422, 'CLIENT_APPROVAL_NO_FILES', 'خروجی بدون فایل را نمی‌توان برای تأیید فرستاد؛ نخست فایل آن را بارگذاری کنید.');
  const files: ManifestFile[] = [];
  for (const d of docs as NonNullable<(typeof docs)[number]>[]) {
    const now = await hashStoredFile(storageRoot, d.storedName);
    if (!now) throw new AppError(422, 'CLIENT_APPROVAL_FILE_MISSING', `فایل «${d.fileName}» در بایگانی پیدا نشد.`);
    if (d.checksum && d.checksum !== now) throw new AppError(422, 'CLIENT_APPROVAL_FILE_ALTERED', `فایل «${d.fileName}» با اثر انگشت زمان بارگذاری‌اش نمی‌خواند؛ پیش از فرستادن بررسی شود.`);
    files.push({ documentId: d.id, fileName: d.fileName, mimeType: d.mimeType, sizeBytes: d.sizeBytes, sha256: now });
  }

  const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { name: true } });
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.expiresInDays * DAY);
  const manifest: Manifest = {
    v: 1, organization: org.name, subject: s.subject, content: s.content, files,
    contact: { name: contact.fullName, email: contact.email }, message: input.message ?? null,
    requestedAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
  };
  const token = randomBytes(32).toString('base64url');
  const channel = approvalMail.enabled() ? 'EMAIL' : 'MANUAL';
  const approval = await tx.clientApproval.create({
    data: {
      organizationId: actor.organizationId, code: await nextCode(tx, 'clientApproval'),
      subjectType: input.subjectType, subjectId: input.subjectId, subjectState: kind.state, companyId: s.companyId,
      contactId: contact.id, contactName: contact.fullName, contactEmail: contact.email, message: input.message ?? null,
      manifest: manifest as object, manifestHash: hashOf(manifest), tokenHash: sha256(token), channel, expiresAt,
      requestedById: actor.id, createdAt: now,
      events: { create: [
        { kind: 'CREATED', ip: actor.ipAddress ?? null, userAgent: actor.userAgent ?? null, at: now },
        { kind: 'SENT', ip: actor.ipAddress ?? null, userAgent: actor.userAgent ?? null, at: now },
      ] },
    },
  });
  return { approval, token, manifest };
}

/** What the request form offers: whether the subject may be sent now, to whom, and which files. */
export async function optionsFor(actor: RequestActor, type: SubjectType, id: string) {
  const kind = SUBJECT[type];
  if (!actor.permissions.includes(kind.write)) throw forbidden(`برای درخواست تأیید مشتری به دسترسی «${kind.write}» نیاز دارید.`);
  const s = await loadSubject(prisma, actor.organizationId, type, id);
  const contacts = await prisma.contact.findMany({
    where: { companyId: s.companyId, deletedAt: null }, select: { id: true, fullName: true, email: true, jobTitle: true, isPrimary: true },
    orderBy: [{ isPrimary: 'desc' }, { fullName: 'asc' }],
  });
  return {
    eligible: s.state === kind.state, state: s.state, requiredState: kind.state, mailOn: approvalMail.enabled(),
    contacts, documents: s.documents.map((d) => ({ id: d.id, fileName: d.fileName, mimeType: d.mimeType, sizeBytes: d.sizeBytes })),
  };
}

/** The request email — sent after the request is committed. */
export async function mailRequest(approval: { code: string; contactEmail: string; contactName: string; expiresAt: Date }, manifest: Manifest, token: string) {
  const files = manifest.files.map((f) => `<li>${esc(f.fileName)} — <code dir="ltr">${f.sha256.slice(0, 16)}…</code></li>`).join('');
  const subject = `درخواست تأیید ${manifest.subject.type === 'DELIVERABLE' ? 'خروجی' : 'پروپوزال'}: ${manifest.subject.title}`;
  const html = `<div dir="rtl"><p>${esc(approval.contactName)} گرامی،</p>
<p>${esc(manifest.organization)} از شما خواسته است «${esc(manifest.subject.title)}» (${esc(manifest.subject.code)}، نسخهٔ ${esc(manifest.subject.version)}) را بررسی و تأیید کنید.</p>
${manifest.message ? `<p>${esc(manifest.message)}</p>` : ''}
${files ? `<p>فایل‌ها و اثر انگشت هرکدام:</p><ul>${files}</ul>` : ''}
<p><a href="${esc(linkFor(token))}">مشاهده و تأیید</a> — این پیوند تا ${esc(formatJalali(approval.expiresAt))} معتبر است و فقط برای شماست.</p>
<p>شناسهٔ درخواست: ${esc(approval.code)}</p></div>`;
  const text = `${approval.contactName} گرامی،\n${manifest.organization} از شما خواسته است «${manifest.subject.title}» را بررسی و تأیید کنید.\n${linkFor(token)}\nشناسهٔ درخواست: ${approval.code}`;
  await approvalMail.deliver({ to: approval.contactEmail, subject, html, text });
}

/* ── the client's side ──────────────────────────────────────────────────────── */

async function event(tx: Tx, approvalId: string, kind: string, ctx: ClientContext, documentId: string | null = null, at = new Date()) {
  await tx.clientApprovalEvent.create({ data: { approvalId, kind, documentId, ip: ctx.ip, userAgent: ctx.userAgent, at } });
}

/**
 * The request a link names, brought up to date: a pending request past its date expires, and one
 * whose subject has moved on (delivered again, or withdrawn) can no longer be decided.
 */
export async function byToken(token: string, ctx: ClientContext) {
  if (!/^[\w-]{20,100}$/.test(token)) throw notFound('درخواست تأیید');
  const a = await prisma.clientApproval.findUnique({ where: { tokenHash: sha256(token) } });
  if (!a) throw notFound('درخواست تأیید');
  return current(a, ctx);
}

/** The same, for a request reached from a portal session (#34). */
export async function byIdForCompany(id: string, companyId: string, ctx: ClientContext) {
  const a = await prisma.clientApproval.findFirst({ where: { id, companyId } });
  if (!a) throw notFound('درخواست تأیید');
  return current(a, ctx);
}

type ApprovalRow = NonNullable<Awaited<ReturnType<typeof prisma.clientApproval.findUnique>>>;

async function current(row: ApprovalRow, ctx: ClientContext) {
  let a = row;
  if (a.status === 'PENDING') {
    if (a.expiresAt <= new Date()) {
      a = await prisma.clientApproval.update({ where: { id: a.id }, data: { status: 'EXPIRED' } });
      await event(prisma, a.id, 'EXPIRED', ctx);
    } else {
      const s = await loadSubject(prisma, a.organizationId, a.subjectType as SubjectType, a.subjectId).catch(() => null);
      if (!s || s.state !== a.subjectState) {
        a = await prisma.clientApproval.update({ where: { id: a.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'وضعیت موضوع درخواست پس از فرستادن آن تغییر کرد.' } });
        await event(prisma, a.id, 'CANCELLED', ctx);
      }
    }
  }
  return a;
}

type Approval = Awaited<ReturnType<typeof current>>;

export async function publicView(a: Approval, ctx: ClientContext, record = true) {
  if (record) await event(prisma, a.id, 'OPENED', ctx);
  const viewed = new Set((await prisma.clientApprovalEvent.findMany({ where: { approvalId: a.id, kind: 'FILE_VIEWED' }, select: { documentId: true } })).map((e) => e.documentId));
  const m = a.manifest as unknown as Manifest;
  return {
    code: a.code, status: a.status, organization: m.organization, subject: m.subject, content: m.content, message: m.message,
    contactName: a.contactName, contactEmail: maskEmail(a.contactEmail), expiresAt: a.expiresAt, manifestHash: a.manifestHash,
    files: m.files.map((f) => ({ id: f.documentId, fileName: f.fileName, mimeType: f.mimeType, sizeBytes: f.sizeBytes, sha256: f.sha256, viewed: viewed.has(f.documentId) })),
    verification: approvalMail.enabled() ? 'EMAIL_CODE' : 'LINK',
    decision: a.decision, decidedAt: a.decidedAt, signerName: a.signerName, evidenceHash: a.evidenceHash,
  };
}

/** A file exactly as frozen — checked against its hash each time it is served. */
export async function fileFor(a: Approval, documentId: string, ctx: ClientContext, storageRoot: string) {
  const open = a.status === 'PENDING' || (['APPROVED', 'CHANGES_REQUESTED'].includes(a.status) && a.expiresAt > new Date());
  if (!open) throw new AppError(410, 'CLIENT_APPROVAL_CLOSED', 'این پیوند دیگر فایلی نشان نمی‌دهد.');
  const f = (a.manifest as unknown as Manifest).files.find((x) => x.documentId === documentId);
  if (!f) throw notFound('فایل');
  const doc = await prisma.document.findUnique({ where: { id: documentId }, select: { storedName: true } });
  const now = doc ? await hashStoredFile(storageRoot, doc.storedName) : null;
  if (!doc || now !== f.sha256) {
    await event(prisma, a.id, 'FILE_MISMATCH', ctx, documentId);
    throw conflict('CLIENT_APPROVAL_FILE_CHANGED', `فایل «${f.fileName}» دیگر همان نسخه‌ای نیست که برای تأیید فرستاده شد؛ با ${(a.manifest as unknown as Manifest).organization} تماس بگیرید.`);
  }
  await event(prisma, a.id, 'FILE_VIEWED', ctx, documentId);
  return { storedName: doc.storedName, fileName: f.fileName };
}

const assertPending = (a: Approval) => {
  if (a.status !== 'PENDING') throw conflict('CLIENT_APPROVAL_CLOSED', a.status === 'EXPIRED' ? 'مهلت این درخواست گذشته است.' : a.status === 'CANCELLED' ? 'این درخواست لغو شده است.' : 'تصمیم این درخواست پیش‌تر ثبت شده است.');
};

/** A one-time code to the contact's own address — whoever holds the link must also hold the mailbox. */
export async function sendCode(a: Approval, ctx: ClientContext) {
  assertPending(a);
  if (!approvalMail.enabled()) throw new AppError(422, 'CLIENT_APPROVAL_NO_CODE', 'ارسال کد در این سامانه فعال نیست؛ تصمیم با همین پیوند ثبت می‌شود.');
  if (a.codesSent >= MAX_CODES) throw new AppError(429, 'CLIENT_APPROVAL_CODE_LIMIT', 'بیش از این کد فرستاده نمی‌شود؛ با فرستندهٔ درخواست تماس بگیرید.');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await prisma.clientApproval.update({
    where: { id: a.id },
    data: { codeHash: sha256(`${a.id}:${code}`), codeExpiresAt: new Date(Date.now() + CODE_TTL_MS), codeAttempts: 0, codesSent: { increment: 1 } },
  });
  await event(prisma, a.id, 'CODE_SENT', ctx);
  const m = a.manifest as unknown as Manifest;
  await approvalMail.deliver({
    to: a.contactEmail, subject: `کد تأیید ${a.code}: ${code}`,
    html: `<div dir="rtl"><p>کد یک‌بارمصرف شما برای تصمیم دربارهٔ «${esc(m.subject.title)}»:</p><p style="font-size:20px;letter-spacing:4px" dir="ltr"><b>${code}</b></p><p>این کد ده دقیقه معتبر است. اگر شما درخواستش نکرده‌اید، آن را به کسی ندهید.</p></div>`,
    text: `کد یک‌بارمصرف شما: ${code}\nده دقیقه معتبر است.`,
  });
  return { sentTo: maskEmail(a.contactEmail), expiresInMinutes: CODE_TTL_MS / 60_000 };
}

/**
 * `via` is a signed-in portal user (#34): the addressee's own session is the identity, so no code
 * is asked for, and the record names the portal account.
 */
export async function decide(
  a: Approval, input: { decision: 'APPROVE' | 'REQUEST_CHANGES'; signerName: string; comment?: string; code?: string }, ctx: ClientContext,
  via?: { portalUserId: string },
) {
  assertPending(a);
  const comment = input.comment?.trim() || null;
  if (input.decision === 'REQUEST_CHANGES' && (!comment || comment.length < 5)) throw new AppError(422, 'CLIENT_APPROVAL_COMMENT', 'بنویسید چه چیزی باید اصلاح شود.');
  const m = a.manifest as unknown as Manifest;
  if (input.decision === 'APPROVE') {
    const viewed = new Set((await prisma.clientApprovalEvent.findMany({ where: { approvalId: a.id, kind: 'FILE_VIEWED' }, select: { documentId: true } })).map((e) => e.documentId));
    const unseen = m.files.filter((f) => !viewed.has(f.documentId));
    if (unseen.length) throw new AppError(422, 'CLIENT_APPROVAL_UNSEEN', `پیش از تأیید، این فایل‌ها را باز کنید: ${unseen.map((f) => f.fileName).join('، ')}`);
  }
  const verification = via ? 'PORTAL' as const : approvalMail.enabled() ? 'EMAIL_CODE' as const : 'LINK' as const;
  if (verification === 'EMAIL_CODE') {
    const fresh = a.codeHash && a.codeExpiresAt && a.codeExpiresAt > new Date() && a.codeAttempts < MAX_CODE_ATTEMPTS;
    if (!fresh) throw new AppError(422, 'CLIENT_APPROVAL_CODE_REQUIRED', 'نخست کد یک‌بارمصرف را دریافت کنید؛ کد پیشین منقضی شده یا دفعات آن تمام شده است.');
    if (!input.code || sha256(`${a.id}:${input.code.trim()}`) !== a.codeHash) {
      await prisma.clientApproval.update({ where: { id: a.id }, data: { codeAttempts: { increment: 1 } } });
      await event(prisma, a.id, 'CODE_REJECTED', ctx);
      throw new AppError(422, 'CLIENT_APPROVAL_CODE_INVALID', `کد درست نیست؛ ${MAX_CODE_ATTEMPTS - a.codeAttempts - 1} بار دیگر می‌توانید امتحان کنید.`);
    }
  }
  // Decided from where the organisation's own people work? Worth knowing when the link was handed over by hand.
  const staffAddress = !!ctx.ip && (await prisma.auditEvent.count({
    where: { organizationId: a.organizationId, actorId: { not: null }, ipAddress: ctx.ip, createdAt: { gt: new Date(Date.now() - 30 * DAY) } },
  })) > 0;

  const sealed = await prisma.$transaction(async (tx) => {
    // One decision per request, even when the button is pressed twice.
    await tx.$queryRaw`SELECT id FROM client_approvals WHERE id = ${a.id} FOR UPDATE`;
    const current = await tx.clientApproval.findUniqueOrThrow({ where: { id: a.id }, select: { status: true } });
    if (current.status !== 'PENDING') throw conflict('CLIENT_APPROVAL_CLOSED', 'تصمیم این درخواست پیش‌تر ثبت شده است.');
    const now = new Date();
    // The chain's counter row is held until this commits, so the previous link is already written.
    const sequence = await nextNumber(tx, `client-approval-chain:${a.organizationId}`);
    const prev = sequence === 1 ? GENESIS
      : (await tx.clientApproval.findFirstOrThrow({ where: { organizationId: a.organizationId, sequence: sequence - 1 }, select: { evidenceHash: true } })).evidenceHash!;
    // Every event so far: a download racing this decision waits on the lock above (its row references this one).
    const events: EvidenceEvent[] = (await tx.clientApprovalEvent.findMany({ where: { approvalId: a.id }, orderBy: { seq: 'asc' } }))
      .map((e) => ({ seq: e.seq, kind: e.kind, documentId: e.documentId, ip: e.ip, userAgent: e.userAgent, at: e.at.toISOString() }));
    const evidence: Evidence = {
      v: 1, approval: a.code, organizationId: a.organizationId, manifestHash: a.manifestHash, decision: input.decision, comment,
      signerName: input.signerName.trim(), contact: { name: a.contactName, email: a.contactEmail }, verification,
      decidedAt: now.toISOString(), ip: ctx.ip, userAgent: ctx.userAgent, staffAddress, events, sequence, prevEvidenceHash: prev,
      ...(via ? { portalUserId: via.portalUserId } : {}),
    };
    const updated = await tx.clientApproval.update({
      where: { id: a.id },
      data: {
        status: input.decision === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED', decision: input.decision, comment, signerName: evidence.signerName,
        verification, decidedAt: now, decidedIp: ctx.ip, decidedUserAgent: ctx.userAgent, sequence, prevEvidenceHash: prev,
        evidence: evidence as object, evidenceHash: hashOf(evidence), codeHash: null, codeExpiresAt: null,
      },
    });
    await event(tx, a.id, 'DECIDED', ctx, null, now);
    return updated;
  });

  await audit({
    organizationId: a.organizationId, actorId: null, action: 'CLIENT_APPROVAL_DECIDED', entityType: SUBJECT[a.subjectType as SubjectType].entity, entityId: a.subjectId,
    after: { approval: a.code, decision: input.decision, signerName: sealed.signerName, verification, evidenceHash: sealed.evidenceHash },
    ipAddress: ctx.ip, userAgent: ctx.userAgent,
  });
  const applied = await applyDecision(sealed);
  await notify({
    userId: a.requestedById, kind: 'CLIENT_APPROVAL_DECIDED', severity: input.decision === 'APPROVE' ? 'INFO' : 'WARNING',
    title: `${a.contactName}: ${DECISION_FA[input.decision]} — ${m.subject.title}`,
    body: applied.error ? `تصمیم ثبت شد اما بر ${SUBJECT[a.subjectType as SubjectType].fa} اعمال نشد: ${applied.error}` : comment,
    entityType: SUBJECT[a.subjectType as SubjectType].entity, entityId: a.subjectId,
  });
  if (approvalMail.enabled()) {
    await approvalMail.deliver({
      to: a.contactEmail, subject: `رسید تصمیم شما — ${a.code}`,
      html: `<div dir="rtl"><p>تصمیم شما دربارهٔ «${esc(m.subject.title)}» ثبت شد: <b>${DECISION_FA[input.decision]}</b>.</p>
<p>زمان: ${esc(formatJalali(sealed.decidedAt!))} — شناسه: ${esc(a.code)}</p>
<p>اثر انگشت آنچه دیدید: <code dir="ltr">${a.manifestHash}</code></p>
<p>اثر انگشت تصمیم: <code dir="ltr">${sealed.evidenceHash}</code></p>
<p>این رسید را نگه دارید؛ با آن می‌توان نشان داد تصمیم شما پس از ثبت تغییر نکرده است.</p></div>`,
      text: `تصمیم شما ثبت شد: ${DECISION_FA[input.decision]}\nشناسه: ${a.code}\nاثر انگشت تصمیم: ${sealed.evidenceHash}`,
    }).catch(() => undefined);
  }
  return { ...sealed, transitionError: applied.error };
}

/**
 * The decision, applied through the engine as the staff member who asked — with their own
 * permissions today and the client's address, so a guard or a lost permission stops it the way it
 * would stop them. If it cannot be applied, the evidence stands and the reason is kept.
 */
async function applyDecision(a: NonNullable<Approval>) {
  const kind = SUBJECT[a.subjectType as SubjectType];
  const requester = await prisma.user.findUnique({ where: { id: a.requestedById }, select: { organizationId: true, isActive: true, deletedAt: true, roles: { select: { role: { select: { code: true } } } } } });
  const permissions = requester?.isActive && !requester.deletedAt ? await permissionsFor(requester.organizationId, requester.roles.map((r) => r.role.code)) : [];
  const approve = a.decision === 'APPROVE';
  try {
    await transition({
      entity: kind.entity, id: a.subjectId, action: approve ? kind.approve : kind.changes,
      reason: approve ? `تأیید مشتری — ${a.signerName} (${a.contactEmail})، ${a.code}` : `${a.comment} — ${a.signerName}، ${a.code}`,
      payload: { clientApprovalId: a.id },
      actor: { id: a.requestedById, organizationId: a.organizationId, permissions, ipAddress: a.decidedIp, userAgent: a.decidedUserAgent },
    });
    return { error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await prisma.clientApproval.update({ where: { id: a.id }, data: { transitionError: error.slice(0, 1000) } });
    return { error };
  }
}

/* ── staff: cancel, read, verify ────────────────────────────────────────────── */

export async function cancel(id: string, actor: RequestActor, reason: string) {
  const a = await prisma.clientApproval.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!a) throw notFound('درخواست تأیید');
  const kind = SUBJECT[a.subjectType as SubjectType];
  if (!actor.permissions.includes(kind.write)) throw forbidden(`برای لغو درخواست به دسترسی «${kind.write}» نیاز دارید.`);
  if (a.status !== 'PENDING') throw conflict('CLIENT_APPROVAL_CLOSED', 'فقط درخواستِ در انتظار مشتری لغو می‌شود.');
  const updated = await prisma.clientApproval.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: actor.id, cancelReason: reason } });
  await event(prisma, id, 'CANCELLED', { ip: actor.ipAddress ?? null, userAgent: actor.userAgent ?? null });
  return updated;
}

/** For staff: everything but the secrets. */
export const staffView = <T extends { tokenHash: string; codeHash: string | null }>(a: T) => {
  const { tokenHash: _t, codeHash: _c, ...rest } = a;
  return rest;
};

export async function verify(id: string, organizationId: string, storageRoot: string): Promise<{ ok: boolean; problems: Problem[]; checkedAt: Date }> {
  const a = await prisma.clientApproval.findFirst({ where: { id, organizationId }, include: { events: { orderBy: { seq: 'asc' } } } });
  if (!a) throw notFound('درخواست تأیید');
  const m = a.manifest as unknown as Manifest;
  const docs = await prisma.document.findMany({ where: { id: { in: m.files.map((f) => f.documentId) } }, select: { id: true, storedName: true } });
  const hashes: Record<string, string | null> = {};
  for (const f of m.files) {
    const d = docs.find((x) => x.id === f.documentId);
    hashes[f.documentId] = d ? await hashStoredFile(storageRoot, d.storedName) : null;
  }
  const previous = a.sequence && a.sequence > 1
    ? await prisma.clientApproval.findFirst({ where: { organizationId, sequence: a.sequence - 1 }, select: { evidenceHash: true } })
    : null;
  const events: EvidenceEvent[] = a.events.map((e) => ({ seq: e.seq, kind: e.kind, documentId: e.documentId, ip: e.ip, userAgent: e.userAgent, at: e.at.toISOString() }));
  const problems = checkEvidence(a, events, previous, hashes);
  return { ok: problems.length === 0, problems, checkedAt: new Date() };
}
