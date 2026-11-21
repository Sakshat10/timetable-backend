import { type FastifyRequest, type FastifyReply } from 'fastify';
import { sectionService } from './section.service.js';
import {
  createSectionSchema,
  updateSectionSchema,
  sectionIdParamSchema,
  gradeIdParamSchema,
  type CreateSectionInput,
  type UpdateSectionInput,
  type SectionIdParam,
  type GradeIdParam,
} from './section.schema.js';
import { handleError } from '../../utils/errors.js';
import { type ApiSuccessResponse } from '../../types/api.js';
import { type SectionWithStream } from './section.service.js';

export class SectionController {
  /**
   * POST /api/sections
   */
  async createSection(
    request: FastifyRequest<{ Body: CreateSectionInput }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const body = createSectionSchema.parse(request.body);
      const section = await sectionService.createSection(request.admin.schoolId, body);
      const response: ApiSuccessResponse<SectionWithStream> = {
        success: true,
        message: 'Section created successfully',
        data: section,
      };
      reply.status(201).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * GET /api/grades/:gradeId/sections
   */
  async getSectionsByGrade(
    request: FastifyRequest<{ Params: GradeIdParam }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = gradeIdParamSchema.parse(request.params);
      const sections = await sectionService.getSectionsByGrade(
        request.admin.schoolId,
        params.gradeId
      );
      const response: ApiSuccessResponse<SectionWithStream[]> = {
        success: true,
        message: 'Sections retrieved successfully',
        data: sections,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * GET /api/sections/:id
   */
  async getSection(
    request: FastifyRequest<{ Params: SectionIdParam }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = sectionIdParamSchema.parse(request.params);
      const section = await sectionService.getSectionById(
        params.id,
        request.admin.schoolId
      );
      const response: ApiSuccessResponse<SectionWithStream> = {
        success: true,
        message: 'Section retrieved successfully',
        data: section,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * PATCH /api/sections/:id
   */
  async updateSection(
    request: FastifyRequest<{ Params: SectionIdParam; Body: UpdateSectionInput }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = sectionIdParamSchema.parse(request.params);
      const body = updateSectionSchema.parse(request.body);
      const section = await sectionService.updateSection(
        params.id,
        request.admin.schoolId,
        body
      );
      const response: ApiSuccessResponse<SectionWithStream> = {
        success: true,
        message: 'Section updated successfully',
        data: section,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }
}

export const sectionController = new SectionController();
