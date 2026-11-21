import { type FastifyRequest, type FastifyReply } from 'fastify';
import {
  sectionSubjectTeacherService,
  type SectionSubjectTeacherDetail,
} from './section-subject-teacher.service.js';
import {
  createSectionSubjectTeacherSchema,
  updateSectionSubjectTeacherSchema,
  listSectionSubjectTeachersQuerySchema,
  sectionSubjectTeacherIdParamSchema,
  type CreateSectionSubjectTeacherBody,
  type UpdateSectionSubjectTeacherBody,
  type ListSectionSubjectTeachersQuery,
  type SectionSubjectTeacherIdParam,
} from './section-subject-teacher.schema.js';
import { handleError } from '../../utils/errors.js';
import { type ApiSuccessResponse } from '../../types/api.js';

// NOTE: these routes opt out of Fastify's Ajv validation (see the routes file), so every
// controller method MUST parse params, query and body with Zod itself.
export class SectionSubjectTeacherController {
  /**
   * POST /api/section-subject-teachers
   */
  async createAssignment(
    request: FastifyRequest<{ Body: CreateSectionSubjectTeacherBody }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const body = createSectionSubjectTeacherSchema.parse(request.body);
      const assignment = await sectionSubjectTeacherService.createAssignment(
        request.admin.schoolId,
        body
      );
      const response: ApiSuccessResponse<SectionSubjectTeacherDetail> = {
        success: true,
        message: 'Teacher assigned to section subject successfully',
        data: assignment,
      };
      reply.status(201).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * GET /api/section-subject-teachers
   */
  async getAssignments(
    request: FastifyRequest<{ Querystring: ListSectionSubjectTeachersQuery }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const query = listSectionSubjectTeachersQuerySchema.parse(request.query);
      const assignments = await sectionSubjectTeacherService.getAssignments(
        request.admin.schoolId,
        query
      );
      const response: ApiSuccessResponse<SectionSubjectTeacherDetail[]> = {
        success: true,
        message: 'Section subject teacher assignments retrieved successfully',
        data: assignments,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * GET /api/section-subject-teachers/:id
   */
  async getAssignment(
    request: FastifyRequest<{ Params: SectionSubjectTeacherIdParam }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = sectionSubjectTeacherIdParamSchema.parse(request.params);
      const assignment = await sectionSubjectTeacherService.getAssignmentById(
        params.id,
        request.admin.schoolId
      );
      const response: ApiSuccessResponse<SectionSubjectTeacherDetail> = {
        success: true,
        message: 'Section subject teacher assignment retrieved successfully',
        data: assignment,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * PATCH /api/section-subject-teachers/:id
   */
  async updateAssignment(
    request: FastifyRequest<{
      Params: SectionSubjectTeacherIdParam;
      Body: UpdateSectionSubjectTeacherBody;
    }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = sectionSubjectTeacherIdParamSchema.parse(request.params);
      const body = updateSectionSubjectTeacherSchema.parse(request.body);
      const assignment = await sectionSubjectTeacherService.updateAssignment(
        params.id,
        request.admin.schoolId,
        body
      );
      const response: ApiSuccessResponse<SectionSubjectTeacherDetail> = {
        success: true,
        message: 'Section subject teacher assignment updated successfully',
        data: assignment,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * DELETE /api/section-subject-teachers/:id
   */
  async deleteAssignment(
    request: FastifyRequest<{ Params: SectionSubjectTeacherIdParam }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = sectionSubjectTeacherIdParamSchema.parse(request.params);
      await sectionSubjectTeacherService.deleteAssignment(params.id, request.admin.schoolId);
      const response: ApiSuccessResponse<null> = {
        success: true,
        message: 'Section subject teacher assignment deleted successfully',
        data: null,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }
}

export const sectionSubjectTeacherController = new SectionSubjectTeacherController();
