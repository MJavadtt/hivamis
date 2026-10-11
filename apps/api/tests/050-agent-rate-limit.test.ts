import { describe, it, expect, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { env } from '../src/env.js';
import { buildApp } from '../src/app.js';
import { asAgentFor } from '../src/lib/request-context.js';
import { prisma } from '../src/db.js';

/**
 * Audit PERF-1: the assistant's reads all came from 127.0.0.1 in-process, so every person's assistant
 * shared one rate-limit bucket — one busy person's questions refused everyone else's. Now they count
 * against the person they are for, and nothing a request says can make it count as someone else's.
 */
describe('The assistant’s reads and the rate limit (audit PERF-1)', () => {
  let app: FastifyInstance;
  const was = env.RATE_LIMIT_MAX;
  afterAll(async () => { env.RATE_LIMIT_MAX = was; await app?.close(); await prisma.$disconnect(); });

  it('counts each person’s assistant on its own, and the address on its own', async () => {
    env.RATE_LIMIT_MAX = 3;
    app = await buildApp();
    await app.ready();
    const hit = (headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: '/api/v1/auth/methods', headers }).then((r) => r.statusCode);
    const asAgent = (userId: string) => asAgentFor(userId, () => hit());

    // One person's assistant spends its three…
    expect([await asAgent('person-a'), await asAgent('person-a'), await asAgent('person-a'), await asAgent('person-a')]).toEqual([200, 200, 200, 429]);
    // …and neither another person's assistant nor a browser at the same address is refused for it.
    expect(await asAgent('person-b')).toBe(200);
    expect([await hit(), await hit(), await hit(), await hit()]).toEqual([200, 200, 200, 429]);
    // A request cannot claim to be someone's assistant: nothing it sends is read for that.
    expect(await hit({ 'x-hiva-agent': 'person-c', 'x-forwarded-for': '10.9.9.9' })).toBe(429);
    expect(await asAgent('person-b')).toBe(200);
  });
});
