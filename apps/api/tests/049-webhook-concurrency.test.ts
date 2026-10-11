import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { closeApp } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { sendDue } from '../src/integrations/webhooks.js';

/**
 * Audit PERF-2: deliveries went out one after another, so one receiver taking its ten seconds held up
 * every other. Now each receiver has its own lane, one delivery at a time, and lanes run side by side.
 */
describe('Webhook sending (audit PERF-2)', () => {
  let server: http.Server;
  let base = '';
  const inFlight = new Map<string, number>();
  const most = new Map<string, number>();
  const done: { path: string; at: number }[] = [];
  const original = env.WEBHOOK_ALLOW_PRIVATE;

  beforeAll(async () => {
    env.WEBHOOK_ALLOW_PRIVATE = true; // the receivers below live on 127.0.0.1
    server = http.createServer((req, res) => {
      const path = req.url ?? '';
      inFlight.set(path, (inFlight.get(path) ?? 0) + 1);
      most.set(path, Math.max(most.get(path) ?? 0, inFlight.get(path)!));
      req.resume();
      setTimeout(() => {
        inFlight.set(path, inFlight.get(path)! - 1);
        done.push({ path, at: Date.now() });
        res.end('ok');
      }, path === '/slow' ? 400 : 5);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { env.WEBHOOK_ALLOW_PRIVATE = original; await new Promise((r) => server.close(r)); await closeApp(); });

  it('lets a slow receiver hold up only itself, and never sends one receiver two at once', async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@hiva.local' } });
    const make = async (path: string) => {
      const sub = await prisma.webhookSubscription.create({ data: { organizationId: admin.organizationId, name: path, url: `${base}${path}`, secret: 'whsec_test', events: ['*'], createdById: admin.id } });
      await prisma.webhookDelivery.createMany({
        data: Array.from({ length: 4 }, (_, i) => ({ organizationId: admin.organizationId, subscriptionId: sub.id, event: 'ping', payload: { n: i }, nextAttemptAt: new Date(Date.now() - 60_000 + i) })),
      });
    };
    await make('/slow');
    await make('/fast');
    const started = Date.now();
    const result = await sendDue(new Date(), 100, 8);
    expect(result).toEqual({ delivered: 8, failed: 0 });
    // The fast receiver had everything long before the slow one finished its four.
    const fastDone = Math.max(...done.filter((d) => d.path === '/fast').map((d) => d.at)) - started;
    const slowDone = Math.max(...done.filter((d) => d.path === '/slow').map((d) => d.at)) - started;
    expect(fastDone).toBeLessThan(400);
    expect(slowDone).toBeGreaterThanOrEqual(1500);
    expect([most.get('/slow'), most.get('/fast')]).toEqual([1, 1]);
  });
});
