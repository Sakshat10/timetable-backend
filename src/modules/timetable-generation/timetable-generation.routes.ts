import { type FastifyInstance, type FastifySchemaCompiler } from 'fastify';
import { timetableGenerationController } from './timetable-generation.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { FAILURE_CODES, RUN_STATUSES, type GenerationParams, type ListGenerationsQuery, type StartGenerationBody } from './timetable-generation.schema.js';

// Validation is done by Zod in the controller (field-level 400 errors in the standard envelope), consistent with Modules 7-10.
// The JSON schemas below drive the Swagger documentation and the response serializer. Attached to these routes only.
const deferToZodValidator: FastifySchemaCompiler<unknown> = () => (data) => ({ value: data });

const freeObject = { type: 'object', additionalProperties: true } as const;

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
    errors: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
  },
} as const;

const errorWithDataSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data: { ...freeObject, nullable: true },
  },
} as const;

export const runViewSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    academicYearId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: [...RUN_STATUSES], description: 'QUEUED and RUNNING are in progress; SUCCEEDED and FAILED are final.' },
    phase: { type: 'string', nullable: true, description: 'Current step while RUNNING (SNAPSHOT, FEASIBILITY, NORMALIZE, BASELINE, SOLVING, VALIDATING, METRICS, PERSISTING); DONE when finished.' },
    attempts: { type: 'integer', description: 'How many times a worker claimed the run (a lost worker is retried once).' },
    seed: { type: 'integer', nullable: true },
    reproducible: { type: 'boolean', nullable: true },
    timeLimitSeconds: { type: 'integer', description: 'Solver time budget chosen by the server from the number of sections.' },
    workers: { type: 'integer' },
    sectionCount: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time', description: 'When the run was queued' },
    startedAt: { type: 'string', format: 'date-time', nullable: true },
    completedAt: { type: 'string', format: 'date-time', nullable: true },
    updatedAt: { type: 'string', format: 'date-time' },
    versionId: { type: 'string', format: 'uuid', nullable: true, description: 'The generated timetable version. Null until SUCCEEDED, and null again if that draft was deleted (result.versionId keeps the id).' },
    sourceVersionId: { type: 'string', format: 'uuid', nullable: true, description: 'The DRAFT this run was started from (its locked lessons were frozen into the run), or null for a plain generation. Provenance only: that draft may have been changed or deleted since.' },
    lockedEntryCount: { type: 'integer', description: 'How many locked lessons were frozen into this run (0 for a plain generation)' },
    versionDeleted: { type: 'boolean', description: 'true when the version this run produced was deleted afterwards (versionId is then null; result.versionId keeps the historical id, which no longer resolves)' },
    result: { ...freeObject, nullable: true, description: 'SUCCEEDED only: solverStatus, solutionSource (CP_SAT | BASELINE), optimal, fallbackReason, runtimeSeconds, the authoritative metric terms and weightedObjective, baselineWeightedObjective, warnings, versionId, versionNumber, entryCount.' },
    failure: {
      type: 'object',
      nullable: true,
      description: 'FAILED only.',
      properties: {
        code: { type: 'string', enum: [...FAILURE_CODES] },
        message: { type: 'string' },
        diagnostics: { ...freeObject, nullable: true, description: 'Bounded details; never contains process ids, stderr, paths or tokens.' },
      },
    },
  },
} as const;

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid', description: 'Generation run UUID (must belong to your school)' } },
} as const;

