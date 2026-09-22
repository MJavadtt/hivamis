-- Organisational memory, searchable by meaning (roadmap #21).
--
-- The vector is a float array rather than a pgvector column: the feature works on a stock
-- PostgreSQL, which is what ADR-006 asked for. A deployment that installs pgvector can add a
-- `vector` column and an HNSW index alongside without changing the arithmetic — see
-- docs/operations.md.
CREATE TABLE IF NOT EXISTS "memory_documents" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "projectId" TEXT,
    "companyId" TEXT,
    "titleFa" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "searchText" TEXT NOT NULL,
    "vector" DOUBLE PRECISION[],
    "dims" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_documents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "memory_documents_organizationId_entityType_idx" ON "memory_documents"("organizationId", "entityType");
CREATE INDEX IF NOT EXISTS "memory_documents_organizationId_projectId_idx" ON "memory_documents"("organizationId", "projectId");
CREATE UNIQUE INDEX IF NOT EXISTS "memory_documents_entityType_entityId_key" ON "memory_documents"("entityType", "entityId");

-- Trigram index for the lexical half of the hybrid score. pg_trgm ships with PostgreSQL.
--
-- Pinned to the public schema and referenced schema-qualified: this database gives each test
-- file its own schema, and an operator class found only on today's search_path is a migration
-- that works on one machine.
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;
DROP INDEX IF EXISTS "memory_documents_search_trgm";
CREATE INDEX "memory_documents_search_trgm" ON "memory_documents" USING gin ("searchText" public.gin_trgm_ops);
