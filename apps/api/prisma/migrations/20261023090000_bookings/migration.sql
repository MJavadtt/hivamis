-- Audit F-9, step 2: meeting bookings — the Telegram meeting platform's domain, brought into
-- Hivamis with an organisation on every row. Holds are the source of truth for conflicts: their
-- period is generated from the two instants, and exclusion constraints let the database refuse
-- one room, or one person, booked twice at once. btree_gist lets an equality on an id share a GiST
-- index with the range (a trusted extension: the database's owner may create it).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateTable
CREATE TABLE "booking_locations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'INSIDE',
    "address" TEXT,
    "building" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookable_resources" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "locationId" TEXT,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "floor" TEXT,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookable_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'INTERNAL',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "organizerId" TEXT NOT NULL,
    "approverId" TEXT,
    "roomId" TEXT,
    "placeNote" TEXT,
    "parkingId" TEXT,
    "parkingSpaces" INTEGER NOT NULL DEFAULT 0,
    "projectId" TEXT,
    "companyId" TEXT,
    "meetingId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_participants" (
    "bookingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "response" TEXT NOT NULL DEFAULT 'PENDING',
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "booking_participants_pkey" PRIMARY KEY ("bookingId","userId")
);

-- CreateTable
CREATE TABLE "booking_resources" (
    "bookingId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "booking_resources_pkey" PRIMARY KEY ("bookingId","resourceId")
);

-- CreateTable
CREATE TABLE "booking_guests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "company" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "isVip" BOOLEAN NOT NULL DEFAULT false,
    "checkedInAt" TIMESTAMP(3),
    "checkedOutAt" TIMESTAMP(3),
    "checkedInById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_guests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catering_options" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "labelFa" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catering_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_catering" (
    "bookingId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "booking_catering_pkey" PRIMARY KEY ("bookingId","optionId")
);

-- CreateTable
CREATE TABLE "resource_holds" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "spaces" INTEGER NOT NULL DEFAULT 1,
    "exclusive" BOOLEAN NOT NULL DEFAULT true,
    "period" tsrange GENERATED ALWAYS AS (tsrange("startsAt", "endsAt", '[)')) STORED,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resource_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_holds" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "period" tsrange GENERATED ALWAYS AS (tsrange("startsAt", "endsAt", '[)')) STORED,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "booking_locations_organizationId_name_key" ON "booking_locations"("organizationId", "name");

