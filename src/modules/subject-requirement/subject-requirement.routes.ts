import { type FastifyInstance, type FastifySchemaCompiler } from 'fastify';
import { subjectRequirementController } from './subject-requirement.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import {
  type CreateSubjectRequirementBody,
  type ListSubjectRequirementsQuery,
  type SubjectRequirementIdParam,
  type UpdateSubjectRequirementBody,
} from './subject-requirement.schema.js';

// Strict, non-coercing validation for THIS module only.
//
// Fastify's default Ajv validator coerces types before the handler runs: "5", " 5 "
// and [5] become 5, and true becomes 1. periodsPerWeek is a scheduler input, so that
// is not acceptable. These routes therefore pass the raw request data straight through
// and the controller validates it with Zod, which is strict (a real JSON number that
// is an integer) and returns the standard field-level 400 errors. The JSON schemas
// below still drive the Swagger documentation. Modules 1-6 are unaffected: this
// compiler is attached to the Module 7 routes only.
const deferToZodValidator: FastifySchemaCompiler<unknown> = () => (data) => ({ value: data });

// Reusable Swagger schema fragments
const requirementDataSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    gradeId: { type: 'string', format: 'uuid' },
    streamId: { type: 'string', format: 'uuid', nullable: true },
    subjectId: { type: 'string', format: 'uuid' },
    periodsPerWeek: { type: 'integer', minimum: 1, maximum: 40 },
    isOptional: { type: 'boolean', description: 'A label: optional subjects are scheduled exactly like compulsory ones.' },
    sectionScope: { type: 'string', enum: ['ALL_SECTIONS', 'SELECTED_SECTIONS'], description: 'ALL_SECTIONS: every section of the grade/stream. SELECTED_SECTIONS: only sectionIds.' },
    sectionIds: { type: 'array', items: { type: 'string', format: 'uuid' }, description: 'The sections a SELECTED_SECTIONS requirement applies to (empty for ALL_SECTIONS).' },
    subject: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        code: { type: 'string' },
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
    id: { type: 'string', format: 'uuid', description: 'Subject requirement UUID' },
  },
} as const;

const periodsPerWeekDescription =
  'Required periods per week for this subject. Strict integer from 1 to 40: it must be a ' +
  'JSON number. Strings ("5"), booleans, arrays, decimals, 0, negatives and values above 40 ' +
  'are rejected with 400.';

