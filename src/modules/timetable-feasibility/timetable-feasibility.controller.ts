import { type FastifyRequest, type FastifyReply } from 'fastify';
import { timetableFeasibilityService } from './timetable-feasibility.service.js';
import { feasibilityQuerySchema, type FeasibilityQueryBody, type FeasibilityReport } from './timetable-feasibility.schema.js';
import { handleError } from '../../utils/errors.js';
import { type ApiSuccessResponse } from '../../types/api.js';

// NOTE: this route opts out of Fastify's Ajv validation (see the routes file), so the controller
// MUST parse the query with Zod itself.
export class TimetableFeasibilityController {
  /**
   * GET /api/timetable-feasibility?academicYearId=
   */
  async checkFeasibility(
    request: FastifyRequest<{ Querystring: FeasibilityQueryBody }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const query = feasibilityQuerySchema.parse(request.query);
      const report = await timetableFeasibilityService.checkFeasibility(
        request.admin.schoolId,
        query.academicYearId
      );
      const response: ApiSuccessResponse<FeasibilityReport> = {
        success: true,
        message: report.status === 'READY'
          ? 'Configuration is ready for timetable generation'
          : 'Configuration is not ready for timetable generation',
        data: report,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }
}

export const timetableFeasibilityController = new TimetableFeasibilityController();
