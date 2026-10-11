import { prisma } from '../db.js';
import { env } from '../env.js';

/**
 * Audit PERF-5: what the assistant's tools returned is kept with the conversation — up to 4 KB a call,
 * several calls a question — and was kept for ever. After AI_HISTORY_RETENTION_DAYS it goes: those rows
 * are copies of records the person could read then, not the conversation. What the person asked and what
 * the assistant answered stay, with the rest of their own history.
 */
export async function pruneAiToolRows(now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - env.AI_HISTORY_RETENTION_DAYS * 86_400_000);
  const { count } = await prisma.aiMessage.deleteMany({ where: { role: 'tool', createdAt: { lt: before } } });
  return count;
}
