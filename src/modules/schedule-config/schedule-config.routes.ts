import { type FastifyInstance, type FastifySchemaCompiler } from 'fastify';
import { scheduleConfigController } from './schedule-config.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import {
  type CreateScheduleConfigBody,
  type ListScheduleConfigsQuery,
  type ScheduleConfigIdParam,
  type UpdateScheduleConfigBody,
} from './schedule-config.schema.js';

// Strict, non-coercing validation for THIS module only. Fastify's default Ajv validator coerces
// types ("8" -> 8, true -> 1), which is not acceptable for scheduler input. These routes pass the
// raw request data through and the controller validates it with Zod (strict types, field-level
// 400 errors in the standard envelope). The JSON schemas below drive the Swagger documentation.
// Modules 1-6 are unaffected: this compiler is attached to the Module 9 routes only.
const deferToZodValidator: FastifySchemaCompiler<unknown> = () => (data) => ({ value: data });

const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

// Reusable Swagger schema fragments
const workingDaysProperty = {
  type: 'array',
  minItems: 1,
  maxItems: 7,
  uniqueItems: true,
  items: { type: 'string', enum: DAYS },
  description: 'Distinct working days. Not hardcoded: any subset of the week.',
} as const;

const periodsPerDayProperty = {
  type: 'integer',
  minimum: 2,
  maximum: 12,
  description: 'Number of TEACHING periods per working day (2-12). The break is not a period and adds none.',
} as const;

const breakAfterPeriodProperty = {
  type: 'integer',
  minimum: 1,
  maximum: 11,
  description: 'The one break of every working day comes AFTER this teaching period: 1 .. periodsPerDay-1 (never after the last period). Example: 6 periods, breakAfterPeriod 4 = periods 1-4, break, periods 5-6.',
} as const;

const nullableTime = { type: 'string', nullable: true, description: 'Always null for a simplified configuration (no clock times). Present only on a legacy configuration, as read-only history.' } as const;

const configDataSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    academicYearId: { type: 'string', format: 'uuid' },
    periodsPerDay: { type: 'integer' },
    workingDays: { type: 'array', items: { type: 'string', enum: DAYS } },
    breakAfterPeriod: { type: 'integer', nullable: true, description: 'The break position. null only for a legacy configuration (legacy: true).' },
    weeklyTeachingCapacity: { type: 'integer', description: 'workingDays.length x periodsPerDay. The break adds none.' },
    legacy: { type: 'boolean', description: 'true: made before the simplification and not yet saved with the simplified form. PATCH breakAfterPeriod to convert it.' },
    periods: {
      type: 'array',
      description: 'Compatibility field. The teaching periods 1..periodsPerDay; times are null unless the configuration is legacy.',
      items: { type: 'object', properties: { periodNumber: { type: 'integer' }, startTime: nullableTime, endTime: nullableTime } },
    },
    timingEvents: { type: 'array', description: 'Compatibility field: stored timing events of a LEGACY configuration, unchanged. Always [] otherwise.', items: { type: 'object', additionalProperties: true } },
    timeline: {
      type: 'array',
      description: 'Read-only, for rendering: the periods in order with the single break after breakAfterPeriod (legacy: periods and stored events in clock order).',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['PERIOD', 'BREAK', 'EVENT'] },
          periodNumber: { type: 'integer' },
          afterPeriodNumber: { type: 'integer' },
          type: { type: 'string' },
          label: { type: 'string', nullable: true },
          startTime: nullableTime,
          endTime: nullableTime,
        },
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
    id: { type: 'string', format: 'uuid', description: 'Schedule configuration UUID' },
  },
} as const;

