-- Calendars per unit and per person (roadmap #13). Departments and users gain optional
-- overrides that inherit upward when null; leaves give a person days with no working hours.

-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "breakHours" INTEGER,
ADD COLUMN     "workEndHour" INTEGER,
ADD COLUMN     "workStartHour" INTEGER,
ADD COLUMN     "workingDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "workEndHour" INTEGER,
ADD COLUMN     "workStartHour" INTEGER,
ADD COLUMN     "workingDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- CreateTable
CREATE TABLE "user_leaves" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "from" DATE NOT NULL,
    "to" DATE NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'VACATION',
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_leaves_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_leaves_userId_from_to_idx" ON "user_leaves"("userId", "from", "to");

-- AddForeignKey
ALTER TABLE "user_leaves" ADD CONSTRAINT "user_leaves_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


