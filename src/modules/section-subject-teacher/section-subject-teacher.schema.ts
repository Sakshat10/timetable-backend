import { z } from 'zod';

// ---------------------------------------------------------------------------
// Create / Update
// ---------------------------------------------------------------------------
export const createSectionSubjectTeacherSchema = z.object({
  sectionId: z.string().uuid('Invalid section ID format'),
  subjectRequirementId: z.string().uuid('Invalid subject requirement ID format'),
  teacherId: z.string().uuid('Invalid teacher ID format'),
});

// Only the teacher may change. sectionId / subjectRequirementId are immutable: supplying
// them is rejected (field-level 400) instead of being silently ignored. To "move" an
// assignment, delete it and create a new one.
export const updateSectionSubjectTeacherSchema = z.object({
  teacherId: z.string().uuid('Invalid teacher ID format'),
  sectionId: z.never({ error: 'sectionId cannot be changed; delete and re-create the assignment' }).optional(),
  subjectRequirementId: z
    .never({ error: 'subjectRequirementId cannot be changed; delete and re-create the assignment' })
    .optional(),
});

// ---------------------------------------------------------------------------
// Query + path params
// ---------------------------------------------------------------------------
export const listSectionSubjectTeachersQuerySchema = z.object({
  academicYearId: z.string().uuid('Invalid academic year ID format').optional(),
  gradeId: z.string().uuid('Invalid grade ID format').optional(),
  sectionId: z.string().uuid('Invalid section ID format').optional(),
  subjectId: z.string().uuid('Invalid subject ID format').optional(),
  teacherId: z.string().uuid('Invalid teacher ID format').optional(),
});

export const sectionSubjectTeacherIdParamSchema = z.object({
  id: z.string().uuid('Invalid section subject teacher ID format'),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------
export type CreateSectionSubjectTeacherBody = z.input<typeof createSectionSubjectTeacherSchema>;
export type UpdateSectionSubjectTeacherBody = z.input<typeof updateSectionSubjectTeacherSchema>;
export type CreateSectionSubjectTeacherInput = z.output<typeof createSectionSubjectTeacherSchema>;
export type UpdateSectionSubjectTeacherInput = z.output<typeof updateSectionSubjectTeacherSchema>;
export type ListSectionSubjectTeachersQuery = z.infer<typeof listSectionSubjectTeachersQuerySchema>;
export type SectionSubjectTeacherIdParam = z.infer<typeof sectionSubjectTeacherIdParamSchema>;
