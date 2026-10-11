import { describe, it, expect, afterAll } from 'vitest';
import { closeApp } from './helpers.js';
import { prisma } from '../src/db.js';
import { enqueueDeliveries } from '../src/integrations/webhooks.js';

/**
 * Audit LOG-1: the dispatcher read the transition log by createdAt — the moment a transaction began.
 * A transaction that began first and committed last wrote a row behind a cursor that had already
 * passed it, and that event was never sent. Read by transaction id below the oldest one running, it is.
 */
/** Enqueue until `done`: another test file's write transaction may hold the horizon back for a moment. */
async function enqueueUntil(done: () => Promise<boolean>) {
  for (let i = 0; i < 50 && !(await done()); i++) { await enqueueDeliveries(); if (!(await done())) await new Promise((r) => setTimeout(r, 100)); }
}

describe('Webhooks read every transition, however the transactions overlap (audit LOG-1)', () => {
  afterAll(async () => { await closeApp(); });

  it('sends the row of a transaction that began first and committed last', async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@hiva.local' } });
    const org = admin.organizationId;
    const sub = await prisma.webhookSubscription.create({
      data: { organizationId: org, name: 'گیرنده', url: 'https://receiver.example/hook', secret: 'whsec_test', events: ['lead.*'], createdById: admin.id },
    });
    const lead = await prisma.lead.findFirstOrThrow({ where: { organizationId: org } });
    const transition = (reason: string) => ({ organizationId: org, entityType: 'lead', entityId: lead.id, fromState: 'NEW', toState: 'CONTACTED', action: 'contact', reason, actorId: admin.id });

    // A slow transaction writes first, and stays open.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let wrote!: () => void;
    const written = new Promise<void>((r) => { wrote = r; });
    const slow = prisma.$transaction(async (tx) => {
      await tx.stateTransition.create({ data: transition('slow') });
      wrote();
      await held;
    }, { timeout: 30_000 });
    await written;

    // A quick one writes after it, and commits at once.
    await prisma.stateTransition.create({ data: transition('quick') });
    const reasons = async () => (await prisma.webhookDelivery.findMany({ where: { subscriptionId: sub.id } }))
      .map((d) => (d.payload as { data: { reason: string } }).data.reason).sort();

    // While the slow one is open the dispatcher waits below it: the quick row is not sent ahead of it…
    await enqueueDeliveries();
    expect(await reasons()).toEqual([]);

    // …and once it commits, both are — the slow row included, which a createdAt cursor had passed.
    release();
    await slow;
    await enqueueUntil(async () => (await reasons()).length === 2);
    expect(await reasons()).toEqual(['quick', 'slow']);

    // Read again, nothing is sent twice.
    await enqueueDeliveries();
    expect(await prisma.webhookDelivery.count({ where: { subscriptionId: sub.id } })).toBe(2);
  }, 60_000);

  it('starts a new subscription at its own beginning: nothing from before it is sent', async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@hiva.local' } });
    const lead = await prisma.lead.findFirstOrThrow({ where: { organizationId: admin.organizationId } });
    await prisma.stateTransition.create({ data: { organizationId: admin.organizationId, entityType: 'lead', entityId: lead.id, fromState: 'NEW', toState: 'CONTACTED', action: 'contact', reason: 'before', actorId: admin.id } });
    const sub = await prisma.webhookSubscription.create({
      data: { organizationId: admin.organizationId, name: 'تازه', url: 'https://receiver.example/new', secret: 'whsec_test', events: ['lead.*'], createdById: admin.id },
    });
    await prisma.stateTransition.create({ data: { organizationId: admin.organizationId, entityType: 'lead', entityId: lead.id, fromState: 'NEW', toState: 'CONTACTED', action: 'contact', reason: 'after', actorId: admin.id } });
    await enqueueUntil(async () => (await prisma.webhookDelivery.count({ where: { subscriptionId: sub.id } })) > 0);
    const sent = await prisma.webhookDelivery.findMany({ where: { subscriptionId: sub.id } });
    expect(sent.map((d) => (d.payload as { data: { reason: string } }).data.reason)).toEqual(['after']);
  });
});
