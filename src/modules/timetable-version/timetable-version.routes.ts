import { type FastifyInstance, type FastifySchemaCompiler } from 'fastify';
import { timetableVersionController } from './timetable-version.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { DAYS_OF_WEEK, SOLUTION_SOURCES, SOLVER_STATUSES, VERSION_STATUSES, type ListVersionsQuery, type LocksBody, type MoveBody, type CloneBodyInput, type PublishBody, type TimetableViewQueryInput, type VersionParams } from './timetable-version.schema.js';

// Validation is done by Zod in the controller (field-level 400 errors in the standard envelope), consistent with Modules 7-10.
const deferToZodValidator: FastifySchemaCompiler<unknown> = () => (data) => ({ value: data });

const freeObject = { type: 'object', additionalProperties: true } as const;
const errorSchema = { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } } as const;
const validationErrorSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    errors: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
  },
} as const;

/** Rule refusals: the standard envelope plus data.code (stable, machine-readable) and bounded details. */
const refusalSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data: { ...freeObject, nullable: true, description: 'Always carries `code`; see the operation description for the codes.' },
  },
} as const;

const revisionProperty = { type: 'integer', minimum: 1, description: 'The timetable\'s revision AFTER this request' } as const;

const summaryProperties = {
  id: { type: 'string', format: 'uuid' },
  academicYearId: { type: 'string', format: 'uuid' },
  versionNumber: { type: 'integer', description: 'Per academic year, starting at 1' },
  status: { type: 'string', enum: [...VERSION_STATUSES], description: 'Generation always creates DRAFT. PUBLISHED and ARCHIVED versions cannot be deleted.' },
  solutionSource: { type: 'string', enum: [...SOLUTION_SOURCES], description: 'CP_SAT, or BASELINE when the solver produced no solution in time' },
  solverStatus: { type: 'string', enum: [...SOLVER_STATUSES] },
  optimal: { type: 'boolean', description: 'true only when CP-SAT proved the timetable optimal' },
  weightsVersion: { type: 'string' },
  inputHash: { type: 'string', description: 'Hash of the configuration the timetable was generated from (staleness detection)' },
  metrics: { ...freeObject, description: 'Authoritative quality metrics computed by the backend (teacher runs, repeated subjects, holes, load)' },
  baselineMetrics: { ...freeObject, description: 'The same metrics for the baseline timetable, for comparison. A version generated from locked lessons may have no valid baseline: then this is {available: false, reason} and holds no numbers.' },
  entryCount: { type: 'integer' },
  revision: { type: 'integer', minimum: 1, description: 'Optimistic-concurrency token: send it back as expectedRevision. Starts at 1 and grows with every successful change.' },
  publishedAt: { type: 'string', format: 'date-time', nullable: true },
  archivedAt: { type: 'string', format: 'date-time', nullable: true },
  lockedCount: { type: 'integer', description: 'Lessons that are locked' },
  manualEditCount: { type: 'integer', description: 'Lessons that were moved or swapped by an admin (source MANUAL)' },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
} as const;

/** Phase 7F-3: present on a listed version only when includeStaleness=true. */
const stalenessReasons = ['NONE', 'CONFIGURATION_CHANGED', 'CONFIGURATION_NOT_NORMALIZABLE', 'SNAPSHOT_UNUSABLE', 'ASSESSMENT_FAILED'] as const;
const stalenessListProperties = {
  isStale: { type: 'boolean', nullable: true, description: 'Only with includeStaleness=true. true: the live configuration differs from the one the timetable was generated from. null: could not be established (see staleReason).' },
  staleReason: { type: 'string', enum: [...stalenessReasons], description: 'Only with includeStaleness=true' },
} as const;

const entrySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    sectionId: { type: 'string', format: 'uuid' },
    subjectId: { type: 'string', format: 'uuid' },
    teacherId: { type: 'string', format: 'uuid' },
    subjectRequirementId: { type: 'string', format: 'uuid' },
    dayOfWeek: { type: 'string', enum: [...DAYS_OF_WEEK] },
    periodNumber: { type: 'integer', minimum: 1 },
    source: { type: 'string', enum: ['GENERATED', 'MANUAL'], description: 'GENERATED for solver output; MANUAL once an admin moved or swapped the lesson' },
    isLocked: { type: 'boolean' },
  },
} as const;

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid', description: 'Timetable version UUID (must belong to your school)' } },
} as const;

