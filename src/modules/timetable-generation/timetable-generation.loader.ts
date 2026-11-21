import { requirementSectionIds } from '../timetable-feasibility/requirement-applicability.js';
import { effectiveSchedule, SCHEDULE_ENGINE_SELECT } from '../schedule-config/schedule-config.effective.js';
import { Prisma, type PrismaClient } from '@prisma/client';
import { type GenerationSnapshot } from './timetable-generation.normalizer.js';
import { type PeriodTime } from './timetable-generation.period-times.js';

// ---------------------------------------------------------------------------
// Authoritative snapshot of one academic year for generation.
//
// It reads exactly what Module 10's loader reads (same query shapes, so the analyzer and the normalizer see identical
// data) PLUS the schedule's timing events, which the Phase 1 normalizer needs for `continuesIntoNext`. Module 10's own
// loader is frozen, opens its own transaction and does not read timing events, so it cannot be reused for this; a parity
// test (test-timetable-generation-runner.ts) proves the two return the same scheduling data.
//
// `readGenerationSnapshot(client, ...)` works on any Prisma client, so the final persistence transaction can re-read the
// data under its locks; `loadGenerationSnapshot` wraps it in one REPEATABLE READ transaction (a consistent snapshot that
// never blocks writers).
// ---------------------------------------------------------------------------

export class SnapshotError extends Error {
  constructor(public readonly code: 'ACADEMIC_YEAR_NOT_FOUND' | 'ACADEMIC_YEAR_FOREIGN', message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

type Client = Prisma.TransactionClient;

export async function readGenerationSnapshot(tx: Client, schoolId: string, academicYearId: string): Promise<GenerationSnapshot> {
  const academicYear = await tx.academicYear.findUnique({
    where: { id: academicYearId },
    select: { id: true, name: true, status: true, schoolId: true },
  });
  if (!academicYear) throw new SnapshotError('ACADEMIC_YEAR_NOT_FOUND', 'Academic year not found');
  if (academicYear.schoolId !== schoolId) throw new SnapshotError('ACADEMIC_YEAR_FOREIGN', 'The academic year belongs to another school');

  const inYear = { academicYearId };
  const config = await tx.scheduleConfig.findUnique({
    where: { academicYearId },
    select: SCHEDULE_ENGINE_SELECT,
  });
  const schedule = config ? effectiveSchedule(config) : null;
  const grades = await tx.grade.findMany({ where: inYear, select: { id: true, name: true, displayOrder: true } });
  const streams = await tx.stream.findMany({ where: { grade: inYear }, select: { id: true, gradeId: true, name: true, code: true } });
  const sections = await tx.section.findMany({ where: { grade: inYear }, select: { id: true, gradeId: true, streamId: true, name: true, code: true } });
  const requirements = await tx.subjectRequirement.findMany({
    where: { grade: inYear },
    select: { id: true, gradeId: true, streamId: true, subjectId: true, periodsPerWeek: true, sectionScope: true, sections: { select: { sectionId: true } } },
  });
  const assignments = await tx.sectionSubjectTeacher.findMany({
    where: { section: { grade: inYear } },
    select: {
      id: true,
      sectionId: true,
      subjectRequirementId: true,
      teacherId: true,
      teacher: { select: { id: true, schoolId: true, name: true, isActive: true } },
    },
  });
  const usedByYear = { subjectRequirements: { some: { grade: inYear } } };
  const subjects = await tx.subject.findMany({ where: usedByYear, select: { id: true, name: true, code: true, schoolId: true } });
  const schoolTeachers = await tx.teacher.findMany({ where: { schoolId }, select: { id: true, schoolId: true, name: true, isActive: true } });
  const teacherSubjects = await tx.teacherSubject.findMany({
    where: { teacher: { schoolId }, subject: usedByYear },
    select: { teacherId: true, subjectId: true, gradeScope: true, grades: { where: { grade: inYear }, select: { gradeId: true } } },
  });

  const teachers = new Map(schoolTeachers.map((t) => [t.id, t]));
  for (const a of assignments) teachers.set(a.teacher.id, a.teacher);

  return {
    schoolId,
    academicYear: { id: academicYear.id, name: academicYear.name, status: academicYear.status },
    schedule: schedule ? { periodsPerDay: schedule.periodsPerDay, workingDays: schedule.workingDays, periods: schedule.periods } : null,
    grades,
    streams,
    sections,
    subjects,
    requirements: requirements.map((r) => ({ id: r.id, gradeId: r.gradeId, streamId: r.streamId, subjectId: r.subjectId, periodsPerWeek: r.periodsPerWeek, sectionIds: requirementSectionIds(r) })),
    assignments: assignments.map((a) => ({ id: a.id, sectionId: a.sectionId, subjectRequirementId: a.subjectRequirementId, teacherId: a.teacherId })),
    teachers: [...teachers.values()],
    teacherSubjects: teacherSubjects.map((link) => ({ teacherId: link.teacherId, subjectId: link.subjectId, gradeIds: link.grades.map((g) => g.gradeId), allGrades: link.gradeScope === 'ALL_GRADES' })),
    timingEvents: schedule ? schedule.breakPositions.map((afterPeriodNumber) => ({ afterPeriodNumber })) : [],
  };
}

/** One fresh, internally consistent snapshot (REPEATABLE READ: it never blocks writers and never sees half an edit). */
export async function loadGenerationSnapshot(prisma: PrismaClient, schoolId: string, academicYearId: string): Promise<GenerationSnapshot> {
  return prisma.$transaction((tx) => readGenerationSnapshot(tx, schoolId, academicYearId), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: 10_000,
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Phase 7F-0: the same snapshot PLUS the period times, read in the SAME transaction (so the times are consistent with the scheduling
// data). GenerationSnapshot itself is unchanged (times are not scheduling data, so the normalizer and both hashes never see them).
// ---------------------------------------------------------------------------
export interface GenerationSnapshotWithTimes {
  snapshot: GenerationSnapshot;
  /** Periods 1..n with their school-local minutes; null when the year has no schedule (it will then fail normalisation anyway). */
  periodTimes: PeriodTime[] | null;
  /** True when period rows exist but are not a valid 1..n sequence (never expected: Module 9 validates them). */
  periodTimesInvalid: boolean;
}

export async function readGenerationSnapshotWithTimes(tx: Client, schoolId: string, academicYearId: string): Promise<GenerationSnapshotWithTimes> {
  const snapshot = await readGenerationSnapshot(tx, schoolId, academicYearId);
  // Clock times are not part of a schedule any more: no schedule_periods row is read. The EMPTY list is the run's period-time snapshot ("no clock times").
  return { snapshot, periodTimes: [], periodTimesInvalid: false };
}

export async function loadGenerationSnapshotWithTimes(prisma: PrismaClient, schoolId: string, academicYearId: string): Promise<GenerationSnapshotWithTimes> {
  return prisma.$transaction((tx) => readGenerationSnapshotWithTimes(tx, schoolId, academicYearId), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: 10_000,
    timeout: 30_000,
  });
}
