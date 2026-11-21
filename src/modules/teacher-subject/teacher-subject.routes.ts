import { type FastifyInstance } from 'fastify';
import { teacherSubjectController } from './teacher-subject.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import {
  type CreateTeacherSubjectInput,
  type TeacherIdParam,
  type TeacherSubjectIdParam,
  type UpdateTeacherSubjectInput,
} from './teacher-subject.schema.js';

// Reusable Swagger schema fragments
const teacherSubjectDataSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    teacherId: { type: 'string', format: 'uuid' },
    subjectId: { type: 'string', format: 'uuid' },
    type: { type: 'string', enum: ['PRIMARY', 'SECONDARY'] },
    gradeScope: { type: 'string', enum: ['SELECTED_GRADES', 'ALL_GRADES'], description: 'SELECTED_GRADES: only grades with an explicit eligibility row (per academic year). ALL_GRADES: every grade, an explicit admin choice; the eligibility rows are then not required.' },
    subject: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        code: { type: 'string' },
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const errorSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
  },
} as const;

// 400 with validation errors — additionalProperties prevents Fastify response
// serialization from stripping dynamic error keys
const validationErrorSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    errors: {
      type: 'object',
      additionalProperties: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  },
} as const;

const teacherIdParamsSchema = {
  type: 'object',
  required: ['teacherId'],
  properties: {
    teacherId: { type: 'string', format: 'uuid', description: 'Teacher UUID' },
  },
} as const;

