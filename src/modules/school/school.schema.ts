import { z } from 'zod';

export const schoolTypeEnum = z.enum(['PRIMARY', 'SECONDARY', 'CUSTOM']);

export const createSchoolSchema = z.object({
  name: z
    .string()
    .min(1, 'School name is required')
    .max(200, 'School name must not exceed 200 characters')
    .trim(),
  code: z
    .string()
    .min(1, 'School code is required')
    .max(50, 'School code must not exceed 50 characters')
    .regex(/^[A-Z0-9_-]+$/, 'School code must contain only uppercase letters, numbers, hyphens, and underscores')
    .trim(),
  schoolType: schoolTypeEnum,
});

export const getSchoolParamsSchema = z.object({
  id: z.string().uuid('Invalid school ID format'),
});

export type CreateSchoolInput = z.infer<typeof createSchoolSchema>;
export type GetSchoolParams = z.infer<typeof getSchoolParamsSchema>;
