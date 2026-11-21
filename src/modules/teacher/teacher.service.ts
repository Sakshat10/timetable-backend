import { createHash, randomUUID } from 'node:crypto';
import { type Prisma, type Teacher, type TeacherSubjectType } from '@prisma/client';
import prisma from '../../config/database.js';
import { type BulkCreateTeachersInput, type CreateTeacherInput, type UpdateTeacherInput } from './teacher.schema.js';
import { AppError, isUniqueViolation } from '../../utils/errors.js';
import { flagInRequestDuplicates, RowErrors } from '../../utils/bulk.js';

/** A subject a teacher is linked to, as listed with the teacher. `type` is the existing PRIMARY / SECONDARY link type. */
export interface TeacherSubjectSummary {
  id: string;
  name: string;
  code: string;
  type: TeacherSubjectType;
}

/** A teacher as returned by the list: every teacher field plus their linked subjects. */
export type TeacherWithSubjects = Teacher & { subjects: TeacherSubjectSummary[] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function duplicateEmployeeCodeError(code: string): AppError {
  return new AppError(409, `Teacher with employee code "${code}" already exists in this school`);
}

/**
 * Fetch a teacher and verify it belongs to the given school.
 * Throws 404 if not found, 403 if ownership mismatch.
 */
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

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface BulkTeachersResult {
  /** true when this is the stored response of an earlier, identical request (nothing was created now). */
  replayed: boolean;
  teachers: Array<Record<string, unknown>>;
}

/** Rows whose employee code already exists in the school, as row-specific 409 errors (empty when none). */
async function existingEmployeeCodeConflicts(
  db: Prisma.TransactionClient | typeof prisma,
  schoolId: string,
  rows: Array<{ employeeCode?: string | null | undefined }>
): Promise<RowErrors> {
  const errors = new RowErrors();
  const codes = rows.map((r) => r.employeeCode ?? null).filter((c): c is string => c !== null);
  if (codes.length === 0) return errors;
  const existing = await db.teacher.findMany({ where: { schoolId, employeeCode: { in: codes } }, select: { employeeCode: true } });
  const taken = new Set(existing.map((e) => e.employeeCode));
  rows.forEach((row, index) => {
    const code = row.employeeCode ?? null;
    if (code !== null && taken.has(code)) errors.add(`teachers.${index}.employeeCode`, `Teacher with employee code "${code}" already exists in this school`);
  });
  return errors;
}

const BULK_CONFLICT_MESSAGE = 'One or more employee codes already exist in this school; nothing was created';

export class TeacherService {
  /**
   * Create several teachers atomically and idempotently.
   *
   * Atomic: the teachers and the idempotency record are written in ONE transaction; a validation conflict or any error rolls both back.
   * Idempotent: UNIQUE (schoolId, idempotencyKey) is the arbiter. The key row is inserted with ON CONFLICT DO NOTHING; when another
   * transaction holds the same key uncommitted, PostgreSQL makes this insert WAIT for it to commit or abort, so two simultaneous requests
   * with one key can never both create teachers. After the first commits, the second finds the row and either replays the stored
   * response (same body) or fails with 409 (different body). If the first aborted, the second proceeds and creates the teachers itself.
   * A request that failed (400/409) stored nothing, so its key is free to be reused after the caller fixes the body.
   */
  async createTeachersBulk(schoolId: string, data: BulkCreateTeachersInput, idempotencyKey: string): Promise<BulkTeachersResult> {
    const rows = data.teachers;

    const invalid = new RowErrors();
    flagInRequestDuplicates(rows, (r) => r.employeeCode ?? null, invalid, (i) => `teachers.${i}.employeeCode`, (code, first) => `Duplicate employee code "${code}": already used by teachers.${first} in this request`);
    invalid.throwIfAny(400, 'Validation failed');

    const requestHash = createHash('sha256').update(JSON.stringify(rows.map((r) => [r.name, r.employeeCode ?? null, r.isActive ?? true]))).digest('hex');
    const replayOf = (stored: { requestHash: string; response: Prisma.JsonValue }): BulkTeachersResult => {
      if (stored.requestHash !== requestHash) {
        throw new AppError(409, 'This Idempotency-Key was already used with a different request body. Use a new key for a different request.');
      }
      return { replayed: true, teachers: stored.response as Array<Record<string, unknown>> };
    };

    // Fast path for a plain retry. The transaction below re-checks, so this is only an optimisation.
    const earlier = await prisma.teacherBulkRequest.findUnique({ where: { schoolId_idempotencyKey: { schoolId, idempotencyKey } } });
    if (earlier) return replayOf(earlier);

    try {
      return await prisma.$transaction(
        async (tx) => {
          const claimed = await tx.$queryRaw<Array<{ id: string }>>`
            INSERT INTO "teacher_bulk_requests" ("id", "schoolId", "idempotencyKey", "requestHash", "response")
            VALUES (${randomUUID()}, ${schoolId}, ${idempotencyKey}, ${requestHash}, '[]'::jsonb)
            ON CONFLICT ("schoolId", "idempotencyKey") DO NOTHING
            RETURNING "id"`;
          const claim = claimed[0];
          if (!claim) {
            const stored = await tx.teacherBulkRequest.findUnique({ where: { schoolId_idempotencyKey: { schoolId, idempotencyKey } } });
            if (!stored) throw new AppError(409, 'The request conflicted with a concurrent request. Retry it.');
            return replayOf(stored);
          }

          (await existingEmployeeCodeConflicts(tx, schoolId, rows)).throwIfAny(409, BULK_CONFLICT_MESSAGE);

          const ids = rows.map(() => randomUUID());
          const created = await tx.teacher.createManyAndReturn({
            data: rows.map((r, i) => ({ id: ids[i]!, schoolId, name: r.name, employeeCode: r.employeeCode ?? null, ...(r.isActive !== undefined && { isActive: r.isActive }) })),
          });
          const byId = new Map(created.map((c) => [c.id, c]));
          const teachers = JSON.parse(JSON.stringify(ids.map((id) => byId.get(id)!))) as Array<Record<string, unknown>>;
          await tx.teacherBulkRequest.update({ where: { id: claim.id }, data: { response: teachers as Prisma.InputJsonValue } });
          return { replayed: false, teachers };
        },
        { timeout: 15_000 }
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // The transaction (key row included) rolled back: an employee code was taken by a concurrent writer between the check and the insert.
      (await existingEmployeeCodeConflicts(prisma, schoolId, rows)).throwIfAny(409, BULK_CONFLICT_MESSAGE);
      throw new AppError(409, 'A value conflicted with a concurrent request; nothing was created. Retry the request.');
    }
  }

  /**
   * Create a teacher in the admin's school.
   * Teachers are school-level masters, so no academic-year status rule applies.
   * employeeCode is optional; when present it is unique within the school.
   */
  async createTeacher(schoolId: string, data: CreateTeacherInput): Promise<Teacher> {
    const employeeCode = data.employeeCode ?? null;

    if (employeeCode !== null) {
      const clash = await prisma.teacher.findFirst({ where: { schoolId, employeeCode } });
      if (clash) {
        throw duplicateEmployeeCodeError(employeeCode);
      }
    }

    try {
      return await prisma.teacher.create({
        data: {
          schoolId,
          name: data.name,
          employeeCode,
          ...(data.isActive !== undefined && { isActive: data.isActive }),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error) && employeeCode !== null) {
        throw duplicateEmployeeCodeError(employeeCode);
      }
      throw error;
    }
  }

  /**
   * List teachers in the admin's school, ordered by name, each with the subjects they are linked to (`subjects`, [] when none).
   * Optional isActive filter. One query: the links and their subjects are loaded with the teachers (no per-teacher lookups). A subject of
   * another school can never appear: the link is only returned when the subject belongs to this same school.
   */
  async getTeachers(schoolId: string, isActive?: boolean): Promise<TeacherWithSubjects[]> {
    const rows = await prisma.teacher.findMany({
      where: { schoolId, ...(isActive !== undefined && { isActive }) },
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
      include: {
        teacherSubjects: {
          where: { subject: { schoolId } },
          select: { type: true, subject: { select: { id: true, name: true, code: true } } },
        },
      },
    });
    return rows.map(({ teacherSubjects, ...teacher }) => ({
      ...teacher,
      subjects: teacherSubjects
        .map((link) => ({ id: link.subject.id, name: link.subject.name, code: link.subject.code, type: link.type }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code)),
    }));
  }

  async getTeacherById(teacherId: string, schoolId: string): Promise<Teacher> {
    return fetchTeacherWithOwnership(teacherId, schoolId);
  }

  /**
   * Update a teacher. Changing isActive never touches the teacher's existing
   * subject / grade relationships. A teacher cannot move between schools.
   */
  async updateTeacher(
    teacherId: string,
    schoolId: string,
    data: UpdateTeacherInput
  ): Promise<Teacher> {
    const existing = await fetchTeacherWithOwnership(teacherId, schoolId);

    const updateData: { name?: string; employeeCode?: string | null; isActive?: boolean } = {};

    if (data.name !== undefined) {
      updateData.name = data.name;
    }

    if (data.isActive !== undefined) {
      updateData.isActive = data.isActive;
    }

    if (data.employeeCode !== undefined) {
      const newCode = data.employeeCode;
      if (newCode !== null && newCode !== existing.employeeCode) {
        const clash = await prisma.teacher.findFirst({
          where: { schoolId, employeeCode: newCode, id: { not: teacherId } },
        });
        if (clash) {
          throw duplicateEmployeeCodeError(newCode);
        }
      }
      updateData.employeeCode = newCode;
    }

    try {
      return await prisma.teacher.update({ where: { id: teacherId }, data: updateData });
    } catch (error) {
      if (isUniqueViolation(error) && typeof data.employeeCode === 'string') {
        throw duplicateEmployeeCodeError(data.employeeCode);
      }
      throw error;
    }
  }
}

export const teacherService = new TeacherService();
