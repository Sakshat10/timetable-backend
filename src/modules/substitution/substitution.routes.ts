import { type FastifyInstance } from 'fastify';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { substitutionController as c } from './substitution.controller.js';

// `data` may be an object or an array: an empty schema serialises whatever the service returned
const ok = {} as const;
const errs = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    errors: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
  },
} as const;
const envelope = (description: string) => ({ description, type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: ok } }) as const;
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const common = {
  400: { description: 'Validation error (row/field specific in "errors")', ...errs },
  401: { description: 'Authentication required', ...errs },
  403: { description: 'The record belongs to another school', ...errs },
  404: { description: 'Not found', ...errs },
  409: { description: 'Conflict with the current state ("errors.code" says which)', ...errs },
} as const;
const query = (props: string[]) => ({ type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])) }) as const;

export async function substitutionRoutes(app: FastifyInstance): Promise<void> {
  const tag = ['Substitution'];
  const security = [{ cookieAuth: [] }];
  const pre = authMiddleware;

  // ----- absences -------------------------------------------------------------------------------------------------------------------------------
  app.post('/teacher-absences', {
    schema: {
      tags: tag, security, summary: 'Record a teacher absence',
      description:
        'Records that a teacher of your school is absent from startDate to endDate (inclusive calendar dates, YYYY-MM-DD, at most 366 days). scope FULL_DAY (default) covers every period; ' +
        'scope PERIODS needs fromPeriod and toPeriod (1-12) and applies to each day of the range. The lessons of the school\'s PUBLISHED timetable that fall inside the absence become OPEN cover ' +
        'requests (GET /api/substitutions); drafts are never used. 409 when the teacher already has an overlapping active absence (same dates and periods) or is assigned to cover a lesson ' +
        'inside it (an assignment made automatically gives way instead). An inactive teacher is not treated as absent; only a record makes them absent. ' +
        'AUTOMATIC SUBSTITUTION: unless autoAssign is false, the future lessons are then allocated together to the best free teachers (subject, grade eligibility, weekly workload, covers that day, consecutive periods, fairness); ' +
        'a free teacher who does not teach the subject may cover temporarily unless allowTemporaryCover is false; lessons nobody can take stay OPEN with data.automaticAllocation.covers[].attention. ' +
        'Existing response fields are unchanged; data.automaticAllocation is new. Retry with POST /teacher-absences/{id}/auto-assign.',
      body: { type: 'object', required: ['teacherId', 'startDate', 'endDate'] },
      response: { 201: envelope('Absence recorded; data.coverRequestsCreated says how many lessons need cover; data.automaticAllocation summarises the automatic assignment'), ...common },
    }, preHandler: pre, handler: c.createAbsence,
  });
  app.get('/teacher-absences', {
    schema: { tags: tag, security, summary: 'List absences', description: 'Absences of your school with the number of cover requests per status. Filters: teacherId, status, from, to (absences overlapping the window).', querystring: query(['teacherId', 'status', 'from', 'to']), response: { 200: envelope('Absences'), ...common } },
    preHandler: pre, handler: c.listAbsences,
  });
  app.get('/teacher-absences/:id', {
    schema: { tags: tag, security, summary: 'Get an absence', params: idParams, response: { 200: envelope('The absence'), ...common } },
    preHandler: pre, handler: c.getAbsence,
  });
  app.patch('/teacher-absences/:id', {
    schema: {
      tags: tag, security, summary: 'Change an absence', params: idParams,
      description: 'Change dates, periods or reason of an ACTIVE absence (the teacher cannot change). OPEN cover requests that fall outside the new definition are cancelled, new lessons get requests; 409 while an ASSIGNED substitution would fall outside it.',
      body: { type: 'object', minProperties: 1 }, response: { 200: envelope('Absence updated'), ...common },
    }, preHandler: pre, handler: c.updateAbsence,
  });
  app.post('/teacher-absences/:id/auto-assign', {
    schema: { tags: tag, security, summary: 'Run (or retry) automatic substitute assignment for an absence', params: idParams, body: { type: 'object', properties: { allowTemporaryCover: { type: 'boolean' } } },
      description: 'Allocates the absence\'s OPEN cover requests (future dates, published timetable) with the coordinated allocator. Idempotent and safe to retry: assigned requests (automatic or manual) are never touched. Returns the same summary as POST /teacher-absences.automaticAllocation.',
      response: { 200: envelope('{ totalAffectedLessons, assigned, automaticallyAssigned, unfilled, temporaryUnqualifiedCovers, covers[], run }'), ...common } },
    preHandler: pre, handler: c.autoAssignAbsence,
  });
  app.get('/teacher-absences/:id/substitution-summary', {
    schema: { tags: tag, security, summary: 'Current substitution result of an absence', params: idParams, description: 'Read only: affected lessons, how many are assigned (automatically / manually), unfilled (needs the admin, with the reason), temporary unqualified covers, and every cover request id with its status.', response: { 200: envelope('The summary'), ...common } },
    preHandler: pre, handler: c.absenceSummary,
  });
  app.post('/substitutions/auto-assign', {
    schema: { tags: tag, security, summary: 'Run automatic assignment for a date range', body: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, allowTemporaryCover: { type: 'boolean' } } },
      description: 'Allocates every OPEN cover request of your school in the range (default: all future dates), e.g. after a timetable was republished. Idempotent; manual assignments are never touched.', response: { 200: envelope('{ run }'), ...common } },
    preHandler: pre, handler: c.autoAssignRange,
  });
  app.get('/substitution-settings', {
    schema: { tags: tag, security, summary: 'Read the substitution settings', description: 'consecutivePeriodPolicy: ALLOW | PREFER_AVOID (default) | NEVER_ALLOW. How a substitute who would end with four or more consecutive teaching periods is treated.', response: { 200: envelope('{ consecutivePeriodPolicy, allowedValues }'), ...common } },
    preHandler: pre, handler: c.getSettings,
  });
  app.put('/substitution-settings', {
    schema: { tags: tag, security, summary: 'Change the substitution settings', body: { type: 'object', required: ['consecutivePeriodPolicy'], properties: { consecutivePeriodPolicy: { type: 'string', enum: ['ALLOW', 'PREFER_AVOID', 'NEVER_ALLOW'] } } },
      description: 'ALLOW: four consecutive periods are permitted. PREFER_AVOID: avoided while another teacher can take the lesson, used as a last resort (a manual assignment then needs confirmFourConsecutive). NEVER_ALLOW: never assigned, automatically or manually (409 FOUR_CONSECUTIVE_NOT_ALLOWED). Applies to future decisions only; existing assignments are not changed. It is not a weekly workload limit and does not change the normal timetable\'s constraints.',
      response: { 200: envelope('The settings'), ...common } },
    preHandler: pre, handler: c.updateSettings,
  });
  app.get('/substitution-events', {
    schema: { tags: tag, security, summary: 'Substitution events feed', querystring: query(['since', 'cursor', 'limit']),
      description: 'Persistent, school-scoped events for notifications: ABSENCE_RECORDED, ABSENCE_CANCELLED, SUBSTITUTE_AUTO_ASSIGNED, NO_SUBSTITUTE_AVAILABLE, ASSIGNMENT_CHANGED, SUBSTITUTE_REPLACED, ASSIGNMENT_CANCELLED, SUBSTITUTE_RELEASED. Oldest first, ordered by (time, id). Pass the returned nextCursor as cursor to continue exactly after the last event received (events written together share a timestamp, so nextSince alone can skip some; it is kept for compatibility). limit 1-500, default 100. Read only.',
      response: { 200: envelope('{ items, nextCursor, nextSince, hasMore }'), ...common } },
    preHandler: pre, handler: c.listEvents,
  });
  app.post('/teacher-absences/:id/cancel', {
    schema: { tags: tag, security, summary: 'Cancel an absence', params: idParams, description: 'Soft cancel (the record stays). OPEN cover requests are cancelled; 409 while any substitution is ASSIGNED for it.', response: { 200: envelope('Absence cancelled'), ...common } },
    preHandler: pre, handler: c.cancelAbsence,
  });

  // ----- unavailability -------------------------------------------------------------------------------------------------------------------------
  app.post('/teacher-unavailability', {
    schema: {
      tags: tag, security, summary: 'Mark a teacher unavailable for cover',
      description: 'The teacher is not absent but cannot take cover on a date: the whole day (omit periodNumber) or one period. 409 if they are already assigned to cover a lesson in that slot.',
      body: { type: 'object', required: ['teacherId', 'date'] }, response: { 201: envelope('Recorded'), ...common },
    }, preHandler: pre, handler: c.createUnavailability,
  });
  app.get('/teacher-unavailability', {
    schema: { tags: tag, security, summary: 'List unavailability', querystring: query(['teacherId', 'from', 'to', 'status']), response: { 200: envelope('Unavailability records'), ...common } },
    preHandler: pre, handler: c.listUnavailability,
  });
  app.delete('/teacher-unavailability/:id', {
    schema: { tags: tag, security, summary: 'Remove an unavailability mark', params: idParams, description: 'Soft: the record stays as CANCELLED. Assignments already made are not affected.', response: { 200: envelope('Removed'), ...common } },
    preHandler: pre, handler: c.cancelUnavailability,
  });

  // ----- cover requests (lessons needing cover) -------------------------------------------------------------------------------------------------
  app.get('/substitutions', {
    schema: {
      tags: tag, security, summary: 'List lessons needing cover (and the history)',
      description: 'Cover requests of your school, each a lesson of the PUBLISHED timetable on a date. All statuses by default (OPEN, ASSIGNED, CANCELLED, OBSOLETE); filter with status=OPEN,ASSIGNED, from, to, absentTeacherId, replacementTeacherId, absenceId, limit, offset. When a newer timetable version is published, requests of upcoming dates from the old version become OBSOLETE (history kept) and new ones are created from the new version; past dates are left as they were.',
      querystring: query(['from', 'to', 'status', 'absentTeacherId', 'replacementTeacherId', 'absenceId', 'limit', 'offset']), response: { 200: envelope('{ total, items }'), ...common },
    }, preHandler: pre, handler: c.listCovers,
  });
  app.get('/substitutions/:id', {
    schema: { tags: tag, security, summary: 'Get a cover request with its history', params: idParams, description: 'Includes the complete audit trail: every transition with who made it, when, and the teachers involved.', response: { 200: envelope('The request and data.history'), ...common } },
    preHandler: pre, handler: c.getCover,
  });
  app.get('/substitutions/:id/candidates', {
    schema: {
      tags: tag, security, summary: 'List valid replacement teachers', params: idParams, querystring: query(['includeExcluded']),
      description:
        'Teachers who may take the lesson (same school, active, qualified for the subject, eligible for the grade via ALL_GRADES or an eligibility row, not absent, not marked unavailable, no lesson of the published timetable and no other cover in that period), ' +
        'each labelled with a PRIORITY TIER and ordered by it. Tier 1 SAME_SUBJECT: the subject is the teacher\'s own (PRIMARY link) and the cover would not give them four consecutive teaching periods. Tier 2 OTHER_ELIGIBLE: qualified and eligible (SECONDARY link) without four in a row. ' +
        'Tier 3 LAST_RESORT: would end with four or more consecutive periods; OFFERED only when tiers 1 and 2 are empty, and assigning needs confirmFourConsecutive. Consecutive periods follow the school\'s period order and breaks and count both normal lessons and covers already assigned that day. ' +
        'Within a tier: shorter resulting run, fewer covers that day, name. Each candidate says why (explanation) and the exact consecutive periods (consecutive). When nobody can cover, data.message says why; includeExcluded=true lists every other teacher with the reason. Nothing is assigned automatically.',
      response: { 200: envelope('{ candidates (ranked, with tier), selection, excludedCounts, message?, excluded? }'), ...common },
    }, preHandler: pre, handler: c.getCandidates,
  });
  app.put('/substitutions/:id/assignment', {
    schema: {
      tags: tag, security, summary: 'Assign or reassign a replacement', params: idParams, body: { type: 'object', required: ['teacherId'], properties: { confirmFourConsecutive: { type: 'boolean', description: 'true to assign a last-resort teacher who would end with four or more consecutive teaching periods' } } },
      description: 'Assigns the teacher (OPEN request) or replaces the current one (ASSIGNED). The teacher is re-validated under locks with the same rules as the candidates list; a teacher who is not qualified/eligible is 400, one who is absent, unavailable, teaching or already booked in that period is 409. Two simultaneous assignments of one teacher to one slot cannot both succeed. The four-consecutive-periods impact is recomputed on the server under the locks: if the teacher would end with four or more in a row the answer is 409 FOUR_CONSECUTIVE_CONFIRMATION_REQUIRED (errors.periods lists them) unless confirmFourConsecutive is true; the warning never blocks by itself, and a confirmed last-resort assignment is noted in the history.',
      response: { 200: envelope('The updated request'), ...common },
    }, preHandler: pre, handler: c.assign,
  });
  app.delete('/substitutions/:id/assignment', {
    schema: { tags: tag, security, summary: 'Remove the replacement', params: idParams, description: 'ASSIGNED -> OPEN. The request stays; the history records who removed which teacher.', response: { 200: envelope('The updated request'), ...common } },
    preHandler: pre, handler: c.unassign,
  });
  app.post('/substitutions/:id/cancel', {
    schema: { tags: tag, security, summary: 'Cancel a cover request', params: idParams, body: { type: 'object' }, description: 'OPEN or ASSIGNED -> CANCELLED (no cover is needed for this lesson). Optional body { reason }.', response: { 200: envelope('The updated request'), ...common } },
    preHandler: pre, handler: c.cancelCover,
  });
}
