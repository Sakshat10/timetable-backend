import { type FastifyInstance } from 'fastify';
import { streamController } from './stream.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { type CreateStreamInput, type GradeIdParam, type StreamIdParam, type UpdateStreamInput } from './stream.schema.js';

// Reusable Swagger schema fragments
const streamDataSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    gradeId: { type: 'string', format: 'uuid' },
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

// 400 with validation errors — additionalProperties:true prevents Fastify
// response serialization from stripping dynamic error keys
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

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------
  // POST /api/streams — Create a stream
  // ------------------------------------------------------------------
  app.post<{ Body: CreateStreamInput }>('/streams', {
    schema: {
      tags: ['Stream'],
      summary: 'Create a stream',
      description:
        'Create a new stream for a grade. ' +
        'The grade must belong to the authenticated admin\'s school and its academic year must be DRAFT. ' +
        'Stream code is normalized to uppercase (SCI, sci, Sci → SCI).',
      security: [{ cookieAuth: [] }],
      body: {
        type: 'object',
        required: ['gradeId', 'name', 'code'],
        properties: {
          gradeId: {
            type: 'string',
            format: 'uuid',
            description: 'UUID of the grade this stream belongs to',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 100,
            description: 'Stream name (e.g. "Science", "Commerce", "Arts")',
          },
          code: {
            type: 'string',
            minLength: 1,
            maxLength: 20,
            description: 'Short stream code, normalized to uppercase (e.g. "SCI", "COM")',
          },
        },
      },
      response: {
        201: {
          description: 'Stream created successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: streamDataSchema,
          },
        },
        400: {
          description: 'Validation error or academic year not in DRAFT status',
          ...validationErrorSchema,
        },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Access denied — grade belongs to another school', ...errorSchema },
        404: { description: 'Grade not found', ...errorSchema },
        409: { description: 'Duplicate stream code or name within the grade', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: streamController.createStream.bind(streamController),
  });

  // ------------------------------------------------------------------
  // GET /api/grades/:gradeId/streams — List streams for a grade
  // ------------------------------------------------------------------
  app.get<{ Params: GradeIdParam }>('/grades/:gradeId/streams', {
    schema: {
      tags: ['Stream'],
      summary: 'List streams for a grade',
      description:
        'Return all streams belonging to the specified grade. ' +
        'Ownership is verified through grade → academic year → school.',
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
          description: 'Streams retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'array',
              items: streamDataSchema,
            },
          },
        },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Access denied', ...errorSchema },
        404: { description: 'Grade not found', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: streamController.getStreamsByGrade.bind(streamController),
  });

  // ------------------------------------------------------------------
  // GET /api/streams/:id — Get a stream by ID
  // ------------------------------------------------------------------
  app.get<{ Params: StreamIdParam }>('/streams/:id', {
    schema: {
      tags: ['Stream'],
      summary: 'Get stream by ID',
      description:
        'Retrieve a specific stream. ' +
        'Ownership is verified through stream → grade → academic year → school.',
      security: [{ cookieAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'string',
            format: 'uuid',
            description: 'Stream UUID',
          },
        },
      },
      response: {
        200: {
          description: 'Stream retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: streamDataSchema,
          },
        },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Access denied', ...errorSchema },
        404: { description: 'Stream not found', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: streamController.getStream.bind(streamController),
  });

  // ------------------------------------------------------------------
  // PATCH /api/streams/:id — Update a stream
  // ------------------------------------------------------------------
  app.patch<{ Params: StreamIdParam; Body: UpdateStreamInput }>('/streams/:id', {
    schema: {
      tags: ['Stream'],
      summary: 'Update a stream',
      description:
        'Update a stream\'s name and/or code. ' +
        'gradeId cannot be changed. ' +
        'Academic year must be DRAFT. ' +
        'Code is normalized to uppercase.',
      security: [{ cookieAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'string',
            format: 'uuid',
            description: 'Stream UUID',
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
            description: 'New stream name',
          },
          code: {
            type: 'string',
            minLength: 1,
            maxLength: 20,
            description: 'New stream code (normalized to uppercase)',
          },
        },
      },
      response: {
        200: {
          description: 'Stream updated successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: streamDataSchema,
          },
        },
        400: {
          description: 'Validation error, empty update, or academic year not in DRAFT status',
          ...validationErrorSchema,
        },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Access denied', ...errorSchema },
        404: { description: 'Stream not found', ...errorSchema },
        409: { description: 'Duplicate stream code or name', ...errorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: streamController.updateStream.bind(streamController),
  });
}
