import { randomUUID } from 'node:crypto';
import { type Grade, type Section, type Stream } from '@prisma/client';
import prisma from '../../config/database.js';
import { AppError, isUniqueViolation } from '../../utils/errors.js';
import { flagInRequestDuplicates, RowErrors } from '../../utils/bulk.js';
import { type BulkGradeStructureInput } from './grade-structure.schema.js';

export interface GradeStructureResult {
  academicYearId: string;
  grades: Array<Grade & { streams: Stream[]; sections: Section[] }>;
}

const CONFLICT_MESSAGE = 'One or more grades already exist in this academic year; nothing was created';
const DRAFT_MESSAGE = 'Grades can only be modified while the academic year is in DRAFT status';

// Same normalisation as the single-record services: stream codes are uppercase; section codes and grade names are kept as typed (trimmed).
const normalizeStreamCode = (code: string): string => code.trim().toUpperCase();

/**
 * Rules that only involve the request itself. They restate the single-record rules for a grade that is created together with its
 * children (so no children exist yet):
 *   - grade name and displayOrder are unique in the request (the database also enforces them per academic year)
 *   - stream codes are unique per grade (case-insensitive), stream names are unique per grade (case-insensitive)
 *   - a grade is streamed or not, never both: either EVERY section names a declared stream (streamCode) or NONE does
 *   - streams may be declared without sections (as with POST /api/streams alone), but not next to non-streamed sections
 *   - section codes are unique per (grade, stream)
 */
function validateStructure(data: BulkGradeStructureInput): RowErrors {
  const errors = new RowErrors();
  flagInRequestDuplicates(data.grades, (g) => g.name, errors, (i) => `grades.${i}.name`, (name, first) => `Duplicate grade name "${name}": already used by grades.${first} in this request`);
  flagInRequestDuplicates(data.grades, (g) => String(g.displayOrder), errors, (i) => `grades.${i}.displayOrder`, (order, first) => `Duplicate display order ${order}: already used by grades.${first} in this request`);

  data.grades.forEach((grade, gi) => {
    const base = `grades.${gi}`;
    flagInRequestDuplicates(grade.streams, (s) => normalizeStreamCode(s.code), errors, (i) => `${base}.streams.${i}.code`, (code, first) => `Duplicate stream code "${code}": already used by ${base}.streams.${first}`);
    flagInRequestDuplicates(grade.streams, (s) => s.name.toLowerCase(), errors, (i) => `${base}.streams.${i}.name`, (name, first) => `Duplicate stream name "${name}": already used by ${base}.streams.${first}`);

    const streamCodes = new Set(grade.streams.map((s) => normalizeStreamCode(s.code)));
    const streamedSections = grade.sections.filter((s) => s.streamCode !== undefined).length;
    const anyStreamed = streamedSections > 0;

    if (!anyStreamed && grade.streams.length > 0 && grade.sections.length > 0) {
      errors.add(`${base}.streams`, 'Streams are declared but no section uses one. Give every section a streamCode, or declare no streams.');
    }
    grade.sections.forEach((section, si) => {
      const path = `${base}.sections.${si}.streamCode`;
      if (section.streamCode === undefined) {
        if (anyStreamed) errors.add(path, 'This grade uses streams: every section must have a streamCode');
      } else if (!streamCodes.has(normalizeStreamCode(section.streamCode))) {
        errors.add(path, `Stream "${normalizeStreamCode(section.streamCode)}" is not declared in this grade's streams`);
      }
    });
    flagInRequestDuplicates(
      grade.sections,
      (s) => `${s.streamCode === undefined ? '' : normalizeStreamCode(s.streamCode)}|${s.code}`,
      errors,
      (i) => `${base}.sections.${i}.code`,
      (key, first) => `Duplicate section code "${key.split('|')[1]}": already used by ${base}.sections.${first}${key.startsWith('|') ? '' : ' in the same stream'}`
    );
  });
  return errors;
}

async function existingGradeConflicts(db: Pick<typeof prisma, 'grade'>, data: BulkGradeStructureInput): Promise<RowErrors> {
  const errors = new RowErrors();
  const existing = await db.grade.findMany({ where: { academicYearId: data.academicYearId }, select: { name: true, displayOrder: true } });
  const names = new Set(existing.map((g) => g.name));
  const orders = new Set(existing.map((g) => g.displayOrder));
  data.grades.forEach((grade, i) => {
    if (names.has(grade.name)) errors.add(`grades.${i}.name`, `Grade "${grade.name}" already exists in this academic year`);
    if (orders.has(grade.displayOrder)) errors.add(`grades.${i}.displayOrder`, `Display order ${grade.displayOrder} is already used in this academic year`);
  });
  return errors;
}

