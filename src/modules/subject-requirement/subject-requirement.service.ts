import { type Prisma, type SubjectRequirement } from '@prisma/client';
import prisma from '../../config/database.js';
import {
  type CreateSubjectRequirementInput,
  type ListSubjectRequirementsQuery,
  type UpdateSubjectRequirementInput,
} from './subject-requirement.schema.js';
import { AppError, isUniqueViolation } from '../../utils/errors.js';
import { getGradeMixingMode } from '../section/section.service.js';
import { validateSectionSelection } from './requirement-scope.js';

// ---------------------------------------------------------------------------
// Return type — requirement enriched with subject / stream / grade summaries
// ---------------------------------------------------------------------------
export interface SubjectRequirementDetail extends SubjectRequirement {
  subject: { id: string; name: string; code: string };
  stream: { id: string; name: string; code: string } | null;
  grade: { id: string; name: string; displayOrder: number; academicYearId: string };
  /** The sections a SELECTED_SECTIONS requirement applies to (empty for ALL_SECTIONS). Sorted. */
  sectionIds: string[];
}

export const detailInclude = {
  subject: { select: { id: true, name: true, code: true } },
  stream: { select: { id: true, name: true, code: true } },
  grade: { select: { id: true, name: true, displayOrder: true, academicYearId: true } },
  sections: { select: { sectionId: true } },
} as const;

type DetailRow = Omit<SubjectRequirementDetail, 'sectionIds'> & { sections: Array<{ sectionId: string }> };
export function toDetail(row: DetailRow): SubjectRequirementDetail {
  const { sections, ...rest } = row;
  return { ...rest, sectionIds: sections.map((x) => x.sectionId).sort() };
}

