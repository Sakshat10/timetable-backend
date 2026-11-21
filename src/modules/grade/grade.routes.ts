import { type FastifyInstance } from 'fastify';
import { gradeController } from './grade.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { type CreateGradeInput, type GetGradeParams, type GetGradesQuery, type UpdateGradeInput } from './grade.schema.js';

const bulkErrorSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    errors: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
  },
} as const;

export async function gradeRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/grades/bulk - Create grades with their streams and sections, atomically
  app.post('/grades/bulk', {
    schema: {
      tags: ['Grade'],
      summary: 'Create grades with streams and sections (bulk, atomic)',
      description:
        'Create up to 20 grades for one academic year, each with its streams (up to 10) and sections (up to 30; 200 sections per request), ' +
        'in ONE all-or-nothing transaction: either the whole structure is created or nothing is. The academic year must belong to your school ' +
        'and be DRAFT. Every field follows the single-record endpoints (POST /api/grades, /streams, /sections). Rules: grade name and ' +
        'displayOrder unique (in the request and in the year); stream code (case-insensitive) and name unique per grade; section code unique ' +
        'per (grade, stream); a grade is streamed or not, never mixed: if any section has a "streamCode" every section of that grade must, and it ' +
        'must name a stream declared in that grade; streams may be declared without sections. Request rule violations are 400 and conflicts with ' +
        'existing grades are 409, both with "errors" keyed by row ("grades.0.sections.2.streamCode"). The response nests streams and sections under ' +
        'each grade, with ids.',
      security: [{ cookieAuth: [] }],
      body: {
        type: 'object',
        required: ['academicYearId', 'grades'],
        properties: {
          academicYearId: { type: 'string', format: 'uuid', description: 'Academic year UUID (DRAFT, your school)' },
          grades: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: { type: 'object', description: '{ name, displayOrder, streams?: [{ name, code }], sections?: [{ name, code, streamCode? }] }' },
          },
        },
      },
      response: {
        201: {
          description: 'Whole structure created',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                academicYearId: { type: 'string', format: 'uuid' },
                grades: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                      streams: { type: 'array', items: { type: 'object', additionalProperties: true } },
                      sections: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    },
                  },
                },
              },
            },
          },
        },
        400: { description: 'Validation error or academic year is not DRAFT (row-specific errors)', ...bulkErrorSchema },
        401: { description: 'Authentication required', ...bulkErrorSchema },
        403: { description: 'Academic year belongs to another school', ...bulkErrorSchema },
        404: { description: 'Academic year not found', ...bulkErrorSchema },
        409: { description: 'Grade name or display order already exists (row-specific); nothing created', ...bulkErrorSchema },
      },
    },
    preHandler: authMiddleware,
    handler: gradeController.createGradeStructure.bind(gradeController),
  });

  // POST /api/grades - Create grade
  app.post<{ Body: CreateGradeInput }>('/grades', {
    schema: {
      tags: ['Grade'],
      summary: 'Create grade',
      description: 'Create a new grade for an academic year (requires authentication, academic year must be DRAFT)',
      security: [{ cookieAuth: [] }],
      body: {
        type: 'object',
        required: ['academicYearId', 'name', 'displayOrder'],
        properties: {
          academicYearId: {
            type: 'string',
            format: 'uuid',
            description: 'Academic year UUID',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 100,
            description: 'Grade name (e.g., "Grade 6", "Nursery", "LKG")',
          },
          displayOrder: {
            type: 'integer',
            minimum: 1,
            description: 'Display order (positive integer, must be unique within academic year)',
          },
        },
      },
      response: {
        201: {
          description: 'Grade created successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                academicYearId: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                displayOrder: { type: 'integer' },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
        400: {
          description: 'Validation error or academic year not in DRAFT status',
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
          description: 'Duplicate name or display order',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
    preHandler: authMiddleware,
    handler: gradeController.createGrade.bind(gradeController),
  });

  // GET /api/grades - List grades
  app.get<{ Querystring: GetGradesQuery }>('/grades', {
    schema: {
      tags: ['Grade'],
      summary: 'List grades',
      description: 'Get all grades for authenticated admin\'s school (requires authentication)',
      security: [{ cookieAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          academicYearId: {
            type: 'string',
            format: 'uuid',
            description: 'Optional filter by academic year',
          },
        },
      },
      response: {
        200: {
          description: 'Grades retrieved successfully',
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
                  academicYearId: { type: 'string', format: 'uuid' },
                  name: { type: 'string' },
                  displayOrder: { type: 'integer' },
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
        403: {
          description: 'Access denied (if filtering by academic year from another school)',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
    preHandler: authMiddleware,
    handler: gradeController.getGrades.bind(gradeController),
  });

  // GET /api/grades/:id - Get grade by ID
  app.get<{ Params: GetGradeParams }>('/grades/:id', {
    schema: {
      tags: ['Grade'],
      summary: 'Get grade by ID',
      description: 'Retrieve a specific grade (requires authentication)',
      security: [{ cookieAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'string',
            format: 'uuid',
            description: 'Grade UUID',
          },
        },
      },
      response: {
        200: {
          description: 'Grade retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                academicYearId: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                displayOrder: { type: 'integer' },
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
          description: 'Grade not found',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
    preHandler: authMiddleware,
    handler: gradeController.getGrade.bind(gradeController),
  });

  // PATCH /api/grades/:id - Update grade
  app.patch<{ Params: GetGradeParams; Body: UpdateGradeInput }>('/grades/:id', {
    schema: {
      tags: ['Grade'],
      summary: 'Update grade',
      description: 'Update a grade (requires authentication, academic year must be DRAFT)',
      security: [{ cookieAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'string',
            format: 'uuid',
            description: 'Grade UUID',
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
            description: 'Grade name',
          },
          displayOrder: {
            type: 'integer',
            minimum: 1,
            description: 'Display order (positive integer)',
          },
        },
      },
      response: {
        200: {
          description: 'Grade updated successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                academicYearId: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                displayOrder: { type: 'integer' },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
        400: {
          description: 'Validation error, empty update, or academic year not in DRAFT status',
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
          description: 'Grade not found',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        409: {
          description: 'Duplicate name or display order',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
    preHandler: authMiddleware,
    handler: gradeController.updateGrade.bind(gradeController),
  });
}
