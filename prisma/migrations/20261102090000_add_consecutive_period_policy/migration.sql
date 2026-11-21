-- School-level policy for four or more consecutive teaching periods of a substitute. Additive: one enum and one NOT NULL column with a default, so every existing school
-- gets PREFER_AVOID (the behaviour the substitution module already had: avoid it, allow it as a last resort). No row is rewritten in a way that loses data.
-- Rollback (code first): ALTER TABLE "schools" DROP COLUMN "consecutivePeriodPolicy"; DROP TYPE "ConsecutivePeriodPolicy";

-- CreateEnum
CREATE TYPE "ConsecutivePeriodPolicy" AS ENUM ('ALLOW', 'PREFER_AVOID', 'NEVER_ALLOW');

-- AlterTable
ALTER TABLE "schools" ADD COLUMN "consecutivePeriodPolicy" "ConsecutivePeriodPolicy" NOT NULL DEFAULT 'PREFER_AVOID';
