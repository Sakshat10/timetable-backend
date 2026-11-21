import { type FastifyRequest, type FastifyReply } from 'fastify';
import { subjectService } from './subject.service.js';
import {
  createSubjectSchema,
  bulkCreateSubjectsSchema,
  updateSubjectSchema,
  subjectIdParamSchema,
  type CreateSubjectBody,
  type UpdateSubjectBody,
  type SubjectIdParam,
} from './subject.schema.js';
import { handleError } from '../../utils/errors.js';
import { type ApiSuccessResponse } from '../../types/api.js';
import { type Subject } from '@prisma/client';

export class SubjectController {
  /**
   * POST /api/subjects
   */
  async createSubject(
    request: FastifyRequest<{ Body: CreateSubjectBody }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const body = createSubjectSchema.parse(request.body);
      const subject = await subjectService.createSubject(request.admin.schoolId, body);
      const response: ApiSuccessResponse<Subject> = {
        success: true,
        message: 'Subject created successfully',
        data: subject,
      };
      reply.status(201).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * POST /api/subjects/bulk
   */
  async createSubjectsBulk(request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const body = bulkCreateSubjectsSchema.parse(request.body);
      const subjects = await subjectService.createSubjectsBulk(request.admin.schoolId, body);
      const response: ApiSuccessResponse<Subject[]> = {
        success: true,
        message: `${subjects.length} subject(s) created successfully`,
        data: subjects,
      };
      reply.status(201).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * GET /api/subjects
   */
  async getSubjects(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const subjects = await subjectService.getSubjects(request.admin.schoolId);
      const response: ApiSuccessResponse<Subject[]> = {
        success: true,
        message: 'Subjects retrieved successfully',
        data: subjects,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * GET /api/subjects/:id
   */
  async getSubject(
    request: FastifyRequest<{ Params: SubjectIdParam }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = subjectIdParamSchema.parse(request.params);
      const subject = await subjectService.getSubjectById(params.id, request.admin.schoolId);
      const response: ApiSuccessResponse<Subject> = {
        success: true,
        message: 'Subject retrieved successfully',
        data: subject,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * PATCH /api/subjects/:id
   */
  async updateSubject(
    request: FastifyRequest<{ Params: SubjectIdParam; Body: UpdateSubjectBody }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = subjectIdParamSchema.parse(request.params);
      const body = updateSubjectSchema.parse(request.body);
      const subject = await subjectService.updateSubject(
        params.id,
        request.admin.schoolId,
        body
      );
      const response: ApiSuccessResponse<Subject> = {
        success: true,
        message: 'Subject updated successfully',
        data: subject,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }
}

export const subjectController = new SubjectController();