export async function teacherSubjectRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------
  // POST /api/teachers/:teacherId/subjects — Add a subject to a teacher
  // ------------------------------------------------------------------
  app.post<{ Params: TeacherIdParam; Body: CreateTeacherSubjectInput }>(
    '/teachers/:teacherId/subjects',
    {
      schema: {
        tags: ['Teacher Subject'],
        summary: 'Add subject to teacher',
        description:
          'Associate a subject with a teacher. Both must belong to the authenticated admin\'s ' +
          'school, and the teacher must be active. The same teacher-subject pair cannot be added ' +
          'twice. No academic-year status rule applies. "type" is PRIMARY or SECONDARY (the teacher\'s primary or secondary subject); it has no effect on eligibility, ' +
          'assignment or generation; it only orders substitute candidates (a link of either type marks a teacher of the subject, PRIMARY first). This link is the teacher\'s SUBJECT QUALIFICATION and is always required before the teacher can be ' +
          'assigned. "gradeScope" (optional) says which grades the teacher may teach this subject in: SELECTED_GRADES (the default when omitted: ' +
          'only grades with an explicit POST /api/teacher-subjects/{id}/grades row, entered per academic year) or ALL_GRADES (every grade, an ' +
          'explicit choice; no grade rows are needed). Omitting it never grants permission to other grades.',
        security: [{ cookieAuth: [] }],
        params: teacherIdParamsSchema,
        body: {
          type: 'object',
          required: ['subjectId', 'type'],
          properties: {
            subjectId: { type: 'string', format: 'uuid', description: 'Subject UUID' },
            type: { type: 'string', enum: ['PRIMARY', 'SECONDARY'] },
            gradeScope: { type: 'string', enum: ['SELECTED_GRADES', 'ALL_GRADES'], default: 'SELECTED_GRADES', description: 'Which grades the teacher may teach this subject in. Default SELECTED_GRADES.' },
          },
        },
        response: {
          201: {
            description: 'Subject added to teacher successfully',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: teacherSubjectDataSchema,
            },
          },
          400: {
            description: 'Validation error, or the teacher is inactive',
            ...validationErrorSchema,
          },
          401: { description: 'Authentication required', ...errorSchema },
          403: { description: 'Teacher or subject belongs to another school', ...errorSchema },
          404: { description: 'Teacher or subject not found', ...errorSchema },
          409: { description: 'Subject already assigned to this teacher', ...errorSchema },
        },
      },
      preHandler: authMiddleware,
      handler: teacherSubjectController.createTeacherSubject.bind(teacherSubjectController),
    }
  );

  // ------------------------------------------------------------------
  // GET /api/teachers/:teacherId/subjects — List a teacher's subjects
  // ------------------------------------------------------------------
  app.get<{ Params: TeacherIdParam }>('/teachers/:teacherId/subjects', {
    schema: {
      tags: ['Teacher Subject'],
      summary: 'List teacher subjects',
      description:
        'Return the subjects associated with a teacher, ordered by subject name. ' +
        'Allowed for inactive teachers.',
      security: [{ cookieAuth: [] }],
      params: teacherIdParamsSchema,
      response: {
        200: {
          description: 'Teacher subjects retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'array', items: teacherSubjectDataSchema },
          },
        },
        400: { description: 'Invalid teacher ID', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Teacher belongs to another school', ...errorSchema },
        404: { description: 'Teacher not found', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: teacherSubjectController.getTeacherSubjects.bind(teacherSubjectController),
  });

  // ------------------------------------------------------------------
  // PATCH /api/teacher-subjects/:id — Change the relationship type
  // ------------------------------------------------------------------
  app.patch<{ Params: TeacherSubjectIdParam; Body: UpdateTeacherSubjectInput }>(
    '/teacher-subjects/:id',
    {
      schema: {
        tags: ['Teacher Subject'],
        summary: 'Update teacher-subject type and/or grade scope',
        description:
          'Change a teacher-subject relationship\'s type (PRIMARY or SECONDARY) and/or its gradeScope (SELECTED_GRADES or ALL_GRADES); ' +
          'send at least one. No academic-year status rule applies. Widening to ALL_GRADES needs no check. Narrowing ALL_GRADES to ' +
          'SELECTED_GRADES is refused with 409 while an assignment of this teacher and subject in a DRAFT academic year teaches a grade that has ' +
          'no explicit eligibility row (it would become ineligible): add the eligibility for those grades first (allowed while ALL_GRADES; ' +
          'ignored until then) or change the assignments. Assignments in ACTIVE or COMPLETED years are history and are not considered.',
        security: [{ cookieAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid', description: 'TeacherSubject UUID' },
          },
        },
        body: {
          type: 'object',
          minProperties: 1,
          properties: {
            type: { type: 'string', enum: ['PRIMARY', 'SECONDARY'] },
            gradeScope: { type: 'string', enum: ['SELECTED_GRADES', 'ALL_GRADES'] },
          },
        },
        response: {
          200: {
            description: 'Teacher subject updated successfully',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: teacherSubjectDataSchema,
            },
          },
          400: { description: 'Validation error', ...validationErrorSchema },
          401: { description: 'Authentication required', ...errorSchema },
          403: { description: 'Relationship belongs to another school', ...errorSchema },
          404: { description: 'Relationship not found', ...errorSchema },
          409: { description: 'Narrowing ALL_GRADES to SELECTED_GRADES would leave DRAFT-year assignments without an eligibility', ...errorSchema },
        },
      },
      preHandler: authMiddleware,
      handler: teacherSubjectController.updateTeacherSubject.bind(teacherSubjectController),
    }
  );

  // ------------------------------------------------------------------
  // DELETE /api/teacher-subjects/:id — Remove a subject from a teacher
  // ------------------------------------------------------------------
  app.delete<{ Params: TeacherSubjectIdParam }>('/teacher-subjects/:id', {
    schema: {
      tags: ['Teacher Subject'],
      summary: 'Remove a subject from a teacher',
      description:
        'Remove one teacher-subject link (the teacher\'s qualification for that subject). The teacher and the school-level subject are not ' +
        'deleted. The link\'s grade eligibility rows are removed with it. Refused with 409, deleting nothing, while an assignment of this ' +
        'teacher and subject exists in a DRAFT or ACTIVE academic year, or a PUBLISHED timetable of such a year contains their lessons: ' +
        'remove or change those first. COMPLETED years are history and do not block; draft timetables do not block (they become stale). ' +
        'No academic-year status rule applies otherwise.',
      security: [{ cookieAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid', description: 'TeacherSubject UUID' } },
      },
      response: {
        200: {
          description: 'Subject removed from the teacher',
          type: 'object',
          properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: { type: 'null', nullable: true } },
        },
        400: { description: 'Invalid ID', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Relationship belongs to another school', ...errorSchema },
        404: { description: 'Relationship not found', ...errorSchema },
        409: { description: 'Assignments or published lessons depend on this link', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: teacherSubjectController.deleteTeacherSubject.bind(teacherSubjectController),
  });
}
