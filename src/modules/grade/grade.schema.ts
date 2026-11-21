import { z } from 'zod';

// Create Grade schema
export const createGradeSchema = z.object({
  academicYearId: z.string().uuid('Invalid academic year ID format'),
  name: z
    .string()
    .min(1, 'Grade name is required')
    .max(100, 'Grade name must not exceed 100 characters')
    .trim()
    .refine((val) => val.length > 0, 'Grade name cannot be empty'),
  displayOrder: z
    .number()
    .int('Display order must be an integer')
    .positive('Display order must be a positive number'),
});

// Update Grade schema
export const updateGradeSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Grade name is required')
      .max(100, 'Grade name must not exceed 100 characters')
      .trim()
      .refine((val) => val.length > 0, 'Grade name cannot be empty')
      .optional(),
    displayOrder: z
      .number()
      .int('Display order must be an integer')
      .positive('Display order must be a positive number')
      .optional(),
  })
  .refine((data) => data.name !== undefined || data.displayOrder !== undefined, {
    message: 'At least one field (name or displayOrder) must be provided',
  });

// Get Grade params schema
export const getGradeParamsSchema = z.object({
  id: z.string().uuid('Invalid grade ID format'),
});

// Query parameters for filtering
export const getGradesQuerySchema = z.object({
  academicYearId: z.string().uuid('Invalid academic year ID format').optional(),
});

export type CreateGradeInput = z.infer<typeof createGradeSchema>;
export type UpdateGradeInput = z.infer<typeof updateGradeSchema>;
export type GetGradeParams = z.infer<typeof getGradeParamsSchema>;
export type GetGradesQuery = z.infer<typeof getGradesQuerySchema>;
