import { type Prisma, type SectionSubjectTeacher } from '@prisma/client';
import prisma from '../../config/database.js';
import {
  type CreateSectionSubjectTeacherInput,
  type ListSectionSubjectTeachersQuery,
  type UpdateSectionSubjectTeacherInput,
} from './section-subject-teacher.schema.js';
import { AppError, isUniqueViolation } from '../../utils/errors.js';
import { assertSectionInScope } from '../subject-requirement/requirement-scope.js';

// ---------------------------------------------------------------------------
// Return type — assignment enriched through relations (nothing is duplicated in the table)
// ---------------------------------------------------------------------------
export interface SectionSubjectTeacherDetail extends SectionSubjectTeacher {
  section: { id: string; name: string; code: string };
  grade: { id: string; name: string; displayOrder: number; academicYearId: string };
  stream: { id: string; name: string; code: string } | null;
  subject: { id: string; name: string; code: string };
  subjectRequirement: { id: string; periodsPerWeek: number };
  teacher: { id: string; name: string; employeeCode: string | null; isActive: boolean };
}

const detailInclude = {
  section: {
    select: {
      id: true,
      name: true,
      code: true,
      grade: { select: { id: true, name: true, displayOrder: true, academicYearId: true } },
      stream: { select: { id: true, name: true, code: true } },
    },
  },
  subjectRequirement: {
    select: {
      id: true,
      periodsPerWeek: true,
      subject: { select: { id: true, name: true, code: true } },
    },
  },
  teacher: { select: { id: true, name: true, employeeCode: true, isActive: true } },
} as const;

type DetailRow = Prisma.SectionSubjectTeacherGetPayload<{ include: typeof detailInclude }>;

function toDetail(row: DetailRow): SectionSubjectTeacherDetail {
  return {
    id: row.id,
    sectionId: row.sectionId,
    subjectRequirementId: row.subjectRequirementId,
    teacherId: row.teacherId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    section: { id: row.section.id, name: row.section.name, code: row.section.code },
    grade: row.section.grade,
    stream: row.section.stream,
    subject: row.subjectRequirement.subject,
    subjectRequirement: { id: row.subjectRequirement.id, periodsPerWeek: row.subjectRequirement.periodsPerWeek },
    teacher: row.teacher,
  };
}

const DRAFT_ONLY_MESSAGE =
  'Section subject teacher assignments can only be modified while the academic year is in DRAFT status';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function duplicateError(): AppError {
  return new AppError(
    409,
    'This section already has a teacher assigned for this subject requirement'
  );
}

/**
 * Fetch a section with its grade/academic year and verify it belongs to the school.
 * Throws 404 if not found, 403 if ownership mismatch.
 */
async function fetchSectionWithOwnership(sectionId: string, schoolId: string) {
  const section = await prisma.section.findUnique({
    where: { id: sectionId },
    include: { grade: { include: { academicYear: true } } },
  });

  if (!section) {
    throw new AppError(404, 'Section not found');
  }

  if (section.grade.academicYear.schoolId !== schoolId) {
    throw new AppError(403, 'You do not have access to this section');
  }

  return section;
}

/**
 * Fetch a requirement and verify BOTH its grade's school and its subject's school.
 * Throws 404 if not found, 403 if either belongs to another school.
 */
async function fetchRequirementWithOwnership(requirementId: string, schoolId: string) {
  const requirement = await prisma.subjectRequirement.findUnique({
    where: { id: requirementId },
    include: { subject: true, grade: { include: { academicYear: true } } },
  });

  if (!requirement) {
    throw new AppError(404, 'Subject requirement not found');
  }

  if (
    requirement.grade.academicYear.schoolId !== schoolId ||
    requirement.subject.schoolId !== schoolId
  ) {
    throw new AppError(403, 'You do not have access to this subject requirement');
  }

  return requirement;
}

/**
 * The section and the requirement must describe the same class group:
 * same grade, and exactly the same stream (null equals null).
 */
