import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { app, closeApp, get, login, post } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { ollama } from '../src/ai/ollama.js';
import { agrees, likeness, words } from '../src/ai/plans.js';
import { makesARecord } from '../src/ai/agent.js';

/**
 * Audit F-4: speaking to the assistant, and its proposals. «امروز پیش‌نویس لوگوی PRJ-000016 را تمام کردم
 * و سه ساعت رویش کار کردم» becomes a plan — submit the task, log the time — that writes nothing until
 * the person approves it, and then runs as them, through the ordinary API, audited.
 */

type Line = Record<string, unknown>;
let script: Line[][] = [];
const say = (text: string): Line[] => [{ message: { role: 'assistant', content: text }, done: false }, { message: { role: 'assistant', content: '' }, done: true }];
const callTool = (name: string, args: Record<string, unknown>): Line[] => [{ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: false }, { message: { role: 'assistant', content: '' }, done: true }];
let SPOKEN = '';
let PROJECT = '';
let heard: { fields: string; type: string } | null = null;

async function chat(token: string, message: string) {
  const res = await (await app()).inject({ method: 'POST', url: '/api/v1/ai/chat', payload: { message }, headers: { authorization: `Bearer ${token}` } });
  return res.body.split('\n\n').filter(Boolean).map((block) => ({ event: /event: (\w+)/.exec(block)?.[1] ?? '', data: JSON.parse(/data: (.*)/.exec(block)?.[1] ?? 'null') }));
}

