-- Indexes for the executive dashboard's per-project roll-ups.
--
-- Both are PARTIAL, matching the predicate the queries actually use. A plain index on
-- ("organizationId", "dueDate") would not help: the queries also filter `state NOT IN (...)`,
-- a negation the planner cannot use an index for, so it fell back to a sequential scan over
-- every task row.
--
-- Prisma's schema language cannot express a partial index, so these are declared here. They
-- are additive and carry no data change.

-- Serves both the overdue-task count and the late-tasks-per-project GROUP BY.
CREATE INDEX IF NOT EXISTS "tasks_open_overdue_idx"
  ON "tasks" ("organizationId", "projectId", "dueDate")
  WHERE state NOT IN ('APPROVED', 'CLOSED', 'CANCELLED');

-- Serves the on-time-delivery ratio, which reads only finished tasks that had a deadline.
CREATE INDEX IF NOT EXISTS "tasks_completed_with_due_idx"
  ON "tasks" ("organizationId", "dueDate", "submittedAt")
  WHERE state IN ('APPROVED', 'CLOSED');

-- cost_declarations are reached from a project only through their work order.
CREATE INDEX IF NOT EXISTS "cost_declarations_workorder_idx"
  ON "cost_declarations" ("organizationId", "workOrderId");
