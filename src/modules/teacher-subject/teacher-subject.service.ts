import { type Subject, type Teacher, type TeacherSubject } from '@prisma/client';
import prisma from '../../config/database.js';
import {
  type CreateTeacherSubjectInput,
  type UpdateTeacherSubjectInput,
} from './teacher-subject.schema.js';
import { AppError, isUniqueViolation } from '../../utils/errors.js';

// ---------------------------------------------------------------------------
// Return type — TeacherSubject enriched with the subject summary
// ---------------------------------------------------------------------------
export interface TeacherSubjectWithSubject extends TeacherSubject {
  subject: { id: string; name: string; code: string };
}

const subjectSummarySelect = { id: true, name: true, code: true } as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function duplicateRelationshipError(): AppError {
  return new AppError(409, 'This subject is already assigned to this teacher');
}

async function fetchTeacherWithOwnership(teacherId: string, schoolId: string): Promise<Teacher> {
  const teacher = await prisma.teacher.findUnique({ where: { id: teacherId } });

  if (!teacher) {
    throw new AppError(404, 'Teacher not found');
  }

  if (teacher.schoolId !== schoolId) {
    throw new AppError(403, 'You do not have access to this teacher');
  }

  return teacher;
}

async function fetchSubjectWithOwnership(subjectId: string, schoolId: string): Promise<Subject> {
  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });

  if (!subject) {
    throw new AppError(404, 'Subject not found');
  }

  if (subject.schoolId !== schoolId) {
    throw new AppError(403, 'You do not have access to this subject');
  }

  return subject;
}

/**
 * Fetch a TeacherSubject and verify BOTH its teacher and its subject belong to
 * the given school (there is no database constraint tying them together).
 * Throws 404 if not found, 403 if either side belongs to another school.
 * Exported for reuse by the teacher-subject-grade module.
 */
