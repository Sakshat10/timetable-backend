-- Substitution workflow: teacher absences, unavailability, lessons needing cover (from the PUBLISHED timetable) and an append-only audit trail.
-- Additive: four new tables and five new enums; no existing table or data changes.
-- Rollback (after rolling the code back first): DROP TABLE "cover_events", "cover_requests", "teacher_unavailabilities", "teacher_absences";
--   DROP TYPE "CoverEventAction", "CoverStatus", "RecordStatus", "AbsenceScope";

-- CreateEnum
CREATE TYPE "AbsenceScope" AS ENUM ('FULL_DAY', 'PERIODS');

-- CreateEnum
CREATE TYPE "RecordStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CoverStatus" AS ENUM ('OPEN', 'ASSIGNED', 'CANCELLED', 'OBSOLETE');

-- CreateEnum
CREATE TYPE "CoverEventAction" AS ENUM ('CREATED', 'ASSIGNED', 'REASSIGNED', 'UNASSIGNED', 'CANCELLED', 'OBSOLETED');

-- CreateTable
CREATE TABLE "teacher_absences" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "scope" "AbsenceScope" NOT NULL,
    "fromPeriod" INTEGER,
    "toPeriod" INTEGER,
    "reason" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "updatedById" TEXT,
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "teacher_absences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teacher_unavailabilities" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "periodNumber" INTEGER,
    "reason" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teacher_unavailabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cover_requests" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "absenceId" TEXT NOT NULL,
    "timetableVersionId" TEXT NOT NULL,
    "sourceEntryId" TEXT,
    "date" DATE NOT NULL,
    "dayOfWeek" "DayOfWeek" NOT NULL,
    "periodNumber" INTEGER NOT NULL,
    "sectionId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "absentTeacherId" TEXT NOT NULL,
    "status" "CoverStatus" NOT NULL DEFAULT 'OPEN',
    "replacementTeacherId" TEXT,
    "assignedById" TEXT,
    "assignedAt" TIMESTAMPTZ(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "obsoleteAt" TIMESTAMPTZ(3),
    "supersedesId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cover_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cover_events" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "coverRequestId" TEXT NOT NULL,
    "action" "CoverEventAction" NOT NULL,
    "fromStatus" "CoverStatus",
    "toStatus" "CoverStatus" NOT NULL,
    "fromTeacherId" TEXT,
    "toTeacherId" TEXT,
    "actorAdminId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cover_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "teacher_absences_schoolId_status_endDate_idx" ON "teacher_absences"("schoolId", "status", "endDate");

-- CreateIndex
CREATE INDEX "teacher_absences_teacherId_startDate_idx" ON "teacher_absences"("teacherId", "startDate");

-- CreateIndex
CREATE INDEX "teacher_unavailabilities_schoolId_date_idx" ON "teacher_unavailabilities"("schoolId", "date");

-- CreateIndex
CREATE INDEX "teacher_unavailabilities_teacherId_date_idx" ON "teacher_unavailabilities"("teacherId", "date");

-- CreateIndex
CREATE INDEX "cover_requests_schoolId_date_status_idx" ON "cover_requests"("schoolId", "date", "status");

-- CreateIndex
CREATE INDEX "cover_requests_absenceId_idx" ON "cover_requests"("absenceId");

-- CreateIndex
CREATE INDEX "cover_requests_timetableVersionId_idx" ON "cover_requests"("timetableVersionId");

-- CreateIndex
CREATE INDEX "cover_requests_replacementTeacherId_date_idx" ON "cover_requests"("replacementTeacherId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "cover_requests_absenceId_timetableVersionId_sectionId_date__key" ON "cover_requests"("absenceId", "timetableVersionId", "sectionId", "date", "periodNumber");

-- CreateIndex
CREATE INDEX "cover_events_coverRequestId_createdAt_idx" ON "cover_events"("coverRequestId", "createdAt");

-- AddForeignKey
ALTER TABLE "teacher_absences" ADD CONSTRAINT "teacher_absences_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_absences" ADD CONSTRAINT "teacher_absences_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "teachers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_unavailabilities" ADD CONSTRAINT "teacher_unavailabilities_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_unavailabilities" ADD CONSTRAINT "teacher_unavailabilities_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "teachers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cover_requests" ADD CONSTRAINT "cover_requests_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cover_requests" ADD CONSTRAINT "cover_requests_absenceId_fkey" FOREIGN KEY ("absenceId") REFERENCES "teacher_absences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cover_requests" ADD CONSTRAINT "cover_requests_timetableVersionId_fkey" FOREIGN KEY ("timetableVersionId") REFERENCES "timetable_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cover_requests" ADD CONSTRAINT "cover_requests_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cover_requests" ADD CONSTRAINT "cover_requests_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cover_requests" ADD CONSTRAINT "cover_requests_absentTeacherId_fkey" FOREIGN KEY ("absentTeacherId") REFERENCES "teachers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cover_requests" ADD CONSTRAINT "cover_requests_replacementTeacherId_fkey" FOREIGN KEY ("replacementTeacherId") REFERENCES "teachers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cover_events" ADD CONSTRAINT "cover_events_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cover_events" ADD CONSTRAINT "cover_events_coverRequestId_fkey" FOREIGN KEY ("coverRequestId") REFERENCES "cover_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Business rules as database constraints (Prisma cannot express CHECKs or partial unique indexes)
-- ---------------------------------------------------------------------------------------------------------------------------------------------

-- An absence: valid, bounded date range; FULL_DAY has no periods, PERIODS has a valid period range (1..12, as the schedule allows at most 12).
ALTER TABLE "teacher_absences" ADD CONSTRAINT "teacher_absences_dates_check" CHECK ("endDate" >= "startDate" AND "endDate" - "startDate" <= 365);
ALTER TABLE "teacher_absences" ADD CONSTRAINT "teacher_absences_scope_check" CHECK (
  ("scope" = 'FULL_DAY' AND "fromPeriod" IS NULL AND "toPeriod" IS NULL)
  OR ("scope" = 'PERIODS' AND "fromPeriod" IS NOT NULL AND "toPeriod" IS NOT NULL AND "fromPeriod" BETWEEN 1 AND 12 AND "toPeriod" BETWEEN "fromPeriod" AND 12)
);
ALTER TABLE "teacher_absences" ADD CONSTRAINT "teacher_absences_cancel_check" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL));

