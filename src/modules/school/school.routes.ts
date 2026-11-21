import { type FastifyInstance } from 'fastify';
import { schoolController } from './school.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { schoolCreationRateLimiter } from '../../middleware/rate-limit.middleware.js';
import { type CreateSchoolInput, type GetSchoolParams } from './school.schema.js';

export async function schoolRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/schools - Create a new school (BOOTSTRAP: kept public for initial setup)
  app.post<{ Body: CreateSchoolInput }>('/schools', {
    schema: {
      tags: ['School'],
      summary: 'Create a new school',
      description:
        'Create a new school (public endpoint for initial setup, rate-limited to 1 per client per 24 hours). The response carries a ONE-TIME setup token ' +
        'and its expiry: it is the only credential that lets the first admin register (POST /api/admin/register), it is shown here exactly once, and only its ' +
        'hash is stored, so keep it. It is single-use, valid for this school only, and expires (24 hours by default). The school and its token are created in ' +
        'one transaction. If the token expires unused, an operator can issue a new one with the recovery command (npm run setup-token); there is no public way.',
      body: {
        type: 'object',
        required: ['name', 'code', 'schoolType'],
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            description: 'School name',
          },
          code: {
            type: 'string',
            minLength: 1,
            maxLength: 50,
            pattern: '^[A-Z0-9_-]+$',
            description: 'Unique school code (uppercase letters, numbers, hyphens, underscores)',
          },
          schoolType: {
            type: 'string',
            enum: ['PRIMARY', 'SECONDARY', 'CUSTOM'],
            description: 'Type of school',
          },
        },
      },
      response: {
        201: {
          description: 'School created successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                code: { type: 'string' },
                schoolType: { type: 'string', enum: ['PRIMARY', 'SECONDARY', 'CUSTOM'] },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
                setupToken: { type: 'string', description: 'ONE-TIME token for registering the first admin. Shown only in this response; store it now.' },
                setupTokenExpiresAt: { type: 'string', format: 'date-time', description: 'When the setup token stops being valid' },
              },
            },
          },
        },
        400: {
          description: 'Validation error',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            errors: { type: 'object' },
          },
        },
        409: {
          description: 'School code already exists',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        429: {
          description: 'Rate limit exceeded',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
    preHandler: schoolCreationRateLimiter,
    handler: schoolController.createSchool.bind(schoolController),
  });

  // GET /api/schools/:id - Get school by ID (PROTECTED)
  app.get<{ Params: GetSchoolParams }>('/schools/:id', {
    schema: {
      tags: ['School'],
      summary: 'Get school by ID',
      description: 'Retrieve a school by ID (requires authentication)',
      security: [{ cookieAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'string',
            format: 'uuid',
            description: 'School UUID',
          },
        },
      },
      response: {
        200: {
          description: 'School retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                code: { type: 'string' },
                schoolType: { type: 'string', enum: ['PRIMARY', 'SECONDARY', 'CUSTOM'] },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
        401: {
          description: 'Authentication required',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        403: {
          description: 'Access denied',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        404: {
          description: 'School not found',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
    preHandler: authMiddleware,
    handler: schoolController.getSchool.bind(schoolController),
  });
}