export class GradeStructureService {
  /**
   * Create grades with their streams and sections for one academic year, atomically (everything or nothing).
   *
   * Order: request-level rules (400, no database access) -> academic year ownership (404/403) and DRAFT status (400), re-checked inside
   * the transaction under FOR SHARE on the year row, so the year cannot leave DRAFT mid-request -> conflicts with existing grades (409, per
   * row) -> inserts (grades, streams, sections; ids are generated here so parents and children are linked without extra reads).
   * A concurrent writer that takes a grade name/order between the check and the insert aborts the whole transaction; the clashing rows
   * are then re-read and reported as 409.
   */
  async createGradeStructure(schoolId: string, data: BulkGradeStructureInput): Promise<GradeStructureResult> {
    validateStructure(data).throwIfAny(400, 'Validation failed');

    const year = await prisma.academicYear.findUnique({ where: { id: data.academicYearId } });
    if (!year) throw new AppError(404, 'Academic year not found');
    if (year.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this academic year');
    if (year.status !== 'DRAFT') throw new AppError(400, DRAFT_MESSAGE);

    try {
      return await prisma.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw<Array<{ status: string; schoolId: string }>>`
            SELECT "status"::text AS "status", "schoolId" FROM "academic_years" WHERE "id" = ${data.academicYearId} FOR SHARE`;
          const current = locked[0];
          if (!current) throw new AppError(404, 'Academic year not found');
          if (current.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this academic year');
          if (current.status !== 'DRAFT') throw new AppError(400, DRAFT_MESSAGE);

          (await existingGradeConflicts(tx, data)).throwIfAny(409, CONFLICT_MESSAGE);

          const gradeIds = data.grades.map(() => randomUUID());
          const streamRows: Array<{ id: string; gradeId: string; name: string; code: string }> = [];
          const sectionRows: Array<{ id: string; gradeId: string; streamId: string | null; name: string; code: string }> = [];
          data.grades.forEach((grade, gi) => {
            const gradeId = gradeIds[gi]!;
            const streamIdByCode = new Map<string, string>();
            for (const stream of grade.streams) {
              const id = randomUUID();
              streamIdByCode.set(normalizeStreamCode(stream.code), id);
              streamRows.push({ id, gradeId, name: stream.name, code: normalizeStreamCode(stream.code) });
            }
            for (const section of grade.sections) {
              const streamId = section.streamCode === undefined ? null : streamIdByCode.get(normalizeStreamCode(section.streamCode))!;
              sectionRows.push({ id: randomUUID(), gradeId, streamId, name: section.name, code: section.code });
            }
          });

          const grades = await tx.grade.createManyAndReturn({
            data: data.grades.map((g, i) => ({ id: gradeIds[i]!, academicYearId: data.academicYearId, name: g.name, displayOrder: g.displayOrder })),
          });
          const streams = streamRows.length > 0 ? await tx.stream.createManyAndReturn({ data: streamRows }) : [];
          const sections = sectionRows.length > 0 ? await tx.section.createManyAndReturn({ data: sectionRows }) : [];

          const gradeById = new Map(grades.map((g) => [g.id, g]));
          const streamById = new Map(streams.map((s) => [s.id, s]));
          const sectionById = new Map(sections.map((s) => [s.id, s]));
          return {
            academicYearId: data.academicYearId,
            grades: gradeIds.map((gradeId) => ({
              ...gradeById.get(gradeId)!,
              streams: streamRows.filter((s) => s.gradeId === gradeId).map((s) => streamById.get(s.id)!),
              sections: sectionRows.filter((s) => s.gradeId === gradeId).map((s) => sectionById.get(s.id)!),
            })),
          };
        },
        { timeout: 20_000 }
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      (await existingGradeConflicts(prisma, data)).throwIfAny(409, CONFLICT_MESSAGE);
      throw new AppError(409, 'A value conflicted with a concurrent request; nothing was created. Retry the request.');
    }
  }
}

export const gradeStructureService = new GradeStructureService();