export async function scheduleConfigRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------
  // POST /api/schedule-configs — Create the academic year's schedule
  // ------------------------------------------------------------------
  app.post<{ Body: CreateScheduleConfigBody }>('/schedule-configs', {
    schema: {
      tags: ['Schedule Config'],
      summary: 'Create schedule configuration',
      description:
        'Define the school\'s standard weekly schedule for an academic year: the working days, the number of teaching periods per day and exactly ONE ' +
        'break per day, given as the period it comes after (breakAfterPeriod, 1..periodsPerDay-1). There are no clock times, break durations or other ' +
        'timing events: timetables are generated from period numbers and the break position only. The break is not a teaching period, so it never ' +
        'counts toward subject requirements or teacher workload; weekly teaching capacity = working days x periodsPerDay. One configuration per academic ' +
        'year, shared by every grade. The academic year must be DRAFT. The old `periods` and `timingEvents` fields are refused (400). Half-days, exams and ' +
        'holidays are NOT part of this configuration. periodsPerDay and breakAfterPeriod are strict integers (strings and booleans are rejected).',
      security: [{ cookieAuth: [] }],
      body: {
        type: 'object',
        required: ['academicYearId', 'workingDays', 'periodsPerDay', 'breakAfterPeriod'],
        properties: {
          academicYearId: { type: 'string', format: 'uuid', description: 'Academic year UUID' },
          workingDays: workingDaysProperty,
          periodsPerDay: periodsPerDayProperty,
          breakAfterPeriod: breakAfterPeriodProperty,
        },
      },
      response: {
        201: {
          description: 'Schedule configuration created successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: configDataSchema,
          },
        },
        400: {
          description:
            'Validation error (days, periodsPerDay, breakAfterPeriod out of range, legacy periods/timingEvents sent) or the ' +
            'academic year is not in DRAFT status',
          ...validationErrorSchema,
        },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Academic year belongs to another school', ...errorSchema },
        404: { description: 'Academic year not found', ...errorSchema },
        409: { description: 'A schedule configuration already exists for this academic year', ...errorSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: scheduleConfigController.createScheduleConfig.bind(scheduleConfigController),
  });

  // ------------------------------------------------------------------
  // GET /api/schedule-configs — List
  // ------------------------------------------------------------------
  app.get<{ Querystring: ListScheduleConfigsQuery }>('/schedule-configs', {
    schema: {
      tags: ['Schedule Config'],
      summary: 'List schedule configurations',
      description:
        'Return the schedule configurations of the authenticated admin\'s school (at most one per ' +
        'academic year), newest academic year first. Use ?academicYearId= to fetch one year\'s ' +
        'configuration (an empty list means none is configured yet). Allowed in any academic-year status.',
      security: [{ cookieAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          academicYearId: { type: 'string', format: 'uuid', description: 'Only this academic year' },
        },
      },
      response: {
        200: {
          description: 'Schedule configurations retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'array', items: configDataSchema },
          },
        },
        400: { description: 'Invalid filter value', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'The academic year belongs to another school', ...errorSchema },
        404: { description: 'The academic year was not found', ...errorSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: scheduleConfigController.getScheduleConfigs.bind(scheduleConfigController),
  });

  // ------------------------------------------------------------------
  // GET /api/schedule-configs/:id — Get one
  // ------------------------------------------------------------------
  app.get<{ Params: ScheduleConfigIdParam }>('/schedule-configs/:id', {
    schema: {
      tags: ['Schedule Config'],
      summary: 'Get schedule configuration by ID',
      description:
        'Retrieve a configuration with its working days, periods, timing events and the computed ' +
        'read-only timeline. Ownership is verified through the academic year. Allowed in any status.',
      security: [{ cookieAuth: [] }],
      params: idParamsSchema,
      response: {
        200: {
          description: 'Schedule configuration retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: configDataSchema,
          },
        },
        400: { description: 'Invalid schedule configuration ID', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'Configuration belongs to another school', ...errorSchema },
        404: { description: 'Schedule configuration not found', ...errorSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: scheduleConfigController.getScheduleConfig.bind(scheduleConfigController),
  });

  // ------------------------------------------------------------------
  // PATCH /api/schedule-configs/:id — Replace sections of the configuration
  // ------------------------------------------------------------------
  app.patch<{ Params: ScheduleConfigIdParam; Body: UpdateScheduleConfigBody }>(
    '/schedule-configs/:id',
    {
      schema: {
        tags: ['Schedule Config'],
        summary: 'Update schedule configuration',
        description:
          'Replace one or more of workingDays, periodsPerDay and breakAfterPeriod. The complete merged schedule is validated before anything is saved (for example, ' +
          'lowering periodsPerDay below the current break position is a 400: send breakAfterPeriod too). A LEGACY configuration (legacy: true, breakAfterPeriod null) ' +
          'must be sent breakAfterPeriod: that converts it to the simplified model; its stored legacy timings are kept untouched as history. `periods` and ' +
          '`timingEvents` are refused (400). academicYearId cannot be changed. The academic year must be DRAFT.',
        security: [{ cookieAuth: [] }],
        params: idParamsSchema,
        body: {
          type: 'object',
          properties: {
            workingDays: workingDaysProperty,
            periodsPerDay: periodsPerDayProperty,
            breakAfterPeriod: breakAfterPeriodProperty,
          },
        },
        response: {
          200: {
            description: 'Schedule configuration updated successfully',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: configDataSchema,
            },
          },
          400: {
            description:
              'Validation error, empty update, academicYearId supplied, or the academic year is not in DRAFT status',
            ...validationErrorSchema,
          },
          401: { description: 'Authentication required', ...errorSchema },
          403: { description: 'Configuration belongs to another school', ...errorSchema },
          404: { description: 'Schedule configuration not found', ...errorSchema },
        },
      },
      validatorCompiler: deferToZodValidator,
      preHandler: authMiddleware,
      handler: scheduleConfigController.updateScheduleConfig.bind(scheduleConfigController),
    }
  );
}
