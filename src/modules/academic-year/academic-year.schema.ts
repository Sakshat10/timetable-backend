import { z } from 'zod';

// Status enum for validation
export const academicYearStatusEnum = z.enum(['DRAFT', 'ACTIVE', 'COMPLETED']);

// Create Academic Year schema
export const createAcademicYearSchema = z.object({
  name: z
    .string()
    .min(1, 'Academic year name is required')
    .max(50, 'Academic year name must not exceed 50 characters')
    .trim(),
  startDate: z
    .string()
    .refine((val) => {
      const date = new Date(val);
      return !isNaN(date.getTime());
    }, 'Invalid start date format'),
  endDate: z
    .string()
    .refine((val) => {
      const date = new Date(val);
      return !isNaN(date.getTime());
    }, 'Invalid end date format'),
}).refine(
  (data) => {
    const start = new Date(data.startDate);
    const end = new Date(data.endDate);
    return end > start;
  },
  {
    message: 'End date must be after start date',
    path: ['endDate'],
  }
);

// Update Academic Year schema
export const updateAcademicYearSchema = z.object({
  name: z
    .string()
    .min(1, 'Academic year name is required')
    .max(50, 'Academic year name must not exceed 50 characters')
    .trim()
    .optional(),
  startDate: z
    .string()
    .refine((val) => {
      const date = new Date(val);
      return !isNaN(date.getTime());
    }, 'Invalid start date format')
    .optional(),
  endDate: z
    .string()
    .refine((val) => {
      const date = new Date(val);
      return !isNaN(date.getTime());
    }, 'Invalid end date format')
    .optional(),
  status: academicYearStatusEnum.optional(),
}).refine(
  (data) => {
    // If both dates provided, validate the relationship
    if (data.startDate && data.endDate) {
      const start = new Date(data.startDate);
      const end = new Date(data.endDate);
      return end > start;
    }
    return true;
  },
  {
    message: 'End date must be after start date',
    path: ['endDate'],
  }
);

// Get Academic Year params schema
export const getAcademicYearParamsSchema = z.object({
  id: z.string().uuid('Invalid academic year ID format'),
});

export type CreateAcademicYearInput = z.infer<typeof createAcademicYearSchema>;
export type UpdateAcademicYearInput = z.infer<typeof updateAcademicYearSchema>;
export type GetAcademicYearParams = z.infer<typeof getAcademicYearParamsSchema>;