-- CreateIndex
CREATE INDEX "bookable_resources_organizationId_type_idx" ON "bookable_resources"("organizationId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "bookable_resources_organizationId_name_key" ON "bookable_resources"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_code_key" ON "bookings"("code");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_meetingId_key" ON "bookings"("meetingId");

-- CreateIndex
CREATE INDEX "bookings_organizationId_state_idx" ON "bookings"("organizationId", "state");

-- CreateIndex
CREATE INDEX "bookings_organizationId_startsAt_idx" ON "bookings"("organizationId", "startsAt");

-- CreateIndex
CREATE INDEX "bookings_organizerId_idx" ON "bookings"("organizerId");

-- CreateIndex
CREATE INDEX "bookings_approverId_idx" ON "bookings"("approverId");

-- CreateIndex
CREATE INDEX "booking_participants_userId_idx" ON "booking_participants"("userId");

-- CreateIndex
CREATE INDEX "booking_resources_resourceId_idx" ON "booking_resources"("resourceId");

-- CreateIndex
CREATE INDEX "booking_guests_bookingId_idx" ON "booking_guests"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "catering_options_organizationId_labelFa_key" ON "catering_options"("organizationId", "labelFa");

-- CreateIndex
CREATE INDEX "resource_holds_bookingId_idx" ON "resource_holds"("bookingId");

-- CreateIndex
CREATE INDEX "person_holds_bookingId_idx" ON "person_holds"("bookingId");

-- AddForeignKey
ALTER TABLE "bookable_resources" ADD CONSTRAINT "bookable_resources_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "booking_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "bookable_resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_parkingId_fkey" FOREIGN KEY ("parkingId") REFERENCES "bookable_resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_participants" ADD CONSTRAINT "booking_participants_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_participants" ADD CONSTRAINT "booking_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_resources" ADD CONSTRAINT "booking_resources_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_resources" ADD CONSTRAINT "booking_resources_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "bookable_resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_guests" ADD CONSTRAINT "booking_guests_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_guests" ADD CONSTRAINT "booking_guests_checkedInById_fkey" FOREIGN KEY ("checkedInById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_catering" ADD CONSTRAINT "booking_catering_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_catering" ADD CONSTRAINT "booking_catering_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "catering_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_holds" ADD CONSTRAINT "resource_holds_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "bookable_resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_holds" ADD CONSTRAINT "resource_holds_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_holds" ADD CONSTRAINT "person_holds_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_holds" ADD CONSTRAINT "person_holds_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What the application also checks, the database refuses outright.
ALTER TABLE "booking_locations" ADD CONSTRAINT "booking_locations_values" CHECK (
  "kind" IN ('INSIDE', 'OUTSIDE') AND char_length("name") BETWEEN 2 AND 120
);
ALTER TABLE "bookable_resources" ADD CONSTRAINT "bookable_resources_values" CHECK (
  "type" IN ('ROOM', 'EQUIPMENT', 'PARKING', 'VEHICLE', 'OTHER')
  AND "capacity" >= 0 AND ("type" <> 'PARKING' OR "capacity" >= 1)
  AND char_length("name") BETWEEN 2 AND 120
  AND coalesce("features", ARRAY[]::text[]) <@ ARRAY['VIDEO_CONFERENCE', 'DISPLAY', 'WHITEBOARD', 'CAMERA', 'MICROPHONE', 'ACCESSIBLE']::text[]
);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_state_check" CHECK (
  "state" IN ('DRAFT', 'PENDING_APPROVAL', 'CHANGES_REQUESTED', 'APPROVED', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'COMPLETED')
);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_values" CHECK (
  "kind" IN ('INTERNAL', 'EXTERNAL')
  AND "endsAt" > "startsAt" AND "endsAt" - "startsAt" <= interval '12 hours'
  AND "parkingSpaces" BETWEEN 0 AND 50
  AND char_length("title") BETWEEN 3 AND 200
  AND ("organizerId" IS DISTINCT FROM "approverId")
);
ALTER TABLE "booking_participants" ADD CONSTRAINT "booking_participants_response" CHECK ("response" IN ('PENDING', 'ACCEPTED', 'DECLINED'));
ALTER TABLE "booking_catering" ADD CONSTRAINT "booking_catering_quantity" CHECK ("quantity" BETWEEN 1 AND 500);
ALTER TABLE "catering_options" ADD CONSTRAINT "catering_options_price" CHECK ("unitPrice" >= 0);
ALTER TABLE "resource_holds" ADD CONSTRAINT "resource_holds_values" CHECK (
  "endsAt" > "startsAt" AND "spaces" > 0 AND (NOT "exclusive" OR "spaces" = 1)
);
ALTER TABLE "person_holds" ADD CONSTRAINT "person_holds_values" CHECK ("endsAt" > "startsAt");

-- The guarantee itself: no two exclusive holds of a resource, and no two holds of a person, overlap.
-- Half-open ranges, so a meeting ending at 10:00 and one starting at 10:00 do not collide.
ALTER TABLE "resource_holds" ADD CONSTRAINT "resource_holds_no_overlap"
  EXCLUDE USING gist ("resourceId" WITH =, "period" WITH &&) WHERE ("exclusive");
ALTER TABLE "person_holds" ADD CONSTRAINT "person_holds_no_overlap"
  EXCLUDE USING gist ("userId" WITH =, "period" WITH &&);
-- Parking is shared up to its capacity: summed over the overlapping holds, under an advisory lock.
CREATE INDEX "resource_holds_period_idx" ON "resource_holds" USING gist ("resourceId", "period");

-- A booking is decided or confirmed from the messenger by single-use buttons, as forms are (finding 1).
ALTER TABLE "messenger_actions" DROP CONSTRAINT "messenger_actions_kind";
ALTER TABLE "messenger_actions" ADD CONSTRAINT "messenger_actions_kind" CHECK ("kind" IN ('LINK', 'FORM_DECISION', 'BOOKING_DECISION'));
