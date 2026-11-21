import { type FastifyInstance } from 'fastify';
import { teacherController } from './teacher.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import {
  type CreateTeacherBody,
  type ListTeachersQuery,
  type TeacherIdParam,
  type UpdateTeacherBody,
} from './teacher.schema.js';

// Reusable Swagger schema fragments
const teacherDataSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    schoolId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    employeeCode: { type: 'string', nullable: true },
    isActive: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

// A teacher as listed by GET /api/teachers: the teacher fields plus their linked subjects
const teacherWithSubjectsSchema = {
  type: 'object',
  properties: {
    ...teacherDataSchema.properties,
    subjects: {
      type: 'array',
      description: 'The subjects this teacher is linked to, ordered by subject name; empty when there are none',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Subject ID' },
          name: { type: 'string' },
          code: { type: 'string' },
          type: { type: 'string', enum: ['PRIMARY', 'SECONDARY'], description: 'The link type' },
        },
      },
    },
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
    id: { type: 'string', format: 'uuid', description: 'Teacher UUID' },
  },
} as const;

export async function teacherRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------
  // POST /api/teachers — Create a teacher
  // ------------------------------------------------------------------
  app.post<{ Body: CreateTeacherBody }>('/teachers', {
    schema: {
      tags: ['Teacher'],
      summary: 'Create teacher',
      description:
        'Create a teacher in the authenticated admin\'s school. Teachers are school-level masters, ' +
        'so no academic-year status rule applies. employeeCode is optional; it is trimmed and ' +
        'uppercased (an empty value becomes null) and must be unique within the school when present.',
      security: [{ cookieAuth: [] }],
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, description: 'Teacher name (1-200 chars, trimmed)' },
          employeeCode: {
            type: 'string',
            nullable: true,
            description: 'Optional employee code (1-50 chars after normalisation, uppercase)',
          },
          isActive: { type: 'boolean', description: 'Defaults to true' },
        },
      },
      response: {
        201: {
          description: 'Teacher created successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: teacherDataSchema,
          },
        },
        400: { description: 'Validation error', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        409: { description: 'Employee code already exists in this school', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: teacherController.createTeacher.bind(teacherController),
  });

  // ------------------------------------------------------------------
  // POST /api/teachers/bulk — Create up to 100 teachers atomically and idempotently
  // ------------------------------------------------------------------
  app.post('/teachers/bulk', {
    schema: {
      tags: ['Teacher'],
      summary: 'Create teachers in bulk (atomic, idempotent)',
      description:
        'Create 1-100 teachers in the authenticated admin\'s school in ONE all-or-nothing operation. Each row follows POST /api/teachers ' +
        '(name 1-200 chars; optional employeeCode trimmed/uppercased/max 50, empty = none; optional isActive, default true). A repeated ' +
        'employeeCode inside the request is 400; one that already exists in the school is 409; both are keyed by row ("teachers.2.employeeCode") ' +
        'and nothing is written. The Idempotency-Key header (8-128 chars of letters, numbers . _ : -) is REQUIRED and is stored with the ' +
        'teachers in the same transaction: retrying the SAME key with the SAME body returns 200 with the original result ("replayed": true) ' +
        'and creates nothing; the SAME key with a DIFFERENT body is 409. Simultaneous requests with one key create the teachers once. A ' +
        'failed request stores nothing, so its key may be reused. Keys are scoped to the school. Teacher subjects and grade eligibility ' +
        'are separate calls, unchanged.',
      security: [{ cookieAuth: [] }],
      headers: {
        type: 'object',
        properties: { 'idempotency-key': { type: 'string', description: 'Required. 8-128 characters: letters, numbers, ".", "_", ":", "-"' } },
      },
      body: {
        type: 'object',
        required: ['teachers'],
        properties: {
          teachers: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: { type: 'object', description: '{ name, employeeCode?, isActive? }' },
          },
        },
      },
      response: {
        200: {
          description: 'Replay of an identical earlier request (header Idempotent-Replay: true); nothing was created',
          type: 'object',
          properties: { success: { type: 'boolean' }, message: { type: 'string' }, replayed: { type: 'boolean' }, data: { type: 'array', items: teacherDataSchema } },
        },
        201: {
          description: 'All teachers created',
          type: 'object',
          properties: { success: { type: 'boolean' }, message: { type: 'string' }, replayed: { type: 'boolean' }, data: { type: 'array', items: teacherDataSchema } },
        },
        400: { description: 'Validation error (row-specific) or missing/invalid Idempotency-Key', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        409: { description: 'Employee code exists (row-specific), or the key was used with a different body', ...validationErrorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: teacherController.createTeachersBulk.bind(teacherController),
  });

  // ------------------------------------------------------------------
  // GET /api/teachers — List teachers
  // ------------------------------------------------------------------
  app.get<{ Querystring: ListTeachersQuery }>('/teachers', {
    schema: {
      tags: ['Teacher'],
      summary: 'List teachers',
      description:
        'Return all teachers in the authenticated admin\'s school, ordered by name, each with a "subjects" array of the subjects they are linked to ' +
        '({ id, name, code, type: PRIMARY | SECONDARY }, ordered by subject name; [] when none). ' +
        'Use ?isActive=true or ?isActive=false to filter.',
      security: [{ cookieAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          isActive: { type: 'boolean', description: 'Filter by active / inactive teachers' },
        },
      },
      response: {
        200: {
          description: 'Teachers retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'array', items: teacherWithSubjectsSchema },
          },
        },
        400: { description: 'Invalid query parameter', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: teacherController.getTeachers.bind(teacherController),
  });

  // ------------------------------------------------------------------
  // GET /api/teachers/:id — Get a teacher
  // ------------------------------------------------------------------
  app.get<{ Params: TeacherIdParam }>('/teachers/:id', {
    schema: {
      tags: ['Teacher'],
      summary: 'Get teacher by ID',
      description: 'Retrieve a teacher. It must belong to the authenticated admin\'s school.',
      security: [{ cookieAuth: [] }],
      params: idParamsSchema,
      response: {
        200: {
          description: 'Teacher retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: teacherDataSchema,
          },
        },
        400: { description: 'Invalid teacher ID', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Teacher belongs to another school', ...errorSchema },
        404: { description: 'Teacher not found', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: teacherController.getTeacher.bind(teacherController),
  });

  // ------------------------------------------------------------------
  // PATCH /api/teachers/:id — Update a teacher
  // ------------------------------------------------------------------
  app.patch<{ Params: TeacherIdParam; Body: UpdateTeacherBody }>('/teachers/:id', {
    schema: {
      tags: ['Teacher'],
      summary: 'Update teacher',
      description:
        'Update a teacher\'s name, employeeCode and/or isActive. At least one field is required. ' +
        'Send employeeCode as null (or empty) to clear it. Changing isActive never modifies the ' +
        'teacher\'s existing subject or grade relationships. A teacher cannot move to another school.',
      security: [{ cookieAuth: [] }],
      params: idParamsSchema,
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, description: 'Teacher name (1-200 chars, trimmed)' },
          employeeCode: {
            type: 'string',
            nullable: true,
            description: 'Employee code, or null / empty to clear it',
          },
          isActive: { type: 'boolean' },
        },
      },
      response: {
        200: {
          description: 'Teacher updated successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: teacherDataSchema,
          },
        },
        400: { description: 'Validation error', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Teacher belongs to another school', ...errorSchema },
        404: { description: 'Teacher not found', ...errorSchema },
        409: { description: 'Employee code already exists in this school', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: teacherController.updateTeacher.bind(teacherController),
  });
}
