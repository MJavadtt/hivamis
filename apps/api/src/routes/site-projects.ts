import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  ASSIGNMENT_ROLES, assignmentSchema, availableTransitions, counterSchema, employerApprovalSchema, negotiationSchema, negotiationUpdateSchema,
  SITE_TERM_FIELDS, siteContractDecisionSchema, siteContractSchema, siteProjectCreateSchema, siteProjectListSchema, siteProjectUpdateSchema,
} from '@hiva/contracts';
import { prisma, type Tx } from '../db.js';
import { narrowed, reachFor } from '../auth/visibility.js';
import { actorFrom, orderBy, page, parse } from '../lib/http.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { nextCode } from '../lib/codes.js';
import { money } from '../lib/money.js';
import { assertOwnReferences } from '../lib/scope.js';
import { isSystemAdmin } from '../auth/grants.js';
import { transitionWithin } from '../workflow/engine.js';
import { assertOptions } from '../sites/options.js';
import { overridesRules } from '../sites/access.js';
import { balancesOf } from '../sites/ledger.js';

/**
 * Deployment projects (ADR-103, module B): the project, its negotiations, the contract and its
 * approvals, the client's approval, the counters and the people on site. Its state moves through
 * `POST /workflow/siteProject/:id/transitions` like every workflow; a contract's decision moves it in
 * the same transaction as the decision is recorded.
 */

const TERMINAL = ['CLOSED', 'CANCELLED'];
/** Until the contract is sent, the terms are the project's to edit; afterwards they change by amendment. */
const TERMS_OPEN = ['DRAFT', 'EVALUATION', 'NEGOTIATION', 'TERMS_AGREED'];
const versionConflict = () => conflict('VERSION_CONFLICT', 'این پروژه را همکار دیگری هم‌زمان تغییر داده است؛ صفحه را تازه کنید و دوباره ثبت کنید.');

type Actor = ReturnType<typeof actorFrom>;
const auditCtx = (a: Actor) => ({ organizationId: a.organizationId, actorId: a.id, ipAddress: a.ipAddress, requestId: a.requestId });

async function projectFor(tx: Tx | typeof prisma, actor: Actor, id: string, opts: { open?: boolean } = {}) {
  const p = await tx.siteProject.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!p) throw notFound('پروژهٔ استقرار');
  if (opts.open && TERMINAL.includes(p.state) && !overridesRules(actor)) throw conflict('PROJECT_CLOSED', `پروژهٔ ${p.code} ${p.state === 'CLOSED' ? 'بسته' : 'لغو'} شده است؛ چیزی به آن افزوده نمی‌شود.`);
  return p;
}

const projectOptions = (organizationId: string, v: Record<string, unknown>, kept: Record<string, unknown> = {}) => assertOptions(organizationId, [
  { list: 'COOPERATION', codes: [v.cooperationCode as string], field: 'cooperationCode', kept: [kept.cooperationCode as string] },
  { list: 'PAYMENT_METHOD', codes: [v.rentMethodCode as string, v.chargeMethodCode as string], field: 'rentMethodCode', kept: [kept.rentMethodCode as string, kept.chargeMethodCode as string] },
]);

/** The project's terms as a contract version keeps them. */
const termsOf = (p: Record<string, unknown>) => JSON.parse(JSON.stringify(Object.fromEntries(SITE_TERM_FIELDS.map((k) => [k, p[k] ?? null]))));

