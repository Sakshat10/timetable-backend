import { z } from 'zod';

// ---------------------------------------------------------------------------
// Create Section schema
// ---------------------------------------------------------------------------
export const createSectionSchema = z.object({
  gradeId: z.string().uuid('Invalid grade ID format'),
  streamId: z.string().uuid('Invalid stream ID format').optional(),
  name: z
    .string()
    .min(1, 'Section name is required')
    .max(100, 'Section name must not exceed 100 characters')
    .trim()
    .refine((val) => val.length > 0, 'Section name cannot be empty after trimming'),
  code: z
    .string()
    .min(1, 'Section code is required')
    .max(20, 'Section code must not exceed 20 characters')
    .trim()
    .refine((val) => val.length > 0, 'Section code cannot be empty after trimming'),
});

// ---------------------------------------------------------------------------
// Update Section schema
// ---------------------------------------------------------------------------
export const updateSectionSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Section name is required')
      .max(100, 'Section name must not exceed 100 characters')
      .trim()
      .refine((val) => val.length > 0, 'Section name cannot be empty after trimming')
      .optional(),
    code: z
      .string()
      .min(1, 'Section code is required')
      .max(20, 'Section code must not exceed 20 characters')
      .trim()
      .refine((val) => val.length > 0, 'Section code cannot be empty after trimming')
      .optional(),
  })
  .refine(
    (data) => data.name !== undefined || data.code !== undefined,
    { message: 'At least one field (name or code) must be provided' }
  );

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------
export const sectionIdParamSchema = z.object({
  id: z.string().uuid('Invalid section ID format'),
});

export const gradeIdParamSchema = z.object({
  gradeId: z.string().uuid('Invalid grade ID format'),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------
export type CreateSectionInput = z.infer<typeof createSectionSchema>;
export type UpdateSectionInput = z.infer<typeof updateSectionSchema>;
export type SectionIdParam = z.infer<typeof sectionIdParamSchema>;
export type GradeIdParam = z.infer<typeof gradeIdParamSchema>;
