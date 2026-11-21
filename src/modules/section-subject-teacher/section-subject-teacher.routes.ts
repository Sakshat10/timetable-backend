import { type FastifyInstance, type FastifySchemaCompiler } from 'fastify';
import { sectionSubjectTeacherController } from './section-subject-teacher.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import {
  type CreateSectionSubjectTeacherBody,
  type ListSectionSubjectTeachersQuery,
  type SectionSubjectTeacherIdParam,
  type UpdateSectionSubjectTeacherBody,
} from './section-subject-teacher.schema.js';

// Validation is done entirely by Zod in the controller, which returns field-level 400 errors in
// the standard envelope and lets PATCH reject immutable fields (sectionId, subjectRequirementId)
// with a clear message instead of Fastify's Ajv silently coercing or stripping them. The JSON
// schemas below still drive the Swagger documentation. Attached to the Module 8 routes only.
const deferToZodValidator: FastifySchemaCompiler<unknown> = () => (data) => ({ value: data });

// Reusable Swagger schema fragments
const assignmentDataSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    sectionId: { type: 'string', format: 'uuid' },
    subjectRequirementId: { type: 'string', format: 'uuid' },
    teacherId: { type: 'string', format: 'uuid' },
    section: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        code: { type: 'string' },
      },
    },
    grade: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        displayOrder: { type: 'integer' },
        academicYearId: { type: 'string', format: 'uuid' },
      },
    },
    stream: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        code: { type: 'string' },
      },
    },
    subject: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        code: { type: 'string' },
      },
    },
    subjectRequirement: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        periodsPerWeek: { type: 'integer' },
      },
    },
    teacher: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        employeeCode: { type: 'string', nullable: true },
        isActive: { type: 'boolean' },
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

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid', description: 'Section subject teacher assignment UUID' },
  },
} as const;