-- Unavailability: a whole day (periodNumber NULL) or one period 1..12; one ACTIVE record per teacher, date and period (whole day = 0).
ALTER TABLE "teacher_unavailabilities" ADD CONSTRAINT "teacher_unavailabilities_period_check" CHECK ("periodNumber" IS NULL OR "periodNumber" BETWEEN 1 AND 12);
ALTER TABLE "teacher_unavailabilities" ADD CONSTRAINT "teacher_unavailabilities_cancel_check" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL));
CREATE UNIQUE INDEX "teacher_unavailabilities_active_key" ON "teacher_unavailabilities" ("teacherId", "date", COALESCE("periodNumber", 0)) WHERE "status" = 'ACTIVE';

-- A cover request: valid period; OPEN has no replacement; ASSIGNED has one; the replacement is never the absent teacher.
ALTER TABLE "cover_requests" ADD CONSTRAINT "cover_requests_period_check" CHECK ("periodNumber" BETWEEN 1 AND 12);
ALTER TABLE "cover_requests" ADD CONSTRAINT "cover_requests_replacement_check" CHECK (
  ("status" <> 'OPEN' OR "replacementTeacherId" IS NULL)
  AND ("status" <> 'ASSIGNED' OR "replacementTeacherId" IS NOT NULL)
  AND ("replacementTeacherId" IS NULL OR "replacementTeacherId" <> "absentTeacherId")
);
-- At most ONE live (OPEN or ASSIGNED) request per lesson and date, whatever the absence or version: no duplicate cover for the same lesson.
CREATE UNIQUE INDEX "cover_requests_live_lesson_key" ON "cover_requests" ("sectionId", "date", "periodNumber") WHERE "status" IN ('OPEN', 'ASSIGNED');
-- A replacement can be booked for ONE lesson per date and period: the final guard against two simultaneous assignments of the same teacher.
CREATE UNIQUE INDEX "cover_requests_replacement_slot_key" ON "cover_requests" ("replacementTeacherId", "date", "periodNumber") WHERE "status" = 'ASSIGNED';
