import { z } from 'zod';

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export const createTeacherSubjectGradeSchema = z.object({
  gradeId: z.string().uuid('Invalid grade ID format'),
});

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------
export const teacherSubjectIdParamSchema = z.object({
  teacherSubjectId: z.string().uuid('Invalid teacher-subject ID format'),
});

export const teacherSubjectGradeParamSchema = z.object({
  teacherSubjectId: z.string().uuid('Invalid teacher-subject ID format'),
  gradeId: z.string().uuid('Invalid grade ID format'),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------
export type CreateTeacherSubjectGradeInput = z.infer<typeof createTeacherSubjectGradeSchema>;
export type TeacherSubjectIdParam = z.infer<typeof teacherSubjectIdParamSchema>;
export type TeacherSubjectGradeParam = z.infer<typeof teacherSubjectGradeParamSchema>;
