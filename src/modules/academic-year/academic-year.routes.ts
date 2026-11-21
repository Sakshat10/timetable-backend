import { type FastifyInstance } from 'fastify';
import { academicYearController } from './academic-year.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { type CreateAcademicYearInput, type GetAcademicYearParams, type UpdateAcademicYearInput } from './academic-year.schema.js';

export async function academicYearRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/academic-years - Create academic year
  app.post<{ Body: CreateAcademicYearInput }>('/academic-years', {
    schema: {
      tags: ['Academic Year'],
      summary: 'Create academic year',
      description: 'Create a new academic year for authenticated admin\'s school (requires authentication)',
      security: [{ cookieAuth: [] }],
      body: {
        type: 'object',
        required: ['name', 'startDate', 'endDate'],
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 50,
            description: 'Academic year name',
          },
          startDate: {
            type: 'string',
            format: 'date',
            description: 'Start date (ISO 8601)',
          },
          endDate: {
            type: 'string',
            format: 'date',
            description: 'End date (ISO 8601, must be after start date)',
          },
        },
      },
      response: {
        201: {
          description: 'Academic year created successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                schoolId: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                startDate: { type: 'string', format: 'date-time' },
                endDate: { type: 'string', format: 'date-time' },
                status: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'COMPLETED'] },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
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
        409: {
          description: 'Academic year already exists',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
    preHandler: authMiddleware,
    handler: academicYearController.createAcademicYear.bind(academicYearController),
  });

  // GET /api/academic-years - List academic years
  app.get('/academic-years', {
    schema: {
      tags: ['Academic Year'],
      summary: 'List academic years',
      description: 'Get all academic years for authenticated admin\'s school (requires authentication)',
      security: [{ cookieAuth: [] }],
      response: {
        200: {
          description: 'Academic years retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  schoolId: { type: 'string', format: 'uuid' },
                  name: { type: 'string' },
                  startDate: { type: 'string', format: 'date-time' },
                  endDate: { type: 'string', format: 'date-time' },
                  status: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'COMPLETED'] },
                  createdAt: { type: 'string', format: 'date-time' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
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
      },
    },
    preHandler: authMiddleware,
    handler: academicYearController.getAcademicYears.bind(academicYearController),
  });

  // GET /api/academic-years/:id - Get academic year by ID
  app.get<{ Params: GetAcademicYearParams }>('/academic-years/:id', {
    schema: {
      tags: ['Academic Year'],
      summary: 'Get academic year by ID',
      description: 'Retrieve a specific academic year (requires authentication)',
      security: [{ cookieAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'string',
            format: 'uuid',
            description: 'Academic year UUID',
          },
        },
      },
      response: {
        200: {
          description: 'Academic year retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                schoolId: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                startDate: { type: 'string', format: 'date-time' },
                endDate: { type: 'string', format: 'date-time' },
                status: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'COMPLETED'] },
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
          description: 'Academic year not found',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
    preHandler: authMiddleware,
    handler: academicYearController.getAcademicYear.bind(academicYearController),
  });

  // PATCH /api/academic-years/:id - Update academic year
  app.patch<{ Params: GetAcademicYearParams; Body: UpdateAcademicYearInput }>('/academic-years/:id', {
    schema: {
      tags: ['Academic Year'],
      summary: 'Update academic year',
      description: 'Update an academic year (requires authentication)',
      security: [{ cookieAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'string',
            format: 'uuid',
            description: 'Academic year UUID',
          },
        },
      },
      body: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 50,
            description: 'Academic year name',
          },
          startDate: {
            type: 'string',
            format: 'date',
            description: 'Start date (ISO 8601)',
          },
          endDate: {
            type: 'string',
            format: 'date',
            description: 'End date (ISO 8601)',
          },
          status: {
            type: 'string',
            enum: ['DRAFT', 'ACTIVE', 'COMPLETED'],
            description: 'Academic year status (DRAFT → ACTIVE → COMPLETED)',
          },
        },
      },
      response: {
        200: {
          description: 'Academic year updated successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                schoolId: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                startDate: { type: 'string', format: 'date-time' },
                endDate: { type: 'string', format: 'date-time' },
                status: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'COMPLETED'] },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
        400: {
          description: 'Validation error or invalid status transition',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
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
          description: 'Academic year not found',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        409: {
          description: 'Duplicate academic year name',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
    preHandler: authMiddleware,
    handler: academicYearController.updateAcademicYear.bind(academicYearController),
  });
}
