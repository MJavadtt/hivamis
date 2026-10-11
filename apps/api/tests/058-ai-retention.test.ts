import { describe, it, expect, afterAll } from 'vitest';
import { closeApp } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { pruneAiToolRows } from '../src/ai/retention.js';

/** Audit PERF-5: the assistant's tool results are kept AI_HISTORY_RETENTION_DAYS, the conversation itself as long as its owner keeps it. */
describe('Assistant history retention (audit PERF-5)', () => {
  afterAll(async () => { await closeApp(); });

  it('removes old tool results, and keeps what was asked and answered, and anything recent', async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { email: 'sales@hiva.local' } });
    const conversation = await prisma.aiConversation.create({ data: { organizationId: user.organizationId, userId: user.id, title: 'گفت‌وگوی قدیمی' } });
    const old = new Date(Date.now() - (env.AI_HISTORY_RETENTION_DAYS + 1) * 86_400_000);
    const recent = new Date(Date.now() - 86_400_000);
    const row = (role: string, createdAt: Date) => prisma.aiMessage.create({ data: { conversationId: conversation.id, role, content: `${role}-${createdAt.getTime()}`, createdAt, ...(role === 'tool' ? { toolName: 'get_record' } : {}) } });
    const [oldTool, oldUser, oldAnswer, newTool] = [await row('tool', old), await row('user', old), await row('assistant', old), await row('tool', recent)];

    expect(await pruneAiToolRows()).toBeGreaterThanOrEqual(1);
    const left = new Set((await prisma.aiMessage.findMany({ where: { conversationId: conversation.id }, select: { id: true } })).map((m) => m.id));
    expect(left.has(oldTool.id)).toBe(false);
    expect([oldUser, oldAnswer, newTool].every((m) => left.has(m.id))).toBe(true);
  });
});
