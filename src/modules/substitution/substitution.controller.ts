import { type FastifyReply, type FastifyRequest } from 'fastify';
import { handleError } from '../../utils/errors.js';
import { substitutionService } from './substitution.service.js';
import {
  assignReplacementSchema,
  autoAssignBodySchema,
  autoAssignRangeBodySchema,
  listEventsQuerySchema,
  updateSettingsSchema,
  cancelCoverSchema,
  candidatesQuerySchema,
  createAbsenceSchema,
  createUnavailabilitySchema,
  idParamSchema,
  listAbsencesQuerySchema,
  listCoverQuerySchema,
  listUnavailabilityQuerySchema,
  updateAbsenceSchema,
} from './substitution.schema.js';

type Req = FastifyRequest<{ Body: unknown; Params: { id?: string }; Querystring: unknown }>;

function admin(request: FastifyRequest): { id: string; schoolId: string } {
  if (!request.admin) throw new Error('Authentication required');
  return { id: request.admin.id, schoolId: request.admin.schoolId };
}

/** Thin controller: parse, call the service, wrap. Every handler is school-scoped by the session's admin. */
async function run(reply: FastifyReply, status: number, message: string, work: () => Promise<unknown>): Promise<void> {
  try {
    const data = await work();
    reply.status(status).send({ success: true, message, data });
  } catch (error) {
    handleError(error, reply);
  }
}

export class SubstitutionController {
  createAbsence = (request: Req, reply: FastifyReply) => run(reply, 201, 'Absence recorded successfully', () => substitutionService.createAbsence(admin(request), createAbsenceSchema.parse(request.body)));
  listAbsences = (request: Req, reply: FastifyReply) => run(reply, 200, 'Absences retrieved successfully', () => substitutionService.listAbsences(admin(request).schoolId, listAbsencesQuerySchema.parse(request.query)));
  getAbsence = (request: Req, reply: FastifyReply) => run(reply, 200, 'Absence retrieved successfully', () => substitutionService.getAbsence(admin(request).schoolId, idParamSchema.parse(request.params).id));
  updateAbsence = (request: Req, reply: FastifyReply) => run(reply, 200, 'Absence updated successfully', () => substitutionService.updateAbsence(admin(request), idParamSchema.parse(request.params).id, updateAbsenceSchema.parse(request.body)));
  cancelAbsence = (request: Req, reply: FastifyReply) => run(reply, 200, 'Absence cancelled successfully', () => substitutionService.cancelAbsence(admin(request), idParamSchema.parse(request.params).id));

  autoAssignAbsence = (request: Req, reply: FastifyReply) => run(reply, 200, 'Automatic assignment completed', () => substitutionService.autoAssignAbsence(admin(request), idParamSchema.parse(request.params).id, autoAssignBodySchema.parse(request.body ?? {}).allowTemporaryCover !== false));
  absenceSummary = (request: Req, reply: FastifyReply) => run(reply, 200, 'Substitution summary retrieved successfully', () => substitutionService.absenceSummary(admin(request).schoolId, idParamSchema.parse(request.params).id));
  autoAssignRange = (request: Req, reply: FastifyReply) => run(reply, 200, 'Automatic assignment completed', async () => {
    const body = autoAssignRangeBodySchema.parse(request.body ?? {});
    return substitutionService.autoAssignRange(admin(request), { from: body.from, to: body.to }, body.allowTemporaryCover !== false);
  });
  listEvents = (request: Req, reply: FastifyReply) => run(reply, 200, 'Substitution events retrieved successfully', () => substitutionService.listEvents(admin(request).schoolId, listEventsQuerySchema.parse(request.query)));

  getSettings = (request: Req, reply: FastifyReply) => run(reply, 200, 'Substitution settings retrieved successfully', () => substitutionService.getSettings(admin(request).schoolId));
  updateSettings = (request: Req, reply: FastifyReply) => run(reply, 200, 'Substitution settings updated successfully', () => substitutionService.updateSettings(admin(request), updateSettingsSchema.parse(request.body)));

  createUnavailability = (request: Req, reply: FastifyReply) => run(reply, 201, 'Unavailability recorded successfully', () => substitutionService.createUnavailability(admin(request), createUnavailabilitySchema.parse(request.body)));
  listUnavailability = (request: Req, reply: FastifyReply) => run(reply, 200, 'Unavailability retrieved successfully', () => substitutionService.listUnavailability(admin(request).schoolId, listUnavailabilityQuerySchema.parse(request.query)));
  cancelUnavailability = (request: Req, reply: FastifyReply) => run(reply, 200, 'Unavailability removed successfully', () => substitutionService.cancelUnavailability(admin(request), idParamSchema.parse(request.params).id));

  listCovers = (request: Req, reply: FastifyReply) => run(reply, 200, 'Cover requests retrieved successfully', () => substitutionService.listCovers(admin(request).schoolId, listCoverQuerySchema.parse(request.query)));
  getCover = (request: Req, reply: FastifyReply) => run(reply, 200, 'Cover request retrieved successfully', () => substitutionService.getCover(admin(request).schoolId, idParamSchema.parse(request.params).id));
  getCandidates = (request: Req, reply: FastifyReply) => run(reply, 200, 'Replacement candidates retrieved successfully', () => substitutionService.getCandidates(admin(request).schoolId, idParamSchema.parse(request.params).id, candidatesQuerySchema.parse(request.query).includeExcluded === 'true'));
  assign = (request: Req, reply: FastifyReply) => run(reply, 200, 'Replacement assigned successfully', async () => {
    const body = assignReplacementSchema.parse(request.body);
    const result = await substitutionService.assign(admin(request), idParamSchema.parse(request.params).id, body.teacherId, body.confirmFourConsecutive === true);
    return 'selection' in result ? { ...result.cover, selection: result.selection } : result.cover;
  });
  unassign = (request: Req, reply: FastifyReply) => run(reply, 200, 'Replacement removed successfully', () => substitutionService.unassign(admin(request), idParamSchema.parse(request.params).id));
  cancelCover = (request: Req, reply: FastifyReply) => run(reply, 200, 'Cover request cancelled successfully', () => substitutionService.cancelCover(admin(request), idParamSchema.parse(request.params).id, cancelCoverSchema.parse(request.body ?? {}).reason));
}

export const substitutionController = new SubstitutionController();
