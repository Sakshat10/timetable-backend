import { type TeacherSubjectGrade } from '@prisma/client';
import prisma from '../../config/database.js';
import { type CreateTeacherSubjectGradeInput } from './teacher-subject-grade.schema.js';
import { AppError, isUniqueViolation } from '../../utils/errors.js';
import { fetchTeacherSubjectWithOwnership } from '../teacher-subject/teacher-subject.service.js';

// ---------------------------------------------------------------------------
// Return type — eligibility row enriched with a grade summary
// ---------------------------------------------------------------------------
export interface TeacherSubjectGradeWithGrade extends TeacherSubjectGrade {
  grade: { id: string; name: string; displayOrder: number; academicYearId: string };
}

const gradeSummarySelect = {
  id: true,
  name: true,
  displayOrder: true,
  academicYearId: true,
} as const;

const DRAFT_ONLY_MESSAGE =
  'Teacher grade eligibility can only be modified while the academic year is in DRAFT status';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function duplicateEligibilityError(): AppError {
  return new AppError(409, 'This teacher subject is already eligible for this grade');
}

/**
 * Fetch a grade with its academic year and verify it belongs to the given school.
 * Throws 404 if not found, 403 if ownership mismatch.
 */
async function fetchGradeWithOwnership(gradeId: string, schoolId: string) {
  const grade = await prisma.grade.findUnique({
    where: { id: gradeId },
    include: { academicYear: true },
  });

  if (!grade) {
    throw new AppError(404, 'Grade not found');
  }

  if (grade.academicYear.schoolId !== schoolId) {
    throw new AppError(403, 'You do not have access to this grade');
  }

  return grade;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TeacherSubjectGradeService {
  /**
   * Mark a teacher-subject relationship as eligible for a grade.
   *
   * Rules:
   * 1. The teacher-subject's teacher AND subject must belong to the admin's school
   * 2. The grade (via its academic year) must belong to the admin's school
   * 3. The grade's academic year must be DRAFT
   * 4. (teacherSubject, grade) must not already exist
   *
   * The teacher is necessarily already associated with the subject because
   * the endpoint is addressed by teacherSubjectId.
   */
  async createEligibility(
    schoolId: string,
    teacherSubjectId: string,
    data: CreateTeacherSubjectGradeInput
  ): Promise<TeacherSubjectGradeWithGrade> {
    await fetchTeacherSubjectWithOwnership(teacherSubjectId, schoolId);
    const grade = await fetchGradeWithOwnership(data.gradeId, schoolId);

    if (grade.academicYear.status !== 'DRAFT') {
      throw new AppError(400, DRAFT_ONLY_MESSAGE);
    }

    const existing = await prisma.teacherSubjectGrade.findUnique({
      where: { teacherSubjectId_gradeId: { teacherSubjectId, gradeId: data.gradeId } },
    });

    if (existing) {
      throw duplicateEligibilityError();
    }

    try {
      return await prisma.teacherSubjectGrade.create({
        data: { teacherSubjectId, gradeId: data.gradeId },
        include: { grade: { select: gradeSummarySelect } },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateEligibilityError();
      throw error;
    }
  }

  /**
   * List the grades a teacher-subject is eligible for.
   * Allowed in any academic-year status. Ordered newest academic year first,
   * then by grade display order.
   */
  async getEligibility(
    schoolId: string,
    teacherSubjectId: string
  ): Promise<TeacherSubjectGradeWithGrade[]> {
    await fetchTeacherSubjectWithOwnership(teacherSubjectId, schoolId);

    return prisma.teacherSubjectGrade.findMany({
      where: { teacherSubjectId },
      include: { grade: { select: gradeSummarySelect } },
      orderBy: [{ grade: { academicYear: { startDate: 'desc' } } }, { grade: { displayOrder: 'asc' } }],
    });
  }

  /**
   * Remove a grade eligibility. Deletes only the relationship row — the
   * teacher, subject, teacher-subject and grade are untouched.
   *
   * Check order: ownership -> academic-year status -> existence, so a locked
   * year always reports 400 and a repeated delete in a DRAFT year reports 404.
   *
   * Data-integrity guard: a section subject teacher assignment (Module 8) depends on
   * this eligibility when it is for the same teacher, the same subject and a section
   * of this grade. Such an eligibility cannot be removed (409); the assignment is
   * preserved. The eligibility row is locked FOR UPDATE before the dependents are
   * counted, and assignment creation takes it FOR SHARE, so no assignment can slip in
   * between the check and the delete.
   */
  async deleteEligibility(
    schoolId: string,
    teacherSubjectId: string,
    gradeId: string
  ): Promise<void> {
    const teacherSubject = await fetchTeacherSubjectWithOwnership(teacherSubjectId, schoolId);
    const grade = await fetchGradeWithOwnership(gradeId, schoolId);

    if (grade.academicYear.status !== 'DRAFT') {
      throw new AppError(400, DRAFT_ONLY_MESSAGE);
    }

    const existing = await prisma.teacherSubjectGrade.findUnique({
      where: { teacherSubjectId_gradeId: { teacherSubjectId, gradeId } },
    });

    if (!existing) {
      throw new AppError(404, 'This teacher subject is not eligible for this grade');
    }

    await prisma.$transaction(async (tx) => {
      // Lock order: teacher_subject (FOR SHARE) then eligibility row, matching assignment validation. A concurrent
      // gradeScope change (FOR UPDATE on the teacher_subject row) therefore serialises with this delete.
      const scopes = await tx.$queryRaw<Array<{ gradeScope: string }>>`
        SELECT "gradeScope"::text AS "gradeScope" FROM "teacher_subjects" WHERE "id" = ${teacherSubjectId} FOR SHARE`;
      const gradeScope = scopes[0]?.gradeScope;
      if (!gradeScope) {
        throw new AppError(404, 'Teacher-subject relationship not found');
      }

      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "teacher_subject_grades" WHERE "id" = ${existing.id} FOR UPDATE`;

      if (locked.length === 0) {
        throw new AppError(404, 'This teacher subject is not eligible for this grade');
      }

      // Under ALL_GRADES the row is not what grants eligibility, so removing it cannot orphan an assignment.
      const dependents = gradeScope === 'ALL_GRADES' ? 0 : await tx.sectionSubjectTeacher.count({
        where: {
          teacherId: teacherSubject.teacherId,
          subjectRequirement: { subjectId: teacherSubject.subjectId },
          section: { gradeId },
        },
      });

      if (dependents > 0) {
        throw new AppError(
          409,
          'Cannot remove this grade eligibility because teacher assignments depend on it. ' +
            'Remove or change those assignments first.'
        );
      }

      await tx.teacherSubjectGrade.delete({ where: { id: existing.id } });
    });
  }
}

export const teacherSubjectGradeService = new TeacherSubjectGradeService();
