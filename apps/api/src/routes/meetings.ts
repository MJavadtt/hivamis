import type { FastifyPluginAsync } from 'fastify';
import { draftMinutesSchema, recordMinutesSchema } from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { nextCode } from '../lib/codes.js';
import { startSla } from '../sla/engine.js';
import { draftMinutes } from '../meetings/extract.js';
import { transcribe, transcriptionConfigured } from '../meetings/transcribe.js';
import { fa } from '../pdf/fmt.js';
import { notify } from '../mail/notify.js';

const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/ogg', 'video/mp4']);

/**
 * From a meeting to its minutes to its tasks (roadmap #23). Doc_H §6 says no verbal task is
 * valid; this is the path that makes the rule followable rather than merely required — the notes
 * become a draft, the person who ran the meeting confirms it, and each confirmed action becomes a
 * task sourced to the meeting's minutes.
 */
const meetingRoutes: FastifyPluginAsync = async (app) => {
  /** Whether a recording can be sent at all — the page asks before offering the button. */
  app.get('/meetings/capabilities', { preHandler: [app.authenticate] }, async () => ({
    transcription: transcriptionConfigured(),
  }));

  /** A draft from notes or a transcript. Nothing is written: the draft is for a person to correct. */
  app.post('/meetings/:id/draft-minutes', {
    preHandler: [app.authenticate, app.requirePermissions('meeting.write')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const { notes } = parse(draftMinutesSchema, req.body);
    const meeting = await prisma.meeting.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!meeting) throw notFound('جلسه');
    const people = await prisma.user.findMany({
      where: { organizationId: actor.organizationId, isActive: true, deletedAt: null },
      select: { id: true, fullName: true, department: { select: { code: true } } },
    });
    const draft = draftMinutes(notes, meeting.heldAt, people.map((p) => ({ id: p.id, fullName: p.fullName, departmentCode: p.department?.code ?? null })));
    return {
      meetingId: id, projectId: meeting.projectId,
      // Tasks need a project to belong to; a meeting without one can still keep its minutes.
      canCreateTasks: !!meeting.projectId,
      ...draft,
    };
  });

  /** A recording, turned into text by the configured service — then drafted like typed notes. */
  app.post('/meetings/:id/transcribe', {
    preHandler: [app.authenticate, app.requirePermissions('meeting.write')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const meeting = await prisma.meeting.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true } });
    if (!meeting) throw notFound('جلسه');
    const file = await req.file({ limits: { fileSize: MAX_AUDIO_BYTES } });
    if (!file) throw badRequest('NO_FILE', 'فایل صوتی ارسال نشده است');
    if (!AUDIO_TYPES.has(file.mimetype)) throw badRequest('UNSUPPORTED_TYPE', `نوع فایل «${file.mimetype}» صوت جلسه نیست`);
    const audio = await file.toBuffer();
    const result = await transcribe(audio, file.filename, file.mimetype);
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'MEETING_TRANSCRIBED',
      entityType: 'meeting', entityId: id, after: { bytes: audio.length, model: result.model, characters: result.text.length },
      ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return { transcript: result.text, model: result.model };
  });

  /**
   * The confirmed minutes. Every action is kept in the minutes; each one marked `createTask`
   * also becomes a task — ASSIGNED with its acceptance clock running when it has an owner, as a
   * task created any other way would be — sourced to this meeting's minutes. One transaction:
   * minutes that name tasks which failed to exist would be a false record.
   */
  app.post('/meetings/:id/minutes', {
    preHandler: [app.authenticate, app.requirePermissions('meeting.write')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(recordMinutesSchema, req.body);
    const meeting = await prisma.meeting.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!meeting) throw notFound('جلسه');

    const toCreate = input.actions.filter((a) => a.createTask);
    if (toCreate.length && !meeting.projectId) {
      throw badRequest('MEETING_HAS_NO_PROJECT', 'این جلسه به پروژه‌ای وصل نیست؛ اقدام‌ها در صورتجلسه ثبت می‌شوند اما وظیفه ساخته نمی‌شود — تیک «ساخت وظیفه» را بردارید یا جلسه را به پروژه وصل کنید');
    }
    const assigneeIds = [...new Set(toCreate.map((a) => a.assigneeId).filter((x): x is string => !!x))];
    const assignees = await prisma.user.findMany({
      where: { id: { in: assigneeIds }, organizationId: actor.organizationId, isActive: true, deletedAt: null },
      select: { id: true, department: { select: { code: true } } },
    });
    const deptOf = new Map(assignees.map((u) => [u.id, u.department?.code ?? null]));
    const problems: string[] = [];
    for (const [i, a] of toCreate.entries()) {
      if (a.assigneeId && !deptOf.has(a.assigneeId)) problems.push(`اقدام ${fa(i + 1)}: مسئول انتخاب‌شده فعال نیست یا در این سازمان نیست`);
      if (!a.departmentCode && !(a.assigneeId && deptOf.get(a.assigneeId))) problems.push(`اقدام ${fa(i + 1)} («${a.title}»): واحد مسئول مشخص نیست`);
    }
    if (problems.length) throw badRequest('INVALID_ACTIONS', 'برخی اقدام‌ها کامل نیستند', { problems });

    const result = await prisma.$transaction(async (tx) => {
      const created: { id: string; code: string; title: string; assigneeId: string | null }[] = [];
      for (const a of toCreate) {
        const task = await tx.task.create({
          data: {
            organizationId: actor.organizationId, code: await nextCode(tx, 'task'),
            projectId: meeting.projectId!, title: a.title,
            departmentCode: a.departmentCode ?? deptOf.get(a.assigneeId!)!,
            assigneeId: a.assigneeId ?? null, dueDate: a.dueDate ?? null, priority: a.priority,
            // Doc_H §6: the source document is this meeting's minutes.
            sourceType: 'MEETING_MINUTES', sourceRef: meeting.code,
            state: a.assigneeId ? 'ASSIGNED' : 'CREATED', createdById: actor.id,
          },
        });
        if (task.assigneeId) {
          await startSla(tx, {
            organizationId: actor.organizationId, policyCode: 'SLA_TASK_ACCEPTANCE',
            entityType: 'task', entityId: task.id, ownerId: task.assigneeId,
          });
        }
        await audit({
          organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE',
          entityType: 'task', entityId: task.id, after: task,
          ipAddress: actor.ipAddress, requestId: actor.requestId,
        }, tx);
        created.push({ id: task.id, code: task.code, title: task.title, assigneeId: task.assigneeId });
      }

      // The minutes list every action, with the task it became when it became one.
      let n = 0;
      const actions = input.actions.map((a) => ({
        action: a.title, ownerId: a.assigneeId ?? null, dueDate: a.dueDate ?? null,
        taskId: a.createTask ? created[n++]!.id : null,
      }));
      const updated = await tx.meeting.update({
        where: { id },
        data: {
          decisions: input.decisions || null, actions: actions as object,
          minutesRecordedAt: new Date(), minutesSource: input.source ?? null,
        },
      });
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE',
        entityType: 'meeting', entityId: id,
        before: { minutesRecordedAt: meeting.minutesRecordedAt, actions: meeting.actions },
        after: { minutesRecordedAt: updated.minutesRecordedAt, actions, tasksCreated: created.length },
        ipAddress: actor.ipAddress, requestId: actor.requestId,
      }, tx);
      return { meeting: updated, tasks: created };
    });
    // After the commit: an owner who was not in the room learns of the task before its
    // acceptance clock runs out, not from a breach. Not emailed; the queue is where it lives.
    for (const t of result.tasks) {
      if (!t.assigneeId || t.assigneeId === actor.id) continue;
      await notify({
        userId: t.assigneeId, kind: 'MEETING_ACTION_ASSIGNED',
        title: `وظیفه از صورتجلسهٔ ${meeting.code} — ${t.code}`,
        body: `«${t.title}» از جلسهٔ «${meeting.subject}» به شما سپرده شد؛ پذیرش آن را ثبت کنید — مهلت پذیرش از همین حالا در جریان است.`,
        entityType: 'task', entityId: t.id,
      });
    }
    return reply.code(201).send(result);
  });
};

export default meetingRoutes;
