import { type FastifyRequest, type FastifyReply } from 'fastify';
import {
  scheduleConfigService,
  type ScheduleConfigDocument,
} from './schedule-config.service.js';
import {
  createScheduleConfigSchema,
  updateScheduleConfigSchema,
  listScheduleConfigsQuerySchema,
  scheduleConfigIdParamSchema,
  type CreateScheduleConfigBody,
  type UpdateScheduleConfigBody,
  type ListScheduleConfigsQuery,
  type ScheduleConfigIdParam,
} from './schedule-config.schema.js';
import { handleError } from '../../utils/errors.js';
import { type ApiSuccessResponse } from '../../types/api.js';

// NOTE: these routes opt out of Fastify's (type-coercing) Ajv validation, so every
// controller method MUST parse params, query and body with Zod itself.
export class ScheduleConfigController {
  /**
   * POST /api/schedule-configs
   */
  async createScheduleConfig(
    request: FastifyRequest<{ Body: CreateScheduleConfigBody }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const body = createScheduleConfigSchema.parse(request.body);
      const config = await scheduleConfigService.createScheduleConfig(request.admin.schoolId, body);
      const response: ApiSuccessResponse<ScheduleConfigDocument> = {
        success: true,
        message: 'Schedule configuration created successfully',
        data: config,
      };
      reply.status(201).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * GET /api/schedule-configs
   */
  async getScheduleConfigs(
    request: FastifyRequest<{ Querystring: ListScheduleConfigsQuery }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const query = listScheduleConfigsQuerySchema.parse(request.query);
      const configs = await scheduleConfigService.getScheduleConfigs(request.admin.schoolId, query);
      const response: ApiSuccessResponse<ScheduleConfigDocument[]> = {
        success: true,
        message: 'Schedule configurations retrieved successfully',
        data: configs,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * GET /api/schedule-configs/:id
   */
  async getScheduleConfig(
    request: FastifyRequest<{ Params: ScheduleConfigIdParam }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = scheduleConfigIdParamSchema.parse(request.params);
      const config = await scheduleConfigService.getScheduleConfigById(
        params.id,
        request.admin.schoolId
      );
      const response: ApiSuccessResponse<ScheduleConfigDocument> = {
        success: true,
        message: 'Schedule configuration retrieved successfully',
        data: config,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * PATCH /api/schedule-configs/:id
   */
  async updateScheduleConfig(
    request: FastifyRequest<{ Params: ScheduleConfigIdParam; Body: UpdateScheduleConfigBody }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = scheduleConfigIdParamSchema.parse(request.params);
      const body = updateScheduleConfigSchema.parse(request.body);
      const config = await scheduleConfigService.updateScheduleConfig(
        params.id,
        request.admin.schoolId,
        body
      );
      const response: ApiSuccessResponse<ScheduleConfigDocument> = {
        success: true,
        message: 'Schedule configuration updated successfully',
        data: config,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }
}

export const scheduleConfigController = new ScheduleConfigController();
