-- ADR-124: a file has no size limit, and an INTEGER ends at 2 GiB.
ALTER TABLE "documents" ALTER COLUMN "sizeBytes" TYPE DOUBLE PRECISION;
ALTER TABLE "guide_videos" ALTER COLUMN "sizeBytes" TYPE DOUBLE PRECISION;
