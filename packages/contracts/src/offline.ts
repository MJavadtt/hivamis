import { z } from 'zod';

/**
 * Working without a connection (audit F-7). What can be done offline is short on purpose: things a
 * person records about their own work, which a later arrival cannot make wrong. Anything that
 * decides for others, or that a Doc_H guard must judge against the state of the system now —
 * approvals, QC verdicts, accepting work, payments — waits for the connection.
 */
export const OFFLINE_OPERATIONS = ['form', 'time', 'comment', 'submit'] as const;
export type OfflineOperation = (typeof OFFLINE_OPERATIONS)[number];

export const TASK_COMMENT_MAX = 2000;
export const taskCommentSchema = z.object({ body: z.string().trim().min(1, 'یادداشت خالی است').max(TASK_COMMENT_MAX) });
