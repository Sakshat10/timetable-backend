import { type FastifyRequest, type FastifyReply } from 'fastify';
import { streamService } from './stream.service.js';
import {
  createStreamSchema,
  updateStreamSchema,
  streamIdParamSchema,
  gradeIdParamSchema,
  type CreateStreamInput,
  type UpdateStreamInput,
  type StreamIdParam,
  type GradeIdParam,
} from './stream.schema.js';
import { handleError } from '../../utils/errors.js';
import { type ApiSuccessResponse } from '../../types/api.js';
import { type Stream } from '@prisma/client';

export class StreamController {
  /**
   * POST /api/streams
   */
  async createStream(
    request: FastifyRequest<{ Body: CreateStreamInput }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const body = createStreamSchema.parse(request.body);
      const stream = await streamService.createStream(request.admin.schoolId, body);
      const response: ApiSuccessResponse<Stream> = {
        success: true,
        message: 'Stream created successfully',
        data: stream,
      };
      reply.status(201).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * GET /api/grades/:gradeId/streams
   */
  async getStreamsByGrade(
    request: FastifyRequest<{ Params: GradeIdParam }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = gradeIdParamSchema.parse(request.params);
      const streams = await streamService.getStreamsByGrade(
        request.admin.schoolId,
        params.gradeId
      );
      const response: ApiSuccessResponse<Stream[]> = {
        success: true,
        message: 'Streams retrieved successfully',
        data: streams,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * GET /api/streams/:id
   */
  async getStream(
    request: FastifyRequest<{ Params: StreamIdParam }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = streamIdParamSchema.parse(request.params);
      const stream = await streamService.getStreamById(
        params.id,
        request.admin.schoolId
      );
      const response: ApiSuccessResponse<Stream> = {
        success: true,
        message: 'Stream retrieved successfully',
        data: stream,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * PATCH /api/streams/:id
   */
  async updateStream(
    request: FastifyRequest<{ Params: StreamIdParam; Body: UpdateStreamInput }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = streamIdParamSchema.parse(request.params);
      const body = updateStreamSchema.parse(request.body);
      const stream = await streamService.updateStream(
        params.id,
        request.admin.schoolId,
        body
      );
      const response: ApiSuccessResponse<Stream> = {
        success: true,
        message: 'Stream updated successfully',
        data: stream,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }
}

export const streamController = new StreamController();
