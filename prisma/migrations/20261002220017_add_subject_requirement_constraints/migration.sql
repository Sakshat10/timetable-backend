-- Migration: Subject requirement uniqueness for non-streamed grades + positive periods
--
-- Problem with the existing constraint:
--   UNIQUE (gradeId, streamId, subjectId)
-- PostgreSQL treats NULL as distinct from every other NULL in a standard unique
-- index, so for a NON-streamed requirement (streamId IS NULL) two rows with the
-- same (gradeId, subjectId) are both accepted. The existing index therefore only
-- protects STREAMED requirements, which is correct and is left untouched.
--
-- Solution: one partial unique index covering the non-streamed case, the same
-- approach used for sections in 20260929072837_fix_section_uniqueness_partial_indexes.
--
--   UNIQUE(gradeId, subjectId) WHERE streamId IS NULL
--   -> (G6, MATH, NULL) + (G6, MATH, NULL)  = second rejected
--
-- Also add a CHECK so periodsPerWeek can never be zero or negative, whatever
-- code path writes the row. The upper bound (40) is enforced in the application
-- only, because it may change once schedule configuration exists.
--
-- The table is empty when this runs, so there is no backfill and no conflict.

-- Step 1: Partial unique index for non-streamed requirements
CREATE UNIQUE INDEX "subject_requirements_gradeId_subjectId_no_stream_key"
  ON "subject_requirements" ("gradeId", "subjectId")
  WHERE "streamId" IS NULL;

-- Step 2: periodsPerWeek must be positive
ALTER TABLE "subject_requirements"
  ADD CONSTRAINT "subject_requirements_periodsPerWeek_positive_check"
  CHECK ("periodsPerWeek" > 0);
