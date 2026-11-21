-- Automatic substitution: who decided an assignment, whether it is a temporary unqualified cover, why the allocator left a request open, and the
-- ranking facts behind each automatic decision. Additive only: no existing row or constraint changes (new columns are nullable or defaulted).
-- Rollback (code first): ALTER TABLE "cover_events" DROP COLUMN "details"; ALTER TABLE "cover_requests" DROP COLUMN "assignmentSource", DROP COLUMN
-- "temporaryUnqualified", DROP COLUMN "attentionCode", DROP COLUMN "attentionNote"; DROP TYPE "CoverAssignmentSource"; (enum values cannot be dropped).

-- CreateEnum
CREATE TYPE "CoverAssignmentSource" AS ENUM ('MANUAL', 'AUTOMATIC');

-- AlterEnum
ALTER TYPE "CoverEventAction" ADD VALUE 'AUTO_ASSIGNED';
ALTER TYPE "CoverEventAction" ADD VALUE 'AUTO_UNFILLED';
ALTER TYPE "CoverEventAction" ADD VALUE 'AUTO_RELEASED';

-- AlterTable
ALTER TABLE "cover_requests" ADD COLUMN "assignmentSource" "CoverAssignmentSource",
ADD COLUMN "temporaryUnqualified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "attentionCode" TEXT,
ADD COLUMN "attentionNote" TEXT;

-- AlterTable
ALTER TABLE "cover_events" ADD COLUMN "details" JSONB;

-- Existing assignments were all made by an admin.
UPDATE "cover_requests" SET "assignmentSource" = 'MANUAL' WHERE "status" = 'ASSIGNED';

-- Only an ASSIGNED request has a decision source.
ALTER TABLE "cover_requests" ADD CONSTRAINT "cover_requests_assignment_source_check" CHECK (("status" = 'ASSIGNED') = ("assignmentSource" IS NOT NULL) OR "status" IN ('CANCELLED', 'OBSOLETE'));
