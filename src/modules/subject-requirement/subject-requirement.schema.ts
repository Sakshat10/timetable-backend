import { z } from 'zod';

export const MIN_PERIODS_PER_WEEK = 1;
export const MAX_PERIODS_PER_WEEK = 40;

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

// Strict: must be a real JSON number that is an integer. Strings ("5", " 5 "),
// booleans, arrays and null are rejected. (These routes bypass Fastify's Ajv
// validation, which would otherwise coerce them — see the routes file.)
const periodsPerWeekSchema = z
  .number({ error: 'periodsPerWeek must be a number' })
  .int('periodsPerWeek must be an integer')
  .min(MIN_PERIODS_PER_WEEK, `periodsPerWeek must be at least ${MIN_PERIODS_PER_WEEK}`)
  .max(MAX_PERIODS_PER_WEEK, `periodsPerWeek must not exceed ${MAX_PERIODS_PER_WEEK}`);

// Curriculum metadata. isOptional is a label (see prisma/schema.prisma); the scope says which sections of the grade/stream the requirement applies to.
export const MAX_SELECTED_SECTIONS = 200;
export const isOptionalSchema = z.boolean({ error: 'isOptional must be true or false' });
export const sectionScopeSchema = z.enum(['ALL_SECTIONS', 'SELECTED_SECTIONS'], { error: 'sectionScope must be ALL_SECTIONS or SELECTED_SECTIONS' });
export const sectionIdsSchema = z.array(z.string().uuid('Invalid section ID format')).max(MAX_SELECTED_SECTIONS, `At most ${MAX_SELECTED_SECTIONS} sections`);

/** The scope fields relate to each other: SELECTED_SECTIONS needs sections, ALL_SECTIONS must not carry any, and sections without a scope are ambiguous. */
export function scopeIssues(v: { sectionScope?: 'ALL_SECTIONS' | 'SELECTED_SECTIONS' | undefined; sectionIds?: readonly string[] | undefined }): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  if (v.sectionScope === 'SELECTED_SECTIONS' && (v.sectionIds === undefined || v.sectionIds.length === 0)) issues.push({ path: 'sectionIds', message: 'sectionIds is required (at least one section) when sectionScope is SELECTED_SECTIONS' });
  if (v.sectionScope === 'ALL_SECTIONS' && v.sectionIds !== undefined && v.sectionIds.length > 0) issues.push({ path: 'sectionIds', message: 'sectionIds must be omitted when sectionScope is ALL_SECTIONS' });
  if (v.sectionScope === undefined && v.sectionIds !== undefined && v.sectionIds.length > 0) issues.push({ path: 'sectionScope', message: 'sectionScope is required when sectionIds is given' });
  return issues;
}

// ---------------------------------------------------------------------------
// Create / Update
// ---------------------------------------------------------------------------
export const createSubjectRequirementSchema = z
  .object({
    gradeId: z.string().uuid('Invalid grade ID format'),
    // null is treated the same as omitted
    streamId: z.string().uuid('Invalid stream ID format').nullable().optional(),
    subjectId: z.string().uuid('Invalid subject ID format'),
    periodsPerWeek: periodsPerWeekSchema,
    isOptional: isOptionalSchema.optional(),
    sectionScope: sectionScopeSchema.optional(),
    sectionIds: sectionIdsSchema.optional(),
  })
  .superRefine((v, ctx) => {
    for (const i of scopeIssues(v)) ctx.addIssue({ code: 'custom', path: [i.path], message: i.message });
  });

// Grade, stream and subject are immutable. Everything else about the requirement may change.
export const updateSubjectRequirementSchema = z
  .object({
    periodsPerWeek: periodsPerWeekSchema.optional(),
    isOptional: isOptionalSchema.optional(),
    sectionScope: sectionScopeSchema.optional(),
    sectionIds: sectionIdsSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.periodsPerWeek === undefined && v.isOptional === undefined && v.sectionScope === undefined && v.sectionIds === undefined) {
      ctx.addIssue({ code: 'custom', path: ['periodsPerWeek'], message: 'Provide periodsPerWeek, isOptional or sectionScope to change' });
    }
    for (const i of scopeIssues(v)) ctx.addIssue({ code: 'custom', path: [i.path], message: i.message });
  });

// ---------------------------------------------------------------------------
// Query + path params
// ---------------------------------------------------------------------------
export const listSubjectRequirementsQuerySchema = z.object({
  academicYearId: z.string().uuid('Invalid academic year ID format').optional(),
  gradeId: z.string().uuid('Invalid grade ID format').optional(),
  streamId: z.string().uuid('Invalid stream ID format').optional(),
});

export const subjectRequirementIdParamSchema = z.object({
  id: z.string().uuid('Invalid subject requirement ID format'),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------
export type CreateSubjectRequirementBody = z.input<typeof createSubjectRequirementSchema>;
export type UpdateSubjectRequirementBody = z.input<typeof updateSubjectRequirementSchema>;
export type CreateSubjectRequirementInput = z.output<typeof createSubjectRequirementSchema>;
export type UpdateSubjectRequirementInput = z.output<typeof updateSubjectRequirementSchema>;
export type ListSubjectRequirementsQuery = z.infer<typeof listSubjectRequirementsQuerySchema>;
export type SubjectRequirementIdParam = z.infer<typeof subjectRequirementIdParamSchema>;
