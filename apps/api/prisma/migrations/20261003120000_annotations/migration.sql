-- CreateTable
CREATE TABLE "annotations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "deliverableId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "documentSha256" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "page" INTEGER,
    "x" DOUBLE PRECISION,
    "y" DOUBLE PRECISION,
    "w" DOUBLE PRECISION,
    "h" DOUBLE PRECISION,
    "timeSec" DOUBLE PRECISION,
    "note" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qcReviewId" TEXT,
    "revisionId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "annotations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "annotations_deliverableId_status_idx" ON "annotations"("deliverableId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "annotations_documentId_number_key" ON "annotations"("documentId", "number");

-- AddForeignKey
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_deliverableId_fkey" FOREIGN KEY ("deliverableId") REFERENCES "deliverables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_qcReviewId_fkey" FOREIGN KEY ("qcReviewId") REFERENCES "qc_reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Roadmap #38: what each kind of annotation must say about where it is, in fractions of the file.
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_kind" CHECK ("kind" IN ('PIN', 'TIMECODE', 'HIGHLIGHT'));
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_status" CHECK ("status" IN ('OPEN', 'RESOLVED'));
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_place" CHECK (
  ("kind" = 'PIN' AND "x" BETWEEN 0 AND 1 AND "y" BETWEEN 0 AND 1)
  OR ("kind" = 'TIMECODE' AND "timeSec" >= 0 AND ("x" IS NULL OR "x" BETWEEN 0 AND 1) AND ("y" IS NULL OR "y" BETWEEN 0 AND 1))
  OR ("kind" = 'HIGHLIGHT' AND "page" >= 1 AND "x" BETWEEN 0 AND 1 AND "y" BETWEEN 0 AND 1 AND "w" > 0 AND "h" > 0 AND "x" + "w" <= 1.0001 AND "y" + "h" <= 1.0001)
);
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_note" CHECK (length(btrim("note")) > 0);
