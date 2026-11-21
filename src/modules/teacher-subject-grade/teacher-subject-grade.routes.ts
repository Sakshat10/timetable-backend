import { type FastifyInstance } from 'fastify';
import { teacherSubjectGradeController } from './teacher-subject-grade.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import {
  type CreateTeacherSubjectGradeInput,
  type TeacherSubjectGradeParam,
  type TeacherSubjectIdParam,
} from './teacher-subject-grade.schema.js';

// Reusable Swagger schema fragments
const eligibilityDataSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    teacherSubjectId: { type: 'string', format: 'uuid' },
    gradeId: { type: 'string', format: 'uuid' },
    grade: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        displayOrder: { type: 'integer' },
        academicYearId: { type: 'string', format: 'uuid' },
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
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

const teacherSubjectIdParamsSchema = {
  type: 'object',
  required: ['teacherSubjectId'],
  properties: {
    teacherSubjectId: { type: 'string', format: 'uuid', description: 'TeacherSubject UUID' },
  },
} as const;

export async function teacherSubjectGradeRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------
  // POST /api/teacher-subjects/:teacherSubjectId/grades — Add grade eligibility
  // ------------------------------------------------------------------
  app.post<{ Params: TeacherSubjectIdParam; Body: CreateTeacherSubjectGradeInput }>(
    '/teacher-subjects/:teacherSubjectId/grades',
    {
      schema: {
        tags: ['Teacher Subject Grade'],
        summary: 'Add grade eligibility',
        description:
          'Mark a teacher-subject relationship as eligible for a grade. The teacher, subject and ' +
          'grade must all belong to the authenticated admin\'s school. The grade\'s academic year ' +
          'must be DRAFT. The same grade cannot be added twice.',
        security: [{ cookieAuth: [] }],
        params: teacherSubjectIdParamsSchema,
        body: {
          type: 'object',
          required: ['gradeId'],
          properties: {
            gradeId: { type: 'string', format: 'uuid', description: 'Grade UUID' },
          },
        },
        response: {
          201: {
            description: 'Grade eligibility added successfully',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: eligibilityDataSchema,
            },
          },
          400: {
            description: 'Validation error, or the academic year is not in DRAFT status',
            ...validationErrorSchema,
          },
          401: { description: 'Authentication required', ...errorSchema },
          403: { description: 'Resource belongs to another school', ...errorSchema },
          404: { description: 'Teacher-subject relationship or grade not found', ...errorSchema },
          409: { description: 'Grade eligibility already exists', ...errorSchema },
        },
      },
      preHandler: authMiddleware,
      handler: teacherSubjectGradeController.createEligibility.bind(teacherSubjectGradeController),
    }
  );

  // ------------------------------------------------------------------
  // GET /api/teacher-subjects/:teacherSubjectId/grades — List grade eligibility
  // ------------------------------------------------------------------
  app.get<{ Params: TeacherSubjectIdParam }>('/teacher-subjects/:teacherSubjectId/grades', {
    schema: {
      tags: ['Teacher Subject Grade'],
      summary: 'List grade eligibility',
      description:
        'Return the grades a teacher-subject relationship is eligible for, newest academic year ' +
        'first then by grade order. Allowed in any academic-year status.',
      security: [{ cookieAuth: [] }],
      params: teacherSubjectIdParamsSchema,
      response: {
        200: {
          description: 'Grade eligibility retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'array', items: eligibilityDataSchema },
          },
        },
        400: { description: 'Invalid teacher-subject ID', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Relationship belongs to another school', ...errorSchema },
        404: { description: 'Teacher-subject relationship not found', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: teacherSubjectGradeController.getEligibility.bind(teacherSubjectGradeController),
  });

  // ------------------------------------------------------------------
  // DELETE /api/teacher-subjects/:teacherSubjectId/grades/:gradeId — Remove grade eligibility
  // ------------------------------------------------------------------
  app.delete<{ Params: TeacherSubjectGradeParam }>(
    '/teacher-subjects/:teacherSubjectId/grades/:gradeId',
    {
      schema: {
        tags: ['Teacher Subject Grade'],
        summary: 'Remove grade eligibility',
        description:
          'Remove a grade eligibility. Only the relationship row is deleted; the teacher, subject, ' +
          'teacher-subject and grade are untouched. The grade\'s academic year must be DRAFT.',
        security: [{ cookieAuth: [] }],
        params: {
          type: 'object',
          required: ['teacherSubjectId', 'gradeId'],
          properties: {
            teacherSubjectId: { type: 'string', format: 'uuid', description: 'TeacherSubject UUID' },
            gradeId: { type: 'string', format: 'uuid', description: 'Grade UUID' },
          },
        },
        response: {
          200: {
            description: 'Grade eligibility removed successfully',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: { type: 'null', nullable: true },
            },
          },
          400: {
            description: 'Invalid ID, or the academic year is not in DRAFT status',
            ...validationErrorSchema,
          },
          401: { description: 'Authentication required', ...errorSchema },
          403: { description: 'Resource belongs to another school', ...errorSchema },
          404: {
            description: 'Relationship or grade not found, or not eligible for that grade',
            ...errorSchema,
          },
        },
      },
      preHandler: authMiddleware,
      handler: teacherSubjectGradeController.deleteEligibility.bind(teacherSubjectGradeController),
    }
  );
}
