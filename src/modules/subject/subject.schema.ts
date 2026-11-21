import { z } from 'zod';

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------
const subjectNameSchema = z
  .string()
  .trim()
  .min(1, 'Subject name is required')
  .max(100, 'Subject name must not exceed 100 characters');

// Normalised to uppercase so "math", "Math" and "MATH" are the same code.
const subjectCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, 'Subject code is required')
  .max(20, 'Subject code must not exceed 20 characters')
  .regex(
    /^[A-Z0-9][A-Z0-9_-]*$/,
    'Subject code must start with a letter or number and contain only letters, numbers, hyphens, and underscores'
  );

// ---------------------------------------------------------------------------
// Create / Update
// ---------------------------------------------------------------------------
export const createSubjectSchema = z.object({
  name: subjectNameSchema,
  code: subjectCodeSchema,
});

export const MAX_BULK_SUBJECTS = 100;

/** Every row is validated and normalised by the single-record schema, so the rules cannot drift apart. */
export const bulkCreateSubjectsSchema = z.object({
  subjects: z
    .array(createSubjectSchema)
    .min(1, 'At least one subject is required')
    .max(MAX_BULK_SUBJECTS, `At most ${MAX_BULK_SUBJECTS} subjects can be created per request`),
});

export const updateSubjectSchema = z
  .object({
    name: subjectNameSchema.optional(),
    code: subjectCodeSchema.optional(),
  })
  .refine((data) => data.name !== undefined || data.code !== undefined, {
    message: 'At least one field (name or code) must be provided',
  });

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------
export const subjectIdParamSchema = z.object({
  id: z.string().uuid('Invalid subject ID format'),
});

// ---------------------------------------------------------------------------
// Inferred types (Body = raw request shape, Input = parsed/normalised shape)
// ---------------------------------------------------------------------------
export type BulkCreateSubjectsInput = z.output<typeof bulkCreateSubjectsSchema>;
export type CreateSubjectBody = z.input<typeof createSubjectSchema>;
export type UpdateSubjectBody = z.input<typeof updateSubjectSchema>;
export type CreateSubjectInput = z.output<typeof createSubjectSchema>;
export type UpdateSubjectInput = z.output<typeof updateSubjectSchema>;
export type SubjectIdParam = z.infer<typeof subjectIdParamSchema>;
