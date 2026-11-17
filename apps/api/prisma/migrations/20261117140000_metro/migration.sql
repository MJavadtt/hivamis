-- Metro advertising: lines, stations, trains, wagons, ad spaces, bookings and payments (ADR-135).

-- CreateTable
CREATE TABLE "metro_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "nameFa" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT 'TEHRAN',
    "color" TEXT NOT NULL DEFAULT '#64748b',
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metro_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metro_stations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "nameFa" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL DEFAULT '',
    "order" INTEGER NOT NULL DEFAULT 0,
    "branch" TEXT,
    "isInterchange" BOOLEAN NOT NULL DEFAULT false,
    "underConstruction" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metro_stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metro_trains" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metro_trains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metro_wagons" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "trainId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metro_wagons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metro_ad_spaces" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "wagonId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "widthCm" INTEGER,
    "heightCm" INTEGER,
    "monthlyPrice" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metro_ad_spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metro_bookings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT,
    "companyId" TEXT,
    "clientName" TEXT,
    "projectId" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'HOLD',
    "amount" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'IRR',
    "ownerId" TEXT,
    "createdById" TEXT NOT NULL,
    "notes" TEXT,
    "endingNotifiedAt" TIMESTAMP(3),
    "holdNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metro_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metro_booking_items" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "monthlyPrice" DECIMAL(20,2) NOT NULL DEFAULT 0,

    CONSTRAINT "metro_booking_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metro_payments" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "paidAt" DATE NOT NULL,
    "method" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metro_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metro_settings" (
    "organizationId" TEXT NOT NULL,
    "seededAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endingSoonDays" INTEGER NOT NULL DEFAULT 7,
    "holdDays" INTEGER NOT NULL DEFAULT 3,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metro_settings_pkey" PRIMARY KEY ("organizationId")
);

-- CreateIndex
CREATE UNIQUE INDEX "metro_lines_organizationId_number_key" ON "metro_lines"("organizationId", "number");

-- CreateIndex
CREATE INDEX "metro_stations_lineId_order_idx" ON "metro_stations"("lineId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "metro_trains_lineId_code_key" ON "metro_trains"("lineId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "metro_wagons_trainId_number_key" ON "metro_wagons"("trainId", "number");

-- CreateIndex
CREATE INDEX "metro_ad_spaces_wagonId_kind_idx" ON "metro_ad_spaces"("wagonId", "kind");

-- CreateIndex
CREATE INDEX "metro_bookings_organizationId_state_startDate_idx" ON "metro_bookings"("organizationId", "state", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "metro_bookings_organizationId_code_key" ON "metro_bookings"("organizationId", "code");

-- CreateIndex
CREATE INDEX "metro_booking_items_spaceId_idx" ON "metro_booking_items"("spaceId");

-- AddForeignKey
ALTER TABLE "metro_stations" ADD CONSTRAINT "metro_stations_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "metro_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metro_trains" ADD CONSTRAINT "metro_trains_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "metro_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metro_wagons" ADD CONSTRAINT "metro_wagons_trainId_fkey" FOREIGN KEY ("trainId") REFERENCES "metro_trains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metro_ad_spaces" ADD CONSTRAINT "metro_ad_spaces_wagonId_fkey" FOREIGN KEY ("wagonId") REFERENCES "metro_wagons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metro_bookings" ADD CONSTRAINT "metro_bookings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metro_bookings" ADD CONSTRAINT "metro_bookings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metro_booking_items" ADD CONSTRAINT "metro_booking_items_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "metro_bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metro_booking_items" ADD CONSTRAINT "metro_booking_items_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "metro_ad_spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metro_payments" ADD CONSTRAINT "metro_payments_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "metro_bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
