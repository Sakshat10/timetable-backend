-- Migration: schedule grid stored as minutes-since-midnight + timing events
--
-- Module 9 (Schedule Configuration).
--
--  1. schedule_periods.startTime / endTime were TIMESTAMP(3) (a date and time with no time
--     zone). A school period is a wall-clock time of day, so they are replaced by integer
--     minutes since midnight (startMinute / endMinute).
--  2. schedule_days.isWorkingDay / displayOrder are removed. A row now simply means "this is a
--     working day"; non-working days have no row, and the DayOfWeek enum already sorts
--     Monday..Sunday.
--  3. New table schedule_timing_events (break / lunch / assembly / other). Each event is anchored
--     to the gap after a period (afterPeriodNumber, 0 = before period 1) and carries explicit
--     start/end minutes. Events are display data; the scheduler only reads days + periods.
--  4. CHECK constraints (Prisma's DSL cannot express them):
--       periodsPerDay > 0, periodNumber >= 1,
--       0 <= startMinute < endMinute <= 1439 (periods and events), afterPeriodNumber >= 0.
--     The upper bound of 12 periods per day is enforced in the application only.
--
-- DESTRUCTIVE-STEP SAFETY GUARD: this migration drops columns. It first aborts (rolling the
-- whole migration back) if any of the three existing schedule tables contains a row, so it can
-- never destroy data. The tables are empty when this is written.

-- Step 0: refuse to run if there is any data to lose
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "schedule_configs")
     OR EXISTS (SELECT 1 FROM "schedule_days")
     OR EXISTS (SELECT 1 FROM "schedule_periods") THEN
    RAISE EXCEPTION 'Refusing to migrate: schedule_configs / schedule_days / schedule_periods are not empty';
  END IF;
END $$;

-- Step 1: new enum
CREATE TYPE "ScheduleEventType" AS ENUM ('BREAK', 'LUNCH', 'ASSEMBLY', 'OTHER');

-- Step 2: working days are rows; drop the redundant columns and their unique index
DROP INDEX "schedule_days_scheduleConfigId_displayOrder_key";
ALTER TABLE "schedule_days" DROP COLUMN "isWorkingDay",
                            DROP COLUMN "displayOrder";

-- Step 3: period times become integer minutes since midnight
ALTER TABLE "schedule_periods" DROP COLUMN "startTime",
                               DROP COLUMN "endTime",
                               ADD COLUMN "startMinute" INTEGER NOT NULL,
                               ADD COLUMN "endMinute" INTEGER NOT NULL;

-- Step 4: timing events
CREATE TABLE "schedule_timing_events" (
    "id" TEXT NOT NULL,
    "scheduleConfigId" TEXT NOT NULL,
    "eventType" "ScheduleEventType" NOT NULL,
    "label" TEXT,
    "afterPeriodNumber" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_timing_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "schedule_timing_events_scheduleConfigId_afterPeriodNumber_idx"
  ON "schedule_timing_events"("scheduleConfigId", "afterPeriodNumber");

ALTER TABLE "schedule_timing_events"
  ADD CONSTRAINT "schedule_timing_events_scheduleConfigId_fkey"
  FOREIGN KEY ("scheduleConfigId") REFERENCES "schedule_configs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 5: CHECK constraints
ALTER TABLE "schedule_configs"
  ADD CONSTRAINT "schedule_configs_periodsPerDay_positive_check"
  CHECK ("periodsPerDay" > 0);

ALTER TABLE "schedule_periods"
  ADD CONSTRAINT "schedule_periods_periodNumber_positive_check"
  CHECK ("periodNumber" >= 1),
  ADD CONSTRAINT "schedule_periods_time_range_check"
  CHECK ("startMinute" >= 0 AND "endMinute" <= 1439 AND "startMinute" < "endMinute");

ALTER TABLE "schedule_timing_events"
  ADD CONSTRAINT "schedule_timing_events_afterPeriodNumber_check"
  CHECK ("afterPeriodNumber" >= 0),
  ADD CONSTRAINT "schedule_timing_events_time_range_check"
  CHECK ("startMinute" >= 0 AND "endMinute" <= 1439 AND "startMinute" < "endMinute");
