import { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifySchemaCompiler } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { handleError } from '../../utils/errors.js';
import { recordDeletionService as svc } from './record-deletion.service.js';

// The controller validates the id with Zod (the project's standard field-level 400); Fastify's own validator must not coerce or pre-empt it
const deferToZodValidator: FastifySchemaCompiler<unknown> = () => (data) => ({ value: data });
const idParam = z.object({ id: z.string().uuid('Invalid ID format') });

const errs = {
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, errors: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } } },
} as const;
const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const ok = (description: string) => ({ description, type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: { type: 'object', nullable: true, additionalProperties: true } } }) as const;

type Req = FastifyRequest<{ Params: unknown }>;

export async function recordDeletionRoutes(app: FastifyInstance): Promise<void> {
  const tag = ['Record management'];
  const security = [{ cookieAuth: [] }];

  const register = (path: string, summary: string, description: string, conflict: string, work: (schoolId: string, id: string) => Promise<unknown>, doneMessage: string, draftOnly = true) => {
    app.delete(path, {
      schema: {
        tags: tag, security, summary, description, params,
        response: {
          200: ok(doneMessage),
          400: { description: draftOnly ? 'Invalid ID, or the academic year is not in DRAFT status' : 'Invalid ID', ...errs },
          401: { description: 'Authentication required', ...errs },
          403: { description: 'The record belongs to another school', ...errs },
          404: { description: 'Not found', ...errs },
          409: { description: conflict, ...errs },
        },
      },
      validatorCompiler: deferToZodValidator,
      preHandler: authMiddleware,
      handler: async (request: Req, reply: FastifyReply) => {
        try {
          if (!request.admin) throw new Error('Authentication required');
          const { id } = idParam.parse(request.params);
          const data = await work(request.admin.schoolId, id);
          reply.status(200).send({ success: true, message: doneMessage, data: data ?? null });
        } catch (error) {
          handleError(error, reply);
        }
      },
    });
  };

  register('/grades/:id', 'Delete a grade',
    'Permanently deletes a grade that nothing depends on. Refused with 409 (errors.blockedBy lists what) while it still has sections, streams, subject requirements or teacher grade eligibility entries. The academic year must be DRAFT.',
    'The grade still has sections, streams, requirements or teacher eligibility entries', (s, id) => svc.deleteGrade(s, id), 'Grade deleted successfully');
  register('/sections/:id', 'Delete a section',
    'Permanently deletes a section that nothing depends on. Refused with 409 while teacher assignments, selected-sections requirements, substitution cover requests or timetable lessons (in any version, draft or published) reference it. The academic year must be DRAFT.',
    'Assignments, requirement scopes, cover requests or timetable lessons reference the section', (s, id) => svc.deleteSection(s, id), 'Section deleted successfully');
  register('/streams/:id', 'Delete a stream',
    'Permanently deletes a stream that has no sections and no subject requirements (they are never cascade-deleted or silently detached). The academic year must be DRAFT.',
    'The stream still has sections or subject requirements', (s, id) => svc.deleteStream(s, id), 'Stream deleted successfully');
  register('/subjects/:id', 'Delete a subject',
    'Permanently deletes a subject that is unused. Refused with 409 while curriculum requirements, teacher links, substitution cover requests or timetable lessons reference it. Subjects are school-wide, so every academic year is considered.',
    'Requirements, teacher links, cover requests or timetable lessons reference the subject', (s, id) => svc.deleteSubject(s, id), 'Subject deleted successfully', false);
  register('/teachers/:id', 'Delete a teacher',
    'Permanently deletes a teacher with no history: no section assignments, timetable lessons, substitution cover requests, absences or unavailability entries. Their subject links (qualifications) are removed with them (data.removedSubjectLinks). To stop giving a teacher new work while keeping their history, deactivate instead with PATCH /api/teachers/:id { "isActive": false } (and reactivate the same way).',
    'The teacher has assignments, timetable lessons, cover requests, absences or unavailability entries', (s, id) => svc.deleteTeacher(s, id), 'Teacher deleted successfully', false);
  register('/academic-years/:id', 'Delete an academic year',
    'Permanently deletes a DRAFT academic year that is empty: no grades, no timetable versions and no generation runs. Its schedule configuration (periods, days, breaks) is removed with it. Active and completed years can never be deleted.',
    'The year still has grades, timetable versions or generation runs', (s, id) => svc.deleteAcademicYear(s, id), 'Academic year deleted successfully');
  register('/schedule-configs/:id', 'Delete (reset) a schedule configuration',
    'Removes the periods, days and breaks of a DRAFT academic year so the schedule can be set up again. Refused with 409 while a timetable version exists for the year or a generation is queued or running. Editing in place (PATCH) is the usual way to change it.',
    'A timetable version exists for the year, or a generation is in progress', (s, id) => svc.deleteScheduleConfig(s, id), 'Schedule configuration deleted successfully');
}
