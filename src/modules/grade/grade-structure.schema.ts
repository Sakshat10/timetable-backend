import { z } from 'zod';
import { createGradeSchema } from './grade.schema.js';
import { createStreamSchema } from '../stream/stream.schema.js';
import { createSectionSchema } from '../section/section.schema.js';

/** Explicit size limits of one grade-structure request (everything is created in a single transaction). */
export const GRADE_STRUCTURE_LIMITS = {
  grades: 20,
  streamsPerGrade: 10,
  sectionsPerGrade: 30,
  totalSections: 200,
} as const;

// Every field is validated and normalised by the SAME schemas as POST /api/grades, /api/streams and /api/sections.
const streamRow = createStreamSchema.pick({ name: true, code: true });

const sectionRow = createSectionSchema.pick({ name: true, code: true }).extend({
  /** Code of one of this grade's streams (matched case-insensitively). Required for every section of a streamed grade, forbidden otherwise. */
  streamCode: z.string().min(1, 'Stream code is required').max(20, 'Stream code must not exceed 20 characters').trim().optional(),
});

const gradeRow = createGradeSchema.omit({ academicYearId: true }).extend({
  streams: z.array(streamRow).max(GRADE_STRUCTURE_LIMITS.streamsPerGrade, `At most ${GRADE_STRUCTURE_LIMITS.streamsPerGrade} streams per grade`).default([]),
  sections: z.array(sectionRow).max(GRADE_STRUCTURE_LIMITS.sectionsPerGrade, `At most ${GRADE_STRUCTURE_LIMITS.sectionsPerGrade} sections per grade`).default([]),
});

export const bulkGradeStructureSchema = z
  .object({
    academicYearId: z.string().uuid('Invalid academic year ID format'),
    grades: z
      .array(gradeRow)
      .min(1, 'At least one grade is required')
      .max(GRADE_STRUCTURE_LIMITS.grades, `At most ${GRADE_STRUCTURE_LIMITS.grades} grades can be created per request`),
  })
  .refine((v) => v.grades.reduce((n, g) => n + g.sections.length, 0) <= GRADE_STRUCTURE_LIMITS.totalSections, {
    message: `At most ${GRADE_STRUCTURE_LIMITS.totalSections} sections can be created per request`,
    path: ['grades'],
  });

export type BulkGradeStructureInput = z.output<typeof bulkGradeStructureSchema>;
