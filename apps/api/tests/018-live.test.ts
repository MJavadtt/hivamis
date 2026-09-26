import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { app, closeApp, login, move, post, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';
import { nextCode } from '../src/lib/codes.js';
import { notify } from '../src/mail/notify.js';
import { liveBus } from '../src/live/bus.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let base: string;

/** A reader of the stream, as the page's fetch-based client reads it. */
async function stream(token: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/v1/events`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: ctrl.signal });
  const events: { event: string; data: any }[] = [];
  if (res.ok) {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (event) events.push({ event, data: data ? JSON.parse(data) : null });
          }
        }
      } catch { /* aborted */ }
    })();
  }
  const until = async (pred: (e: { event: string; data: any }) => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const e = events.find(pred); if (e) return e; await sleep(20); }
    throw new Error(`no matching event in ${ms}ms; got ${JSON.stringify(events.map((e) => e.event))}`);
  };
  return { res, events, until, close: () => ctrl.abort() };
}

describe('Live updates', () => {
  let T: Record<string, string>;
  let am: Awaited<ReturnType<typeof stream>>, designer: Awaited<ReturnType<typeof stream>>;
  let org: string, amId: string;

  beforeAll(async () => {
    const a = await app();
    await a.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(a.server.address() as AddressInfo).port}`;
    T = { am: await login('account.manager@hiva.local'), designer: await login('designer@hiva.local'), finance: await login('finance@hiva.local') };
    org = (await prisma.organization.findFirstOrThrow()).id;
    amId = (await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } })).id;
    am = await stream(T.am);
    designer = await stream(T.designer);
    await am.until((e) => e.event === 'ready');
    await designer.until((e) => e.event === 'ready');
  });
  afterAll(async () => { am?.close(); designer?.close(); await closeApp(); });

  it('opens only with a session, and says when it is listening', async () => {
    expect((await stream('')).res.status).toBe(401);
    expect(am.res.headers.get('content-type')).toContain('text/event-stream');
    expect(am.res.headers.get('x-accel-buffering')).toBe('no');
    expect(am.events.find((e) => e.event === 'ready')!.data).toEqual({ live: true });
  });

  it('announces a committed move — to whoever may read that kind of record, and only them', async () => {
    const owner = await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } });
    const company = await prisma.company.findFirstOrThrow();
    const project = await prisma.project.create({ data: { organizationId: org, code: await nextCode(prisma, 'project'), name: 'پروژهٔ زنده', companyId: company.id, accountOwnerId: owner.id, state: 'ACTIVE' } });
    const invoiceId = expectOk(await post('/invoices', T.finance, {
      kind: 'INVOICE', companyId: company.id, projectId: project.id, number: 'LIVE-1', issueDate: new Date().toISOString(), lines: [{ description: 'خدمات', quantity: 1, unitPrice: 1000 }],
    }), 'invoice').id;
    expectOk(await move('invoice', invoiceId, 'issue', T.finance), 'issue');
    const seen = await am.until((e) => e.event === 'transition' && e.data.id === invoiceId);
    expect(seen.data).toMatchObject({ entity: 'invoice', from: 'DRAFT', to: 'ISSUED', action: 'issue', mine: false });
    expect(Object.keys(seen.data).sort()).toEqual(['action', 'at', 'entity', 'from', 'id', 'mine', 'to']);   // that it moved — not what it holds

    // The designer may read deliverables but not finance: the same stream carries one and not the other.
    const d = await prisma.deliverable.create({ data: { organizationId: org, code: await nextCode(prisma, 'deliverable'), projectId: project.id, name: 'بنر', departmentCode: 'CR', state: 'DELIVERED' } });
    expectOk(await move('deliverable', d.id, 'client_accept', T.am), 'accept');
    await designer.until((e) => e.event === 'transition' && e.data.id === d.id);
    expect((await am.until((e) => e.event === 'transition' && e.data.id === d.id)).data.mine).toBe(true);
    expect(designer.events.some((e) => e.data?.id === invoiceId)).toBe(false);
  });

  it('never announces what was rolled back, nor another organisation’s moves', async () => {
    const ghost = '00000000-0000-4000-8000-00000000abcd';
    await prisma.$transaction(async (tx) => {
      await tx.stateTransition.create({ data: { organizationId: org, entityType: 'deliverable', entityId: ghost, fromState: 'A', toState: 'B', action: 'x', actorId: amId } });
      throw new Error('rolled back');
    }).catch(() => undefined);
    const other = '00000000-0000-4000-8000-00000000beef';
    await prisma.stateTransition.create({ data: { organizationId: other, entityType: 'deliverable', entityId: other, fromState: 'A', toState: 'B', action: 'x', actorId: amId } });
    await sleep(600);
    expect(am.events.some((e) => e.data?.id === ghost || e.data?.id === other)).toBe(false);
  });

  it('brings each person their own notifications', async () => {
    await notify({ userId: amId, kind: 'LIVE_TEST', title: 'آزمون', severity: 'WARNING' });
    expect((await am.until((e) => e.event === 'notification')).data).toEqual({ kind: 'LIVE_TEST', severity: 'WARNING' });
    await sleep(300);
    expect(designer.events.some((e) => e.event === 'notification')).toBe(false);
  });

  it('survives losing its database connection: says “reset”, reconnects, and carries on', async () => {
    await prisma.$executeRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'hiva-live' AND pid <> pg_backend_pid()`);
    await am.until((e) => e.event === 'reset');
    expect(await liveBus.ready(10_000)).toBe(true);
    await notify({ userId: amId, kind: 'AFTER_RESET', title: 'پس از قطع' });
    await am.until((e) => e.event === 'notification' && e.data.kind === 'AFTER_RESET', 8000);
  }, 20_000);

  it('caps the streams one person may hold open', async () => {
    const more = [await stream(T.finance), await stream(T.finance), await stream(T.finance), await stream(T.finance), await stream(T.finance)];
    const sixth = await stream(T.finance);
    expect(sixth.res.status).toBe(429);
    for (const s of more) s.close();
    await sleep(200);
    const again = await stream(T.finance);
    expect(again.res.status).toBe(200);
    again.close();
  });
});
