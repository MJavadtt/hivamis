import { stateLabelFa, WORKFLOWS } from '@hiva/contracts';
import { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { notify } from '../mail/notify.js';
import { canSee, isVisibleModel, reachOf, type Reach, type ReachActor } from '../auth/visibility.js';
import { delegate } from './engine.js';
import { rulesInForce } from './rules.js';

/**
 * Back one step, to correct a mistake (the owner, 2026-11-14; ADR-128): «کاربران درصورت اشتباه در هر
 * مرحله باید بتوانند با تایید مدیر خود به مرحله قبلی برگردند و ویرایش انجام بدهند، مدیران نیاز به
 * تایید کسی ندارند».
 *
 * The step before is the state the record last arrived from — not a step back itself, so going back
 * twice goes back two steps. A manager over the record (a unit's manager, or one who sees everyone's)
 * takes it back at once; anyone else asks, and their unit's manager decides. Either way the move is a
 * state transition and an audit row like every other, and nothing the forward move did is undone: a
 * record taken back is corrected and sent on again through the same steps and their rules.
 *
 * What the books or the tax authority already hold is not taken back: an invoice in an accounting
 * export, or reported to سامانهٔ مؤدیان, is cancelled and issued anew instead.
 */

export interface StepActor extends ReachActor {
  ipAddress?: string | null; userAgent?: string | null; requestId?: string | null;
}

/** Whether this person manages the record: sees everyone's, or manages a unit and sees the record. */
async function manages(actor: StepActor, reach: Reach, entity: string, id: string): Promise<boolean> {
  if (reach.all) return true;
  if (!reach.units.length) return false;
  return isVisibleModel(entity) ? canSee(entity, reach, id) : true;
}

/** The state the record last came from, not counting steps back. */
export async function previousState(db: Tx | typeof prisma, entity: string, id: string, current: string): Promise<string | null> {
  const last = await db.stateTransition.findFirst({
    where: { entityType: entity, entityId: id, toState: current, action: { notIn: ['step_back'] } },
    orderBy: { createdAt: 'desc' }, select: { fromState: true },
  });
  return last?.fromState && last.fromState !== current ? last.fromState : null;
}

/** What the books or the tax authority hold is not taken back. */
async function assertMayStepBack(db: Tx | typeof prisma, entity: string, id: string) {
  if (entity !== 'invoice') return;
  const inv = await db.invoice.findUnique({ where: { id }, select: { accountingExportId: true, taxSubmissions: { select: { status: true } } } });
  if (inv?.accountingExportId) throw conflict('STEP_BACK_POSTED', 'این سند به خروجی حسابداری رفته است و به مرحلهٔ قبل برنمی‌گردد؛ آن را باطل کنید و سند تازه صادر کنید.');
  if (inv?.taxSubmissions.some((s) => ['QUEUED', 'SENT', 'ACCEPTED'].includes(s.status))) {
    throw conflict('STEP_BACK_REPORTED', 'این فاکتور به سامانهٔ مؤدیان گزارش شده است و به مرحلهٔ قبل برنمی‌گردد؛ اصلاحی یا ابطالی آن را بفرستید.');
  }
}

async function loadRecord(db: Tx | typeof prisma, entity: string, id: string, organizationId: string) {
  if (!WORKFLOWS[entity]) throw badRequest('UNKNOWN_ENTITY', `موجودیت «${entity}» فاقد ماشین حالت است.`);
  const record = await delegate(db as Tx, entity).findFirst({ where: { id, organizationId } });
  if (!record) throw notFound('رکورد');
  return record as { id: string; state: string; code?: string; title?: string; name?: string };
}

/** Takes the record back, as one move: the transition, the audit row, and the request it settles, if any. */
async function apply(tx: Tx, actor: StepActor, entity: string, id: string, fromState: string, toState: string, reason: string, requestId?: string) {
  const record = await loadRecord(tx, entity, id, actor.organizationId);
  if (record.state !== fromState) {
    throw conflict('STEP_BACK_MOVED_ON', `این رکورد از «${stateLabelFa(fromState)}» جلو رفته است؛ دوباره ببینید از کجا باید برگردد.`);
  }
  await assertMayStepBack(tx, entity, id);
  const updated = await delegate(tx, entity).update({ where: { id }, data: { state: toState } });
  const rules = await rulesInForce(tx);
  await tx.stateTransition.create({
    data: {
      organizationId: actor.organizationId, entityType: entity, entityId: id, fromState, toState, action: 'step_back',
      reason, actorId: actor.id, rulesVersionId: rules.workflows, permissionsVersionId: rules.permissions,
    },
  });
  await audit({
    organizationId: actor.organizationId, actorId: actor.id, action: 'STATE_STEPPED_BACK', entityType: entity, entityId: id,
    before: { state: fromState }, after: { state: toState, ...(requestId ? { stepBackRequestId: requestId } : {}) }, reason,
    ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
  }, tx);
  return updated;
}

/** What the record's page shows: where it would go back to, whether this person may take it there, and a request waiting. */
export async function stepBackInfo(actor: StepActor, entity: string, id: string) {
  const record = await loadRecord(prisma, entity, id, actor.organizationId);
  const toState = await previousState(prisma, entity, id, record.state);
  const reach = await reachOf(actor);
  const pending = await prisma.stepBackRequest.findFirst({
    where: { organizationId: actor.organizationId, entityType: entity, entityId: id, state: 'PENDING' },
    include: { requestedBy: { select: { id: true, fullName: true } }, approver: { select: { id: true, fullName: true } } },
  });
  return {
    state: record.state, toState, toStateFa: toState ? stateLabelFa(toState) : null,
    direct: toState ? await manages(actor, reach, entity, id) : false,
    pending: pending && { ...pending, toStateFa: stateLabelFa(pending.toState), mayDecide: await mayDecide(actor, reach, pending) },
  };
}

/** The requester's unit manager, when it has one other than the requester. */
async function approverFor(actor: StepActor): Promise<string | null> {
  const me = await prisma.user.findUnique({ where: { id: actor.id }, select: { department: { select: { managerId: true } } } });
  const id = me?.department?.managerId ?? null;
  return id && id !== actor.id ? id : null;
}

/** Back now for a manager; a request to the unit's manager for anyone else. */
export async function stepBack(actor: StepActor, entity: string, id: string, reason: string) {
  const why = reason.trim();
  if (why.length < 5) throw badRequest('REASON_REQUIRED', 'بنویسید چه چیزی اشتباه بود (دست‌کم پنج حرف).');
  const record = await loadRecord(prisma, entity, id, actor.organizationId);
  const toState = await previousState(prisma, entity, id, record.state);
  if (!toState) throw conflict('NOTHING_BEFORE', 'این رکورد مرحلهٔ قبلی ندارد.');
  await assertMayStepBack(prisma, entity, id);
  const reach = await reachOf(actor);

  if (await manages(actor, reach, entity, id)) {
    const updated = await prisma.$transaction(async (tx) => {
      // A request waiting on this record is answered by the move itself.
      await tx.stepBackRequest.updateMany({
        where: { organizationId: actor.organizationId, entityType: entity, entityId: id, state: 'PENDING' },
        data: { state: 'APPROVED', decidedById: actor.id, decidedAt: new Date(), decisionNote: 'مدیر مستقیم برگرداند' },
      });
      return apply(tx, actor, entity, id, record.state, toState, why);
    });
    return { applied: true as const, fromState: record.state, toState, record: updated };
  }

  const waiting = await prisma.stepBackRequest.findFirst({ where: { organizationId: actor.organizationId, entityType: entity, entityId: id, state: 'PENDING' } });
  if (waiting) throw conflict('STEP_BACK_PENDING', 'درخواست برگشت این رکورد پیش‌تر فرستاده شده و منتظر تأیید است.');
  const approverId = await approverFor(actor);
  const request = await prisma.stepBackRequest.create({
    data: { organizationId: actor.organizationId, entityType: entity, entityId: id, fromState: record.state, toState, reason: why, requestedById: actor.id, approverId },
  });
  await audit({
    organizationId: actor.organizationId, actorId: actor.id, action: 'STEP_BACK_REQUESTED', entityType: entity, entityId: id,
    after: { requestId: request.id, fromState: record.state, toState, approverId }, reason: why,
    ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
  });
  const label = record.code ?? record.title ?? record.name ?? WORKFLOWS[entity]!.labelFa;
  const to = approverId ? [approverId] : await seniorManagers(actor.organizationId);
  for (const userId of to) {
    await notify({
      userId, kind: 'STEP_BACK_REQUESTED', severity: 'WARNING', entityType: entity, entityId: id,
      title: `درخواست برگشت ${WORKFLOWS[entity]!.labelFa} ${label} به «${stateLabelFa(toState)}»`, body: why,
    });
  }
  return { applied: false as const, request };
}

/** Who decides when the requester's unit names no manager: those who see everyone's records. */
async function seniorManagers(organizationId: string): Promise<string[]> {
  const people = await prisma.user.findMany({
    where: { organizationId, deletedAt: null, isActive: true, roles: { some: { role: { code: { in: ['CEO', 'DEPUTY'] } } } } },
    select: { id: true }, take: 10,
  });
  return people.map((p) => p.id);
}

/** The approver named, anyone who sees everyone's records, or a manager of the requester's unit. */
async function mayDecide(actor: StepActor, reach: Reach, r: { approverId: string | null; requestedById: string }): Promise<boolean> {
  if (r.requestedById === actor.id) return false;
  if (reach.all || r.approverId === actor.id) return true;
  return reach.units.length > 0 && reach.users.includes(r.requestedById);
}

export async function decideStepBack(actor: StepActor, requestId: string, approve: boolean, note?: string) {
  const r = await prisma.stepBackRequest.findFirst({ where: { id: requestId, organizationId: actor.organizationId } });
  if (!r) throw notFound('درخواست');
  if (r.state !== 'PENDING') throw conflict('STEP_BACK_DECIDED', 'دربارهٔ این درخواست پیش‌تر تصمیم گرفته شده است.');
  const reach = await reachOf(actor);
  if (!(await mayDecide(actor, reach, r))) throw forbidden('تصمیم دربارهٔ این درخواست با مدیر درخواست‌دهنده است.');
  const decided = { decidedById: actor.id, decidedAt: new Date(), decisionNote: note?.trim() || null };

  if (!approve) {
    const out = await prisma.stepBackRequest.update({ where: { id: r.id }, data: { state: 'REJECTED', ...decided } });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'STEP_BACK_REJECTED', entityType: r.entityType, entityId: r.entityId,
      after: { requestId: r.id }, reason: decided.decisionNote, ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
    });
    await notify({ userId: r.requestedById, kind: 'STEP_BACK_DECIDED', entityType: r.entityType, entityId: r.entityId, title: 'درخواست برگشت به مرحلهٔ قبل پذیرفته نشد', body: decided.decisionNote ?? undefined });
    return { request: out, applied: false };
  }

  try {
    const record = await prisma.$transaction(async (tx) => {
      const updated = await apply(tx, actor, r.entityType, r.entityId, r.fromState, r.toState, r.reason, r.id);
      await tx.stepBackRequest.update({ where: { id: r.id }, data: { state: 'APPROVED', ...decided } });
      return updated;
    });
    await notify({ userId: r.requestedById, kind: 'STEP_BACK_DECIDED', entityType: r.entityType, entityId: r.entityId, title: `به «${stateLabelFa(r.toState)}» برگشت؛ اکنون ویرایشش کنید` });
    return { request: { ...r, state: 'APPROVED', ...decided }, applied: true, record };
  } catch (e) {
    // The record moved on while the request waited: what it asked for no longer applies.
    if (e instanceof AppError && e.code === 'STEP_BACK_MOVED_ON') {
      await prisma.stepBackRequest.update({ where: { id: r.id }, data: { state: 'LAPSED', ...decided } });
    }
    throw e;
  }
}

