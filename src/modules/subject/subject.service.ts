import { type Subject } from '@prisma/client';
import prisma from '../../config/database.js';
import { randomUUID } from 'node:crypto';
import { type BulkCreateSubjectsInput, type CreateSubjectInput, type UpdateSubjectInput } from './subject.schema.js';
import { AppError, isUniqueViolation } from '../../utils/errors.js';
import { flagInRequestDuplicates, RowErrors } from '../../utils/bulk.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function duplicateCodeError(code: string): AppError {
  return new AppError(409, `Subject with code "${code}" already exists in this school`);
}

/**
 * Fetch a subject and verify it belongs to the given school.
 * Throws 404 if not found, 403 if ownership mismatch.
 */
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

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Rows of `codes` that already exist in the school, as row-specific 409 errors (empty when none). */
async function existingCodeConflicts(schoolId: string, rows: Array<{ code: string }>): Promise<RowErrors> {
  const errors = new RowErrors();
  const existing = await prisma.subject.findMany({ where: { schoolId, code: { in: rows.map((r) => r.code) } }, select: { code: true } });
  const taken = new Set(existing.map((e) => e.code));
  rows.forEach((row, index) => {
    if (taken.has(row.code)) errors.add(`subjects.${index}.code`, `Subject with code "${row.code}" already exists in this school`);
  });
  return errors;
}

export class SubjectService {
  /**
   * Create several subjects atomically: every row is created or none is.
   * Rows are already validated and normalised (trim, uppercase code) by bulkCreateSubjectsSchema. Order: in-request duplicates (400),
   * conflicts with existing subjects (409, per row), then ONE INSERT statement (atomic by itself). A concurrent writer that wins a code
   * between the check and the insert makes the insert fail as a whole; the rows that now clash are re-read and reported as 409.
   */
  async createSubjectsBulk(schoolId: string, data: BulkCreateSubjectsInput): Promise<Subject[]> {
    const rows = data.subjects;

    const invalid = new RowErrors();
    flagInRequestDuplicates(rows, (r) => r.code, invalid, (i) => `subjects.${i}.code`, (code, first) => `Duplicate code "${code}": already used by subjects.${first} in this request`);
    invalid.throwIfAny(400, 'Validation failed');

    (await existingCodeConflicts(schoolId, rows)).throwIfAny(409, 'One or more subject codes already exist in this school; nothing was created');

    const ids = rows.map(() => randomUUID());
    try {
      const created = await prisma.subject.createManyAndReturn({
        data: rows.map((r, i) => ({ id: ids[i]!, schoolId, name: r.name, code: r.code })),
      });
      const byId = new Map(created.map((c) => [c.id, c]));
      return ids.map((id) => byId.get(id)!);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await existingCodeConflicts(schoolId, rows);
      raced.throwIfAny(409, 'One or more subject codes already exist in this school; nothing was created');
      throw new AppError(409, 'A subject code conflicted with a concurrent request; nothing was created. Retry the request.');
    }
  }

  /**
   * Create a subject for the admin's school.
   * Subjects are school-level masters, so no academic-year status rule applies.
   */
  async createSubject(schoolId: string, data: CreateSubjectInput): Promise<Subject> {
    const existing = await prisma.subject.findUnique({
      where: { schoolId_code: { schoolId, code: data.code } },
    });

    if (existing) {
      throw duplicateCodeError(data.code);
    }

    try {
      return await prisma.subject.create({
        data: { schoolId, name: data.name, code: data.code },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateCodeError(data.code);
      throw error;
    }
  }

  /**
   * List all subjects in the admin's school, ordered by name then code.
   */
  async getSubjects(schoolId: string): Promise<Subject[]> {
    return prisma.subject.findMany({
      where: { schoolId },
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    });
  }

  async getSubjectById(subjectId: string, schoolId: string): Promise<Subject> {
    return fetchSubjectWithOwnership(subjectId, schoolId);
  }

  /**
   * Update a subject's name and/or code. A subject cannot move between schools.
   */
  async updateSubject(
    subjectId: string,
    schoolId: string,
    data: UpdateSubjectInput
  ): Promise<Subject> {
    const existing = await fetchSubjectWithOwnership(subjectId, schoolId);

    const updateData: { name?: string; code?: string } = {};

    if (data.name !== undefined) {
      updateData.name = data.name;
    }

    if (data.code !== undefined) {
      if (data.code !== existing.code) {
        const clash = await prisma.subject.findUnique({
          where: { schoolId_code: { schoolId, code: data.code } },
        });
        if (clash && clash.id !== subjectId) {
          throw duplicateCodeError(data.code);
        }
      }
      updateData.code = data.code;
    }

    try {
      return await prisma.subject.update({ where: { id: subjectId }, data: updateData });
    } catch (error) {
      if (isUniqueViolation(error) && data.code !== undefined) throw duplicateCodeError(data.code);
      throw error;
    }
  }
}

export const subjectService = new SubjectService();
