import { type FastifyInstance } from 'fastify';
import { subjectController } from './subject.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import {
  type CreateSubjectBody,
  type SubjectIdParam,
  type UpdateSubjectBody,
} from './subject.schema.js';

// Reusable Swagger schema fragments
const subjectDataSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    schoolId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    code: { type: 'string' },
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
    id: { type: 'string', format: 'uuid', description: 'Subject UUID' },
  },
} as const;

export async function subjectRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------
  // POST /api/subjects — Create a subject
  // ------------------------------------------------------------------
  app.post<{ Body: CreateSubjectBody }>('/subjects', {
    schema: {
      tags: ['Subject'],
      summary: 'Create subject',
      description:
        'Create a subject in the authenticated admin\'s school. Subjects are school-level ' +
        'masters, so no academic-year status rule applies. The code is trimmed and uppercased, ' +
        'and must be unique within the school.',
      security: [{ cookieAuth: [] }],
      body: {
        type: 'object',
        required: ['name', 'code'],
        properties: {
          name: { type: 'string', minLength: 1, description: 'Display name (1-100 chars, trimmed)' },
          code: {
            type: 'string',
            minLength: 1,
            description:
              'Short code (1-20 chars; letters, numbers, hyphen, underscore). Normalised to uppercase.',
          },
        },
      },
      response: {
        201: {
          description: 'Subject created successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: subjectDataSchema,
          },
        },
        400: { description: 'Validation error', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        409: { description: 'Subject code already exists in this school', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: subjectController.createSubject.bind(subjectController),
  });

  // ------------------------------------------------------------------
  // POST /api/subjects/bulk — Create up to 100 subjects atomically
  // ------------------------------------------------------------------
  app.post('/subjects/bulk', {
    schema: {
      tags: ['Subject'],
      summary: 'Create subjects in bulk (atomic)',
      description:
        'Create 1-100 subjects in the authenticated admin\'s school in ONE all-or-nothing operation: either every subject is ' +
        'created or none is. Each row follows the same rules as POST /api/subjects (name 1-100 chars; code trimmed, uppercased, ' +
        '1-20 chars). A code repeated inside the request is 400; a code that already exists in the school is 409. Both return ' +
        '"errors" keyed by row, e.g. "subjects.2.code". Nothing is written when any row fails. Not idempotent: a retry after an ' +
        'ambiguous timeout is safe because codes are unique (the retry reports 409 for rows that were already created).',
      security: [{ cookieAuth: [] }],
      body: {
        type: 'object',
        required: ['subjects'],
        properties: {
          subjects: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: { type: 'object', description: '{ name, code }' },
          },
        },
      },
      response: {
        201: {
          description: 'All subjects created',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'array', items: subjectDataSchema },
          },
        },
        400: { description: 'Validation error (row-specific)', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        409: { description: 'One or more codes already exist (row-specific); nothing created', ...validationErrorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: subjectController.createSubjectsBulk.bind(subjectController),
  });

  // ------------------------------------------------------------------
  // GET /api/subjects — List subjects
  // ------------------------------------------------------------------
  app.get('/subjects', {
    schema: {
      tags: ['Subject'],
      summary: 'List subjects',
      description: 'Return all subjects in the authenticated admin\'s school, ordered by name.',
      security: [{ cookieAuth: [] }],
      response: {
        200: {
          description: 'Subjects retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'array', items: subjectDataSchema },
          },
        },
        401: { description: 'Authentication required', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: subjectController.getSubjects.bind(subjectController),
  });

  // ------------------------------------------------------------------
  // GET /api/subjects/:id — Get a subject
  // ------------------------------------------------------------------
  app.get<{ Params: SubjectIdParam }>('/subjects/:id', {
    schema: {
      tags: ['Subject'],
      summary: 'Get subject by ID',
      description: 'Retrieve a subject. It must belong to the authenticated admin\'s school.',
      security: [{ cookieAuth: [] }],
      params: idParamsSchema,
      response: {
        200: {
          description: 'Subject retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: subjectDataSchema,
          },
        },
        400: { description: 'Invalid subject ID', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Subject belongs to another school', ...errorSchema },
        404: { description: 'Subject not found', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: subjectController.getSubject.bind(subjectController),
  });

  // ------------------------------------------------------------------
  // PATCH /api/subjects/:id — Update a subject
  // ------------------------------------------------------------------
  app.patch<{ Params: SubjectIdParam; Body: UpdateSubjectBody }>('/subjects/:id', {
    schema: {
      tags: ['Subject'],
      summary: 'Update subject',
      description:
        'Update a subject\'s name and/or code. At least one field is required. ' +
        'A subject cannot be moved to another school.',
      security: [{ cookieAuth: [] }],
      params: idParamsSchema,
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, description: 'Display name (1-100 chars, trimmed)' },
          code: {
            type: 'string',
            minLength: 1,
            description: 'Short code (1-20 chars). Normalised to uppercase.',
          },
        },
      },
      response: {
        200: {
          description: 'Subject updated successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: subjectDataSchema,
          },
        },
        400: { description: 'Validation error', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Subject belongs to another school', ...errorSchema },
        404: { description: 'Subject not found', ...errorSchema },
        409: { description: 'Subject code already exists in this school', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: subjectController.updateSubject.bind(subjectController),
  });
}
