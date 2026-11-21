import { type FastifyRequest, type FastifyReply } from 'fastify';
import { handleError } from '../../utils/errors.js';
import { type ApiErrorResponse, type ApiSuccessResponse } from '../../types/api.js';
import { AppErrorWithData, timetableGenerationService, type AcceptedGeneration } from './timetable-generation.service.js';
import {
  generationParamsSchema,
  listGenerationsQuerySchema,
  startGenerationSchema,
  type GenerationParams,
  type GenerationRunView,
  type ListGenerationsQuery,
  type StartGenerationBody,
} from './timetable-generation.schema.js';

// NOTE: these routes opt out of Fastify's Ajv validation (see the routes file), so the controller MUST parse with Zod itself.
export class TimetableGenerationController {
  /** Errors that carry structured data (NOT_READY report, existing run id, Retry-After) keep the standard envelope plus `data`. */
  private fail(error: unknown, reply: FastifyReply): void {
    if (error instanceof AppErrorWithData) {
      for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
      const body: ApiErrorResponse & { data?: unknown } = { success: false, message: error.message };
      if (error.data !== null && error.data !== undefined) body.data = error.data;
      reply.status(error.statusCode).send(body);
      return;
    }
    handleError(error, reply);
  }

  /** POST /api/timetable-generations */
  async start(request: FastifyRequest<{ Body: StartGenerationBody }>, reply: FastifyReply): Promise<void> {
    try {
      if (!request.admin) throw new Error('Authentication required');
      const body = startGenerationSchema.parse(request.body ?? {});
      const accepted = await timetableGenerationService.start({ id: request.admin.id, schoolId: request.admin.schoolId }, body);
      const response: ApiSuccessResponse<AcceptedGeneration> = {
        success: true,
        message: 'Timetable generation accepted',
        data: accepted,
      };
      reply.header('Location', `/api/timetable-generations/${accepted.generationRunId}`).status(202).send(response);
    } catch (error) {
      this.fail(error, reply);
    }
  }

  /** GET /api/timetable-generations/:id */
  async get(request: FastifyRequest<{ Params: GenerationParams }>, reply: FastifyReply): Promise<void> {
    try {
      if (!request.admin) throw new Error('Authentication required');
      const { id } = generationParamsSchema.parse(request.params);
      const run = await timetableGenerationService.get(request.admin.schoolId, id);
      const response: ApiSuccessResponse<GenerationRunView> = { success: true, message: 'Timetable generation retrieved successfully', data: run };
      reply.status(200).send(response);
    } catch (error) {
      this.fail(error, reply);
    }
  }

  /** GET /api/timetable-generations?academicYearId= */
  async list(request: FastifyRequest<{ Querystring: ListGenerationsQuery }>, reply: FastifyReply): Promise<void> {
    try {
      if (!request.admin) throw new Error('Authentication required');
      const query = listGenerationsQuerySchema.parse(request.query);
      const runs = await timetableGenerationService.list(request.admin.schoolId, query.academicYearId, query.limit);
      const response: ApiSuccessResponse<GenerationRunView[]> = { success: true, message: 'Timetable generations retrieved successfully', data: runs };
      reply.status(200).send(response);
    } catch (error) {
      this.fail(error, reply);
    }
  }
}

export const timetableGenerationController = new TimetableGenerationController();