export async function fetchTeacherSubjectWithOwnership(teacherSubjectId: string, schoolId: string) {
  const teacherSubject = await prisma.teacherSubject.findUnique({
    where: { id: teacherSubjectId },
    include: { teacher: true, subject: true },
  });

  if (!teacherSubject) {
    throw new AppError(404, 'Teacher-subject relationship not found');
  }

  if (teacherSubject.teacher.schoolId !== schoolId || teacherSubject.subject.schoolId !== schoolId) {
    throw new AppError(403, 'You do not have access to this teacher-subject relationship');
  }

  return teacherSubject;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TeacherSubjectService {
  /**
   * Associate a subject with a teacher.
   *
   * Rules:
   * 1. Teacher must belong to the admin's school
   * 2. Subject must belong to the admin's school
   * 3. Teacher must be active (existing relationships are unaffected by deactivation)
   * 4. (teacher, subject) must not already exist
   *
   * Both are school-level masters, so no academic-year status rule applies.
   */
  async createTeacherSubject(
    schoolId: string,
    teacherId: string,
    data: CreateTeacherSubjectInput
  ): Promise<TeacherSubjectWithSubject> {
    const teacher = await fetchTeacherWithOwnership(teacherId, schoolId);
    await fetchSubjectWithOwnership(data.subjectId, schoolId);

    if (!teacher.isActive) {
      throw new AppError(
        400,
        'Cannot add a subject to an inactive teacher. Reactivate the teacher first.'
      );
    }

    const existing = await prisma.teacherSubject.findUnique({
      where: { teacherId_subjectId: { teacherId, subjectId: data.subjectId } },
    });

    if (existing) {
      throw duplicateRelationshipError();
    }

    try {
      return await prisma.teacherSubject.create({
        data: { teacherId, subjectId: data.subjectId, type: data.type, gradeScope: data.gradeScope ?? 'SELECTED_GRADES' },
        include: { subject: { select: subjectSummarySelect } },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateRelationshipError();
      throw error;
    }
  }

  /**
   * List a teacher's subjects (works for inactive teachers too).
   */
  async getTeacherSubjects(
    schoolId: string,
    teacherId: string
  ): Promise<TeacherSubjectWithSubject[]> {
    await fetchTeacherWithOwnership(teacherId, schoolId);

    return prisma.teacherSubject.findMany({
      where: { teacherId },
      include: { subject: { select: subjectSummarySelect } },
      orderBy: [{ subject: { name: 'asc' } }, { subject: { code: 'asc' } }],
    });
  }

  /**
   * Change the type and/or the grade scope of an existing relationship.
   * Works for inactive teachers. Changing only the type is a plain update.
   *
   * A scope change always runs in a transaction that locks the row FOR UPDATE first, and decides from the LOCKED current value, so a stale
   * read can never narrow a link behind the back of an assignment that was created in the meantime. Assignment creation takes this row
   * FOR SHARE (lock order: teacher, this row, the eligibility row), so the two serialise.
   *
   * Narrowing ALL_GRADES -> SELECTED_GRADES is refused (409) while an assignment of this teacher and subject in a DRAFT academic year teaches a
   * grade without an explicit eligibility row: it would become ineligible (feasibility and generation would reject it). Add the grade rows
   * first (allowed while ALL_GRADES, and ignored until then), or change the assignments. Assignments in ACTIVE or COMPLETED years are
   * history and are not considered. Widening SELECTED_GRADES -> ALL_GRADES needs no check.
   */
  async updateTeacherSubject(
    teacherSubjectId: string,
    schoolId: string,
    data: UpdateTeacherSubjectInput
  ): Promise<TeacherSubjectWithSubject> {
    await fetchTeacherSubjectWithOwnership(teacherSubjectId, schoolId);

    if (data.gradeScope === undefined) {
      return prisma.teacherSubject.update({
        where: { id: teacherSubjectId },
        data: { ...(data.type !== undefined ? { type: data.type } : {}) },
        include: { subject: { select: subjectSummarySelect } },
      });
    }
    const requestedScope = data.gradeScope;

    return prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ teacherId: string; subjectId: string; gradeScope: string }>>`
        SELECT "teacherId", "subjectId", "gradeScope"::text AS "gradeScope" FROM "teacher_subjects" WHERE "id" = ${teacherSubjectId} FOR UPDATE`;
      const current = locked[0];
      if (!current) throw new AppError(404, 'Teacher-subject relationship not found');

      if (requestedScope === 'SELECTED_GRADES' && current.gradeScope === 'ALL_GRADES') {
        const uncovered = await tx.$queryRaw<Array<{ gradeName: string; assignments: number }>>`
          SELECT g."name" AS "gradeName", count(*)::int AS "assignments"
          FROM "section_subject_teachers" sst
          JOIN "subject_requirements" r ON r."id" = sst."subjectRequirementId"
          JOIN "sections" s ON s."id" = sst."sectionId"
          JOIN "grades" g ON g."id" = s."gradeId"
          JOIN "academic_years" y ON y."id" = g."academicYearId"
          WHERE sst."teacherId" = ${current.teacherId} AND r."subjectId" = ${current.subjectId} AND y."status" = 'DRAFT'::"AcademicYearStatus"
            AND NOT EXISTS (SELECT 1 FROM "teacher_subject_grades" tsg WHERE tsg."teacherSubjectId" = ${teacherSubjectId} AND tsg."gradeId" = g."id")
          GROUP BY g."name", g."displayOrder" ORDER BY g."displayOrder" LIMIT 5`;
        if (uncovered.length > 0) {
          const total = uncovered.reduce((n, g) => n + g.assignments, 0);
          throw new AppError(
            409,
            `Cannot restrict this teacher subject to selected grades: ${total}${uncovered.length === 5 ? '+' : ''} assignment(s) in DRAFT academic years teach grades without an explicit eligibility (${uncovered.map((g) => g.gradeName).join(', ')}). ` +
              'Add the eligibility for those grades first, or change those assignments.'
          );
        }
      }

      return tx.teacherSubject.update({
        where: { id: teacherSubjectId },
        data: { gradeScope: requestedScope, ...(data.type !== undefined ? { type: data.type } : {}) },
        include: { subject: { select: subjectSummarySelect } },
      });
    });
  }

  /**
   * Remove ONE teacher-subject link (a teacher's subject qualification). The teacher and the school-level subject are never touched.
   *
   * The link row is locked FOR UPDATE first (assignment validation and generation persistence hold it FOR SHARE, so they serialise with
   * this) and everything is decided from the locked state, in one transaction. Refused with 409 (nothing is deleted, nothing is cascaded)
   * while the link is in meaningful use:
   *   - a section-subject-teacher assignment of this teacher and subject exists in a DRAFT or ACTIVE academic year, or
   *   - a PUBLISHED timetable of a DRAFT or ACTIVE year contains lessons of this teacher and subject.
   * Change or delete those assignments, or replace the published timetable, first. COMPLETED years are history and never block.
   * Draft timetable versions do not block: they simply become stale (their configuration changed), as with any eligibility edit.
   * The link's grade eligibility rows are the link's own configuration and are removed with it (foreign key ON DELETE CASCADE): at that
   * point no assignment or published lesson depends on them.
   */
  async deleteTeacherSubject(teacherSubjectId: string, schoolId: string): Promise<void> {
    await fetchTeacherSubjectWithOwnership(teacherSubjectId, schoolId);

    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ teacherId: string; subjectId: string }>>`
        SELECT "teacherId", "subjectId" FROM "teacher_subjects" WHERE "id" = ${teacherSubjectId} FOR UPDATE`;
      const link = locked[0];
      if (!link) throw new AppError(404, 'Teacher-subject relationship not found'); // deleted while we waited

      const assignments = await tx.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n
        FROM "section_subject_teachers" sst
        JOIN "subject_requirements" r ON r."id" = sst."subjectRequirementId"
        JOIN "sections" s ON s."id" = sst."sectionId"
        JOIN "grades" g ON g."id" = s."gradeId"
        JOIN "academic_years" y ON y."id" = g."academicYearId"
        WHERE sst."teacherId" = ${link.teacherId} AND r."subjectId" = ${link.subjectId} AND y."status" IN ('DRAFT'::"AcademicYearStatus", 'ACTIVE'::"AcademicYearStatus")`;
      const published = await tx.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n
        FROM "timetable_entries" e
        JOIN "timetable_versions" v ON v."id" = e."versionId" AND v."status" = 'PUBLISHED'::"TimetableVersionStatus"
        JOIN "academic_years" y ON y."id" = v."academicYearId"
        WHERE e."teacherId" = ${link.teacherId} AND e."subjectId" = ${link.subjectId} AND y."status" IN ('DRAFT'::"AcademicYearStatus", 'ACTIVE'::"AcademicYearStatus")`;

      const assignmentCount = assignments[0]?.n ?? 0;
      const publishedCount = published[0]?.n ?? 0;
      if (assignmentCount > 0 || publishedCount > 0) {
        const reasons = [
          assignmentCount > 0 ? `${assignmentCount} section assignment(s) of this teacher and subject exist in DRAFT or ACTIVE academic years` : '',
          publishedCount > 0 ? `${publishedCount} lesson(s) of this teacher and subject are in a published timetable` : '',
        ].filter(Boolean);
        throw new AppError(409, `Cannot remove this subject from the teacher: ${reasons.join(' and ')}. Remove or change those first.`);
      }

      await tx.teacherSubject.delete({ where: { id: teacherSubjectId } });
    });
  }
}

export const teacherSubjectService = new TeacherSubjectService();