function assertSectionMatchesRequirement(
  section: { gradeId: string; streamId: string | null },
  requirement: { gradeId: string; streamId: string | null }
): void {
  if (requirement.gradeId !== section.gradeId) {
    throw new AppError(400, 'The subject requirement does not belong to the same grade as the section');
  }

  if (requirement.streamId !== section.streamId) {
    throw new AppError(
      400,
      section.streamId === null
        ? 'The subject requirement is for a stream, but the section is not in a stream'
        : requirement.streamId === null
          ? 'The subject requirement is not stream-specific, but the section is in a stream'
          : 'The subject requirement is for a different stream than the section'
    );
  }
}

/**
 * Fetch an assignment and verify EVERY ownership chain:
 *   section -> grade -> academic year -> school
 *   requirement -> grade -> academic year -> school, and requirement -> subject -> school
 *   teacher -> school
 * Any foreign link (including a deliberately corrupt mixed-school row) is a 403.
 */
async function fetchAssignmentWithOwnership(assignmentId: string, schoolId: string) {
  const assignment = await prisma.sectionSubjectTeacher.findUnique({
    where: { id: assignmentId },
    include: {
      section: { include: { grade: { include: { academicYear: true } } } },
      subjectRequirement: { include: { subject: true, grade: { include: { academicYear: true } } } },
      teacher: true,
    },
  });

  if (!assignment) {
    throw new AppError(404, 'Section subject teacher assignment not found');
  }

  if (
    assignment.section.grade.academicYear.schoolId !== schoolId ||
    assignment.subjectRequirement.grade.academicYear.schoolId !== schoolId ||
    assignment.subjectRequirement.subject.schoolId !== schoolId ||
    assignment.teacher.schoolId !== schoolId
  ) {
    throw new AppError(403, 'You do not have access to this section subject teacher assignment');
  }

  return assignment;
}

/**
 * Validate that a teacher may teach `subjectId` to `gradeId`, inside the caller's transaction.
 *
 * Lock order (always the same): teacher row, teacher_subject row, then the eligibility row, all FOR SHARE.
 * Deactivating the teacher (Module 6 PATCH) and deleting the eligibility (Module 6 DELETE,
 * which takes FOR UPDATE) therefore wait for this transaction, or make it fail
 * validation, so a teacher who is inactive / no longer eligible can never be newly assigned.
 *
 *  1. teacher exists (404), belongs to the school (403)
 *  2. teacher is active (400)
 *  3. teacher is linked to the subject (400)
 *  4. that link is eligible for the grade (400): gradeScope ALL_GRADES, or an explicit eligibility row
 */
