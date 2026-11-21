import { z } from 'zod';

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------
const teacherNameSchema = z
  .string()
  .trim()
  .min(1, 'Teacher name is required')
  .max(200, 'Teacher name must not exceed 200 characters');

// Normalisation: trim -> uppercase -> empty becomes null.
// "t-001", "T-001" and " t-001 " all become "T-001"; "" and "   " become null.
// NULL employee codes never collide (PostgreSQL treats NULLs as distinct in unique indexes).
const employeeCodeSchema = z
  .string()
  .transform((value) => {
    const normalized = value.trim().toUpperCase();
    return normalized === '' ? null : normalized;
  })
  .refine((value) => value === null || value.length <= 50, {
    message: 'Employee code must not exceed 50 characters',
  });

// ---------------------------------------------------------------------------
// Create / Update
// ---------------------------------------------------------------------------
export const createTeacherSchema = z.object({
  name: teacherNameSchema,
  employeeCode: employeeCodeSchema.nullable().optional(),
  isActive: z.boolean().optional(),
});

export const MAX_BULK_TEACHERS = 100;

/** Rows are validated and normalised by the single-record schema (trim, uppercase employee code, empty code -> null). */
export const bulkCreateTeachersSchema = z.object({
  teachers: z
    .array(createTeacherSchema)
    .min(1, 'At least one teacher is required')
    .max(MAX_BULK_TEACHERS, `At most ${MAX_BULK_TEACHERS} teachers can be created per request`),
});

/** The Idempotency-Key request header: required for bulk teacher creation (a retry of a teacher without an employee code cannot be detected otherwise). */
export const idempotencyKeySchema = z
  .string({ error: 'The Idempotency-Key header is required' })
  .trim()
  .min(8, 'The Idempotency-Key header must be 8-128 characters')
  .max(128, 'The Idempotency-Key header must be 8-128 characters')
  .regex(/^[A-Za-z0-9._:-]+$/, 'The Idempotency-Key header may contain only letters, numbers, ".", "_", ":" and "-"');

export const updateTeacherSchema = z
  .object({
    name: teacherNameSchema.optional(),
    // null (or an empty string) clears the code; omitting the field leaves it unchanged
    employeeCode: employeeCodeSchema.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined || data.employeeCode !== undefined || data.isActive !== undefined,
    { message: 'At least one field (name, employeeCode or isActive) must be provided' }
  );

// ---------------------------------------------------------------------------
// Query + path params
// ---------------------------------------------------------------------------
// Fastify's validation coerces "true"/"false" to booleans before the handler runs,
// so accept both real booleans and the literal strings.
export const listTeachersQuerySchema = z.object({
  isActive: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')])
    .optional(),
});

export const teacherIdParamSchema = z.object({
  id: z.string().uuid('Invalid teacher ID format'),
});

// ---------------------------------------------------------------------------
// Inferred types (Body = raw request shape, Input = parsed/normalised shape)
// ---------------------------------------------------------------------------
export type BulkCreateTeachersInput = z.output<typeof bulkCreateTeachersSchema>;
export type CreateTeacherBody = z.input<typeof createTeacherSchema>;
export type UpdateTeacherBody = z.input<typeof updateTeacherSchema>;
export type CreateTeacherInput = z.output<typeof createTeacherSchema>;
export type UpdateTeacherInput = z.output<typeof updateTeacherSchema>;
export type ListTeachersQuery = z.input<typeof listTeachersQuerySchema>;
export type TeacherIdParam = z.infer<typeof teacherIdParamSchema>;
