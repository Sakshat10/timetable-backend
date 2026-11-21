import { type FastifyInstance, type FastifySchemaCompiler } from 'fastify';
import { timetableFeasibilityController } from './timetable-feasibility.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { ERROR_CODES, WARNING_CODES, type FeasibilityQueryBody } from './timetable-feasibility.schema.js';

// Validation is done by Zod in the controller (field-level 400 errors in the standard envelope),
// consistent with Modules 7-9. The JSON schemas below drive the Swagger documentation and the
// response serializer. Attached to this route only.
const deferToZodValidator: FastifySchemaCompiler<unknown> = () => (data) => ({ value: data });

const entitySchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    id: { type: 'string', nullable: true },
    label: { type: 'string' },
  },
} as const;

// details is free-form per issue code, so it must keep arbitrary keys when serialized.
const issueSchema = {
  type: 'object',
  properties: {
    code: { type: 'string', enum: [...ERROR_CODES, ...WARNING_CODES] },
    severity: { type: 'string', enum: ['ERROR', 'WARNING'] },
    message: { type: 'string' },
    hint: { type: 'string', description: 'What the admin can do about it' },
    entity: entitySchema,
    details: { type: 'object', additionalProperties: true },
  },
} as const;

const errorSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
  },
} as const;

const validationErrorSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    errors: {
      type: 'object',
      additionalProperties: { type: 'array', items: { type: 'string' } },
    },
  },
} as const;

const reportSchema = {
  type: 'object',
  properties: {
    academicYear: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        status: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'COMPLETED'] },
      },
    },
    status: { type: 'string', enum: ['READY', 'NOT_READY'] },
    statusMeaning: { type: 'string' },
    generatedAt: { type: 'string', format: 'date-time' },
    limits: {
      type: 'object',
      properties: {
        maxTeacherPeriodsPerWeek: { type: 'integer' },
        weeklySlots: { type: 'integer', nullable: true },
        effectiveTeacherCapacity: { type: 'integer' },
      },
    },
    summary: {
      type: 'object',
      properties: {
        workingDays: { type: 'integer' },
        periodsPerDay: { type: 'integer' },
        weeklySlots: { type: 'integer', nullable: true },
        grades: { type: 'integer' },
        sections: { type: 'integer' },
        requirements: { type: 'integer' },
        assignments: { type: 'integer' },
        totalDemandPeriods: { type: 'integer' },
        assignedPeriods: { type: 'integer' },
        unassignedPeriods: { type: 'integer' },
        teachersWithAssignments: { type: 'integer' },
        errorCount: { type: 'integer' },
        warningCount: { type: 'integer' },
      },
    },
    errors: { type: 'array', items: issueSchema },
    warnings: { type: 'array', items: issueSchema },
    breakdown: {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              gradeId: { type: 'string' },
              gradeName: { type: 'string' },
              streamId: { type: 'string', nullable: true },
              streamName: { type: 'string', nullable: true },
              requirementCount: { type: 'integer' },
              demandPeriods: { type: 'integer' },
              assignedPeriods: { type: 'integer' },
              unassignedPeriods: { type: 'integer' },
              weeklySlots: { type: 'integer', nullable: true },
            },
          },
        },
        teachers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              isActive: { type: 'boolean' },
              belongsToSchool: { type: 'boolean' },
              assignmentCount: { type: 'integer' },
              assignedPeriods: { type: 'integer' },
              capacity: { type: 'integer' },
              remainingCapacity: { type: 'integer' },
            },
          },
        },
        subjectGroups: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              gradeId: { type: 'string' },
              gradeName: { type: 'string' },
              subjectId: { type: 'string' },
              subjectName: { type: 'string' },
              sectionCount: { type: 'integer' },
              demandPeriods: { type: 'integer' },
              assignedPeriods: { type: 'integer' },
              unassignedPeriods: { type: 'integer' },
              eligibleTeacherCount: { type: 'integer' },
              eligibleRemainingCapacity: { type: 'integer' },
            },
          },
        },
      },
    },
    notChecked: {
      type: 'array',
      description: 'What this check does NOT prove; these are left to the solver.',
      items: { type: 'string' },
    },
  },
} as const;

export async function timetableFeasibilityRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------
  // GET /api/timetable-feasibility — Pre-generation readiness report
  // ------------------------------------------------------------------
  app.get<{ Querystring: FeasibilityQueryBody }>('/timetable-feasibility', {
    schema: {
      tags: ['Timetable Feasibility'],
      summary: 'Check whether an academic year is ready for timetable generation',
      description:
        'Read-only, stateless pre-generation validation of an academic year of the authenticated admin\'s ' +
        'school. It does NOT generate a timetable and persists nothing: the report is computed from a ' +
        'consistent database snapshot on every call. READY means every deterministic precondition passes ' +
        '(schedule exists, every section\'s weekly demand fits the slots, every requirement has an active ' +
        'eligible teacher, no teacher exceeds min(32, weekly slots), unassigned demand fits the eligible ' +
        'teachers\' remaining capacity); it does NOT guarantee the solver will find a timetable (see ' +
        'notChecked). Demand is expanded per section: a subject requirement defined once per grade/stream ' +
        'applies independently to every matching section (5 periods for sections A, B and C is 15 periods). ' +
        'Missing teacher assignments are errors; sections without requirements and requirements without ' +
        'sections are warnings. Allowed for DRAFT, ACTIVE and COMPLETED academic years. The pooled ' +
        'eligible-teacher check is a max-flow relaxation: it can prove impossibility, not possibility.',
      security: [{ cookieAuth: [] }],
      querystring: {
        type: 'object',
        required: ['academicYearId'],
        properties: {
          academicYearId: { type: 'string', format: 'uuid', description: 'Academic year UUID (must belong to your school)' },
        },
      },
      response: {
        200: {
          description: 'Readiness report (status READY or NOT_READY)',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: reportSchema,
          },
        },
        400: { description: 'Missing or malformed academicYearId', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'The academic year belongs to another school', ...errorSchema },
        404: { description: 'Academic year not found', ...errorSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: timetableFeasibilityController.checkFeasibility.bind(timetableFeasibilityController),
  });
}
