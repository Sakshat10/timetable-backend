import { type FastifyRequest, type FastifyReply } from 'fastify';
import {
  subjectRequirementService,
  type SubjectRequirementDetail,
} from './subject-requirement.service.js';
import {
  createSubjectRequirementSchema,
  updateSubjectRequirementSchema,
  listSubjectRequirementsQuerySchema,
  subjectRequirementIdParamSchema,
  type CreateSubjectRequirementBody,
  type UpdateSubjectRequirementBody,
  type ListSubjectRequirementsQuery,
  type SubjectRequirementIdParam,
} from './subject-requirement.schema.js';
import { handleError } from '../../utils/errors.js';
import { type ApiSuccessResponse } from '../../types/api.js';

// NOTE: these routes opt out of Fastify's (type-coercing) Ajv validation, so every
// controller method MUST parse params, query and body with Zod itself.
export class SubjectRequirementController {
  /**
   * POST /api/subject-requirements
   */
  async createSubjectRequirement(
    request: FastifyRequest<{ Body: CreateSubjectRequirementBody }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const body = createSubjectRequirementSchema.parse(request.body);
      const requirement = await subjectRequirementService.createSubjectRequirement(
        request.admin.schoolId,
        body
      );
      const response: ApiSuccessResponse<SubjectRequirementDetail> = {
        success: true,
        message: 'Subject requirement created successfully',
        data: requirement,
      };
      reply.status(201).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * GET /api/subject-requirements
   */
  async getSubjectRequirements(
    request: FastifyRequest<{ Querystring: ListSubjectRequirementsQuery }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const query = listSubjectRequirementsQuerySchema.parse(request.query);
      const requirements = await subjectRequirementService.getSubjectRequirements(
        request.admin.schoolId,
        query
      );
      const response: ApiSuccessResponse<SubjectRequirementDetail[]> = {
        success: true,
        message: 'Subject requirements retrieved successfully',
        data: requirements,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * GET /api/subject-requirements/:id
   */
  async getSubjectRequirement(
    request: FastifyRequest<{ Params: SubjectRequirementIdParam }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = subjectRequirementIdParamSchema.parse(request.params);
      const requirement = await subjectRequirementService.getSubjectRequirementById(
        params.id,
        request.admin.schoolId
      );
      const response: ApiSuccessResponse<SubjectRequirementDetail> = {
        success: true,
        message: 'Subject requirement retrieved successfully',
        data: requirement,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * PATCH /api/subject-requirements/:id
   */
  async updateSubjectRequirement(
    request: FastifyRequest<{
      Params: SubjectRequirementIdParam;
      Body: UpdateSubjectRequirementBody;
    }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = subjectRequirementIdParamSchema.parse(request.params);
      const body = updateSubjectRequirementSchema.parse(request.body);
      const requirement = await subjectRequirementService.updateSubjectRequirement(
        params.id,
        request.admin.schoolId,
        body
      );
      const response: ApiSuccessResponse<SubjectRequirementDetail> = {
        success: true,
        message: 'Subject requirement updated successfully',
        data: requirement,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * DELETE /api/subject-requirements/:id
   */
  async deleteSubjectRequirement(
    request: FastifyRequest<{ Params: SubjectRequirementIdParam }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = subjectRequirementIdParamSchema.parse(request.params);
      await subjectRequirementService.deleteSubjectRequirement(
        params.id,
        request.admin.schoolId
      );
      const response: ApiSuccessResponse<null> = {
        success: true,
        message: 'Subject requirement deleted successfully',
        data: null,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }
}

export const subjectRequirementController = new SubjectRequirementController();