export async function subjectRequirementRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------
  // POST /api/subject-requirements — Create a requirement
  // ------------------------------------------------------------------
  app.post<{ Body: CreateSubjectRequirementBody }>('/subject-requirements', {
    schema: {
      tags: ['Subject Requirement'],
      summary: 'Create subject requirement',
      description:
        'Define how many periods per week a subject needs for a grade (non-streamed grade) or for ' +
        'a stream of a grade (streamed grade). The grade\'s academic year must be DRAFT. ' +
        'A grade\'s mode comes from its sections when it has any (the Module 5 rule), otherwise ' +
        'from whether it has streams. A streamed grade requires streamId; a non-streamed grade ' +
        'must omit it. One requirement per (grade, subject) or (grade, stream, subject). ' +
        'By default every section of the grade/stream inherits the requirement (sectionScope ALL_SECTIONS); with sectionScope SELECTED_SECTIONS and sectionIds only those sections do ' +
        '(each must be in this grade and exactly this stream). isOptional (default false) is a label: optional subjects are scheduled like compulsory ones.',
      security: [{ cookieAuth: [] }],
      body: {
        type: 'object',
        required: ['gradeId', 'subjectId', 'periodsPerWeek'],
        properties: {
          gradeId: { type: 'string', format: 'uuid', description: 'Grade UUID' },
          streamId: {
            type: 'string',
            format: 'uuid',
            nullable: true,
            description: 'Stream UUID. Required for a streamed grade, must be omitted otherwise.',
          },
          subjectId: { type: 'string', format: 'uuid', description: 'Subject UUID' },
          periodsPerWeek: { type: 'integer', minimum: 1, maximum: 40, description: periodsPerWeekDescription },
          isOptional: { type: 'boolean', description: 'Label only; default false' },
          sectionScope: { type: 'string', enum: ['ALL_SECTIONS', 'SELECTED_SECTIONS'], description: 'Default ALL_SECTIONS' },
          sectionIds: { type: 'array', items: { type: 'string', format: 'uuid' }, description: 'Required (non-empty) for SELECTED_SECTIONS, omitted otherwise' },
        },
      },
      response: {
        201: {
          description: 'Subject requirement created successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: requirementDataSchema,
          },
        },
        400: {
          description:
            'Validation error, academic year not in DRAFT status, stream from another grade, or ' +
            'streamId missing/unexpected for the grade\'s mode',
          ...validationErrorSchema,
        },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Grade, stream or subject belongs to another school', ...errorSchema },
        404: { description: 'Grade, stream or subject not found', ...errorSchema },
        409: { description: 'A requirement for this subject already exists', ...errorSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: subjectRequirementController.createSubjectRequirement.bind(subjectRequirementController),
  });

  // ------------------------------------------------------------------
  // GET /api/subject-requirements — List requirements
  // ------------------------------------------------------------------
  app.get<{ Querystring: ListSubjectRequirementsQuery }>('/subject-requirements', {
    schema: {
      tags: ['Subject Requirement'],
      summary: 'List subject requirements',
      description:
        'Return the subject requirements of the authenticated admin\'s school, ordered by academic ' +
        'year (newest first), grade order, stream name and subject name. All filters are optional ' +
        'and each must belong to the admin\'s school. Allowed in any academic-year status. ' +
        'Not paginated.',
      security: [{ cookieAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          academicYearId: { type: 'string', format: 'uuid', description: 'Only this academic year' },
          gradeId: { type: 'string', format: 'uuid', description: 'Only this grade' },
          streamId: { type: 'string', format: 'uuid', description: 'Only this stream' },
        },
      },
      response: {
        200: {
          description: 'Subject requirements retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'array', items: requirementDataSchema },
          },
        },
        400: { description: 'Invalid filter value', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'A filter refers to another school\'s data', ...errorSchema },
        404: { description: 'A filter refers to an unknown academic year, grade or stream', ...errorSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: subjectRequirementController.getSubjectRequirements.bind(subjectRequirementController),
  });

  // ------------------------------------------------------------------
  // GET /api/subject-requirements/:id — Get one requirement
  // ------------------------------------------------------------------
  app.get<{ Params: SubjectRequirementIdParam }>('/subject-requirements/:id', {
    schema: {
      tags: ['Subject Requirement'],
      summary: 'Get subject requirement by ID',
      description:
        'Retrieve a requirement. Ownership is verified through requirement → grade → academic year ' +
        '→ school (and subject → school). Allowed in any academic-year status.',
      security: [{ cookieAuth: [] }],
      params: idParamsSchema,
      response: {
        200: {
          description: 'Subject requirement retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: requirementDataSchema,
          },
        },
        400: { description: 'Invalid subject requirement ID', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Requirement belongs to another school', ...errorSchema },
        404: { description: 'Subject requirement not found', ...errorSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: subjectRequirementController.getSubjectRequirement.bind(subjectRequirementController),
  });

  // ------------------------------------------------------------------
  // PATCH /api/subject-requirements/:id — Update periodsPerWeek
  // ------------------------------------------------------------------
  app.patch<{ Params: SubjectRequirementIdParam; Body: UpdateSubjectRequirementBody }>(
    '/subject-requirements/:id',
    {
      schema: {
        tags: ['Subject Requirement'],
        summary: 'Update subject requirement',
        description:
          'Change periodsPerWeek, isOptional and/or the section scope (grade, stream and subject are immutable). ' +
          'The academic year must be DRAFT. Restricting the scope (SELECTED_SECTIONS) is refused with 409 while teacher assignments exist for sections that would no longer have the subject.',
        security: [{ cookieAuth: [] }],
        params: idParamsSchema,
        body: {
          type: 'object',
          properties: {
            periodsPerWeek: { type: 'integer', minimum: 1, maximum: 40, description: periodsPerWeekDescription },
            isOptional: { type: 'boolean' },
            sectionScope: { type: 'string', enum: ['ALL_SECTIONS', 'SELECTED_SECTIONS'] },
            sectionIds: { type: 'array', items: { type: 'string', format: 'uuid' }, description: 'Required with SELECTED_SECTIONS; send sectionScope whenever sectionIds is sent' },
          },
        },
        response: {
          200: {
            description: 'Subject requirement updated successfully',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: requirementDataSchema,
            },
          },
          400: { description: 'Validation error, or the academic year is not in DRAFT status', ...validationErrorSchema },
          401: { description: 'Authentication required', ...errorSchema },
          403: { description: 'Requirement belongs to another school', ...errorSchema },
          404: { description: 'Subject requirement not found', ...errorSchema },
        },
      },
      validatorCompiler: deferToZodValidator,
      preHandler: authMiddleware,
      handler: subjectRequirementController.updateSubjectRequirement.bind(subjectRequirementController),
    }
  );

  // ------------------------------------------------------------------
  // DELETE /api/subject-requirements/:id — Delete a requirement
  // ------------------------------------------------------------------
  app.delete<{ Params: SubjectRequirementIdParam }>('/subject-requirements/:id', {
    schema: {
      tags: ['Subject Requirement'],
      summary: 'Delete subject requirement',
      description:
        'Delete a requirement. Only the requirement row is deleted; the subject, grade, stream and ' +
        'sections are untouched. The academic year must be DRAFT. Refused with 409 if teacher ' +
        'assignments reference the requirement (they are never cascade-deleted).',
      security: [{ cookieAuth: [] }],
      params: idParamsSchema,
      response: {
        200: {
          description: 'Subject requirement deleted successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'null', nullable: true },
          },
        },
        400: { description: 'Invalid ID, or the academic year is not in DRAFT status', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Requirement belongs to another school', ...errorSchema },
        404: { description: 'Subject requirement not found', ...errorSchema },
        409: { description: 'Teacher assignments reference this requirement', ...errorSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: subjectRequirementController.deleteSubjectRequirement.bind(subjectRequirementController),
  });
}
