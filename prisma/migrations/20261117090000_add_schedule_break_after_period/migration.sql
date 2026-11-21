-- Simplified school schedule: working days + teaching periods per day + exactly ONE break position. Clock timings are no longer part of the model.
--
-- ADDITIVE and data-preserving: one nullable column, one CHECK, one backfill UPDATE. No row is deleted and no clock time (schedule_periods start/end minutes,
-- schedule_timing_events, timetable_versions.periodTimes) is touched: they stay as READ-ONLY history that old versions and legacy configurations still show.
--
-- Backfill rule (decided from the stored data, not guessed): a configuration that has EXACTLY ONE timing event, positioned after a teaching period
-- (1 .. periodsPerDay-1), gets that position as its break. That is behaviour-preserving: the scheduler already treated any event after period k as the end of a
-- consecutive run there, so generated timetables, input hashes and substitution run lengths do not change. Configurations with zero events, several events, or an
-- event before the first / after the last period are AMBIGUOUS for a one-break model; they stay NULL (legacy), keep working from their stored event positions,
-- and become simplified when an admin saves the new form.
--
-- Rollback (code first): ALTER TABLE "schedule_configs" DROP CONSTRAINT "schedule_configs_breakAfterPeriod_check"; ALTER TABLE "schedule_configs" DROP COLUMN "breakAfterPeriod";

-- AlterTable
ALTER TABLE "schedule_configs" ADD COLUMN "breakAfterPeriod" INTEGER;

-- The break sits between two teaching periods of the same day.
ALTER TABLE "schedule_configs" ADD CONSTRAINT "schedule_configs_breakAfterPeriod_check"
  CHECK ("breakAfterPeriod" IS NULL OR ("breakAfterPeriod" >= 1 AND "breakAfterPeriod" < "periodsPerDay"));

-- Backfill (see the rule above).
UPDATE "schedule_configs" c
SET "breakAfterPeriod" = e."pos"
FROM (
  SELECT "scheduleConfigId", min("afterPeriodNumber") AS "pos", count(*) AS "n"
  FROM "schedule_timing_events"
  GROUP BY "scheduleConfigId"
) e
WHERE e."scheduleConfigId" = c."id"
  AND e."n" = 1
  AND e."pos" >= 1
  AND e."pos" < c."periodsPerDay";
