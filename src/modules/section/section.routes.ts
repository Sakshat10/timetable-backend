import { type FastifyInstance } from 'fastify';
import { sectionController } from './section.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { type CreateSectionInput, type GradeIdParam, type SectionIdParam, type UpdateSectionInput } from './section.schema.js';

// Reusable stream sub-object (nullable)
const streamSubSchema = {
  type: 'object',
  nullable: true,
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    code: { type: 'string' },
  },
} as const;

// Section data returned by all endpoints (includes stream sub-object)
const sectionDataSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    gradeId: { type: 'string', format: 'uuid' },
    streamId: { type: 'string', format: 'uuid', nullable: true },
    name: { type: 'string' },
    code: { type: 'string' },
    stream: streamSubSchema,
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

// 400 with dynamic validation error keys — additionalProperties prevents stripping
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

export async function sectionRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------
  // POST /api/sections — Create a section
  // ------------------------------------------------------------------
  app.post<{ Body: CreateSectionInput }>('/sections', {
    schema: {
      tags: ['Section'],
      summary: 'Create a section',
      description:
        'Create a new section for a grade, optionally within a stream. ' +
        'A grade must not mix streamed and non-streamed sections. ' +
        'If streamId is provided, the stream must belong to the same grade. ' +
        'Academic year must be DRAFT.',
      security: [{ cookieAuth: [] }],
      body: {
        type: 'object',
        required: ['gradeId', 'name', 'code'],
        properties: {
          gradeId: {
            type: 'string',
            format: 'uuid',
            description: 'UUID of the grade this section belongs to',
          },
          streamId: {
            type: 'string',
            format: 'uuid',
            nullable: true,
            description:
              'UUID of the stream (omit or null for non-streamed grades). ' +
              'The stream must belong to the same grade.',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 100,
            description: 'Section name (e.g. "Section A", "A")',
          },
          code: {
            type: 'string',
            minLength: 1,
            maxLength: 20,
            description: 'Short section code (e.g. "A", "B"). Unique within grade+stream context.',
          },
        },
      },
      response: {
        201: {
          description: 'Section created successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: sectionDataSchema,
          },
        },
        400: {
          description:
            'Validation error, academic year not DRAFT, stream/grade mismatch, or mixing rule violation',
          ...validationErrorSchema,
        },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Access denied — grade or stream belongs to another school', ...errorSchema },
        404: { description: 'Grade or stream not found', ...errorSchema },
        409: { description: 'Duplicate section code within grade/stream context', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: sectionController.createSection.bind(sectionController),
  });

  // ------------------------------------------------------------------
  // GET /api/grades/:gradeId/sections — List sections for a grade
  // ------------------------------------------------------------------
  app.get<{ Params: GradeIdParam }>('/grades/:gradeId/sections', {
    schema: {
      tags: ['Section'],
      summary: 'List sections for a grade',
      description:
        'Return all sections for the specified grade. ' +
        'For streamed grades, results include stream information. ' +
        'Ordered by stream name then section code.',
      security: [{ cookieAuth: [] }],
      params: {
        type: 'object',
        required: ['gradeId'],
        properties: {
          gradeId: {
            type: 'string',
            format: 'uuid',
            description: 'Grade UUID',
          },
        },
      },
      response: {
        200: {
          description: 'Sections retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'array',
              items: sectionDataSchema,
            },
          },
        },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Access denied', ...errorSchema },
        404: { description: 'Grade not found', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: sectionController.getSectionsByGrade.bind(sectionController),
  });

  // ------------------------------------------------------------------
  // GET /api/sections/:id — Get a section by ID
  // ------------------------------------------------------------------
  app.get<{ Params: SectionIdParam }>('/sections/:id', {
    schema: {
      tags: ['Section'],
      summary: 'Get section by ID',
      description:
        'Retrieve a specific section. ' +
        'Ownership verified through section → grade → academic year → school.',
      security: [{ cookieAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'string',
            format: 'uuid',
            description: 'Section UUID',
          },
        },
      },
      response: {
        200: {
          description: 'Section retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: sectionDataSchema,
          },
        },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Access denied', ...errorSchema },
        404: { description: 'Section not found', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: sectionController.getSection.bind(sectionController),
  });

  // ------------------------------------------------------------------
  // PATCH /api/sections/:id — Update a section
  // ------------------------------------------------------------------
  app.patch<{ Params: SectionIdParam; Body: UpdateSectionInput }>('/sections/:id', {
    schema: {
      tags: ['Section'],
      summary: 'Update a section',
      description:
        'Update a section\'s name and/or code. ' +
        'gradeId and streamId cannot be changed. ' +
        'Academic year must be DRAFT.',
      security: [{ cookieAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'string',
            format: 'uuid',
            description: 'Section UUID',
          },
        },
      },
      body: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 100,
            description: 'New section name',
          },
          code: {
            type: 'string',
            minLength: 1,
            maxLength: 20,
            description: 'New section code (must be unique within grade+stream context)',
          },
        },
      },
      response: {
        200: {
          description: 'Section updated successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: sectionDataSchema,
          },
        },
        400: {
          description: 'Validation error, empty update, or academic year not in DRAFT status',
          ...validationErrorSchema,
        },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Access denied', ...errorSchema },
        404: { description: 'Section not found', ...errorSchema },
        409: { description: 'Duplicate section code within grade/stream context', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: sectionController.updateSection.bind(sectionController),
  });
}