export async function timetableGenerationRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------
  // POST /api/timetable-generations : accept a generation request
  // ------------------------------------------------------------------
  app.post<{ Body: StartGenerationBody }>('/timetable-generations', {
    schema: {
      operationId: 'startTimetableGeneration',
      tags: ['Timetable Generation'],
      summary: 'Start generating a timetable for a DRAFT academic year (asynchronous)',
      description:
        'Queues a generation run and returns 202 immediately; nothing is solved inside the request. A quick preflight rejects ' +
        'requests that cannot work (unknown or foreign year, year not DRAFT, Module 10 readiness NOT_READY). The background ' +
        'runner then repeats every check on a fresh snapshot, so the preflight is a courtesy and not the authority. Poll ' +
        'GET /api/timetable-generations/{id} until status is SUCCEEDED or FAILED. A successful run creates a NEW DRAFT ' +
        'timetable version; nothing is overwritten or published. The time limit, worker count and solver process are ' +
        'server-side policy and cannot be set here. Only one run per academic year can be QUEUED or RUNNING. ' +
        'With options.sourceVersionId the new draft keeps the locked lessons of that DRAFT exactly. The locks are frozen and ' +
        'preflighted at this request (400 LOCKS_INVALID with the detailed issues if they do not fit the current configuration; 404 ' +
        'SOURCE_VERSION_NOT_FOUND; 403 for another school\'s version; 400 SOURCE_VERSION_WRONG_YEAR; 409 SOURCE_VERSION_NOT_DRAFT) and ' +
        'validated again, authoritatively, by the run. If no timetable that keeps them can be produced the run FAILS (LOCKS_INVALID, ' +
        'INFEASIBLE_HARD_CONSTRAINTS when proven impossible, or NO_SOLUTION_WITH_LOCKS when none was found in time, which does not prove ' +
        'impossibility): nothing is persisted and the source is untouched. Without locks the baseline fallback always exists; with locks it is ' +
        'best-effort and may be absent, in which case the new version\'s baselineMetrics says {available: false}. ' +
        'An academic year holds at most MAX_DRAFTS_PER_YEAR (default 20) draft versions: an active generation reserves one slot, so the request is ' +
        'refused with 409 data.code DRAFT_LIMIT_REACHED (data.drafts, data.maxDraftsPerYear) when the year is already at the cap. Delete or publish a draft first. ' +
        'A run queued before the cap was reached can still FAIL with failure.code DRAFT_LIMIT_REACHED at the end (nothing is created).',
      security: [{ cookieAuth: [] }],
      body: {
        type: 'object',
        required: ['academicYearId'],
        properties: {
          academicYearId: { type: 'string', format: 'uuid', description: 'A DRAFT academic year of your school' },
          options: {
            type: 'object',
            additionalProperties: false,
            description: 'Unknown option keys are rejected with 400.',
            properties: {
              seed: { type: 'integer', minimum: 0, maximum: 2147483647, description: 'Random seed. Omitted: the server picks one and returns it.' },
              sourceVersionId: { type: 'string', format: 'uuid', description: 'Regenerate from this DRAFT timetable version of the same academic year: its locked lessons are frozen at this request and kept exactly (same assignment, teacher, day and period) in the NEW draft. The source is never modified, and editing, unlocking or deleting it after this request does not change the run. Omitted: a plain generation, exactly as before. PUBLISHED and ARCHIVED versions cannot be a source.' },
              reproducible: { type: 'boolean', default: false, description: 'true makes the solve bounded by deterministic work instead of wall-clock time (same seed, same result); it uses a shorter effective budget.' },
            },
          },
        },
      },
      response: {
        202: {
          description: 'Accepted: the run is queued',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                generationRunId: { type: 'string', format: 'uuid' },
                academicYearId: { type: 'string', format: 'uuid' },
                status: { type: 'string', enum: [...RUN_STATUSES] },
                seed: { type: 'integer' },
                reproducible: { type: 'boolean' },
                timeLimitSeconds: { type: 'integer' },
                sectionCount: { type: 'integer' },
                sourceVersionId: { type: 'string', format: 'uuid', description: 'Only when the request named a source draft' },
                lockedEntryCount: { type: 'integer', description: 'Only when the request named a source draft: how many locked lessons were frozen' },
              },
            },
          },
        },
        400: { description: 'Malformed request; the year is not DRAFT; or the year is NOT_READY (data carries the readiness errors)', ...errorWithDataSchema, properties: { ...errorWithDataSchema.properties, errors: validationErrorSchema.properties.errors } },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'The academic year (or the source version, data.code SOURCE_VERSION_FORBIDDEN) belongs to another school', ...errorWithDataSchema },
        404: { description: 'Academic year not found, or the source version (data.code SOURCE_VERSION_NOT_FOUND)', ...errorWithDataSchema },
        409: { description: 'A generation for this academic year is already QUEUED or RUNNING (data.existingRunId), the source version is not a DRAFT (data.code SOURCE_VERSION_NOT_DRAFT), or the year already holds the maximum number of drafts (data.code DRAFT_LIMIT_REACHED)', ...errorWithDataSchema },
        503: { description: 'The generation queue is full, or the academic year is busy with another operation (data.code BUSY); retry later (Retry-After header)', ...errorWithDataSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: timetableGenerationController.start.bind(timetableGenerationController),
  });

  // ------------------------------------------------------------------
  // GET /api/timetable-generations/:id : one run
  // ------------------------------------------------------------------
  app.get<{ Params: GenerationParams }>('/timetable-generations/:id', {
    schema: {
      operationId: 'getTimetableGeneration',
      tags: ['Timetable Generation'],
      summary: 'Get the status and result of one timetable generation run',
      description:
        'Poll this until status is SUCCEEDED or FAILED. On SUCCEEDED, versionId names the new DRAFT timetable version and ' +
        'result says whether the CP-SAT solution or the validated baseline was used (solutionSource) and why. On FAILED, ' +
        'failure.code is one of the documented codes; the run never silently falls back to the baseline after a solver fault.',
      security: [{ cookieAuth: [] }],
      params: idParams,
      response: {
        200: { description: 'The run', type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: runViewSchema } },
        400: { description: 'Malformed generation ID', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'The run belongs to another school', ...errorSchema },
        404: { description: 'Generation not found', ...errorSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: timetableGenerationController.get.bind(timetableGenerationController),
  });

  // ------------------------------------------------------------------
  // GET /api/timetable-generations?academicYearId= : runs of a year
  // ------------------------------------------------------------------
  app.get<{ Querystring: ListGenerationsQuery }>('/timetable-generations', {
    schema: {
      operationId: 'listTimetableGenerations',
      tags: ['Timetable Generation'],
      summary: 'List the generation runs of an academic year, newest first',
      description: 'Lets a page reload find the active run of a year. At most `limit` runs (default 50, maximum 100).',
      security: [{ cookieAuth: [] }],
      querystring: {
        type: 'object',
        required: ['academicYearId'],
        properties: {
          academicYearId: { type: 'string', format: 'uuid', description: 'Academic year UUID (must belong to your school)' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
      },
      response: {
        200: { description: 'Runs, newest first', type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: { type: 'array', items: runViewSchema } } },
        400: { description: 'Missing or malformed academicYearId or limit', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'The academic year belongs to another school', ...errorSchema },
        404: { description: 'Academic year not found', ...errorSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: timetableGenerationController.list.bind(timetableGenerationController),
  });
}
