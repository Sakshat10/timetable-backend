import { type Prisma, type Section } from '@prisma/client';
import prisma from '../../config/database.js';
import { type CreateSectionInput, type UpdateSectionInput } from './section.schema.js';
import { AppError } from '../../utils/errors.js';

// ---------------------------------------------------------------------------
// Return type — Section enriched with optional stream data for responses
// ---------------------------------------------------------------------------
export interface SectionWithStream extends Section {
  stream: { id: string; name: string; code: string } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a section with its grade and academic year, and verify ownership.
 * Throws 404 if not found, 403 if ownership mismatch.
 */
async function fetchSectionWithOwnership(sectionId: string, schoolId: string) {
  const section = await prisma.section.findUnique({
    where: { id: sectionId },
    include: {
      grade: { include: { academicYear: true } },
      stream: true,
    },
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
 * Determine the mixing mode of a grade.
 *
 * Returns:
 *  'empty'      — no sections exist yet
 *  'streamed'   — all existing sections have a streamId
 *  'unstreamed' — all existing sections have no streamId
 */
export async function getGradeMixingMode(
  db: Prisma.TransactionClient,
  gradeId: string
): Promise<'empty' | 'streamed' | 'unstreamed'> {
  const total = await db.section.count({ where: { gradeId } });
  if (total === 0) return 'empty';

  const streamed = await db.section.count({
    where: { gradeId, streamId: { not: null } },
  });

  // Because of the business rule enforced here, all sections are either
  // all streamed or all unstreamed — but we check carefully.
  if (streamed === total) return 'streamed';
  if (streamed === 0) return 'unstreamed';

  // Mixed state in DB should not happen, but handle defensively
  return 'streamed'; // treat as streamed so no new unstreamed can sneak in
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SectionService {
  /**
   * Create a section.
   *
   * Key rules:
   * 1. Grade must belong to admin's school
   * 2. Academic year must be DRAFT
   * 3. If streamId provided: stream.gradeId must equal gradeId
   * 4. Mixing rule: cannot mix streamed and non-streamed sections in one grade
   * 5. Code uniqueness: scoped by grade + stream context
   */
  async createSection(
    schoolId: string,
    data: CreateSectionInput
  ): Promise<SectionWithStream> {
    // ------------------------------------------------------------------
    // 1. Resolve grade + academic year
    // ------------------------------------------------------------------
    const grade = await prisma.grade.findUnique({
      where: { id: data.gradeId },
      include: { academicYear: true },
    });

    if (!grade) {
      throw new AppError(404, 'Grade not found');
    }

    if (grade.academicYear.schoolId !== schoolId) {
      throw new AppError(403, 'You do not have access to this grade');
    }

    if (grade.academicYear.status !== 'DRAFT') {
      throw new AppError(
        400,
        'Sections can only be modified while the academic year is in DRAFT status'
      );
    }

    // ------------------------------------------------------------------
    // 2. Resolve stream (if provided) and verify it belongs to this grade
    // ------------------------------------------------------------------
    let resolvedStreamId: string | null = null;

    if (data.streamId !== undefined) {
      const stream = await prisma.stream.findUnique({
        where: { id: data.streamId },
        include: { grade: { include: { academicYear: true } } },
      });

      if (!stream) {
        throw new AppError(404, 'Stream not found');
      }

      // Stream must belong to the same grade
      if (stream.gradeId !== data.gradeId) {
        throw new AppError(
          400,
          'Stream does not belong to the specified grade'
        );
      }

      // Stream's grade must belong to admin's school (extra safety)
      if (stream.grade.academicYear.schoolId !== schoolId) {
        throw new AppError(403, 'You do not have access to this stream');
      }

      resolvedStreamId = data.streamId;
    }

    // ------------------------------------------------------------------
    // 3-5. Mixing rule, duplicate check and insert — as one serialized unit.
    //
    // The mixing rule ("a grade is all-streamed or all-non-streamed") spans
    // several rows, so no unique index can enforce it. Without a lock, two
    // concurrent requests both read the grade as 'empty' and both insert.
    // Locking the grade row (SELECT ... FOR UPDATE) makes concurrent section
    // creates for the same grade run one after another; the second sees the
    // first's committed row. Creates for different grades do not block.
    // ------------------------------------------------------------------
    const section = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "grades" WHERE "id" = ${data.gradeId} FOR UPDATE`;

      const mode = await getGradeMixingMode(tx, data.gradeId);

      if (mode === 'unstreamed' && resolvedStreamId !== null) {
        throw new AppError(
          400,
          'Cannot create a streamed section because this grade already contains non-streamed sections'
        );
      }

      if (mode === 'streamed' && resolvedStreamId === null) {
        throw new AppError(
          400,
          'Cannot create a non-streamed section because this grade already uses streams'
        );
      }

      // Service-level duplicate code check (the partial unique indexes are the backstop).
      // Non-streamed: code unique within grade where streamId IS NULL.
      // Streamed: code unique within (grade, stream).
      const clash = await tx.section.findFirst({
        where: {
          gradeId: data.gradeId,
          streamId: resolvedStreamId,
          code: data.code,
        },
      });
      if (clash) {
        throw new AppError(
          409,
          resolvedStreamId === null
            ? `Section with code "${data.code}" already exists in this grade`
            : `Section with code "${data.code}" already exists in this stream`
        );
      }

      return tx.section.create({
        data: {
          gradeId: data.gradeId,
          streamId: resolvedStreamId,
          name: data.name,
          code: data.code,
        },
        include: { stream: true },
      });
    });

    return section as SectionWithStream;
  }

  /**
   * List all sections for a grade.
   * Ordered: stream name ASC (nulls first for non-streamed), then code ASC.
   */
  async getSectionsByGrade(
    schoolId: string,
    gradeId: string
  ): Promise<SectionWithStream[]> {
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

    const sections = await prisma.section.findMany({
      where: { gradeId },
      include: { stream: true },
      orderBy: [
        { stream: { name: 'asc' } },
        { code: 'asc' },
      ],
    });

    return sections as SectionWithStream[];
  }

  /**
   * Get a section by ID.
   * Verifies ownership through section → grade → academicYear → school.
   */
  async getSectionById(
    sectionId: string,
    schoolId: string
  ): Promise<SectionWithStream> {
    const section = await fetchSectionWithOwnership(sectionId, schoolId);
    return section as SectionWithStream;
  }

  /**
   * Update a section's name and/or code.
   *
   * Rules:
   * - gradeId cannot be changed
   * - streamId cannot be changed
   * - Academic year must be DRAFT
   * - New code must not clash within the same (grade, stream) context
   */
  async updateSection(
    sectionId: string,
    schoolId: string,
    data: UpdateSectionInput
  ): Promise<SectionWithStream> {
    const existing = await fetchSectionWithOwnership(sectionId, schoolId);

    if (existing.grade.academicYear.status !== 'DRAFT') {
      throw new AppError(
        400,
        'Sections can only be modified while the academic year is in DRAFT status'
      );
    }

    const updateData: { name?: string; code?: string } = {};

    // Handle name update
    if (data.name !== undefined) {
      updateData.name = data.name.trim();
    }

    // Handle code update — check uniqueness in the same (grade, stream) context
    if (data.code !== undefined) {
      const newCode = data.code.trim();
      if (newCode !== existing.code) {
        if (existing.streamId === null) {
          const clash = await prisma.section.findFirst({
            where: {
              gradeId: existing.gradeId,
              streamId: null,
              code: newCode,
              id: { not: sectionId },
            },
          });
          if (clash) {
            throw new AppError(
              409,
              `Section with code "${newCode}" already exists in this grade`
            );
          }
        } else {
          const clash = await prisma.section.findFirst({
            where: {
              gradeId: existing.gradeId,
              streamId: existing.streamId,
              code: newCode,
              id: { not: sectionId },
            },
          });
          if (clash) {
            throw new AppError(
              409,
              `Section with code "${newCode}" already exists in this stream`
            );
          }
        }
      }
      updateData.code = newCode;
    }

    const updated = await prisma.section.update({
      where: { id: sectionId },
      data: updateData,
      include: { stream: true },
    });

    return updated as SectionWithStream;
  }
}

export const sectionService = new SectionService();
