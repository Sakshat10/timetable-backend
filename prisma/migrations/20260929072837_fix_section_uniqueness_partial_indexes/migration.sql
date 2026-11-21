-- Migration: Fix Section uniqueness constraint for streamed grades
--
-- Problem with the existing constraint:
--   UNIQUE (gradeId, code)
-- This incorrectly blocks two sections with the same code in different streams,
-- e.g. Grade11/Science/A and Grade11/Commerce/A would collide.
--
-- Problem with a naive replacement:
--   UNIQUE (gradeId, streamId, code)
-- PostgreSQL treats NULL as distinct from every other NULL value in standard
-- composite unique indexes, so (Grade6, NULL, 'A') and (Grade6, NULL, 'A')
-- would both be permitted — wrong for non-streamed grades.
--
-- Solution: Two partial unique indexes with WHERE predicates.
--
-- Index 1 covers non-streamed sections (streamId IS NULL):
--   UNIQUE(gradeId, code) WHERE streamId IS NULL
--   → (G6, NULL, 'A') + (G6, NULL, 'A')  = second rejected  ✓
--
-- Index 2 covers streamed sections (streamId IS NOT NULL):
--   UNIQUE(gradeId, streamId, code) WHERE streamId IS NOT NULL
--   → (G11, Science, 'A') + (G11, Commerce, 'A') = both allowed ✓
--   → (G11, Science, 'A') + (G11, Science, 'A')  = second rejected ✓

-- Step 1: Drop the existing incorrect unique constraint
DROP INDEX IF EXISTS "sections_gradeId_code_key";

-- Step 2: Create partial unique index for non-streamed sections
CREATE UNIQUE INDEX "sections_gradeId_code_no_stream_key"
  ON "sections" ("gradeId", "code")
  WHERE "streamId" IS NULL;

-- Step 3: Create partial unique index for streamed sections
CREATE UNIQUE INDEX "sections_gradeId_streamId_code_key"
  ON "sections" ("gradeId", "streamId", "code")
  WHERE "streamId" IS NOT NULL;
