import { z } from 'zod';

// ---------------------------------------------------------------------------
// Create Stream schema
// ---------------------------------------------------------------------------
export const createStreamSchema = z.object({
  gradeId: z.string().uuid('Invalid grade ID format'),
  name: z
    .string()
    .min(1, 'Stream name is required')
    .max(100, 'Stream name must not exceed 100 characters')
    .trim()
    .refine((val) => val.length > 0, 'Stream name cannot be empty after trimming'),
  code: z
    .string()
    .min(1, 'Stream code is required')
    .max(20, 'Stream code must not exceed 20 characters')
    .trim()
    .refine((val) => val.length > 0, 'Stream code cannot be empty after trimming'),
});

// ---------------------------------------------------------------------------
// Update Stream schema
// ---------------------------------------------------------------------------
export const updateStreamSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Stream name is required')
      .max(100, 'Stream name must not exceed 100 characters')
      .trim()
      .refine((val) => val.length > 0, 'Stream name cannot be empty after trimming')
      .optional(),
    code: z
      .string()
      .min(1, 'Stream code is required')
      .max(20, 'Stream code must not exceed 20 characters')
      .trim()
      .refine((val) => val.length > 0, 'Stream code cannot be empty after trimming')
      .optional(),
  })
  .refine(
    (data) => data.name !== undefined || data.code !== undefined,
    { message: 'At least one field (name or code) must be provided' }
  );

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------
export const streamIdParamSchema = z.object({
  id: z.string().uuid('Invalid stream ID format'),
});

export const gradeIdParamSchema = z.object({
  gradeId: z.string().uuid('Invalid grade ID format'),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------
export type CreateStreamInput = z.infer<typeof createStreamSchema>;
export type UpdateStreamInput = z.infer<typeof updateStreamSchema>;
export type StreamIdParam = z.infer<typeof streamIdParamSchema>;
export type GradeIdParam = z.infer<typeof gradeIdParamSchema>;
