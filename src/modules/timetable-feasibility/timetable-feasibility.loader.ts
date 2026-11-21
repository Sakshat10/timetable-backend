import { requirementSectionIds } from './requirement-applicability.js';
import { effectiveSchedule, SCHEDULE_ENGINE_SELECT } from '../schedule-config/schedule-config.effective.js';
import { Prisma } from '@prisma/client';
import prisma from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import { type SchedulingInput } from './timetable-feasibility.analyzer.js';

/**
 * Read everything the feasibility analyzer needs for one academic year, in ONE REPEATABLE READ
 * transaction. All reads see the same database snapshot, so the report is internally consistent even
 * if an admin edits the configuration (for example PATCHes the schedule, which rewrites child rows)
 * while it is being built. Postgres MVCC makes this lock-free: it never blocks writers.
 *
 * Query shape (constant, independent of the number of sections or teachers; no per-row queries):
 *  1 academic year (ownership + status)        6 requirements of the year
 *  2 schedule config + days + periods          7 assignments of the year (+ teacher)
 *  3 grades of the year                        8 subjects used by the year's requirements
 *  4 streams of the year's grades              9 the school's teachers
 *  5 sections of the year                     10 teacher-subject links (+ eligible grades of the year)
 *
 * Throws 404 if the academic year does not exist and 403 if it belongs to another school.
 */
export async function loadSchedulingInput(schoolId: string, academicYearId: string): Promise<SchedulingInput> {
  return prisma.$transaction(
    async (tx) => {
      const academicYear = await tx.academicYear.findUnique({
        where: { id: academicYearId },
        select: { id: true, name: true, status: true, schoolId: true },
      });

      if (!academicYear) {
        throw new AppError(404, 'Academic year not found');
      }

      if (academicYear.schoolId !== schoolId) {
        throw new AppError(403, 'You do not have access to this academic year');
      }

      const inYear = { academicYearId };

      const config = await tx.scheduleConfig.findUnique({
        where: { academicYearId },
        select: SCHEDULE_ENGINE_SELECT,
      });
      const schedule = config ? effectiveSchedule(config) : null;
      const grades = await tx.grade.findMany({
        where: inYear,
        select: { id: true, name: true, displayOrder: true },
      });
      const streams = await tx.stream.findMany({
        where: { grade: inYear },
        select: { id: true, gradeId: true, name: true, code: true },
      });
      const sections = await tx.section.findMany({
        where: { grade: inYear },
        select: { id: true, gradeId: true, streamId: true, name: true, code: true },
      });
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
      const subjects = await tx.subject.findMany({
        where: usedByYear,
        select: { id: true, name: true, code: true, schoolId: true },
      });
      const schoolTeachers = await tx.teacher.findMany({
        where: { schoolId },
        select: { id: true, schoolId: true, name: true, isActive: true },
      });
      const teacherSubjects = await tx.teacherSubject.findMany({
        where: { teacher: { schoolId }, subject: usedByYear },
        select: {
          teacherId: true,
          subjectId: true,
          gradeScope: true,
          grades: { where: { grade: inYear }, select: { gradeId: true } },
        },
      });

      // The school's teachers plus any teacher an assignment points at (to spot foreign teachers).
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
        assignments: assignments.map((a) => ({
          id: a.id,
          sectionId: a.sectionId,
          subjectRequirementId: a.subjectRequirementId,
          teacherId: a.teacherId,
        })),
        teachers: [...teachers.values()],
        teacherSubjects: teacherSubjects.map((link) => ({
          teacherId: link.teacherId,
          subjectId: link.subjectId,
          gradeIds: link.grades.map((g) => g.gradeId),
          allGrades: link.gradeScope === 'ALL_GRADES',
        })),
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 10_000,
      timeout: 30_000,
    }
  );
}