export async function timetableVersionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ListVersionsQuery }>('/timetable-versions', {
    schema: {
      operationId: 'listTimetableVersions',
      tags: ['Timetable Version'],
      summary: 'List the generated timetable versions of an academic year, newest first',
      description:
        'Summaries only (no entries). Use GET /api/timetable-versions/{id} for the lessons. Versions are always ordered by versionNumber, newest first. ' +
        '`status` keeps only versions in those statuses: one status, or several as a comma-separated list (status=DRAFT,PUBLISHED) or a repeated parameter ' +
        '(status=DRAFT&status=PUBLISHED); exactly DRAFT, PUBLISHED or ARCHIVED, upper case; anything else is a 400. Omitted: every status. ' +
        '`includeStaleness=true` (opt-in; default false, and then the response is exactly what it always was) adds isStale and staleReason to every returned ' +
        'version: the strict rule of GET /api/timetable-versions/{id}/validation, evaluated the same way, so the two always agree. isStale is true when the ' +
        'live configuration is not the one the timetable was generated from (staleReason CONFIGURATION_CHANGED, or CONFIGURATION_NOT_NORMALIZABLE when it no ' +
        'longer forms a valid problem), false with NONE otherwise, and null when it could not be established (SNAPSHOT_UNUSABLE: the stored snapshot cannot be read). ' +
        'The live configuration is read once for the whole list, and versions that share a configuration are assessed once, so the extra cost does not grow with ' +
        'the number of versions. PUBLISHED and ARCHIVED versions are assessed too.',
      security: [{ cookieAuth: [] }],
      querystring: {
        type: 'object',
        required: ['academicYearId'],
        properties: {
          academicYearId: { type: 'string', format: 'uuid', description: 'Academic year UUID (must belong to your school)' },
          status: { type: 'string', description: 'Filter: DRAFT, PUBLISHED or ARCHIVED; several as comma-separated values or a repeated parameter. Omitted: all statuses.' },
          includeStaleness: { type: 'string', enum: ['true', 'false'], default: 'false', description: 'true adds isStale and staleReason to every version' },
        },
      },
      response: {
        200: { description: 'Versions, newest first', type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: { type: 'array', items: { type: 'object', properties: { ...summaryProperties, ...stalenessListProperties } } } } },
        400: { description: 'Missing or malformed academicYearId, an invalid status (anything other than DRAFT, PUBLISHED or ARCHIVED, an empty value or element), or an invalid includeStaleness', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'The academic year belongs to another school', ...errorSchema },
        404: { description: 'Academic year not found', ...errorSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: timetableVersionController.list.bind(timetableVersionController),
  });

  app.get<{ Params: VersionParams }>('/timetable-versions/:id', {
    schema: {
      operationId: 'getTimetableVersion',
      tags: ['Timetable Version'],
      summary: 'Get one timetable version with all of its lessons',
      description:
        'Every entry places one subject, taught by one teacher, in one section at a (dayOfWeek, periodNumber) slot. Entries are ordered by section, day and period.',
      security: [{ cookieAuth: [] }],
      params: idParams,
      response: {
        200: {
          description: 'The version',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                ...summaryProperties,
                solverDiagnostics: { ...freeObject, nullable: true, description: 'Solver-reported numbers, diagnostic only; never contains process ids, stderr or paths' },
                entries: { type: 'array', items: entrySchema },
              },
            },
          },
        },
        400: { description: 'Malformed version ID', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'The version belongs to another school', ...errorSchema },
        404: { description: 'Version not found', ...errorSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: timetableVersionController.get.bind(timetableVersionController),
  });

  app.delete<{ Params: VersionParams }>('/timetable-versions/:id', {
    schema: {
      operationId: 'deleteTimetableVersion',
      tags: ['Timetable Version'],
      summary: 'Delete a timetable version (a draft directly; published or archived only after explicit confirmation)',
      description:
        'DRAFT: deleted at once, as before. PUBLISHED or ARCHIVED: PERMANENT, and only when the request body confirms it: ' +
        '{ confirmVersionNumber (the version number, typed back), expectedStatus ("PUBLISHED" | "ARCHIVED"), expectedRevision } as read from the version. Without that body the answer is 409 CONFIRMATION_REQUIRED; ' +
        'a wrong number is 400 CONFIRMATION_MISMATCH; a version that changed since it was read is 409 STATUS_CHANGED / REVISION_CONFLICT. The academic year must be DRAFT or ACTIVE (a COMPLETED year keeps its ' +
        'timetables: 409 ACADEMIC_YEAR_NOT_EDITABLE), and no substitution cover request may have been made from the version (409 VERSION_HAS_HISTORY, with the counts by status): substitution history is never erased. ' +
        'The version\'s lessons are deleted with it; no other version, lesson or setting is touched, and NOTHING is published in its place: deleting the published version leaves the year with no published timetable until ' +
        'one is published. The generation run that produced it is kept (its versionId becomes null); drafts cloned from it forget their clonedFromId. The response lists what was removed. ' +
        'Serialised with publish/generation/clone by the academic-year lock.',
      security: [{ cookieAuth: [] }],
      params: idParams,
      body: {
        type: 'object',
        nullable: true,
        properties: {
          confirmVersionNumber: { type: 'integer', minimum: 1, description: 'The number of the version being deleted' },
          expectedStatus: { type: 'string', enum: ['PUBLISHED', 'ARCHIVED'] },
          expectedRevision: { type: 'integer', minimum: 1 },
        },
      },
      response: {
        200: { description: 'Deleted; data = { versionId, versionNumber, status, lessonsRemoved, publishedVersionNow: null, detachedClones }', type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: { type: 'object', nullable: true, additionalProperties: true } } },
        400: { description: 'Malformed version ID or confirmation body (errors), or the confirmed version number does not match (data.code CONFIRMATION_MISMATCH)', type: 'object', properties: { ...validationErrorSchema.properties, ...refusalSchema.properties } },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'The version belongs to another school', ...errorSchema },
        404: { description: 'Version not found', ...errorSchema },
        409: { description: 'CONFIRMATION_REQUIRED, STATUS_CHANGED, REVISION_CONFLICT, ACADEMIC_YEAR_NOT_EDITABLE or VERSION_HAS_HISTORY (data.code)', ...refusalSchema },
        503: { description: 'The timetable is being changed by another request; retry', ...refusalSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: timetableVersionController.delete.bind(timetableVersionController),
  });

  // ------------------------------------------------------------------
  // POST /api/timetable-versions/:id/clone : copy any version into a new DRAFT (Phase 7F-2)
  // ------------------------------------------------------------------
  app.post<{ Params: VersionParams; Body: CloneBodyInput }>('/timetable-versions/:id/clone', {
    schema: {
      operationId: 'cloneTimetableVersion',
      tags: ['Timetable Version'],
      summary: 'Clone a timetable version (draft, published or archived) into a new DRAFT',
      description:
        'Copies the version into a NEW draft of the same academic year and school: next version number, revision 1, status DRAFT (never published), ' +
        'created by you. The source is never modified. Any status can be cloned, including PUBLISHED and ARCHIVED ones. The lessons are copied with new ' +
        'ids; each lesson\'s `source` (GENERATED or MANUAL) is always kept. `lockMode` decides the lock flag of every lesson in the CLONE: KEEP (default) ' +
        'keeps the source\'s flags, ALL locks every lesson, NONE unlocks every lesson. The clone also keeps the source\'s configuration snapshot and hash ' +
        '(so it is exactly as stale as its source: publishing a stale clone is refused by the usual rule), its metrics, and the period times frozen ' +
        'when the source was generated (a legacy source without them gives a clone without them; periodTimesCaptured says which). `clonedFromId` records the ' +
        'source; if the source is deleted later the clone stays and its clonedFromId becomes null. Only for DRAFT or ACTIVE academic years. ' +
        'An academic year holds at most MAX_DRAFTS_PER_YEAR (default 20) drafts, and a queued or running generation reserves one slot, so a clone is ' +
        'refused when drafts plus that generation reach the maximum (409 DRAFT_LIMIT_REACHED with data.drafts, data.maxDraftsPerYear and data.pendingRun). ' +
        '`includeStaleness: true` also returns the clone\'s staleness (opt-in; the same rule as GET .../validation, assessed after the clone is committed, so a failure to assess never fails the clone). '
        +
        'Not idempotent: every call creates another draft. Nothing is solved and the generation queue is not touched. ' +
        'Refusals carry data.code: 409 ACADEMIC_YEAR_NOT_EDITABLE, 409 DRAFT_LIMIT_REACHED, 503 BUSY (another request holds the year or the source; retry).',
      security: [{ cookieAuth: [] }],
      params: idParams,
      body: {
        type: 'object',
        additionalProperties: false,
        description: 'Optional. Unknown fields are rejected with 400: the year, school, lessons and status cannot be chosen.',
        properties: {
          lockMode: { type: 'string', enum: ['KEEP', 'ALL', 'NONE'], default: 'KEEP', description: 'KEEP: keep each lesson\'s lock flag. ALL: lock every lesson. NONE: unlock every lesson.' },
          includeStaleness: { type: 'boolean', default: false, description: 'true adds `staleness` to the response. Omitted or false: the response has no staleness field.' },
        },
      },
      response: {
        201: {
          description: 'The new draft',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                ...summaryProperties,
                clonedFromId: { type: 'string', format: 'uuid', description: 'The version this was cloned from' },
                clonedFromVersionNumber: { type: 'integer' },
                lockMode: { type: 'string', enum: ['KEEP', 'ALL', 'NONE'] },
                periodTimesCaptured: { type: 'boolean', description: 'The clone carries the source\'s frozen period times (false for a legacy source)' },
                staleness: {
                  type: 'object',
                  description: 'Only when the request had includeStaleness: true. The clone\'s strict staleness: the same answer GET /api/timetable-versions/{id}/validation gives for it (a clone is as stale as its source).',
                  properties: {
                    isStale: { type: 'boolean', nullable: true, description: 'null when it could not be established (see reason)' },
                    reason: { type: 'string', enum: [...stalenessReasons], description: 'NONE, CONFIGURATION_CHANGED, CONFIGURATION_NOT_NORMALIZABLE, SNAPSHOT_UNUSABLE, or ASSESSMENT_FAILED (the clone was created, but the assessment itself failed)' },
                  },
                },
              },
            },
          },
        },
        400: { description: 'Malformed version ID, unknown body field, invalid lockMode, or a non-boolean includeStaleness', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'The version belongs to another school', ...errorSchema },
        404: { description: 'Version not found (or deleted while the request waited)', ...errorSchema },
        409: { description: 'data.code ACADEMIC_YEAR_NOT_EDITABLE (the year is COMPLETED) or DRAFT_LIMIT_REACHED', ...refusalSchema },
        503: { description: 'data.code BUSY: another request holds the year or the source; retry (Retry-After header)', ...refusalSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: timetableVersionController.clone.bind(timetableVersionController),
  });

  // ------------------------------------------------------------------
  // GET /api/timetable-versions/:id/timetable : one section's or one teacher's week (Phase 7F-1, read-only)
  // ------------------------------------------------------------------
  const lessonSchema = {
    type: 'object',
    nullable: true,
    description: 'null for a free slot',
    properties: {
      entryId: { type: 'string', format: 'uuid' },
      section: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string', nullable: true }, code: { type: 'string', nullable: true }, gradeName: { type: 'string', nullable: true } } },
      subject: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string', nullable: true }, code: { type: 'string', nullable: true } } },
      teacher: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string', nullable: true }, isActive: { type: 'boolean', nullable: true } } },
      subjectRequirementId: { type: 'string', format: 'uuid' },
      isLocked: { type: 'boolean' },
      source: { type: 'string', enum: ['GENERATED', 'MANUAL'] },
    },
  } as const;
  const countBySchema = { type: 'array', items: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string', nullable: true }, lessons: { type: 'integer' } } } } as const;

  app.get<{ Params: VersionParams; Querystring: TimetableViewQueryInput }>('/timetable-versions/:id/timetable', {
    schema: {
      operationId: 'getTimetableView',
      tags: ['Timetable Version'],
      summary: 'Read one section\'s or one teacher\'s weekly timetable of a version',
      description:
        'A readable, read-only view of a single timetable version: the full weekly grid (every working day x every period, free slots as ' +
        '`lesson: null`) with subject, teacher and section names, the lock state and source (GENERATED or MANUAL) of every lesson, and totals. ' +
        'Works for DRAFT, PUBLISHED and ARCHIVED versions and takes no lock. The version, the lessons and every name are read in one consistent transaction. ' +
        'Choose `view=section` (id = a section of the version\'s academic year) or `view=teacher` (id = a teacher of your school); a section or ' +
        'teacher without lessons returns an empty grid. ' +
        '`periodTimes`: the clock times of each period come from the snapshot stored with the version when it was generated (`periodTimes.source` ' +
        'SNAPSHOT), and `changedSinceCapture` says whether the school\'s live schedule differs from it now. A version generated before snapshots ' +
        'existed has none: `source` is UNAVAILABLE and the periods carry no times, unless you ask for `periodTimes=current`, which returns the live ' +
        'schedule (`source` CURRENT; for such a legacy version `changedSinceCapture` is null and `periodRowsCreatedAfterVersion` is a heuristic hint ' +
        'only, never a guarantee). A version generated under the simplified schedule (no clock times, by design) has `source` NONE: its periods carry no times, nothing is missing and `periodTimes=current` is ignored. Names are the current names. Errors: 404 (unknown version; data.code SECTION_NOT_FOUND or TEACHER_NOT_FOUND, ' +
        'also for a section of another academic year), 403 (version, section or teacher of another school), 400 (malformed query).',
      security: [{ cookieAuth: [] }],
      params: idParams,
      querystring: {
        type: 'object',
        required: ['view', 'id'],
        properties: {
          view: { type: 'string', enum: ['section', 'teacher'] },
          id: { type: 'string', format: 'uuid', description: 'The section (view=section) or teacher (view=teacher)' },
          periodTimes: { type: 'string', enum: ['snapshot', 'current'], default: 'snapshot', description: 'snapshot (default): the stored times, or UNAVAILABLE for a legacy version. current: the live schedule.' },
        },
      },
      response: {
        200: {
          description: 'The weekly view',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                version: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, academicYearId: { type: 'string', format: 'uuid' }, versionNumber: { type: 'integer' }, status: { type: 'string', enum: [...VERSION_STATUSES] }, revision: { type: 'integer' } } },
                subject: { ...freeObject, description: 'type SECTION (id, name, code, grade) or TEACHER (id, name, isActive)' },
                grid: {
                  type: 'object',
                  properties: {
                    days: { type: 'array', items: { type: 'object', properties: { dayOfWeek: { type: 'string', enum: [...DAYS_OF_WEEK] }, index: { type: 'integer' } } } },
                    periods: { type: 'array', items: { type: 'object', properties: { periodNumber: { type: 'integer' }, continuesIntoNext: { type: 'boolean' }, startMinute: { type: 'integer', nullable: true }, endMinute: { type: 'integer', nullable: true }, startTime: { type: 'string', nullable: true, description: 'HH:mm' }, endTime: { type: 'string', nullable: true, description: 'HH:mm' } } } },
                  },
                },
                periodTimes: {
                  type: 'object',
                  properties: {
                    source: { type: 'string', enum: ['SNAPSHOT', 'CURRENT', 'UNAVAILABLE', 'NONE'] },
                    capturedAt: { type: 'string', format: 'date-time', nullable: true },
                    changedSinceCapture: { type: 'boolean', nullable: true, description: 'Stored times differ from the live schedule; null when the version has no stored times' },
                    periodRowsCreatedAfterVersion: { type: 'boolean', nullable: true, description: 'Heuristic hint, legacy version with periodTimes=current only' },
                    incomplete: { type: 'boolean', description: 'Some grid period has no time' },
                  },
                },
                cells: { type: 'array', items: { type: 'object', properties: { dayOfWeek: { type: 'string', enum: [...DAYS_OF_WEEK] }, periodNumber: { type: 'integer' }, lesson: lessonSchema } } },
                totals: {
                  type: 'object',
                  properties: {
                    lessons: { type: 'integer' }, lockedLessons: { type: 'integer' }, manualLessons: { type: 'integer' }, freeSlots: { type: 'integer' }, outsideGrid: { type: 'integer' },
                    perDay: { type: 'array', items: { type: 'object', properties: { dayOfWeek: { type: 'string', enum: [...DAYS_OF_WEEK] }, lessons: { type: 'integer' } } } },
                    bySubject: countBySchema, byTeacher: countBySchema, bySection: countBySchema,
                  },
                },
              },
            },
          },
        },
        400: { description: 'Missing or malformed view, id or periodTimes', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'The version, section or teacher belongs to another school', ...errorSchema },
        404: { description: 'Version not found; or the section/teacher was not found (data.code SECTION_NOT_FOUND / TEACHER_NOT_FOUND, also a section of another academic year)', ...refusalSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: timetableVersionController.timetable.bind(timetableVersionController),
  });

  // ------------------------------------------------------------------
  // POST /api/timetable-versions/:id/moves : move or swap one lesson
  // ------------------------------------------------------------------
  app.post<{ Params: VersionParams; Body: MoveBody }>('/timetable-versions/:id/moves', {
    schema: {
      operationId: 'moveTimetableEntry',
      tags: ['Timetable Version'],
      summary: 'Move a lesson to a free slot, or swap two lessons of the same section',
      description:
        'Only DRAFT versions of a DRAFT or ACTIVE academic year can be changed. A request either MOVES `entryId` to the free slot ' +
        '`to`, or, when `swapWithEntryId` is given, SWAPS two lessons of the same section (`to` must then be the slot of the partner). ' +
        'Only the day and period change: the teacher, subject, section and teaching assignment never do, so the weekly requirement ' +
        'counts are preserved. The WHOLE resulting timetable is validated inside the same transaction; an invalid change is refused ' +
        'and nothing is written. A changed lesson becomes source MANUAL; it is NOT locked automatically (moving and locking are ' +
        'separate). A locked lesson cannot move. Every change must carry `expectedRevision`; the revision grows by one on success. ' +
        'Refusals carry data.code: 404 ENTRY_NOT_FOUND; 400 INVALID_SLOT, INVALID_MOVE, INVALID_SWAP; 409 VERSION_NOT_DRAFT, ' +
        'ACADEMIC_YEAR_NOT_EDITABLE, REVISION_CONFLICT, ENTRY_LOCKED, SLOT_OCCUPIED, TEACHER_BUSY, INVARIANT_VIOLATION, ' +
        'SNAPSHOT_UNUSABLE; 503 BUSY (another request holds the timetable; retry).',
      security: [{ cookieAuth: [] }],
      params: idParams,
      body: {
        type: 'object',
        required: ['entryId', 'to', 'expectedRevision'],
        additionalProperties: false,
        properties: {
          entryId: { type: 'string', format: 'uuid', description: 'The lesson to move' },
          to: {
            type: 'object',
            required: ['dayOfWeek', 'periodNumber'],
            additionalProperties: false,
            properties: {
              dayOfWeek: { type: 'string', enum: [...DAYS_OF_WEEK], description: 'Must be a working day of this timetable (otherwise 400 INVALID_SLOT)' },
              periodNumber: { type: 'integer', minimum: 1, description: 'Must be a period of this timetable (otherwise 400 INVALID_SLOT)' },
            },
          },
          swapWithEntryId: { type: 'string', format: 'uuid', description: 'Swap with this lesson (same section) instead of moving into a free slot' },
          expectedRevision: { type: 'integer', minimum: 1, description: 'The revision you loaded; a different current revision is 409 REVISION_CONFLICT' },
        },
      },
      response: {
        200: {
          description: 'Moved or swapped',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                versionId: { type: 'string', format: 'uuid' },
                mode: { type: 'string', enum: ['MOVE', 'SWAP'] },
                revision: revisionProperty,
                changedEntries: { type: 'array', items: entrySchema, description: 'The lessons whose slot changed, in their new state' },
                metrics: { ...freeObject, nullable: true, description: 'Authoritative metrics (WEIGHTS_V1) of the timetable after the change' },
                metricsDelta: { ...freeObject, nullable: true, description: 'after - before for weightedObjective and every term (negative is better). A worse value does not refuse the edit.' },
                manualEditCount: { type: 'integer' },
                lockedCount: { type: 'integer' },
              },
            },
          },
        },
        400: { description: 'Malformed request, INVALID_SLOT, INVALID_MOVE or INVALID_SWAP', ...refusalSchema, properties: { ...refusalSchema.properties, errors: validationErrorSchema.properties.errors } },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'The version belongs to another school', ...errorSchema },
        404: { description: 'Version or entry not found', ...refusalSchema },
        409: { description: 'State conflict (see the operation description for data.code)', ...refusalSchema },
        503: { description: 'BUSY: retry shortly', ...refusalSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: timetableVersionController.move.bind(timetableVersionController),
  });

  // ------------------------------------------------------------------
  // PUT /api/timetable-versions/:id/locks : lock or unlock lessons
  // ------------------------------------------------------------------
  app.put<{ Params: VersionParams; Body: LocksBody }>('/timetable-versions/:id/locks', {
    schema: {
      operationId: 'setTimetableEntryLocks',
      tags: ['Timetable Version'],
      summary: 'Lock or unlock lessons of a draft timetable',
      description:
        'Sets isLocked to `locked` on every listed entry: lock and unlock are one idempotent operation. Only DRAFT versions of a ' +
        'DRAFT or ACTIVE academic year can be changed, and every entry must belong to this version (otherwise 404 ENTRY_NOT_FOUND ' +
        'and nothing changes). A locked lesson cannot be moved or swapped. The revision grows by one only when at least one entry ' +
        'really changes; a request that changes nothing succeeds with `changed: 0` and leaves the revision as it is, and ' +
        '`expectedRevision` is checked either way. Locks are bookkeeping for review in this version: they are NOT used by ' +
        'timetable generation yet. Refusals carry data.code: 404 ENTRY_NOT_FOUND; 409 VERSION_NOT_DRAFT, ACADEMIC_YEAR_NOT_EDITABLE, ' +
        'REVISION_CONFLICT; 503 BUSY.',
      security: [{ cookieAuth: [] }],
      params: idParams,
      body: {
        type: 'object',
        required: ['entryIds', 'locked', 'expectedRevision'],
        additionalProperties: false,
        properties: {
          entryIds: { type: 'array', minItems: 1, maxItems: 1000, uniqueItems: true, items: { type: 'string', format: 'uuid' } },
          locked: { type: 'boolean', description: 'true locks the lessons, false unlocks them' },
          expectedRevision: { type: 'integer', minimum: 1 },
        },
      },
      response: {
        200: {
          description: 'The requested state holds for every listed lesson',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                versionId: { type: 'string', format: 'uuid' },
                locked: { type: 'boolean' },
                changed: { type: 'integer', description: 'Lessons whose state really changed' },
                unchanged: { type: 'integer', description: 'Lessons that were already in the requested state' },
                revision: revisionProperty,
                lockedCount: { type: 'integer', description: 'Locked lessons in the version afterwards' },
              },
            },
          },
        },
        400: { description: 'Malformed request', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'The version belongs to another school', ...errorSchema },
        404: { description: 'Version or entry not found', ...refusalSchema },
        409: { description: 'State conflict (see the operation description for data.code)', ...refusalSchema },
        503: { description: 'BUSY: retry shortly', ...refusalSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: timetableVersionController.setLocks.bind(timetableVersionController),
  });

  // ------------------------------------------------------------------
  // GET /api/timetable-versions/:id/validation : whole-timetable validation (read-only)
  // ------------------------------------------------------------------
  app.get<{ Params: VersionParams }>('/timetable-versions/:id/validation', {
    schema: {
      operationId: 'validateTimetableVersion',
      tags: ['Timetable Version'],
      summary: 'Validate a whole timetable version (read-only)',
      description:
        'READ-ONLY. Rebuilds the problem the version was generated from (its stored snapshot), checks every hard constraint on the current lessons ' +
        '(no section or teacher collision, exact periods per requirement, teacher capacity, valid slots, consistent assignments), computes ' +
        'the authoritative metrics (WEIGHTS_V1), and compares the LIVE configuration with the one the timetable was generated from: ' +
        '`isStale` is true if they differ in any way (locks are not configuration). Allowed for every status. Nothing is written and no ' +
        'lock is taken (read-only). `informational.publishable` tells whether a publish request would pass its checks right now.',
      security: [{ cookieAuth: [] }],
      params: idParams,
      response: {
        200: {
          description: 'The validation report',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                versionId: { type: 'string', format: 'uuid' },
                status: { type: 'string', enum: [...VERSION_STATUSES] },
                revision: { type: 'integer', minimum: 1 },
                valid: { type: 'boolean', description: 'Every hard constraint holds for the lessons, against the configuration they were generated from' },
                violations: { type: 'array', items: { ...freeObject, description: 'code, message and the ids involved (bounded to 50)' } },
                violationCount: { type: 'integer', description: 'The true number of violations' },
                isStale: { type: 'boolean', description: 'The live configuration is not exactly the one this timetable was generated from' },
                metrics: { ...freeObject, nullable: true, description: 'Authoritative metrics; null when the timetable is not valid' },
                informational: {
                  type: 'object',
                  properties: {
                    staleReason: { type: 'string', enum: ['NONE', 'CONFIGURATION_CHANGED', 'CONFIGURATION_NOT_NORMALIZABLE'] },
                    configurationIssues: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } },
                    academicYearStatus: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'COMPLETED'] },
                    entryCount: { type: 'integer' },
                    lockedCount: { type: 'integer' },
                    manualEditCount: { type: 'integer' },
                    publishable: { type: 'boolean' },
                    stats: { ...freeObject, nullable: true, description: 'Informational statistics (teacher gaps, single-lesson days, ...); not optimised' },
                  },
                },
              },
            },
          },
        },
        400: { description: 'Malformed version ID', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'The version belongs to another school', ...errorSchema },
        404: { description: 'Version not found', ...errorSchema },
        409: { description: 'SNAPSHOT_UNUSABLE: the stored snapshot cannot be used', ...refusalSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: timetableVersionController.validation.bind(timetableVersionController),
  });

  // ------------------------------------------------------------------
  // POST /api/timetable-versions/:id/publish : publish a draft (and archive the previous published version)
  // ------------------------------------------------------------------
  app.post<{ Params: VersionParams; Body: PublishBody }>('/timetable-versions/:id/publish', {
    schema: {
      operationId: 'publishTimetableVersion',
      tags: ['Timetable Version'],
      summary: 'Publish a draft timetable; the previously published version is archived',
      description:
        'One transaction: the draft becomes PUBLISHED and the version that was published until now becomes ARCHIVED, so an academic ' +
        'year never has two published versions and never loses its published version because a publish failed. The request names what ' +
        'the admin reviewed: `expectedRevision` (the draft) and `expectedPublishedVersionId` (the published version they saw, or null ' +
        'if there was none). Under locks the server re-checks the state, then normalizes the LIVE configuration and validates every ' +
        'lesson against it: a draft generated for a different configuration, or that no longer satisfies the hard constraints, is ' +
        'never published. Allowed for DRAFT and ACTIVE academic years, not COMPLETED ones. PUBLISHED and ARCHIVED versions are immutable ' +
        'and there is no unpublish, restore or archive operation. A retry after a lost response gets 409 VERSION_NOT_DRAFT with the ' +
        'current status: treat it as done. Refusals carry data.code: 409 VERSION_NOT_DRAFT, ACADEMIC_YEAR_NOT_EDITABLE, ' +
        'REVISION_CONFLICT, PUBLISHED_CHANGED, STALE_CONFIGURATION, VALIDATION_FAILED, SNAPSHOT_UNUSABLE; 503 BUSY (another request ' +
        'holds the year, for example a generation saving its result; retry).',
      security: [{ cookieAuth: [] }],
      params: idParams,
      body: {
        type: 'object',
        required: ['expectedRevision', 'expectedPublishedVersionId'],
        additionalProperties: false,
        properties: {
          expectedRevision: { type: 'integer', minimum: 1, description: 'The draft revision you reviewed' },
          expectedPublishedVersionId: { type: 'string', format: 'uuid', nullable: true, description: 'The published version of this academic year when you looked, or null if there was none' },
        },
      },
      response: {
        200: {
          description: 'Published',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                versionId: { type: 'string', format: 'uuid' },
                status: { type: 'string', enum: ['PUBLISHED'] },
                revision: revisionProperty,
                publishedAt: { type: 'string', format: 'date-time' },
                archivedVersionId: { type: 'string', format: 'uuid', nullable: true, description: 'The version that was archived by this publish, or null' },
                substitution: { type: 'object', additionalProperties: true, description: 'Automatic substitute assignment for the new version\'s cover requests, run after the publish committed: { status: COMPLETED, run: { considered, assigned, unfilled, conflicts, skippedPast } } or { status: FAILED, error } (the publish itself is unaffected; retry with POST /api/substitutions/auto-assign)' },
              },
            },
          },
        },
        400: { description: 'Malformed request', ...validationErrorSchema },
        401: { description: 'Authentication required', ...errorSchema },
        403: { description: 'The version belongs to another school', ...errorSchema },
        404: { description: 'Version not found', ...errorSchema },
        409: { description: 'State conflict (see the operation description for data.code)', ...refusalSchema },
        503: { description: 'BUSY: retry shortly', ...refusalSchema },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: timetableVersionController.publish.bind(timetableVersionController),
  });
}