async function speak(token: string, audio: Buffer, type = 'audio/webm') {
  const boundary = '----voice';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.webm"\r\nContent-Type: ${type}\r\n\r\n`), audio, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await (await app()).inject({ method: 'POST', url: '/api/v1/ai/voice/transcribe', payload, headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

describe('Voice and proposed actions (audit F-4)', () => {
  let server: http.Server, designer: string, pmo: string, taskId: string, taskCode: string;
  const saved = { ...ollama, url: env.TRANSCRIPTION_URL };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] })); return; }
        if (req.url === '/api/chat') { res.setHeader('content-type', 'application/x-ndjson'); res.end((script.shift() ?? say('—')).map((l) => JSON.stringify(l)).join('\n') + '\n'); return; }
        if (req.url === '/v1/audio/transcriptions') {
          heard = { fields: Buffer.concat(chunks).toString('latin1'), type: String(req.headers['content-type']) };
          res.end(JSON.stringify({ text: SPOKEN }));
          return;
        }
        res.statusCode = 404; res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    Object.assign(ollama, { url, model: 'qwen3:8b' });
    (env as { TRANSCRIPTION_URL: string }).TRANSCRIPTION_URL = `${url}/v1/audio/transcriptions`;

    designer = await login('designer@hiva.local');
    pmo = await login('pmo@hiva.local');
    const me = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    // The prompt's own example — «… for PRJ-000016 …» — on whichever project this database has.
    const project = await prisma.project.findFirstOrThrow({ where: { organizationId: me.organizationId }, orderBy: { code: 'asc' } });
    PROJECT = project.code;
    SPOKEN = `امروز پیش‌نویس لوگوی ${PROJECT} را تمام کردم و سه ساعت رویش کار کردم`;
    taskCode = `TSK-9${String(Date.now()).slice(-5)}`;
    taskId = (await prisma.task.create({
      data: {
        organizationId: me.organizationId, code: taskCode, projectId: project.id, title: 'پیش‌نویس لوگو', departmentCode: 'CR',
        sourceType: 'BRIEF', sourceRef: 'BRF-000007', createdById: me.id, assigneeId: me.id, state: 'IN_PROGRESS',
      },
    })).id;
  });
  afterAll(async () => {
    Object.assign(ollama, { url: saved.url, model: saved.model });
    (env as { TRANSCRIPTION_URL: string }).TRANSCRIPTION_URL = saved.url;
    server.close(); await closeApp();
  });

  it('hears speech on the installation’s own speech server, in Persian, and keeps no audio', async () => {
    const documents = await prisma.document.count();
    const r = await speak(designer, Buffer.from('fake-opus-bytes'));
    expect(r).toMatchObject({ status: 200, body: { text: SPOKEN } });
    expect(heard!.fields).toContain('name="language"\r\n\r\nfa');
    expect(await prisma.document.count()).toBe(documents);
    expect((await speak(designer, Buffer.from('x'), 'application/pdf')).status).toBe(400);
  });

  it('turns what was said into a plan that writes nothing until it is approved', async () => {
    script = [
      callTool('propose_actions', { steps: [
        { kind: 'task_submit', task: 'لوگو', project: PROJECT },
        { kind: 'log_time', task: 'لوگو', project: PROJECT, hours: 3, date: 'today', note: 'پیش‌نویس لوگو' },
      ] }),
      say('دو کار آماده است؛ بررسی و تأیید کنید.'),
    ];
    const events = await chat(designer, SPOKEN);
    const plan = events.find((e) => e.event === 'action' && e.data.type === 'plan')!.data;
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).toMatchObject({ kind: 'task_submit', request: { method: 'POST', path: `/workflow/task/${taskId}/transitions`, body: { action: 'submit' } } });
    expect(plan.steps[0].summary).toContain(taskCode);
    expect(plan.steps[1]).toMatchObject({ kind: 'log_time', request: { path: `/tasks/${taskId}/time`, body: { hours: 3 } } });
    expect(plan.steps.some((s: any) => s.issue)).toBe(false);

    // Nothing written: the task where it was, no time on it; the proposal itself audited.
    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).state).toBe('IN_PROGRESS');
    expect(await prisma.timeEntry.count({ where: { taskId } })).toBe(0);
    expect(await prisma.aiPlan.findUniqueOrThrow({ where: { id: plan.planId } })).toMatchObject({ status: 'PROPOSED' });
    expect(await prisma.auditEvent.count({ where: { entityType: 'aiPlan', entityId: plan.planId, action: 'AI_PLAN_PROPOSED' } })).toBe(1);

    // Not anyone else's to run.
    expect((await post(`/ai/plans/${plan.planId}/execute`, pmo, { steps: [0, 1] })).status).toBe(404);

    // Approved: each step through the ordinary API, as the person — the transition and the time entry
    // are theirs, with the workflow's own record.
    const done = await post(`/ai/plans/${plan.planId}/execute`, designer, { steps: [0, 1] });
    expect(done.body).toMatchObject({ status: 'EXECUTED', outcome: [{ index: 0, status: 'DONE' }, { index: 1, status: 'DONE' }] });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).state).toBe('SUBMITTED');
    expect(await prisma.stateTransition.count({ where: { entityId: taskId, action: 'submit', actorId: (await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } })).id } })).toBe(1);
    expect(Number((await prisma.timeEntry.findFirstOrThrow({ where: { taskId } })).hours)).toBe(3);
    expect(await prisma.auditEvent.count({ where: { entityType: 'aiPlan', entityId: plan.planId, action: 'AI_PLAN_EXECUTED' } })).toBe(1);
    // Its card, reopened later, reads what became of it — and only its owner may.
    expect((await get(`/ai/plans/${plan.planId}`, designer)).body).toMatchObject({ status: 'EXECUTED', expired: false, outcome: [{ status: 'DONE' }, { status: 'DONE' }] });
    expect((await get(`/ai/plans/${plan.planId}`, pmo)).status).toBe(404);
    // Once decided, it is not run again.
    expect((await post(`/ai/plans/${plan.planId}/execute`, designer, { steps: [0, 1] })).body.error.code).toBe('PLAN_DECIDED');
  });

  it('runs only the approved steps, says what the API refused, and lets the rest be declined', async () => {
    script = [callTool('propose_actions', { steps: [
      { kind: 'task_submit', task: taskCode },
      { kind: 'log_time', task: taskCode, hours: 1, date: 'yesterday' },
      { kind: 'create_task', project: PROJECT, title: 'نسخهٔ نهایی لوگو' },
    ] }), say('آماده است.')];
    const plan = (await chat(designer, 'تحویلش بده و یک ساعت دیروز هم ثبت کن')).find((e) => e.event === 'action' && e.data.type === 'plan')!.data;
    // A task without its source document is not approvable: Doc_H §6, said before, not after — in
    // the reader's language.
    expect(plan.steps[2].issue).toMatch(/Doc_H §6: هر وظیفه/);
    const r = await post(`/ai/plans/${plan.planId}/execute`, designer, { steps: [0] });
    // Already submitted: the workflow refuses, in its own words.
    expect(r.body.status).toBe('FAILED');
    expect(r.body.outcome[0]).toMatchObject({ index: 0, status: 'FAILED' });
    expect(r.body.outcome[0].message).toBeTruthy();
    expect(r.body.outcome.slice(1).map((o: any) => o.status)).toEqual(['DECLINED', 'DECLINED']);
    expect(await prisma.timeEntry.count({ where: { taskId } })).toBe(1);

    script = [callTool('propose_actions', { steps: [{ kind: 'log_time', task: taskCode, hours: 2 }] }), say('آماده است.')];
    const second = (await chat(designer, 'دو ساعت دیگر ثبت کن')).find((e) => e.event === 'action' && e.data.type === 'plan')!.data;
    expect((await post(`/ai/plans/${second.planId}/decline`, designer, {})).body.status).toBe('DECLINED');
    expect(await prisma.timeEntry.count({ where: { taskId } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { entityType: 'aiPlan', entityId: second.planId, action: 'AI_PLAN_DECLINED' } })).toBe(1);
  });

  it('finds the task as it was said, not only as it is spelt — among the person’s own when no project is named', async () => {
    const me = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    const project = await prisma.project.findFirstOrThrow({ where: { code: PROJECT } });
    const other = await prisma.task.create({ data: {
      organizationId: me.organizationId, code: `TSK-8${String(Date.now()).slice(-5)}`, projectId: project.id, title: 'برنامه کمپین Performance',
      departmentCode: 'CR', sourceType: 'BRIEF', sourceRef: 'BRF-000007', createdById: me.id, assigneeId: me.id, state: 'IN_PROGRESS',
    } });
    // Spoken: «برنامهٔ» with its hamza, a zero-width joiner, Arabic ي — and the project in the same breath.
    script = [callTool('propose_actions', { steps: [
      { kind: 'log_time', task: 'برنامهٔ\u200cکمپين Performance', hours: 2 },
      { kind: 'task_submit', task: `امروز برنامهٔ کمپین Performance در ${PROJECT} را تمام کردم` },
      { kind: 'log_time', task: 'چیزی که نیست', hours: 1 },
    ] }), say('آماده است.')];
    const plan = (await chat(designer, 'ثبت کن')).find((e) => e.event === 'action' && e.data.type === 'plan')!.data;
    expect(plan.steps[0]).toMatchObject({ request: { path: `/tasks/${other.id}/time` } });
    expect(plan.steps[1]).toMatchObject({ request: { path: `/workflow/task/${other.id}/transitions`, body: { action: 'submit' } } });
    expect(plan.steps[2].issue).toBe('در وظیفه‌های خودتان عنوانی مانند «چیزی که نیست» نیست؛ کد وظیفه (TSK-…) یا پروژه‌اش (PRJ-…) را بگویید.');
    await post(`/ai/plans/${plan.planId}/decline`, designer, {});

    // A code the model made up does not stand: the person's own words this turn are tried, and the
    // step shows the task they name — its real code — before anything is approved.
    script = [callTool('propose_actions', { steps: [{ kind: 'task_submit', task: 'TSK-999999' }, { kind: 'log_time', task: 'TSK-999998', hours: 1 }] }), say('آماده است.')];
    const guessed = (await chat(designer, 'امروز پیش‌نویس لوگو را تمام کردم')).find((e) => e.event === 'action' && e.data.type === 'plan')!.data;
    expect(guessed.steps[0]).toMatchObject({ request: { path: `/workflow/task/${taskId}/transitions` } });
    expect(guessed.steps[0].summary).toContain(taskCode);
    expect(guessed.steps[1]).toMatchObject({ request: { path: `/tasks/${taskId}/time` } });
    await post(`/ai/plans/${guessed.planId}/decline`, designer, {});
  });

  it('compares Persian in one form, and prefers the fuller title', () => {
    expect(words('برنامهٔ\u200cکمپين Performance')).toEqual(['برنامه', 'کمپین', 'performance']);
    expect(likeness('برنامه کمپین Performance', 'امروز برنامهٔ کمپین Performance را تمام کردم')).toEqual({ score: 1, hits: 3 });
    expect(likeness('کار', 'امروز برنامهٔ کمپین Performance را تمام کردم').score).toBe(0);
    expect(likeness('پیش‌نویس لوگو', 'لوگو')).toEqual({ score: 1, hits: 1 });
  });

  it('moves a task as the workflow allows, with the reason a move needs', async () => {
    script = [callTool('propose_actions', { steps: [
      { kind: 'task_move', task: taskCode, action: 'block' },
      { kind: 'task_move', task: taskCode, action: 'assign' },
      { kind: 'task_move', task: taskCode, action: 'qc_approve' },
    ] }), say('آماده است.')];
    const plan = (await chat(designer, 'بگو گیر کرده‌ام')).find((e) => e.event === 'action' && e.data.type === 'plan')!.data;
    expect(plan.steps[0].issue).toBe('«اعلام مانع/تأخیر» دلیل می‌خواهد.');
    expect(plan.steps[1].issue).toMatch(/کاری نیست/);
    // A move the person may not make is proposed as asked — the workflow refuses it, as it would on the page.
    expect(plan.steps[2]).toMatchObject({ request: { path: `/workflow/task/${taskId}/transitions`, body: { action: 'qc_approve' } } });
    expect(plan.steps[2].summary).toContain('تأیید در QC');
    const r = await post(`/ai/plans/${plan.planId}/execute`, designer, { steps: [0, 2] });
    expect(r.body.outcome.map((o: any) => o.status)).toEqual(['FAILED', 'DECLINED', 'FAILED']);
    expect(r.body.outcome[0]).toMatchObject({ code: 'NOT_APPROVABLE', message: '«اعلام مانع/تأخیر» دلیل می‌خواهد.' });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).state).toBe('SUBMITTED');
  });

  it('does not run a plan that has gone stale', async () => {
    script = [callTool('propose_actions', { steps: [{ kind: 'log_time', task: taskCode, hours: 1 }] }), say('آماده است.')];
    const plan = (await chat(designer, 'یک ساعت ثبت کن')).find((e) => e.event === 'action' && e.data.type === 'plan')!.data;
    await prisma.aiPlan.update({ where: { id: plan.planId }, data: { createdAt: new Date(Date.now() - 31 * 60_000) } });
    expect((await post(`/ai/plans/${plan.planId}/execute`, designer, { steps: [0] })).body.error.code).toBe('PLAN_EXPIRED');
    expect((await get(`/ai/plans/${plan.planId}`, designer)).body).toMatchObject({ status: 'PROPOSED', expired: true });
  });

  // The owner's report (2026-10-23): a step that failed only after it was approved — a source type of
  // "manual", a deadline in 2023 — and a «بساز» typed in reply that the model answered with another plan.
  it('checks a step as the page would, so the model mends it before anyone is asked to approve', async () => {
    const planOf = async (steps: unknown[]) => {
      script = [callTool('propose_actions', { steps }), say('—')];
      return (await chat(designer, 'یک وظیفه بساز')).find((e) => e.event === 'action' && e.data.type === 'plan')!.data as { steps: { issue?: string; request: { body: Record<string, unknown> } }[] };
    };
    const made = (extra: Record<string, unknown>) => ({ kind: 'create_task', project: PROJECT, title: 'طراحی بنر', sourceRef: 'BRF-000007', ...extra });
    expect((await planOf([made({ sourceType: 'manual' })])).steps[0]!.issue).toMatch(/نوع سند مبدأ «manual» شناخته نیست/);
    const brief = (await planOf([made({ sourceType: 'brief' })])).steps[0]!;
    expect([brief.issue, brief.request.body.sourceType]).toEqual([undefined, 'BRIEF']);
    expect((await planOf([made({ sourceType: 'BRIEF', dueDate: '2023-10-01' })])).steps[0]!.issue).toMatch(/گذشته است/);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect((await planOf([{ kind: 'log_time', task: taskCode, hours: 1, date: tomorrow }])).steps[0]!.issue).toMatch(/روزی که نیامده/);
  });

  it('runs the waiting proposal when the person agrees in words — the model is not asked again', async () => {
    script = [callTool('propose_actions', { steps: [{ kind: 'log_time', task: taskCode, hours: 2, date: 'today' }] }), say('تأیید می‌کنید؟')];
    const first = await chat(designer, 'دو ساعت روی لوگو کار کردم');
    const conversationId = first.find((e) => e.event === 'meta')!.data.conversationId as string;
    const planId = first.find((e) => e.event === 'action' && e.data.type === 'plan')!.data.planId as string;
    const before = await prisma.timeEntry.count({ where: { taskId } });
    script = [say('این را نباید کسی بشنود')];
    const yes = await (await app()).inject({ method: 'POST', url: '/api/v1/ai/chat', payload: { message: 'بله، بساز', conversationId }, headers: { authorization: `Bearer ${designer}` } });
    const events = yes.body.split('\n\n').filter(Boolean).map((block) => ({ event: /event: (\w+)/.exec(block)?.[1] ?? '', data: JSON.parse(/data: (.*)/.exec(block)?.[1] ?? 'null') }));
    expect(events.find((e) => e.event === 'delta')!.data.text).toMatch(/^انجام شد:\n- ✓ ثبت ۲ ساعت/);
    expect(events.find((e) => e.event === 'done')!.data.planDecided).toBe(planId);
    expect(script.length).toBe(1); // the model was not called
    expect(await prisma.timeEntry.count({ where: { taskId } })).toBe(before + 1);
    expect(await prisma.aiPlan.findUniqueOrThrow({ where: { id: planId } })).toMatchObject({ status: 'EXECUTED' });
    script = [];
    // A new request is not a yes.
    expect(agrees('بله')).toBe(true);
    expect(agrees('انجام بده')).toBe(true);
    expect(agrees('Yes, do it')).toBe(true);
    expect(agrees('بساز یک پروژه')).toBe(false);
    expect(agrees('نه')).toBe(false);
    expect(agrees('لطفاً')).toBe(false);
  });

  it('opens the form for a project, a client or a lead asked for in words — there is no step for them', async () => {
    expect(makesARecord('یک پروژه با عنوان جدید برای من ایجاد کن')?.code).toBe('B14_PROJECT_DEFINITION');
    expect(makesARecord('مشتری تازه ثبت کن')?.code).toBe('A03_CUSTOMER_INFO');
    expect(makesARecord('create a new lead')?.code).toBe('A01_LEAD');
    expect(makesARecord('کدام پروژه‌ها در خطرند؟')).toBeNull();
    expect(makesARecord('یک وظیفه برای پروژه بساز')).toBeNull();
    const admin = await login('admin@hiva.local');
    // What a small model did: a task named like the project, and «done».
    script = [callTool('propose_actions', { steps: [{ kind: 'create_task', project: PROJECT, title: 'ایجاد پروژه جدید', sourceType: 'BRIEF', sourceRef: 'x' }] }), say('پروژه ساخته شد.')];
    let events = await chat(admin, 'یک پروژه با عنوان جدید برای من ایجاد کن');
    expect(events.filter((e) => e.event === 'action').map((e) => [e.data.type, e.data.code])).toEqual([['form', 'B14_PROJECT_DEFINITION']]);
    // An answer with no form gets it.
    script = [say('باشد.')];
    events = await chat(admin, 'یک پروژه جدید بساز');
    expect(events.find((e) => e.event === 'action')!.data).toMatchObject({ type: 'form', code: 'B14_PROJECT_DEFINITION' });
    expect(events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('')).toMatch(/فرم تعریف پروژه/);
    script = [];
  });

  it('ends a ready proposal with what is true: nothing done yet, and how to approve', async () => {
    script = [callTool('propose_actions', { steps: [{ kind: 'log_time', task: taskCode, hours: 1, date: 'today' }] }), say('✅ ثبت شد')];
    const events = await chat(designer, 'یک ساعت ثبت کن');
    const said = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    expect(said).toMatch(/هنوز کاری انجام نشده است/);
    expect(said).not.toMatch(/ثبت شد/);
    script = [];
  });

  it('never leaves the person with a blank reply: asks the model once more, then says so', async () => {
    script = [say(''), say('پاسخ دوم.')];
    expect((await chat(designer, 'سلام')).filter((e) => e.event === 'delta').map((e) => e.data.text).join('')).toBe('پاسخ دوم.');
    script = [say(''), say('')];
    expect((await chat(designer, 'سلام')).filter((e) => e.event === 'delta').map((e) => e.data.text).join('')).toMatch(/نتوانستم پاسخی بسازم/);
  });

  it('lets the page use the microphone, its own origin only (audit SEC-9)', () => {
    const headers = readFileSync(path.resolve(__dirname, '../../../infrastructure/docker/security-headers.conf'), 'utf8');
    expect(headers).toMatch(/Permissions-Policy "geolocation=\(\), microphone=\(self\), camera=\(\)"/);
  });
});