const DRAFT_ONLY_MESSAGE =
  'Subject requirements can only be modified while the academic year is in DRAFT status';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function duplicateError(streamId: string | null): AppError {
  return new AppError(
    409,
    streamId === null
      ? 'A requirement for this subject already exists for this grade'
      : 'A requirement for this subject already exists for this stream'
  );
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

/**
 * Fetch a requirement and verify the whole ownership chain:
 * requirement -> grade -> academic year -> school, and requirement -> subject -> school.
 * Throws 404 if not found, 403 if either chain belongs to another school.
 */
async function fetchRequirementWithOwnership(requirementId: string, schoolId: string) {
  const requirement = await prisma.subjectRequirement.findUnique({
    where: { id: requirementId },
    include: {
      ...detailInclude,
      grade: { include: { academicYear: true } },
      subject: true,
    },
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
 * Is the grade streamed?
 *  1. If it has sections, the existing Module 5 section-derived mode decides
 *     (a mixed grade is treated as streamed — the Module 5 convention).
 *  2. Otherwise it is streamed if it has at least one stream.
 */
export async function isGradeStreamed(tx: Prisma.TransactionClient, gradeId: string): Promise<boolean> {
  const sectionMode = await getGradeMixingMode(tx, gradeId);
  if (sectionMode !== 'empty') {
    return sectionMode === 'streamed';
  }
  return (await tx.stream.count({ where: { gradeId } })) > 0;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SubjectRequirementService {
  /**
   * Create a requirement: "this grade (or stream of it) needs N periods/week of this subject".
   *
   * Rules:
   * 1. Grade (via academic year) must belong to the admin's school, and the year must be DRAFT
   * 2. Subject must belong to the admin's school
   * 3. If streamId is given: the stream exists and belongs to this grade
   * 4. The grade's mode must agree: streamed grade => streamId required,
   *    non-streamed grade => streamId must be omitted
   * 5. (grade, [stream], subject) must be unique
   *
   * Steps 4-5 and the insert run in one transaction holding a row lock on the grade
   * (the Module 5 pattern), so they are serialized against concurrent requirement
   * and section creation for that grade. The database unique indexes remain the
   * final backstop.
   */
  async createSubjectRequirement(
    schoolId: string,
    data: CreateSubjectRequirementInput
  ): Promise<SubjectRequirementDetail> {
    const grade = await fetchGradeWithOwnership(data.gradeId, schoolId);

    if (grade.academicYear.status !== 'DRAFT') {
      throw new AppError(400, DRAFT_ONLY_MESSAGE);
    }

    const subject = await prisma.subject.findUnique({ where: { id: data.subjectId } });

    if (!subject) {
      throw new AppError(404, 'Subject not found');
    }

    if (subject.schoolId !== schoolId) {
      throw new AppError(403, 'You do not have access to this subject');
    }

    let streamId: string | null = null;

    if (data.streamId !== undefined && data.streamId !== null) {
      const stream = await prisma.stream.findUnique({
        where: { id: data.streamId },
        include: { grade: { include: { academicYear: true } } },
      });

      if (!stream) {
        throw new AppError(404, 'Stream not found');
      }

      if (stream.gradeId !== data.gradeId) {
        throw new AppError(400, 'Stream does not belong to the specified grade');
      }

      if (stream.grade.academicYear.schoolId !== schoolId) {
        throw new AppError(403, 'You do not have access to this stream');
      }

      streamId = stream.id;
    }

    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "grades" WHERE "id" = ${data.gradeId} FOR UPDATE`;

        const streamed = await isGradeStreamed(tx, data.gradeId);

        if (streamed && streamId === null) {
          throw new AppError(
            400,
            'This grade uses streams, so streamId is required for its subject requirements'
          );
        }

        if (!streamed && streamId !== null) {
          throw new AppError(
            400,
            'This grade is not streamed, so streamId must be omitted for its subject requirements'
          );
        }

        const clash = await tx.subjectRequirement.findFirst({
          where: { gradeId: data.gradeId, streamId, subjectId: data.subjectId },
        });

        if (clash) {
          throw duplicateError(streamId);
        }

        // Optional section selection: validated under the grade lock (same grade, exactly this stream, same school)
        const scope = data.sectionScope ?? 'ALL_SECTIONS';
        const sectionIds = scope === 'SELECTED_SECTIONS' ? await validateSectionSelection(tx, schoolId, { gradeId: data.gradeId, streamId }, data.sectionIds ?? []) : [];

        const created = await tx.subjectRequirement.create({
          data: {
            gradeId: data.gradeId,
            streamId,
            subjectId: data.subjectId,
            periodsPerWeek: data.periodsPerWeek,
            isOptional: data.isOptional ?? false,
            sectionScope: scope,
            ...(sectionIds.length > 0 ? { sections: { create: sectionIds.map((sectionId) => ({ sectionId })) } } : {}),
          },
          include: detailInclude,
        });
        return toDetail(created);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateError(streamId);
      throw error;
    }
  }

  /**
   * List requirements for the admin's school. All filters are optional and each
   * supplied filter is ownership-checked. Always restricted to the school's own
   * grades and subjects. Ordered: academic year (newest first), grade display
   * order, stream name, subject name.
   */
  async getSubjectRequirements(
    schoolId: string,
    filters: ListSubjectRequirementsQuery
  ): Promise<SubjectRequirementDetail[]> {
    if (filters.academicYearId !== undefined) {
      const academicYear = await prisma.academicYear.findUnique({
        where: { id: filters.academicYearId },
      });
      if (!academicYear) {
        throw new AppError(404, 'Academic year not found');
      }
      if (academicYear.schoolId !== schoolId) {
        throw new AppError(403, 'You do not have access to this academic year');
      }
    }

    if (filters.gradeId !== undefined) {
      await fetchGradeWithOwnership(filters.gradeId, schoolId);
    }

    if (filters.streamId !== undefined) {
      const stream = await prisma.stream.findUnique({
        where: { id: filters.streamId },
        include: { grade: { include: { academicYear: true } } },
      });
      if (!stream) {
        throw new AppError(404, 'Stream not found');
      }
      if (stream.grade.academicYear.schoolId !== schoolId) {
        throw new AppError(403, 'You do not have access to this stream');
      }
    }

    const rows = await prisma.subjectRequirement.findMany({
      where: {
        grade: {
          academicYear: {
            schoolId,
            ...(filters.academicYearId !== undefined && { id: filters.academicYearId }),
          },
        },
        subject: { schoolId },
        ...(filters.gradeId !== undefined && { gradeId: filters.gradeId }),
        ...(filters.streamId !== undefined && { streamId: filters.streamId }),
      },
      include: detailInclude,
      orderBy: [
        { grade: { academicYear: { startDate: 'desc' } } },
        { grade: { displayOrder: 'asc' } },
        { stream: { name: 'asc' } },
        { subject: { name: 'asc' } },
        { subject: { code: 'asc' } },
      ],
    });
    return rows.map(toDetail);
  }

  /**
   * Get one requirement. Allowed in any academic-year status.
   */
  async getSubjectRequirementById(
    requirementId: string,
    schoolId: string
  ): Promise<SubjectRequirementDetail> {
    const owned = await fetchRequirementWithOwnership(requirementId, schoolId);
    return this.loadDetail(owned.id);
  }

  /**
   * Update periodsPerWeek, the optional/compulsory label and/or the section scope (grade, stream and subject are immutable). Academic year must be DRAFT.
   * A scope change runs under the grade lock and the requirement's own row lock, and is refused (409) while teacher assignments exist for sections that
   * would no longer have the subject: remove those assignments first (nothing is deleted behind your back).
   */
  async updateSubjectRequirement(
    requirementId: string,
    schoolId: string,
    data: UpdateSubjectRequirementInput
  ): Promise<SubjectRequirementDetail> {
    const owned = await fetchRequirementWithOwnership(requirementId, schoolId);

    if (owned.grade.academicYear.status !== 'DRAFT') {
      throw new AppError(400, DRAFT_ONLY_MESSAGE);
    }

    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "grades" WHERE "id" = ${owned.gradeId} FOR UPDATE`;
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "subject_requirements" WHERE "id" = ${requirementId} FOR UPDATE`;
      if (locked.length === 0) throw new AppError(404, 'Subject requirement not found');

      let nextIds: string[] = [];
      if (data.sectionScope !== undefined) {
        if (data.sectionScope === 'SELECTED_SECTIONS') {
          nextIds = await validateSectionSelection(tx, schoolId, { gradeId: owned.gradeId, streamId: owned.streamId }, data.sectionIds ?? []);
          const assignments = await tx.sectionSubjectTeacher.findMany({ where: { subjectRequirementId: requirementId }, select: { sectionId: true } });
          const stranded = assignments.filter((a) => !nextIds.includes(a.sectionId));
          if (stranded.length > 0) {
            throw new AppError(409, `Cannot restrict this requirement: ${stranded.length} teacher assignment(s) exist for sections that would no longer have this subject. Remove those assignments first.`);
          }
        }
        // the requirement row first (the section trigger requires SELECTED_SECTIONS), then its rows
        await tx.subjectRequirementSection.deleteMany({ where: { subjectRequirementId: requirementId } });
      }

      await tx.subjectRequirement.update({
        where: { id: requirementId },
        data: {
          ...(data.periodsPerWeek !== undefined ? { periodsPerWeek: data.periodsPerWeek } : {}),
          ...(data.isOptional !== undefined ? { isOptional: data.isOptional } : {}),
          ...(data.sectionScope !== undefined ? { sectionScope: data.sectionScope } : {}),
        },
      });
      if (data.sectionScope === 'SELECTED_SECTIONS') {
        await tx.subjectRequirementSection.createMany({ data: nextIds.map((sectionId) => ({ subjectRequirementId: requirementId, sectionId })) });
      }
      return toDetail(await tx.subjectRequirement.findUniqueOrThrow({ where: { id: requirementId }, include: detailInclude }));
    });
  }

  /**
   * Delete a requirement (only the requirement row). Academic year must be DRAFT.
   *
   * Data-integrity guard: the FK from SectionSubjectTeacher cascades, so deleting a
   * requirement would silently delete any teacher assignments that reference it.
   * Refuse with 409 instead. The requirement row is locked first, and assignments
   * need a share lock on it to be inserted, so no assignment can slip in between
   * the check and the delete.
   */
  async deleteSubjectRequirement(requirementId: string, schoolId: string): Promise<void> {
    const owned = await fetchRequirementWithOwnership(requirementId, schoolId);

    if (owned.grade.academicYear.status !== 'DRAFT') {
      throw new AppError(400, DRAFT_ONLY_MESSAGE);
    }

    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "subject_requirements" WHERE "id" = ${requirementId} FOR UPDATE`;

      if (locked.length === 0) {
        throw new AppError(404, 'Subject requirement not found');
      }

      const assignments = await tx.sectionSubjectTeacher.count({
        where: { subjectRequirementId: requirementId },
      });

      if (assignments > 0) {
        throw new AppError(
          409,
          'Cannot delete a subject requirement that has teacher assignments. Remove the assignments first.'
        );
      }

      await tx.subjectRequirement.delete({ where: { id: requirementId } });
    });
  }

  private async loadDetail(requirementId: string): Promise<SubjectRequirementDetail> {
    return toDetail(await prisma.subjectRequirement.findUniqueOrThrow({
      where: { id: requirementId },
      include: detailInclude,
    }));
  }
}

export const subjectRequirementService = new SubjectRequirementService();
