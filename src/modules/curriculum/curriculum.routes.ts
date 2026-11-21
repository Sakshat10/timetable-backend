import { type FastifyInstance } from 'fastify';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { curriculumController as c } from './curriculum.controller.js';

const ok = {} as const; // `data` is an object whose shape is documented in the module README
const envelope = (description: string) => ({ description, type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: ok } }) as const;
const errs = {
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, errors: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } } },
} as const;
const common = {
  400: { description: 'Validation error (row-specific in "errors", e.g. "requirements.2.periodsPerWeek")', ...errs },
  401: { description: 'Authentication required', ...errs },
  403: { description: 'The record belongs to another school', ...errs },
  404: { description: 'Not found', ...errs },
  409: { description: 'Teacher assignments depend on what would be removed or restricted (errors.blockedBy)', ...errs },
} as const;

export async function curriculumRoutes(app: FastifyInstance): Promise<void> {
  const tags = ['Curriculum'];
  const security = [{ cookieAuth: [] }];
  const preHandler = authMiddleware;

  app.get('/curriculum', {
    schema: {
      tags, security, summary: 'Curriculum overview of an academic year',
      description:
        'Read-only. For every grade of the year: its streams and sections, and for each grade (or stream) its curriculum: every subject with weekly periods, optional/compulsory, the sections it applies to ' +
        'and how widely it applies (COMMON: required in more than one grade; GRADE_SPECIFIC; STREAM_SPECIFIC: only some streams of the grade; SECTION_SPECIFIC: selected sections), plus each section\'s ' +
        'total weekly periods. "subjects" shows where each subject is used (one subject identity across grades). "issues" flags configuration for review: a grade/stream with sections but no requirements, a ' +
        'curriculum without sections, a section whose weekly demand exceeds the schedule\'s slots, a grade with mixed streamed/non-streamed sections. The curriculum says WHAT is taught; teachers are separate.',
      querystring: { type: 'object', required: ['academicYearId'], properties: { academicYearId: { type: 'string' } } },
      response: { 200: envelope('The overview'), ...common },
    }, preHandler, handler: c.getOverview,
  });

  app.put('/curriculum/grades/:gradeId', {
    schema: {
      tags, security, summary: 'Set the complete curriculum of a grade (or one stream of it)',
      description:
        'Makes the curriculum of the grade (non-streamed) or of one stream of it (body "streamId", required for a streamed grade) EXACTLY the given list, atomically: subjects are added, changed and removed in one ' +
        'transaction, or nothing changes. Each line is { subjectId, periodsPerWeek (1-40), isOptional?, sectionScope? (ALL_SECTIONS default | SELECTED_SECTIONS), sectionIds? } with the same rules as ' +
        'POST /api/subject-requirements (the stream must belong to the grade; selected sections must be in this grade and exactly this stream). The year must be DRAFT. Removing a subject, or restricting its ' +
        'sections, is refused with 409 (errors.blockedBy) while teacher assignments depend on it. Only subject requirements change: no teacher-subject link, eligibility or published timetable is touched. ' +
        'With "dryRun": true the plan (create/update/remove/unchanged) is returned and nothing is written. Changing the curriculum makes existing drafts stale (the generation input changes).',
      params: { type: 'object', required: ['gradeId'], properties: { gradeId: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['requirements'] },
      response: { 200: envelope('{ applied, plan, requirements? }'), ...common },
    }, preHandler, handler: c.replace,
  });

  app.post('/curriculum/copy', {
    schema: {
      tags, security, summary: 'Copy a curriculum from another grade/stream',
      description:
        'Adds the source grade/stream\'s subjects (with their periods and optional flag) to the target grade/stream, which must be in a DRAFT year of the same school (the source may be of an earlier year). Never ' +
        'overwrites: subjects the target already requires are kept and reported (ALREADY_REQUIRED); requirements restricted to selected sections are not copied, because their sections belong to the source ' +
        '(SECTION_SPECIFIC_NOT_COPIED). "dryRun": true reports without writing. Streams follow the same rules as in the other endpoints.',
      body: { type: 'object', required: ['fromGradeId', 'toGradeId'] },
      response: { 200: envelope('{ applied, created, skipped }'), ...common },
    }, preHandler, handler: c.copy,
  });
}
