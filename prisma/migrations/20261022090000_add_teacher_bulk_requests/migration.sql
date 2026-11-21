-- Persistent request-level idempotency for POST /api/teachers/bulk.
-- Additive: one new table, no change to existing tables or data.
-- Rollback (after rolling the code back first): DROP TABLE "teacher_bulk_requests";

CREATE TABLE "teacher_bulk_requests" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teacher_bulk_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "teacher_bulk_requests_schoolId_idempotencyKey_key" ON "teacher_bulk_requests"("schoolId", "idempotencyKey");

ALTER TABLE "teacher_bulk_requests" ADD CONSTRAINT "teacher_bulk_requests_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