export async function withdrawStepBack(actor: StepActor, requestId: string) {
  const r = await prisma.stepBackRequest.findFirst({ where: { id: requestId, organizationId: actor.organizationId, requestedById: actor.id } });
  if (!r) throw notFound('درخواست');
  if (r.state !== 'PENDING') throw conflict('STEP_BACK_DECIDED', 'دربارهٔ این درخواست پیش‌تر تصمیم گرفته شده است.');
  return prisma.stepBackRequest.update({ where: { id: r.id }, data: { state: 'WITHDRAWN', decidedAt: new Date() } });
}

/** Requests waiting on this person, or theirs — with what each is about. */
export async function listStepBacks(actor: StepActor, which: 'awaiting' | 'mine') {
  const reach = await reachOf(actor);
  const where = which === 'mine'
    ? { organizationId: actor.organizationId, requestedById: actor.id }
    : {
        organizationId: actor.organizationId, state: 'PENDING', requestedById: { not: actor.id },
        ...(reach.all ? {} : { OR: [{ approverId: actor.id }, ...(reach.units.length ? [{ requestedById: { in: reach.users } }] : [])] }),
      };
  const rows = await prisma.stepBackRequest.findMany({
    where, orderBy: { createdAt: 'desc' }, take: 100,
    include: { requestedBy: { select: { id: true, fullName: true } }, approver: { select: { id: true, fullName: true } }, decidedBy: { select: { id: true, fullName: true } } },
  });
  // Each with the code and title of its record, read as the record is.
  return Promise.all(rows.map(async (r) => {
    const rec = WORKFLOWS[r.entityType]
      ? await delegate(prisma as unknown as Tx, r.entityType).findFirst({ where: { id: r.entityId }, select: recordSelect(r.entityType) }).catch(() => null)
      : null;
    return {
      ...r, entityFa: WORKFLOWS[r.entityType]?.labelFa ?? r.entityType,
      fromStateFa: stateLabelFa(r.fromState), toStateFa: stateLabelFa(r.toState),
      record: rec as Record<string, string | null> | null,
    };
  }));
}

/** The words a record is known by, where its model has them. */
/** What a record is called, as far as its model has the fields: code, number, title, name, subject. */
const NAME_FIELDS = ['code', 'number', 'title', 'name', 'subject'];
function recordSelect(entity: string): Record<string, true> {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name.toLowerCase() === entity.toLowerCase());
  const have = new Set(model?.fields.map((f) => f.name) ?? []);
  const picked = NAME_FIELDS.filter((f) => have.has(f));
  return Object.fromEntries((picked.length ? picked : ['id']).map((f) => [f, true]));
}