const siteProjectRoutes: FastifyPluginAsync = async (app) => {
  const read = { preHandler: [app.authenticate, app.requirePermissions('site.read')] };
  const write = { preHandler: [app.authenticate, app.requirePermissions('site.write')] };
  const approve = { preHandler: [app.authenticate, app.requirePermissions('site.contract.approve')] };

  app.get('/site-projects', read, async (req) => {
    const actor = actorFrom(req);
    const q = parse(siteProjectListSchema, req.query);
    const own: Prisma.SiteProjectWhereInput = {
      organizationId: actor.organizationId, archivedAt: null,
      ...(q.state ? { state: q.state } : {}), ...(q.open === 'true' ? { state: { notIn: TERMINAL } } : {}),
      ...(q.venueId ? { venueId: q.venueId } : {}), ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.cooperationCode ? { cooperationCode: q.cooperationCode } : {}), ...(q.responsibleId ? { responsibleId: q.responsibleId } : {}),
      ...(q.province || q.city ? { venue: { ...(q.province ? { province: q.province } : {}), ...(q.city ? { city: q.city } : {}) } } : {}),
      ...(q.q ? { OR: [
        { name: { contains: q.q, mode: 'insensitive' } }, { code: { contains: q.q, mode: 'insensitive' } }, { placement: { contains: q.q, mode: 'insensitive' } },
        { venue: { name: { contains: q.q, mode: 'insensitive' } } },
      ] } : {}),
    };
    const where = narrowed('siteProject', await reachFor(req, actor), own as Record<string, unknown>) as Prisma.SiteProjectWhereInput;
    const [items, total] = await Promise.all([
      prisma.siteProject.findMany({
        where, orderBy: orderBy(q.sort, q.order, ['name', 'code', 'state', 'contractStart', 'contractEnd', 'installPlannedAt', 'createdAt', 'updatedAt'], 'updatedAt'),
        skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: {
          venue: { select: { id: true, code: true, name: true, city: true, province: true } },
          responsible: { select: { id: true, fullName: true } },
          project: { select: { id: true, code: true, name: true } },
          company: { select: { id: true, legalName: true, brandName: true } },
        },
      }),
      prisma.siteProject.count({ where }),
    ]);
    // What is overdue on each, for whoever may read the rentals: the list's red flag.
    const overdue = actor.permissions.includes('rental.read')
      ? await prisma.siteObligation.groupBy({ by: ['siteProjectId'], where: { organizationId: actor.organizationId, siteProjectId: { in: items.map((i) => i.id) }, status: { in: ['OPEN', 'PARTIAL'] }, dueDate: { lt: new Date() } }, _count: { _all: true } })
      : [];
    return page(items.map((i) => ({ ...i, overdueItems: overdue.find((o) => o.siteProjectId === i.id)?._count._all ?? 0 })), total, q);
  });

  app.post('/site-projects', write, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(siteProjectCreateSchema, req.body);
    await assertOwnReferences('siteProject', input, actor.organizationId);
    await projectOptions(actor.organizationId, input);
    const made = await prisma.$transaction(async (tx) => {
      const venue = await tx.venue.findFirst({ where: { id: input.venueId, organizationId: actor.organizationId, archivedAt: null, mergedIntoId: null } });
      if (!venue) throw new AppError(422, 'UNKNOWN_REFERENCE', 'مکان این پروژه پیدا نشد یا بایگانی شده است.');
      const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { currency: true } });
      // Made for a client project, it takes that project's client as the employer unless one is named.
      const client = input.projectId && !input.companyId
        ? (await tx.project.findFirst({ where: { id: input.projectId, organizationId: actor.organizationId }, select: { companyId: true } }))?.companyId ?? null
        : input.companyId ?? null;
      const row = await tx.siteProject.create({
        data: { ...input, companyId: client, currency: input.currency ?? org.currency, organizationId: actor.organizationId, code: await nextCode(tx, 'siteProject'), createdById: actor.id, responsibleId: input.responsibleId ?? actor.id },
      });
      await audit({ ...auditCtx(actor), action: 'CREATE', entityType: 'siteProject', entityId: row.id, after: row }, tx);
      return row;
    });
    return reply.code(201).send(made);
  });

  app.get('/site-projects/:id', read, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const p = await prisma.siteProject.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: {
        venue: { select: { id: true, code: true, name: true, city: true, province: true, address: true, phone: true, isActive: true, archivedAt: true, contacts: { where: { archivedAt: null }, select: { id: true, fullName: true, roleCode: true, phone: true, isPrimary: true } } } },
        responsible: { select: { id: true, fullName: true } },
        createdBy: { select: { id: true, fullName: true } },
        project: { select: { id: true, code: true, name: true } },
        company: { select: { id: true, legalName: true, brandName: true } },
        negotiations: {
          orderBy: { heldAt: 'desc' },
          include: { assignee: { select: { id: true, fullName: true } }, createdBy: { select: { fullName: true } }, participants: { include: { contact: { select: { id: true, fullName: true } }, user: { select: { id: true, fullName: true } } } } },
        },
        contracts: { orderBy: { version: 'desc' }, include: { createdBy: { select: { id: true, fullName: true } }, decidedBy: { select: { fullName: true } } } },
        approvals: { orderBy: { decidedAt: 'desc' }, include: { decidedBy: { select: { fullName: true } }, recordedBy: { select: { fullName: true } } } },
        counters: { orderBy: { createdAt: 'asc' }, include: { supplier: { select: { id: true, name: true } } } },
        assignments: { orderBy: [{ role: 'asc' }, { createdAt: 'asc' }], include: { user: { select: { id: true, fullName: true } } } },
        documents: {
          where: { deletedAt: null, supersededAt: null },
          orderBy: { createdAt: 'desc' },
          select: { id: true, fileName: true, mimeType: true, sizeBytes: true, siteRecordType: true, siteRecordId: true, category: true, caption: true, takenAt: true, createdAt: true, version: true, uploadedBy: { select: { fullName: true } } },
        },
      },
    });
    if (!p) throw notFound('پروژهٔ استقرار');
    const financial = actor.permissions.includes('rental.read');
    const counters = p.counters.map((c) => ({ ...c, totalCost: c.unitCost ? money(c.unitCost).mul(c.quantity).toFixed(2) : null }));
    return {
      ...p,
      counters,
      fabricationCost: counters.reduce((s, c) => s.add(money(c.totalCost)), money(0)).toFixed(2),
      // A payment's receipt and a deduction's evidence are the ledger's, read with it.
      documents: financial ? p.documents : p.documents.filter((d) => !['payment', 'deduction'].includes(d.siteRecordType ?? '')),
      termsLocked: !TERMS_OPEN.includes(p.state),
      availableTransitions: availableTransitions('siteProject', p.state).filter((t) => !t.permission || actor.permissions.includes(t.permission)).map((t) => ({ action: t.action, labelFa: t.labelFa, labelEn: t.labelEn, requiresReason: !!t.requiresReason, to: t.to })),
      balances: financial ? await balancesOf(prisma, id) : null,
    };
  });

  app.patch('/site-projects/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(siteProjectUpdateSchema, req.body);
    const { version, ...fields } = input;
    await assertOwnReferences('siteProject', fields, actor.organizationId);
    return prisma.$transaction(async (tx) => {
      const before = await projectFor(tx, actor, id, { open: true });
      if (version !== before.version) throw versionConflict();
      const changed = Object.keys(fields).filter((k) => JSON.stringify((fields as Record<string, unknown>)[k] ?? null) !== JSON.stringify((before as Record<string, unknown>)[k] ?? null));
      const terms = changed.filter((k) => (SITE_TERM_FIELDS as readonly string[]).includes(k) || k === 'venueId');
      if (terms.length && !TERMS_OPEN.includes(before.state) && !overridesRules(actor)) {
        throw conflict('TERMS_LOCKED', 'شرایط این پروژه را قرارداد تعیین کرده است؛ برای تغییرش نسخهٔ تازهٔ قرارداد (الحاقیه) ثبت و تأیید کنید.', { fields: terms });
      }
      if (fields.venueId && fields.venueId !== before.venueId && !(await tx.venue.count({ where: { id: fields.venueId, organizationId: actor.organizationId, archivedAt: null, mergedIntoId: null } }))) {
        throw new AppError(422, 'UNKNOWN_REFERENCE', 'مکان تازه پیدا نشد یا بایگانی شده است.');
      }
      await projectOptions(actor.organizationId, fields, before);
      const next = { ...before, ...fields };
      if (next.contractStart && next.contractEnd && next.contractEnd <= next.contractStart) throw badRequest('VALIDATION_ERROR', 'پایان قرارداد باید پس از آغاز آن باشد.');
      const r = await tx.siteProject.updateMany({ where: { id, version: before.version }, data: { ...fields, updatedById: actor.id, version: { increment: 1 } } });
      if (r.count !== 1) throw versionConflict();
      const after = await tx.siteProject.findUniqueOrThrow({ where: { id } });
      await audit({ ...auditCtx(actor), action: 'UPDATE', entityType: 'siteProject', entityId: id, before, after }, tx);
      return after;
    });
  });

  /* ── negotiations ────────────────────────────────────────────────────── */

  async function participants(tx: Tx, actor: Actor, venueId: string, input: { contactIds?: string[]; userIds?: string[]; otherParticipants?: string[] }) {
    const contactIds = [...new Set(input.contactIds ?? [])], userIds = [...new Set(input.userIds ?? [])];
    if (contactIds.length && (await tx.venueContact.count({ where: { id: { in: contactIds }, venueId, organizationId: actor.organizationId } })) !== contactIds.length) {
      throw new AppError(422, 'UNKNOWN_REFERENCE', 'یکی از مخاطبان از این مکان نیست.');
    }
    if (userIds.length && (await tx.user.count({ where: { id: { in: userIds }, organizationId: actor.organizationId, deletedAt: null } })) !== userIds.length) {
      throw new AppError(422, 'UNKNOWN_REFERENCE', 'یکی از همکاران در این سازمان نیست.');
    }
    return [...contactIds.map((contactId) => ({ contactId })), ...userIds.map((userId) => ({ userId })), ...(input.otherParticipants ?? []).map((name) => ({ name }))];
  }

  app.post('/site-projects/:id/negotiations', write, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(negotiationSchema, req.body);
    await assertOwnReferences('siteNegotiation', input, actor.organizationId);
    const made = await prisma.$transaction(async (tx) => {
      const p = await projectFor(tx, actor, id, { open: true });
      const people = await participants(tx, actor, p.venueId, input);
      const { contactIds: _c, userIds: _u, otherParticipants: _o, ...fields } = input;
      const n = await tx.siteNegotiation.create({ data: { ...fields, organizationId: actor.organizationId, siteProjectId: id, createdById: actor.id, participants: { create: people } } });
      await audit({ ...auditCtx(actor), action: 'NEGOTIATION_RECORDED', entityType: 'siteProject', entityId: id, after: { ...n, participants: people.length } }, tx);
      return n;
    });
    return reply.code(201).send(made);
  });

  app.patch('/site-negotiations/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(negotiationUpdateSchema, req.body);
    await assertOwnReferences('siteNegotiation', input, actor.organizationId);
    return prisma.$transaction(async (tx) => {
      const before = await tx.siteNegotiation.findFirst({ where: { id, organizationId: actor.organizationId }, include: { participants: true } });
      if (!before) throw notFound('مذاکره');
      const p = await projectFor(tx, actor, before.siteProjectId, { open: true });
      const { contactIds, userIds, otherParticipants, followUpDone, ...fields } = input;
      if (contactIds || userIds || otherParticipants) {
        const people = await participants(tx, actor, p.venueId, { contactIds, userIds, otherParticipants });
        await tx.siteNegotiationParticipant.deleteMany({ where: { negotiationId: id } });
        await tx.siteNegotiationParticipant.createMany({ data: people.map((x) => ({ ...x, negotiationId: id })) });
      }
      const after = await tx.siteNegotiation.update({
        where: { id },
        data: { ...fields, ...(followUpDone === true ? { followUpDoneAt: new Date() } : followUpDone === false ? { followUpDoneAt: null } : {}) },
      });
      await audit({ ...auditCtx(actor), action: 'NEGOTIATION_UPDATED', entityType: 'siteProject', entityId: before.siteProjectId, before, after }, tx);
      return after;
    });
  });

  /* ── the contract and its approvals ──────────────────────────────────── */

  /**
   * A new version of the agreement. Before the first approval it records the project's terms as they
   * are; after it, an amendment brings the terms it changes. Any version not yet approved is superseded
   * by it; an approved one stays in force until the new one is approved.
   */
  app.post('/site-projects/:id/contracts', write, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(siteContractSchema, req.body);
    const made = await prisma.$transaction(async (tx) => {
      const p = await projectFor(tx, actor, id, { open: true });
      if (['DRAFT', 'EVALUATION'].includes(p.state) && !overridesRules(actor)) throw conflict('TOO_EARLY', 'قرارداد پس از آغاز مذاکره ثبت می‌شود.');
      const approvedBefore = (await tx.siteContract.count({ where: { siteProjectId: id, status: 'APPROVED' } })) > 0;
      if (input.amendment && !approvedBefore && !overridesRules(actor)) throw badRequest('VALIDATION_ERROR', 'پیش از نخستین تأیید، شرایط را در خود پروژه ویرایش کنید؛ الحاقیه برای قرارداد تأییدشده است.');
      if (input.amendment) {
        await projectOptions(actor.organizationId, input.amendment, p);
        const merged = { ...p, ...input.amendment };
        if (merged.contractStart && merged.contractEnd && merged.contractEnd <= merged.contractStart) throw badRequest('VALIDATION_ERROR', 'پایان قرارداد باید پس از آغاز آن باشد.');
      }
      const terms = termsOf({ ...p, ...(input.amendment ?? {}) });
      await tx.siteContract.updateMany({ where: { siteProjectId: id, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'REJECTED'] } }, data: { status: 'SUPERSEDED' } });
      const last = await tx.siteContract.aggregate({ _max: { version: true }, where: { siteProjectId: id } });
      const c = await tx.siteContract.create({
        data: {
          organizationId: actor.organizationId, siteProjectId: id, version: (last._max.version ?? 0) + 1, reference: input.reference ?? null,
          cooperationCode: terms.cooperationCode, startDate: terms.contractStart, endDate: terms.contractEnd, terms, notes: input.notes ?? null,
          status: 'DRAFT', createdById: actor.id,
        },
      });
      await audit({ ...auditCtx(actor), action: input.amendment ? 'CONTRACT_AMENDMENT_DRAFTED' : 'CONTRACT_DRAFTED', entityType: 'siteProject', entityId: id, after: c }, tx);
      return c;
    });
    return reply.code(201).send(made);
  });

  /** Sent for approval: with its file, where the cooperation model is a written contract. */
  app.post('/site-contracts/:id/submit', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    return prisma.$transaction(async (tx) => {
      const c = await tx.siteContract.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!c) throw notFound('قرارداد');
      const p = await projectFor(tx, actor, c.siteProjectId, { open: true });
      if (c.status !== 'DRAFT') throw conflict('ILLEGAL_TRANSITION', 'فقط نسخهٔ پیش‌نویس برای تأیید فرستاده می‌شود.');
      if (p.state === 'NEGOTIATION' && !overridesRules(actor)) throw conflict('TERMS_NOT_AGREED', 'نخست توافق بر شرایط را ثبت کنید، سپس قرارداد را بفرستید.');
      await tx.siteContract.update({ where: { id }, data: { status: 'PENDING_APPROVAL', submittedAt: new Date() } });
      if (p.state === 'TERMS_AGREED') {
        await transitionWithin(tx, { entity: 'siteProject', id: p.id, action: 'submit_contract', actor });
      } else {
        // An amendment, or a new version while one waits: the same file rule, without moving the project.
        const option = c.cooperationCode ? await tx.siteOption.findUnique({ where: { organizationId_list_code: { organizationId: actor.organizationId, list: 'COOPERATION', code: c.cooperationCode } } }) : null;
        const needsFile = (option?.meta as { requiresContract?: boolean } | null)?.requiresContract !== false;
        if (needsFile && !overridesRules(actor) && !(await tx.document.count({ where: { siteProjectId: p.id, siteRecordType: 'contract', siteRecordId: id, deletedAt: null } }))) {
          throw conflict('CONTRACT_FILE_MISSING', 'در همکاری قراردادی، فایل قرارداد باید پیوست این نسخه باشد.');
        }
      }
      await audit({ ...auditCtx(actor), action: 'CONTRACT_SUBMITTED', entityType: 'siteProject', entityId: p.id, after: { contractId: id, version: c.version } }, tx);
      return tx.siteContract.findUniqueOrThrow({ where: { id } });
    });
  });

  /**
   * The decision. Whoever wrote the version does not decide it — the system administrator excepted, who
   * may decide anything and is recorded as such. Approved, an amendment's terms become the project's.
   */
  app.post('/site-contracts/:id/decision', approve, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(siteContractDecisionSchema, req.body);
    const out = await prisma.$transaction(async (tx) => {
      const c = await tx.siteContract.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!c) throw notFound('قرارداد');
      const p = await projectFor(tx, actor, c.siteProjectId, { open: true });
      if (c.status !== 'PENDING_APPROVAL') throw conflict('ALREADY_DECIDED', 'این نسخه در انتظار تأیید نیست.');
      const admin = isSystemAdmin(actor);
      if (c.createdById === actor.id && !admin) throw new AppError(403, 'SEPARATION_OF_DUTIES', 'نسخه‌ای را که خودتان نوشته‌اید، همکار دیگری تأیید یا رد می‌کند.');
      const now = new Date();
      const status = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      if (status === 'APPROVED') await tx.siteContract.updateMany({ where: { siteProjectId: p.id, status: 'APPROVED' }, data: { status: 'SUPERSEDED' } });
      await tx.siteContract.update({ where: { id }, data: { status, decidedAt: now, decidedById: actor.id, decisionComment: input.comment ?? null } });
      await tx.siteApproval.create({
        data: { organizationId: actor.organizationId, siteProjectId: p.id, kind: 'CONTRACT', subjectId: id, decision: status, comment: input.comment ?? null, decidedById: actor.id, decidedAt: now, recordedById: actor.id },
      });
      if (p.state === 'CONTRACT_PENDING') {
        await transitionWithin(tx, { entity: 'siteProject', id: p.id, action: status === 'APPROVED' ? 'approve_contract' : 'reject_contract', reason: input.comment ?? undefined, actor });
      } else if (status === 'APPROVED') {
        // An amendment approved: its terms are the project's from now on.
        const terms = c.terms as Record<string, unknown>;
        const data = Object.fromEntries(SITE_TERM_FIELDS.filter((k) => k !== 'currency').map((k) => [k, k === 'contractStart' || k === 'contractEnd' ? (terms[k] ? new Date(String(terms[k])) : null) : terms[k] ?? null]));
        const after = await tx.siteProject.update({ where: { id: p.id }, data: { ...data, version: { increment: 1 }, updatedById: actor.id } });
        await audit({ ...auditCtx(actor), action: 'TERMS_AMENDED', entityType: 'siteProject', entityId: p.id, before: termsOf(p), after: termsOf(after), reason: `الحاقیهٔ نسخهٔ ${c.version}` }, tx);
      }
      await audit({ ...auditCtx(actor), action: status === 'APPROVED' ? 'CONTRACT_APPROVED' : 'CONTRACT_REJECTED', entityType: 'siteProject', entityId: p.id, reason: input.comment ?? null, after: { contractId: id, version: c.version, ...(admin && c.createdById === actor.id ? { asSystemAdministrator: true } : {}) } }, tx);
      return tx.siteContract.findUniqueOrThrow({ where: { id } });
    });
    return out;
  });

  /** The client's (employer's) approval — taken at the client, recorded here with its evidence. */
  app.post('/site-projects/:id/approvals', write, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(employerApprovalSchema, req.body);
    if (input.decidedAt > new Date()) throw badRequest('VALIDATION_ERROR', 'تاریخ تأیید در آینده است.');
    const made = await prisma.$transaction(async (tx) => {
      const p = await projectFor(tx, actor, id, { open: true });
      const row = await tx.siteApproval.create({
        data: {
          organizationId: actor.organizationId, siteProjectId: p.id, kind: 'EMPLOYER', subject: input.subject, decision: input.decision,
          comment: input.comment ?? null, approverName: input.approverName, approverTitle: input.approverTitle ?? null, decidedAt: input.decidedAt, recordedById: actor.id,
        },
      });
      await audit({ ...auditCtx(actor), action: 'EMPLOYER_APPROVAL_RECORDED', entityType: 'siteProject', entityId: id, after: row }, tx);
      return row;
    });
    return reply.code(201).send(made);
  });

  /* ── counters and people on site ─────────────────────────────────────── */

  app.post('/site-projects/:id/counters', write, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(counterSchema, req.body);
    await assertOwnReferences('siteCounter', input, actor.organizationId);
    const made = await prisma.$transaction(async (tx) => {
      await projectFor(tx, actor, id, { open: true });
      const row = await tx.siteCounter.create({ data: { ...input, organizationId: actor.organizationId, siteProjectId: id } });
      await audit({ ...auditCtx(actor), action: 'COUNTER_ADDED', entityType: 'siteProject', entityId: id, after: row }, tx);
      return row;
    });
    return reply.code(201).send(made);
  });

  app.patch('/site-counters/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(counterSchema.partial(), req.body);
    await assertOwnReferences('siteCounter', input, actor.organizationId);
    return prisma.$transaction(async (tx) => {
      const before = await tx.siteCounter.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!before) throw notFound('کانتر');
      await projectFor(tx, actor, before.siteProjectId, { open: true });
      const after = await tx.siteCounter.update({ where: { id }, data: input });
      await audit({ ...auditCtx(actor), action: 'COUNTER_UPDATED', entityType: 'siteProject', entityId: before.siteProjectId, before, after }, tx);
      return after;
    });
  });

  app.delete('/site-counters/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    return prisma.$transaction(async (tx) => {
      const before = await tx.siteCounter.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!before) throw notFound('کانتر');
      const p = await projectFor(tx, actor, before.siteProjectId, { open: true });
      if (!['DRAFT', 'EVALUATION', 'NEGOTIATION', 'TERMS_AGREED', 'CONTRACT_PENDING', 'CONTRACT_APPROVED', 'INSTALL_PLANNED'].includes(p.state) && !overridesRules(actor)) {
        throw conflict('COUNTER_INSTALLED', 'کانتر نصب‌شده حذف نمی‌شود؛ اگر برداشته شد، در یادداشت پروژه ثبت کنید.');
      }
      await tx.siteCounter.delete({ where: { id } });
      await audit({ ...auditCtx(actor), action: 'COUNTER_REMOVED', entityType: 'siteProject', entityId: before.siteProjectId, before }, tx);
      return { deleted: true };
    });
  });

  app.post('/site-projects/:id/assignments', write, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(assignmentSchema, req.body);
    await assertOwnReferences('siteAssignment', input, actor.organizationId);
    const made = await prisma.$transaction(async (tx) => {
      await projectFor(tx, actor, id, { open: true });
      const row = await tx.siteAssignment.create({ data: { ...input, organizationId: actor.organizationId, siteProjectId: id } });
      await audit({ ...auditCtx(actor), action: 'STAFF_ASSIGNED', entityType: 'siteProject', entityId: id, after: row }, tx);
      return row;
    });
    return reply.code(201).send(made);
  });

  app.patch('/site-assignments/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(z.object({
      role: z.enum(ASSIGNMENT_ROLES).optional(),
      personName: z.string().trim().max(120).nullish(), phone: z.string().trim().max(40).nullish(),
      startsOn: z.coerce.date().nullish(), endsOn: z.coerce.date().nullish(), shift: z.string().trim().max(120).nullish(), notes: z.string().trim().max(1000).nullish(),
    }), req.body);
    return prisma.$transaction(async (tx) => {
      const before = await tx.siteAssignment.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!before) throw notFound('نیروی مستقر');
      await projectFor(tx, actor, before.siteProjectId, { open: true });
      const next = { ...before, ...input };
      if (next.startsOn && next.endsOn && next.endsOn < next.startsOn) throw badRequest('VALIDATION_ERROR', 'پایان حضور پیش از آغاز آن است.');
      const after = await tx.siteAssignment.update({ where: { id }, data: input });
      await audit({ ...auditCtx(actor), action: 'STAFF_UPDATED', entityType: 'siteProject', entityId: before.siteProjectId, before, after }, tx);
      return after;
    });
  });

  app.delete('/site-assignments/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    return prisma.$transaction(async (tx) => {
      const before = await tx.siteAssignment.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!before) throw notFound('نیروی مستقر');
      await projectFor(tx, actor, before.siteProjectId, { open: true });
      await tx.siteAssignment.delete({ where: { id } });
      await audit({ ...auditCtx(actor), action: 'STAFF_REMOVED', entityType: 'siteProject', entityId: before.siteProjectId, before }, tx);
      return { deleted: true };
    });
  });
};

export default siteProjectRoutes;
