import { z } from 'zod';
import { isOptionalSchema, scopeIssues, sectionIdsSchema, sectionScopeSchema } from '../subject-requirement/subject-requirement.schema.js';

export const MAX_CURRICULUM_SUBJECTS = 60;
const periods = z.number({ error: 'periodsPerWeek must be a number' }).int('periodsPerWeek must be an integer').min(1, 'periodsPerWeek must be at least 1').max(40, 'periodsPerWeek must not exceed 40');

/** One line of a curriculum: the same fields, with the same rules, as POST /api/subject-requirements. */
export const curriculumLineSchema = z
  .object({
    subjectId: z.string().uuid('Invalid subject ID format'),
    periodsPerWeek: periods,
    isOptional: isOptionalSchema.optional(),
    sectionScope: sectionScopeSchema.optional(),
    sectionIds: sectionIdsSchema.optional(),
  })
  .superRefine((v, ctx) => {
    for (const i of scopeIssues(v)) ctx.addIssue({ code: 'custom', path: [i.path], message: i.message });
  });

export const replaceCurriculumSchema = z.object({
  /** Required for a streamed grade, omitted (or null) for a non-streamed one. */
  streamId: z.string().uuid('Invalid stream ID format').nullable().optional(),
  /** The COMPLETE curriculum of this grade/stream: subjects not listed are removed (refused while teachers are assigned to them). */
  requirements: z.array(curriculumLineSchema).max(MAX_CURRICULUM_SUBJECTS, `At most ${MAX_CURRICULUM_SUBJECTS} subjects per curriculum`),
  /** true: validate and return what would change, write nothing. */
  dryRun: z.boolean().optional(),
});

export const copyCurriculumSchema = z.object({
  fromGradeId: z.string().uuid('Invalid grade ID format'),
  fromStreamId: z.string().uuid('Invalid stream ID format').nullable().optional(),
  toGradeId: z.string().uuid('Invalid grade ID format'),
  toStreamId: z.string().uuid('Invalid stream ID format').nullable().optional(),
  dryRun: z.boolean().optional(),
});

export const overviewQuerySchema = z.object({ academicYearId: z.string().uuid('Invalid academic year ID format') });
export const gradeParamSchema = z.object({ gradeId: z.string().uuid('Invalid grade ID format') });

export type CurriculumLine = z.output<typeof curriculumLineSchema>;
export type ReplaceCurriculumInput = z.output<typeof replaceCurriculumSchema>;
export type CopyCurriculumInput = z.output<typeof copyCurriculumSchema>;
