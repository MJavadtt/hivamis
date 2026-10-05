-- Hivamis task 8: the guide's videos — one recording per section and language, uploaded by the
-- organisation itself.

-- CreateTable
CREATE TABLE "guide_videos" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guide_videos_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "guide_videos_locale_check" CHECK ("locale" IN ('fa', 'en')),
    CONSTRAINT "guide_videos_type_check" CHECK ("mimeType" IN ('video/mp4', 'video/webm')),
    CONSTRAINT "guide_videos_size_check" CHECK ("sizeBytes" > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "guide_videos_organizationId_sectionId_locale_key" ON "guide_videos"("organizationId", "sectionId", "locale");

-- AddForeignKey
ALTER TABLE "guide_videos" ADD CONSTRAINT "guide_videos_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
