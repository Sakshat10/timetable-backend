-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateTable
CREATE TABLE "schedule_configs" (
    "id" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "periodsPerDay" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_days" (
    "id" TEXT NOT NULL,
    "scheduleConfigId" TEXT NOT NULL,
    "dayOfWeek" "DayOfWeek" NOT NULL,
    "isWorkingDay" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_periods" (
    "id" TEXT NOT NULL,
    "scheduleConfigId" TEXT NOT NULL,
    "periodNumber" INTEGER NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "schedule_configs_academicYearId_key" ON "schedule_configs"("academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_days_scheduleConfigId_dayOfWeek_key" ON "schedule_days"("scheduleConfigId", "dayOfWeek");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_days_scheduleConfigId_displayOrder_key" ON "schedule_days"("scheduleConfigId", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_periods_scheduleConfigId_periodNumber_key" ON "schedule_periods"("scheduleConfigId", "periodNumber");

-- AddForeignKey
ALTER TABLE "schedule_configs" ADD CONSTRAINT "schedule_configs_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_days" ADD CONSTRAINT "schedule_days_scheduleConfigId_fkey" FOREIGN KEY ("scheduleConfigId") REFERENCES "schedule_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_periods" ADD CONSTRAINT "schedule_periods_scheduleConfigId_fkey" FOREIGN KEY ("scheduleConfigId") REFERENCES "schedule_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
