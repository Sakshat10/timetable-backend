import { type Stream } from '@prisma/client';
import prisma from '../../config/database.js';
import { type CreateStreamInput, type UpdateStreamInput } from './stream.schema.js';
import { AppError } from '../../utils/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize stream code to uppercase for consistent case-insensitive uniqueness.
 * e.g. "sci", "SCI", "Sci" all become "SCI".
 */
function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Fetch a stream and verify it belongs to the given school.
 * Throws 404 if not found, 403 if ownership mismatch.
 * Returns the stream plus the nested grade+academicYear for further use.
 */
async function fetchStreamWithOwnership(streamId: string, schoolId: string) {
  const stream = await prisma.stream.findUnique({
    where: { id: streamId },
    include: {
      grade: {
        include: { academicYear: true },
      },
    },
  });

  if (!stream) {
    throw new AppError(404, 'Stream not found');
  }

  if (stream.grade.academicYear.schoolId !== schoolId) {
    throw new AppError(403, 'You do not have access to this stream');
  }

  return stream;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class StreamService {
  /**
   * Create a stream for a grade.
   *
   * Rules:
   * - Grade must belong to admin's school
   * - Academic Year must be DRAFT
   * - Stream code (normalized to uppercase) must be unique within the grade
   */
  async createStream(schoolId: string, data: CreateStreamInput): Promise<Stream> {
    const normalizedCode = normalizeCode(data.code);

    // Verify the grade exists and belongs to the admin's school
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

    // Enforce DRAFT status
    if (grade.academicYear.status !== 'DRAFT') {
      throw new AppError(
        400,
        'Streams can only be modified while the academic year is in DRAFT status'
      );
    }

    // Check for duplicate code within the grade (case-insensitive via normalization)
    const existingByCode = await prisma.stream.findUnique({
      where: {
        gradeId_code: {
          gradeId: data.gradeId,
          code: normalizedCode,
        },
      },
    });

    if (existingByCode) {
      throw new AppError(
        409,
        `Stream with code "${normalizedCode}" already exists in this grade`
      );
    }

    // Check for duplicate name within the grade
    const existingByName = await prisma.stream.findFirst({
      where: {
        gradeId: data.gradeId,
        name: { equals: data.name, mode: 'insensitive' },
      },
    });

    if (existingByName) {
      throw new AppError(
        409,
        `Stream "${data.name}" already exists in this grade`
      );
    }

    const stream = await prisma.stream.create({
      data: {
        gradeId: data.gradeId,
        name: data.name,
        code: normalizedCode,
      },
    });

    return stream;
  }

  /**
   * List all streams for a grade.
   * Verifies the grade belongs to the admin's school.
   * Ordered by name ASC (Stream has no displayOrder).
   */
  async getStreamsByGrade(schoolId: string, gradeId: string): Promise<Stream[]> {
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

    const streams = await prisma.stream.findMany({
      where: { gradeId },
      orderBy: { name: 'asc' },
    });

    return streams;
  }

  /**
   * Get a single stream by ID.
   * Verifies ownership through: stream → grade → academicYear → school.
   */
  async getStreamById(streamId: string, schoolId: string): Promise<Stream> {
    const stream = await fetchStreamWithOwnership(streamId, schoolId);

    // Return plain Stream without nested includes
    const { grade: _grade, ...streamData } = stream;
    return streamData as Stream;
  }

  /**
   * Update a stream's name and/or code.
   *
   * Rules:
   * - gradeId cannot be changed
   * - Academic Year must be DRAFT
   * - Duplicate code/name within the grade is rejected
   */
  async updateStream(
    streamId: string,
    schoolId: string,
    data: UpdateStreamInput
  ): Promise<Stream> {
    const existing = await fetchStreamWithOwnership(streamId, schoolId);

    if (existing.grade.academicYear.status !== 'DRAFT') {
      throw new AppError(
        400,
        'Streams can only be modified while the academic year is in DRAFT status'
      );
    }

    const updateData: { name?: string; code?: string } = {};

    // Handle name update
    if (data.name !== undefined) {
      const newName = data.name.trim();
      if (newName !== existing.name) {
        const clash = await prisma.stream.findFirst({
          where: {
            gradeId: existing.gradeId,
            name: { equals: newName, mode: 'insensitive' },
            id: { not: streamId },
          },
        });
        if (clash) {
          throw new AppError(409, `Stream "${newName}" already exists in this grade`);
        }
      }
      updateData.name = newName;
    }

    // Handle code update
    if (data.code !== undefined) {
      const newCode = normalizeCode(data.code);
      if (newCode !== existing.code) {
        const clash = await prisma.stream.findUnique({
          where: {
            gradeId_code: {
              gradeId: existing.gradeId,
              code: newCode,
            },
          },
        });
        if (clash && clash.id !== streamId) {
          throw new AppError(
            409,
            `Stream with code "${newCode}" already exists in this grade`
          );
        }
      }
      updateData.code = newCode;
    }

    const updated = await prisma.stream.update({
      where: { id: streamId },
      data: updateData,
    });

    return updated;
  }
}

export const streamService = new StreamService();
