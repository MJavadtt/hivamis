-- Audit F-6: a person's profile — a photo (a document, re-encoded to a 512px WebP with its metadata
-- stripped), a few words about themselves, how their name is said, skills and links.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "avatarDocumentId" TEXT,
ADD COLUMN     "bio" TEXT,
ADD COLUMN     "links" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "pronouncedName" TEXT,
ADD COLUMN     "skills" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE UNIQUE INDEX "users_avatarDocumentId_key" ON "users"("avatarDocumentId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_avatarDocumentId_fkey" FOREIGN KEY ("avatarDocumentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What the profile may hold: a short note, a name as said, twenty skills, five links.
ALTER TABLE "users" ADD CONSTRAINT "users_profile_check" CHECK (
  char_length(coalesce("bio", '')) <= 500 AND char_length(coalesce("pronouncedName", '')) <= 120
  AND cardinality("skills") <= 20 AND cardinality("links") <= 5
);
