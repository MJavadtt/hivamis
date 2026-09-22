-- Time logging (roadmap #14): hours actually spent, and the hourly cost that turns them into money.

-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "hourlyCost" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "hourlyCost" DECIMAL(14,2);

-- CreateTable
CREATE TABLE "time_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "hours" DECIMAL(6,2) NOT NULL,
    "workedOn" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "time_entries_taskId_idx" ON "time_entries"("taskId");

-- CreateIndex
CREATE INDEX "time_entries_organizationId_workedOn_idx" ON "time_entries"("organizationId", "workedOn");

-- CreateIndex
CREATE INDEX "time_entries_userId_workedOn_idx" ON "time_entries"("userId", "workedOn");

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


