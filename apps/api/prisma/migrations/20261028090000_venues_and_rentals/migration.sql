-- ADR-103: venues, deployment projects and rentals — the owner's «دیتابیس» document.
-- Every row carries its organisation; children reach their parent by (id, organizationId), so the database
-- itself refuses a contact, a negotiation or a payment filed against another organisation's record.
-- Money is numeric(20,2); the checks at the end are the ledger's arithmetic, held by the database too.

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "caption" TEXT,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "siteProjectId" TEXT,
ADD COLUMN     "siteRecordId" TEXT,
ADD COLUMN     "siteRecordType" TEXT,
ADD COLUMN     "takenAt" TIMESTAMP(3),
ADD COLUMN     "venueId" TEXT;

-- CreateTable
CREATE TABLE "site_options" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "list" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "labelFa" TEXT NOT NULL,
    "labelEn" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_settings" (
    "organizationId" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_settings_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "venues" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "address" TEXT,
    "typeCode" TEXT NOT NULL,
    "gradeCode" TEXT,
    "audienceCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "phone" TEXT,
    "phoneKey" TEXT,
    "email" TEXT,
    "website" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "importId" TEXT,
    "importedValues" JSONB,
    "distinctFrom" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mergedIntoId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_contacts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "roleCode" TEXT NOT NULL,
    "jobTitle" TEXT,
    "phone" TEXT,
    "phoneKey" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "venue_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_channels" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "contactId" TEXT,
    "typeCode" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_projects" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "placement" TEXT,
    "projectId" TEXT,
    "companyId" TEXT,
    "responsibleId" TEXT,
    "cooperationCode" TEXT,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'IRR',
    "contractStart" TIMESTAMP(3),
    "contractEnd" TIMESTAMP(3),
    "depositAmount" DECIMAL(20,2),
    "rentAmount" DECIMAL(20,2),
    "rentPeriod" TEXT NOT NULL DEFAULT 'MONTHLY',
    "rentDueDay" INTEGER,
    "rentMethodCode" TEXT,
    "chargeAmount" DECIMAL(20,2),
    "chargeDueDay" INTEGER,
    "chargeMethodCode" TEXT,
    "installPlannedAt" TIMESTAMP(3),
    "installedAt" TIMESTAMP(3),
    "installDays" INTEGER,
    "installStatus" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "installCost" DECIMAL(20,2),
    "transportCost" DECIMAL(20,2),
    "installNotes" TEXT,
    "notes" TEXT,
    "scheduleGeneratedAt" TIMESTAMP(3),
    "closureStatement" JSONB,
    "closedAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "site_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_negotiations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "siteProjectId" TEXT NOT NULL,
    "heldAt" TIMESTAMP(3) NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'MEETING',
    "summary" TEXT NOT NULL,
    "proposedRent" DECIMAL(20,2),
    "proposedRentPeriod" TEXT,
    "proposedDeposit" DECIMAL(20,2),
    "proposedCharge" DECIMAL(20,2),
    "otherTerms" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'OPEN',
    "nextAction" TEXT,
    "followUpAt" TIMESTAMP(3),
    "followUpDoneAt" TIMESTAMP(3),
    "assigneeId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_negotiations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_negotiation_participants" (
    "id" TEXT NOT NULL,
    "negotiationId" TEXT NOT NULL,
    "contactId" TEXT,
    "userId" TEXT,
    "name" TEXT,

    CONSTRAINT "site_negotiation_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_contracts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "siteProjectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "reference" TEXT,
    "cooperationCode" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "terms" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decisionComment" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_approvals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "siteProjectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT,
    "subjectId" TEXT,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "decidedById" TEXT,
    "approverName" TEXT,
    "approverTitle" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_counters" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "siteProjectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "widthCm" INTEGER,
    "depthCm" INTEGER,
    "heightCm" INTEGER,
    "specs" TEXT,
    "unitCost" DECIMAL(20,2),
    "supplierId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_assignments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "siteProjectId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'PROMOTER',
    "userId" TEXT,
    "personName" TEXT,
    "phone" TEXT,
    "startsOn" TIMESTAMP(3),
    "endsOn" TIMESTAMP(3),
    "shift" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_obligations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "siteProjectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "categoryCode" TEXT,
    "description" TEXT,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "settledAmount" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "scheduleKey" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "closeReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_obligations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_payments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "siteProjectId" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'OUT',
    "purpose" TEXT NOT NULL DEFAULT 'OBLIGATIONS',
    "amount" DECIMAL(20,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "methodCode" TEXT NOT NULL,
    "reference" TEXT,
    "chequeNumber" TEXT,
    "chequeBank" TEXT,
    "chequeDate" TIMESTAMP(3),
    "note" TEXT,
    "clientKey" TEXT NOT NULL,
    "recordedById" TEXT NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_allocations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "paymentId" TEXT,
    "depositEntryId" TEXT,
    "amount" DECIMAL(20,2) NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_deposit_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "siteProjectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT,
    "obligationId" TEXT,
    "paymentId" TEXT,
    "status" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionComment" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_deposit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_reminders" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "siteProjectId" TEXT,
    "event" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "offsetDays" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_messages" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "venueId" TEXT,
    "contactId" TEXT,
    "siteProjectId" TEXT,
    "phone" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "templateKey" TEXT,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerRef" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "sentById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3),

    CONSTRAINT "venue_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_imports" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "created" INTEGER NOT NULL,
    "updated" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "report" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_saved_views" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_options_organizationId_list_code_key" ON "site_options"("organizationId", "list", "code");

-- CreateIndex
CREATE UNIQUE INDEX "venues_code_key" ON "venues"("code");

-- CreateIndex
CREATE INDEX "venues_organizationId_province_city_idx" ON "venues"("organizationId", "province", "city");

-- CreateIndex
CREATE INDEX "venues_organizationId_typeCode_idx" ON "venues"("organizationId", "typeCode");

-- CreateIndex
CREATE INDEX "venues_organizationId_nameKey_idx" ON "venues"("organizationId", "nameKey");

-- CreateIndex
CREATE INDEX "venues_organizationId_phoneKey_idx" ON "venues"("organizationId", "phoneKey");

-- CreateIndex
CREATE UNIQUE INDEX "venues_id_organizationId_key" ON "venues"("id", "organizationId");

-- CreateIndex
CREATE INDEX "venue_contacts_organizationId_venueId_idx" ON "venue_contacts"("organizationId", "venueId");

-- CreateIndex
CREATE INDEX "venue_contacts_organizationId_phoneKey_idx" ON "venue_contacts"("organizationId", "phoneKey");

-- CreateIndex
CREATE UNIQUE INDEX "venue_contacts_id_organizationId_key" ON "venue_contacts"("id", "organizationId");

-- CreateIndex
CREATE INDEX "venue_channels_organizationId_venueId_idx" ON "venue_channels"("organizationId", "venueId");

-- CreateIndex
CREATE UNIQUE INDEX "site_projects_code_key" ON "site_projects"("code");

-- CreateIndex
CREATE INDEX "site_projects_organizationId_state_idx" ON "site_projects"("organizationId", "state");

-- CreateIndex
CREATE INDEX "site_projects_organizationId_venueId_idx" ON "site_projects"("organizationId", "venueId");

-- CreateIndex
CREATE INDEX "site_projects_organizationId_contractEnd_idx" ON "site_projects"("organizationId", "contractEnd");

-- CreateIndex
CREATE INDEX "site_projects_projectId_idx" ON "site_projects"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "site_projects_id_organizationId_key" ON "site_projects"("id", "organizationId");

-- CreateIndex
CREATE INDEX "site_negotiations_organizationId_siteProjectId_heldAt_idx" ON "site_negotiations"("organizationId", "siteProjectId", "heldAt");

-- CreateIndex
CREATE INDEX "site_negotiations_organizationId_followUpAt_idx" ON "site_negotiations"("organizationId", "followUpAt");

-- CreateIndex
CREATE INDEX "site_negotiation_participants_negotiationId_idx" ON "site_negotiation_participants"("negotiationId");

-- CreateIndex
CREATE INDEX "site_contracts_organizationId_status_idx" ON "site_contracts"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "site_contracts_siteProjectId_version_key" ON "site_contracts"("siteProjectId", "version");

-- CreateIndex
CREATE INDEX "site_approvals_organizationId_siteProjectId_kind_idx" ON "site_approvals"("organizationId", "siteProjectId", "kind");

-- CreateIndex
CREATE INDEX "site_counters_organizationId_siteProjectId_idx" ON "site_counters"("organizationId", "siteProjectId");

-- CreateIndex
CREATE INDEX "site_assignments_organizationId_siteProjectId_idx" ON "site_assignments"("organizationId", "siteProjectId");

-- CreateIndex
CREATE INDEX "site_obligations_organizationId_status_dueDate_idx" ON "site_obligations"("organizationId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "site_obligations_organizationId_siteProjectId_idx" ON "site_obligations"("organizationId", "siteProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "site_obligations_id_organizationId_key" ON "site_obligations"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "site_obligations_siteProjectId_scheduleKey_key" ON "site_obligations"("siteProjectId", "scheduleKey");

-- CreateIndex
CREATE INDEX "site_payments_organizationId_siteProjectId_idx" ON "site_payments"("organizationId", "siteProjectId");

-- CreateIndex
CREATE INDEX "site_payments_organizationId_paidAt_idx" ON "site_payments"("organizationId", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "site_payments_organizationId_clientKey_key" ON "site_payments"("organizationId", "clientKey");

-- CreateIndex
CREATE INDEX "site_allocations_obligationId_idx" ON "site_allocations"("obligationId");

-- CreateIndex
CREATE INDEX "site_allocations_paymentId_idx" ON "site_allocations"("paymentId");

-- CreateIndex
CREATE INDEX "site_deposit_entries_organizationId_siteProjectId_idx" ON "site_deposit_entries"("organizationId", "siteProjectId");

-- CreateIndex
CREATE INDEX "site_reminders_organizationId_createdAt_idx" ON "site_reminders"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "site_reminders_status_attempts_idx" ON "site_reminders"("status", "attempts");

-- CreateIndex
CREATE UNIQUE INDEX "site_reminders_organizationId_subjectType_subjectId_event_o_key" ON "site_reminders"("organizationId", "subjectType", "subjectId", "event", "offsetDays", "channel", "recipient");

-- CreateIndex
CREATE INDEX "venue_messages_organizationId_createdAt_idx" ON "venue_messages"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "venue_messages_status_attempts_idx" ON "venue_messages"("status", "attempts");

-- CreateIndex
CREATE INDEX "site_imports_organizationId_createdAt_idx" ON "site_imports"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "site_saved_views_organizationId_page_idx" ON "site_saved_views"("organizationId", "page");

-- CreateIndex
CREATE INDEX "documents_venueId_idx" ON "documents"("venueId");

-- CreateIndex
CREATE INDEX "documents_siteProjectId_siteRecordType_siteRecordId_idx" ON "documents"("siteProjectId", "siteRecordType", "siteRecordId");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_siteProjectId_fkey" FOREIGN KEY ("siteProjectId") REFERENCES "site_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venues" ADD CONSTRAINT "venues_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_contacts" ADD CONSTRAINT "venue_contacts_venueId_organizationId_fkey" FOREIGN KEY ("venueId", "organizationId") REFERENCES "venues"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_channels" ADD CONSTRAINT "venue_channels_venueId_organizationId_fkey" FOREIGN KEY ("venueId", "organizationId") REFERENCES "venues"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_channels" ADD CONSTRAINT "venue_channels_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "venue_contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_projects" ADD CONSTRAINT "site_projects_venueId_organizationId_fkey" FOREIGN KEY ("venueId", "organizationId") REFERENCES "venues"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_projects" ADD CONSTRAINT "site_projects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_projects" ADD CONSTRAINT "site_projects_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_projects" ADD CONSTRAINT "site_projects_responsibleId_fkey" FOREIGN KEY ("responsibleId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_projects" ADD CONSTRAINT "site_projects_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_negotiations" ADD CONSTRAINT "site_negotiations_siteProjectId_organizationId_fkey" FOREIGN KEY ("siteProjectId", "organizationId") REFERENCES "site_projects"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_negotiations" ADD CONSTRAINT "site_negotiations_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_negotiations" ADD CONSTRAINT "site_negotiations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_negotiation_participants" ADD CONSTRAINT "site_negotiation_participants_negotiationId_fkey" FOREIGN KEY ("negotiationId") REFERENCES "site_negotiations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_negotiation_participants" ADD CONSTRAINT "site_negotiation_participants_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "venue_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_negotiation_participants" ADD CONSTRAINT "site_negotiation_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_contracts" ADD CONSTRAINT "site_contracts_siteProjectId_organizationId_fkey" FOREIGN KEY ("siteProjectId", "organizationId") REFERENCES "site_projects"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_contracts" ADD CONSTRAINT "site_contracts_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_contracts" ADD CONSTRAINT "site_contracts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_approvals" ADD CONSTRAINT "site_approvals_siteProjectId_organizationId_fkey" FOREIGN KEY ("siteProjectId", "organizationId") REFERENCES "site_projects"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_approvals" ADD CONSTRAINT "site_approvals_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_approvals" ADD CONSTRAINT "site_approvals_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_counters" ADD CONSTRAINT "site_counters_siteProjectId_organizationId_fkey" FOREIGN KEY ("siteProjectId", "organizationId") REFERENCES "site_projects"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_counters" ADD CONSTRAINT "site_counters_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_assignments" ADD CONSTRAINT "site_assignments_siteProjectId_organizationId_fkey" FOREIGN KEY ("siteProjectId", "organizationId") REFERENCES "site_projects"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_assignments" ADD CONSTRAINT "site_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_obligations" ADD CONSTRAINT "site_obligations_siteProjectId_organizationId_fkey" FOREIGN KEY ("siteProjectId", "organizationId") REFERENCES "site_projects"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_obligations" ADD CONSTRAINT "site_obligations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_payments" ADD CONSTRAINT "site_payments_siteProjectId_organizationId_fkey" FOREIGN KEY ("siteProjectId", "organizationId") REFERENCES "site_projects"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_payments" ADD CONSTRAINT "site_payments_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_payments" ADD CONSTRAINT "site_payments_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_allocations" ADD CONSTRAINT "site_allocations_obligationId_organizationId_fkey" FOREIGN KEY ("obligationId", "organizationId") REFERENCES "site_obligations"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_allocations" ADD CONSTRAINT "site_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "site_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_allocations" ADD CONSTRAINT "site_allocations_depositEntryId_fkey" FOREIGN KEY ("depositEntryId") REFERENCES "site_deposit_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_deposit_entries" ADD CONSTRAINT "site_deposit_entries_siteProjectId_organizationId_fkey" FOREIGN KEY ("siteProjectId", "organizationId") REFERENCES "site_projects"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_deposit_entries" ADD CONSTRAINT "site_deposit_entries_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "site_obligations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_deposit_entries" ADD CONSTRAINT "site_deposit_entries_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "site_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_deposit_entries" ADD CONSTRAINT "site_deposit_entries_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_deposit_entries" ADD CONSTRAINT "site_deposit_entries_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_messages" ADD CONSTRAINT "venue_messages_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_messages" ADD CONSTRAINT "venue_messages_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "venue_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_messages" ADD CONSTRAINT "venue_messages_siteProjectId_fkey" FOREIGN KEY ("siteProjectId") REFERENCES "site_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_messages" ADD CONSTRAINT "venue_messages_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_imports" ADD CONSTRAINT "site_imports_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_saved_views" ADD CONSTRAINT "site_saved_views_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The ledger's arithmetic, and the lists' vocabularies, held by the database as well as the code.
ALTER TABLE "site_options" ADD CONSTRAINT "site_options_list_check"
  CHECK ("list" IN ('VENUE_TYPE','VENUE_GRADE','AUDIENCE','COOPERATION','PAYMENT_METHOD','CONTACT_ROLE','CHANNEL','CHARGE_CATEGORY','PHOTO_CATEGORY'));
ALTER TABLE "venues" ADD CONSTRAINT "venues_source_check" CHECK ("source" IN ('MANUAL','IMPORT'));
ALTER TABLE "site_projects" ADD CONSTRAINT "site_projects_amounts_check"
  CHECK (coalesce("depositAmount",0) >= 0 AND coalesce("rentAmount",0) >= 0 AND coalesce("chargeAmount",0) >= 0
     AND coalesce("installCost",0) >= 0 AND coalesce("transportCost",0) >= 0);
-- The workflow's states, as every workflow table has them: nothing else is a state (SITE_PROJECT_WORKFLOW).
ALTER TABLE "site_projects" ADD CONSTRAINT "site_projects_state_check" CHECK ("state" IN (
  'DRAFT','EVALUATION','NEGOTIATION','TERMS_AGREED','CONTRACT_PENDING','CONTRACT_APPROVED','INSTALL_PLANNED','INSTALLING',
  'ACTIVE','SETTLING','CLOSURE_PENDING','CLOSED','CANCELLED'));
ALTER TABLE "site_projects" ADD CONSTRAINT "site_projects_rent_period_check" CHECK ("rentPeriod" IN ('MONTHLY','DAILY','ONCE'));
ALTER TABLE "site_projects" ADD CONSTRAINT "site_projects_term_check"
  CHECK ("contractStart" IS NULL OR "contractEnd" IS NULL OR "contractEnd" > "contractStart");
ALTER TABLE "site_projects" ADD CONSTRAINT "site_projects_install_status_check"
  CHECK ("installStatus" IN ('NOT_STARTED','PLANNED','IN_PROGRESS','DONE','DELAYED'));
ALTER TABLE "site_contracts" ADD CONSTRAINT "site_contracts_status_check"
  CHECK ("status" IN ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','SUPERSEDED'));
ALTER TABLE "site_approvals" ADD CONSTRAINT "site_approvals_kind_check" CHECK ("kind" IN ('CONTRACT','EMPLOYER','DEDUCTION'));
ALTER TABLE "site_approvals" ADD CONSTRAINT "site_approvals_decision_check" CHECK ("decision" IN ('APPROVED','REJECTED'));
ALTER TABLE "site_counters" ADD CONSTRAINT "site_counters_quantity_check" CHECK ("quantity" > 0 AND coalesce("unitCost",0) >= 0);
ALTER TABLE "site_obligations" ADD CONSTRAINT "site_obligations_kind_check"
  CHECK ("kind" IN ('RENT','CHARGE','DEPOSIT','PENALTY','OTHER','INSTALLATION','TRANSPORT','FABRICATION'));
ALTER TABLE "site_obligations" ADD CONSTRAINT "site_obligations_status_check" CHECK ("status" IN ('OPEN','PARTIAL','SETTLED','WAIVED','VOID'));
-- Nothing is settled beyond what it is: an overpayment stays on the payment as credit, never on the obligation.
ALTER TABLE "site_obligations" ADD CONSTRAINT "site_obligations_amount_check"
  CHECK ("amount" > 0 AND "settledAmount" >= 0 AND "settledAmount" <= "amount");
ALTER TABLE "site_payments" ADD CONSTRAINT "site_payments_amount_check" CHECK ("amount" > 0);
ALTER TABLE "site_payments" ADD CONSTRAINT "site_payments_direction_check"
  CHECK (("direction" = 'OUT' AND "purpose" = 'OBLIGATIONS') OR ("direction" = 'IN' AND "purpose" IN ('DEPOSIT_REFUND','CREDIT_REFUND')));
-- An allocation comes from a payment or from a deposit deduction — one of the two, never both.
ALTER TABLE "site_allocations" ADD CONSTRAINT "site_allocations_source_check"
  CHECK ("amount" > 0 AND (("paymentId" IS NULL) <> ("depositEntryId" IS NULL)));
ALTER TABLE "site_deposit_entries" ADD CONSTRAINT "site_deposit_entries_kind_check" CHECK ("kind" IN ('DEDUCTION','REFUND'));
ALTER TABLE "site_deposit_entries" ADD CONSTRAINT "site_deposit_entries_status_check" CHECK ("status" IN ('PROPOSED','APPROVED','REJECTED','VOID'));
ALTER TABLE "site_deposit_entries" ADD CONSTRAINT "site_deposit_entries_amount_check" CHECK ("amount" > 0);
ALTER TABLE "site_reminders" ADD CONSTRAINT "site_reminders_channel_check" CHECK ("channel" IN ('IN_APP','SMS','EMAIL'));
ALTER TABLE "site_reminders" ADD CONSTRAINT "site_reminders_status_check" CHECK ("status" IN ('SENT','SANDBOX','FAILED'));
ALTER TABLE "venue_messages" ADD CONSTRAINT "venue_messages_status_check"
  CHECK ("status" IN ('SANDBOX','SENT','FAILED','DELIVERED','UNDELIVERED'));
ALTER TABLE "site_imports" ADD CONSTRAINT "site_imports_kind_check" CHECK ("kind" IN ('VENUES','CONTACTS','SITE_PROJECTS','OBLIGATIONS'));

-- One primary contact per venue among those not archived.
CREATE UNIQUE INDEX "venue_contacts_one_primary" ON "venue_contacts" ("venueId") WHERE "isPrimary" AND "archivedAt" IS NULL;