export async function sectionSubjectTeacherRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------
  // POST /api/section-subject-teachers — Assign a teacher
  // ------------------------------------------------------------------
  app.post<{ Body: CreateSectionSubjectTeacherBody }>('/section-subject-teachers', {
    schema: {
      tags: ['Section Subject Teacher'],
      summary: 'Assign teacher to section subject',
      description:
        'Record that a teacher teaches a subject (identified by its subject requirement) to a ' +
        'section. This is configuration only: no day, period, workload or availability is involved, ' +
        'and a teacher may be assigned to any number of sections. The section\'s academic year ' +
        'must be DRAFT. The requirement must match the section\'s grade and exactly its stream ' +
        '(none = none). The teacher must be in the same school, active, linked to the subject ' +
        '(TeacherSubject) and eligible for the section\'s grade (TeacherSubjectGrade). One teacher ' +
        'per section + requirement.',
      security: [{ cookieAuth: [] }],
      body: {
        type: 'object',
        required: ['sectionId', 'subjectRequirementId', 'teacherId'],
        properties: {
          sectionId: { type: 'string', format: 'uuid', description: 'Section UUID' },
          subjectRequirementId: { type: 'string', format: 'uuid', description: 'Subject requirement UUID' },
          teacherId: { type: 'string', format: 'uuid', description: 'Teacher UUID' },
        },
      },
      response: {
        201: {
          description: 'Teacher assigned successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: assignmentDataSchema,
          },
        },
        400: {
          description:
            'Validation error; academic year not in DRAFT status; requirement grade/stream does not ' +
            'match the section; teacher inactive, not linked to the subject, or not eligible for the grade',
          ...validationErrorSchema,
        },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Section, requirement or teacher belongs to another school', ...errorSchema },
        404: { description: 'Section, requirement or teacher not found', ...errorSchema },
        409: { description: 'This section already has a teacher for this requirement', ...errorSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: sectionSubjectTeacherController.createAssignment.bind(sectionSubjectTeacherController),
  });

  // ------------------------------------------------------------------
  // GET /api/section-subject-teachers — List assignments
  // ------------------------------------------------------------------
  app.get<{ Querystring: ListSectionSubjectTeachersQuery }>('/section-subject-teachers', {
    schema: {
      tags: ['Section Subject Teacher'],
      summary: 'List section subject teacher assignments',
      description:
        'Return the assignments of the authenticated admin\'s school, ordered by academic year ' +
        '(newest first), grade order, section and subject. Filters (all optional, combinable, each ' +
        'must belong to the admin\'s school): academicYearId, gradeId, sectionId (everything for a ' +
        'section), subjectId (everything for a subject), teacherId (everything for a teacher). ' +
        'Allowed in any academic-year status. Assignments whose teacher has since been deactivated ' +
        'are still listed, with teacher.isActive = false. Not paginated.',
      security: [{ cookieAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          academicYearId: { type: 'string', format: 'uuid', description: 'Only this academic year' },
          gradeId: { type: 'string', format: 'uuid', description: 'Only this grade' },
          sectionId: { type: 'string', format: 'uuid', description: 'Only this section' },
          subjectId: { type: 'string', format: 'uuid', description: 'Only this subject' },
          teacherId: { type: 'string', format: 'uuid', description: 'Only this teacher' },
        },
      },
      response: {
        200: {
          description: 'Assignments retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'array', items: assignmentDataSchema },
          },
        },
        400: { description: 'Invalid filter value', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'A filter refers to another school\'s data', ...errorSchema },
        404: { description: 'A filter refers to an unknown academic year, grade, section, subject or teacher', ...errorSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: sectionSubjectTeacherController.getAssignments.bind(sectionSubjectTeacherController),
  });

  // ------------------------------------------------------------------
  // GET /api/section-subject-teachers/:id — Get one assignment
  // ------------------------------------------------------------------
  app.get<{ Params: SectionSubjectTeacherIdParam }>('/section-subject-teachers/:id', {
    schema: {
      tags: ['Section Subject Teacher'],
      summary: 'Get assignment by ID',
      description:
        'Retrieve an assignment. Ownership is verified through the section, the requirement (and its ' +
        'subject) and the teacher. Allowed in any academic-year status, and returns assignments whose ' +
        'teacher is now inactive.',
      security: [{ cookieAuth: [] }],
      params: idParamsSchema,
      response: {
        200: {
          description: 'Assignment retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: assignmentDataSchema,
          },
        },
        400: { description: 'Invalid assignment ID', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Assignment belongs to another school', ...errorSchema },
        404: { description: 'Assignment not found', ...errorSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: sectionSubjectTeacherController.getAssignment.bind(sectionSubjectTeacherController),
  });

  // ------------------------------------------------------------------
  // PATCH /api/section-subject-teachers/:id — Change the teacher
  // ------------------------------------------------------------------
  app.patch<{ Params: SectionSubjectTeacherIdParam; Body: UpdateSectionSubjectTeacherBody }>(
    '/section-subject-teachers/:id',
    {
      schema: {
        tags: ['Section Subject Teacher'],
        summary: 'Change assignment teacher',
        description:
          'Change the assigned teacher, the only mutable field. sectionId and subjectRequirementId ' +
          'cannot be changed (they are rejected with 400): delete and re-create instead. Every patch ' +
          're-validates the resulting assignment, even when teacherId is unchanged: DRAFT academic ' +
          'year, and the teacher must be in the same school, active, linked to the subject and ' +
          'eligible for the section\'s grade. Patching an assignment with its own teacher after that ' +
          'teacher was deactivated (or lost eligibility) therefore returns 400.',
        security: [{ cookieAuth: [] }],
        params: idParamsSchema,
        body: {
          type: 'object',
          required: ['teacherId'],
          properties: {
            teacherId: { type: 'string', format: 'uuid', description: 'Teacher UUID' },
          },
        },
        response: {
          200: {
            description: 'Assignment updated successfully',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: assignmentDataSchema,
            },
          },
          400: {
            description:
              'Validation error, immutable field supplied, academic year not DRAFT, or the teacher is ' +
              'inactive / not linked to the subject / not eligible for the grade',
            ...validationErrorSchema,
          },
          401: { description: 'Authentication required', ...errorSchema },
          403: { description: 'Assignment or teacher belongs to another school', ...errorSchema },
          404: { description: 'Assignment or teacher not found', ...errorSchema },
        },
      },
      validatorCompiler: deferToZodValidator,
      preHandler: authMiddleware,
      handler: sectionSubjectTeacherController.updateAssignment.bind(sectionSubjectTeacherController),
    }
  );

  // ------------------------------------------------------------------
  // DELETE /api/section-subject-teachers/:id — Remove the assignment
  // ------------------------------------------------------------------
  app.delete<{ Params: SectionSubjectTeacherIdParam }>('/section-subject-teachers/:id', {
    schema: {
      tags: ['Section Subject Teacher'],
      summary: 'Delete assignment',
      description:
        'Remove the assignment row only. The section, grade, stream, subject, teacher, subject ' +
        'requirement and teacher eligibility are untouched. The academic year must be DRAFT.',
      security: [{ cookieAuth: [] }],
      params: idParamsSchema,
      response: {
        200: {
          description: 'Assignment deleted successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'null', nullable: true },
          },
        },
        400: { description: 'Invalid ID, or the academic year is not in DRAFT status', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Assignment belongs to another school', ...errorSchema },
        404: { description: 'Assignment not found', ...errorSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: sectionSubjectTeacherController.deleteAssignment.bind(sectionSubjectTeacherController),
  });
}