async function validateTeacherForAssignment(
  tx: Prisma.TransactionClient,
  schoolId: string,
  teacherId: string,
  subjectId: string,
  gradeId: string
): Promise<void> {
  const teachers = await tx.$queryRaw<Array<{ id: string; schoolId: string; isActive: boolean }>>`
    SELECT "id", "schoolId", "isActive" FROM "teachers" WHERE "id" = ${teacherId} FOR SHARE`;
  const teacher = teachers[0];

  if (!teacher) {
    throw new AppError(404, 'Teacher not found');
  }

  if (teacher.schoolId !== schoolId) {
    throw new AppError(403, 'You do not have access to this teacher');
  }

  if (!teacher.isActive) {
    throw new AppError(400, 'The teacher is inactive and cannot be assigned to a section');
  }

  // Lock the link FOR SHARE so a concurrent gradeScope change (FOR UPDATE) serialises with this validation.
  const links = await tx.$queryRaw<Array<{ id: string; gradeScope: string }>>`
    SELECT "id", "gradeScope"::text AS "gradeScope" FROM "teacher_subjects"
    WHERE "teacherId" = ${teacherId} AND "subjectId" = ${subjectId} FOR SHARE`;
  const teacherSubject = links[0];

  if (!teacherSubject) {
    throw new AppError(400, 'The teacher is not assigned to teach this subject');
  }

  // ALL_GRADES is an explicit admin choice and needs no eligibility row. SELECTED_GRADES (the default) requires one.
  if (teacherSubject.gradeScope === 'ALL_GRADES') return;

  const eligibility = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "teacher_subject_grades"
    WHERE "teacherSubjectId" = ${teacherSubject.id} AND "gradeId" = ${gradeId} FOR SHARE`;

  if (eligibility.length === 0) {
    throw new AppError(400, 'The teacher is not eligible to teach this subject for the section\'s grade');
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SectionSubjectTeacherService {
  /**
   * Assign a teacher to teach a subject (via its requirement) to a section.
   *
   * Validation order: section (ownership, DRAFT year) -> requirement (ownership) ->
   * section/requirement compatibility (grade, exact stream) -> teacher (ownership, active,
   * subject link, grade eligibility) -> duplicate -> insert. The teacher checks and the
   * insert run in one transaction holding share locks on the teacher and eligibility rows;
   * the unique index on (sectionId, subjectRequirementId) is the final duplicate backstop.
   *
   * A teacher may be assigned to any number of sections: there is no workload or
   * timetable-collision logic here.
   */
  async createAssignment(
    schoolId: string,
    data: CreateSectionSubjectTeacherInput
  ): Promise<SectionSubjectTeacherDetail> {
    const section = await fetchSectionWithOwnership(data.sectionId, schoolId);

    if (section.grade.academicYear.status !== 'DRAFT') {
      throw new AppError(400, DRAFT_ONLY_MESSAGE);
    }

    const requirement = await fetchRequirementWithOwnership(data.subjectRequirementId, schoolId);
    assertSectionMatchesRequirement(section, requirement);

    try {
      const created = await prisma.$transaction(async (tx) => {
        // A SELECTED_SECTIONS requirement applies only to its sections (re-checked under a share lock on the requirement)
        await assertSectionInScope(tx, data.subjectRequirementId, data.sectionId);
        await validateTeacherForAssignment(
          tx,
          schoolId,
          data.teacherId,
          requirement.subjectId,
          section.gradeId
        );

        const existing = await tx.sectionSubjectTeacher.findUnique({
          where: {
            sectionId_subjectRequirementId: {
              sectionId: data.sectionId,
              subjectRequirementId: data.subjectRequirementId,
            },
          },
        });

        if (existing) {
          throw duplicateError();
        }

        return tx.sectionSubjectTeacher.create({
          data: {
            sectionId: data.sectionId,
            subjectRequirementId: data.subjectRequirementId,
            teacherId: data.teacherId,
          },
          include: detailInclude,
        });
      });

      return toDetail(created);
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateError();
      throw error;
    }
  }

  /**
   * List assignments for the admin's school. All filters are optional and each supplied
   * filter is ownership-checked. The query itself is restricted through every ownership
   * chain (section, requirement and subject, teacher), so a corrupt cross-school row is
   * never returned. Allowed in any academic-year status. Not paginated.
   */
  async getAssignments(
    schoolId: string,
    filters: ListSectionSubjectTeachersQuery
  ): Promise<SectionSubjectTeacherDetail[]> {
    if (filters.academicYearId !== undefined) {
      const academicYear = await prisma.academicYear.findUnique({ where: { id: filters.academicYearId } });
      if (!academicYear) {
        throw new AppError(404, 'Academic year not found');
      }
      if (academicYear.schoolId !== schoolId) {
        throw new AppError(403, 'You do not have access to this academic year');
      }
    }

    if (filters.gradeId !== undefined) {
      const grade = await prisma.grade.findUnique({
        where: { id: filters.gradeId },
        include: { academicYear: true },
      });
      if (!grade) {
        throw new AppError(404, 'Grade not found');
      }
      if (grade.academicYear.schoolId !== schoolId) {
        throw new AppError(403, 'You do not have access to this grade');
      }
    }

    if (filters.sectionId !== undefined) {
      await fetchSectionWithOwnership(filters.sectionId, schoolId);
    }

    if (filters.subjectId !== undefined) {
      const subject = await prisma.subject.findUnique({ where: { id: filters.subjectId } });
      if (!subject) {
        throw new AppError(404, 'Subject not found');
      }
      if (subject.schoolId !== schoolId) {
        throw new AppError(403, 'You do not have access to this subject');
      }
    }

    if (filters.teacherId !== undefined) {
      const teacher = await prisma.teacher.findUnique({ where: { id: filters.teacherId } });
      if (!teacher) {
        throw new AppError(404, 'Teacher not found');
      }
      if (teacher.schoolId !== schoolId) {
        throw new AppError(403, 'You do not have access to this teacher');
      }
    }

    const rows = await prisma.sectionSubjectTeacher.findMany({
      where: {
        section: {
          ...(filters.sectionId !== undefined && { id: filters.sectionId }),
          ...(filters.gradeId !== undefined && { gradeId: filters.gradeId }),
          grade: {
            academicYear: {
              schoolId,
              ...(filters.academicYearId !== undefined && { id: filters.academicYearId }),
            },
          },
        },
        subjectRequirement: {
          grade: { academicYear: { schoolId } },
          subject: {
            schoolId,
            ...(filters.subjectId !== undefined && { id: filters.subjectId }),
          },
        },
        teacher: {
          schoolId,
          ...(filters.teacherId !== undefined && { id: filters.teacherId }),
        },
      },
      include: detailInclude,
      orderBy: [
        { section: { grade: { academicYear: { startDate: 'desc' } } } },
        { section: { grade: { displayOrder: 'asc' } } },
        { section: { name: 'asc' } },
        { section: { code: 'asc' } },
        { subjectRequirement: { subject: { name: 'asc' } } },
      ],
    });

    return rows.map(toDetail);
  }

  /**
   * Get one assignment. Allowed in any academic-year status, and still returns an
   * assignment whose teacher has since become inactive (teacher.isActive = false).
   */
  async getAssignmentById(assignmentId: string, schoolId: string): Promise<SectionSubjectTeacherDetail> {
    const owned = await fetchAssignmentWithOwnership(assignmentId, schoolId);
    return this.loadDetail(owned.id);
  }

  /**
   * Change the assigned teacher (the only mutable field).
   *
   * EVERY patch re-validates the resulting state, even when teacherId is unchanged:
   * ownership of all links, DRAFT year, section/requirement compatibility, and the teacher
   * (exists, same school, active, subject link, grade eligibility). A successful patch
   * therefore always leaves a currently valid assignment. An existing assignment may
   * remain in the database after its teacher is deactivated, but patching it with that
   * same teacher returns 400.
   */
  async updateAssignment(
    assignmentId: string,
    schoolId: string,
    data: UpdateSectionSubjectTeacherInput
  ): Promise<SectionSubjectTeacherDetail> {
    const owned = await fetchAssignmentWithOwnership(assignmentId, schoolId);

    if (owned.section.grade.academicYear.status !== 'DRAFT') {
      throw new AppError(400, DRAFT_ONLY_MESSAGE);
    }

    assertSectionMatchesRequirement(owned.section, owned.subjectRequirement);

    const updated = await prisma.$transaction(async (tx) => {
      await assertSectionInScope(tx, owned.subjectRequirement.id, owned.section.id);
      await validateTeacherForAssignment(
        tx,
        schoolId,
        data.teacherId,
        owned.subjectRequirement.subjectId,
        owned.section.gradeId
      );

      return tx.sectionSubjectTeacher.update({
        where: { id: assignmentId },
        data: { teacherId: data.teacherId },
        include: detailInclude,
      });
    });

    return toDetail(updated);
  }

  /**
   * Delete the assignment row only. Section, grade, stream, subject, teacher,
   * requirement and teacher eligibility are untouched. Academic year must be DRAFT.
   */
  async deleteAssignment(assignmentId: string, schoolId: string): Promise<void> {
    const owned = await fetchAssignmentWithOwnership(assignmentId, schoolId);

    if (owned.section.grade.academicYear.status !== 'DRAFT') {
      throw new AppError(400, DRAFT_ONLY_MESSAGE);
    }

    // A concurrent duplicate delete surfaces as Prisma P2025, which handleError maps to 404.
    await prisma.sectionSubjectTeacher.delete({ where: { id: assignmentId } });
  }

  private async loadDetail(assignmentId: string): Promise<SectionSubjectTeacherDetail> {
    const row = await prisma.sectionSubjectTeacher.findUniqueOrThrow({
      where: { id: assignmentId },
      include: detailInclude,
    });
    return toDetail(row);
  }
}

export const sectionSubjectTeacherService = new SectionSubjectTeacherService();
