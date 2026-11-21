import { z } from 'zod';

// PRIMARY / SECONDARY: the product wording (the link dialog and teacher page of the frontend) is "whether it is the teacher's primary or secondary subject". Eligibility, assignment,
// feasibility and generation attach NO rule to it. The ONLY reader is the substitute ranking (src/modules/substitution): any link, of either type, shows the teacher teaches the subject
// (preferred for a substitution, and a PRIMARY link ranks before a SECONDARY one). A substitute never needs a link, and a substitution never creates or changes one.
export const teacherSubjectTypeEnum = z.enum(['PRIMARY', 'SECONDARY']);

// Which grades the link may teach (see prisma/schema.prisma, TeacherSubject.gradeScope):
//   SELECTED_GRADES  only grades with an explicit eligibility row for the academic year (the default, and what every link was before)
//   ALL_GRADES       every grade, by an explicit admin choice; the eligibility rows are then not required
export const GRADE_SCOPES = ['SELECTED_GRADES', 'ALL_GRADES'] as const;
export const gradeScopeEnum = z.enum(GRADE_SCOPES, { error: 'gradeScope must be SELECTED_GRADES or ALL_GRADES' });

// ---------------------------------------------------------------------------
// Create / Update
// ---------------------------------------------------------------------------
export const createTeacherSubjectSchema = z.object({
  subjectId: z.string().uuid('Invalid subject ID format'),
  type: teacherSubjectTypeEnum,
  /** Optional. Omitted: SELECTED_GRADES (strict, as before): nothing is permitted by omission. */
  gradeScope: gradeScopeEnum.optional(),
});

export const updateTeacherSubjectSchema = z
  .object({
    type: teacherSubjectTypeEnum.optional(),
    gradeScope: gradeScopeEnum.optional(),
  })
  .refine((v) => v.type !== undefined || v.gradeScope !== undefined, { message: 'Provide type and/or gradeScope' });

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------
export const teacherIdParamSchema = z.object({
  teacherId: z.string().uuid('Invalid teacher ID format'),
});

export const teacherSubjectIdParamSchema = z.object({
  id: z.string().uuid('Invalid teacher-subject ID format'),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------
export type CreateTeacherSubjectInput = z.infer<typeof createTeacherSubjectSchema>;
export type UpdateTeacherSubjectInput = z.infer<typeof updateTeacherSubjectSchema>;
export type TeacherIdParam = z.infer<typeof teacherIdParamSchema>;
export type TeacherSubjectIdParam = z.infer<typeof teacherSubjectIdParamSchema>;
