import { type FastifyRequest, type FastifyReply } from 'fastify';
import { academicYearService } from './academic-year.service.js';
import {
  createAcademicYearSchema,
  updateAcademicYearSchema,
  getAcademicYearParamsSchema,
  type CreateAcademicYearInput,
  type UpdateAcademicYearInput,
  type GetAcademicYearParams,
} from './academic-year.schema.js';
import { handleError } from '../../utils/errors.js';
import { type ApiSuccessResponse } from '../../types/api.js';
import { type AcademicYear } from '@prisma/client';

export class AcademicYearController {
  /**
   * Create a new academic year
   * POST /api/academic-years
   */
  async createAcademicYear(
    request: FastifyRequest<{ Body: CreateAcademicYearInput }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      // Ensure admin is authenticated
      if (!request.admin) {
        throw new Error('Authentication required');
      }

      // Validate request body
      const validatedData = createAcademicYearSchema.parse(request.body);

      // Create academic year using authenticated admin's school
      const academicYear = await academicYearService.createAcademicYear(
        request.admin.schoolId,
        validatedData
      );

      const response: ApiSuccessResponse<AcademicYear> = {
        success: true,
        message: 'Academic year created successfully',
        data: academicYear,
      };

      reply.status(201).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * Get all academic years for authenticated admin's school
   * GET /api/academic-years
   */
  async getAcademicYears(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      // Ensure admin is authenticated
      if (!request.admin) {
        throw new Error('Authentication required');
      }

      // Get academic years for admin's school
      const academicYears = await academicYearService.getAcademicYears(request.admin.schoolId);

      const response: ApiSuccessResponse<AcademicYear[]> = {
        success: true,
        message: 'Academic years retrieved successfully',
        data: academicYears,
      };

      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * Get academic year by ID
   * GET /api/academic-years/:id
   */
  async getAcademicYear(
    request: FastifyRequest<{ Params: GetAcademicYearParams }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      // Ensure admin is authenticated
      if (!request.admin) {
        throw new Error('Authentication required');
      }

      // Validate params
      const validatedParams = getAcademicYearParamsSchema.parse(request.params);

      // Get academic year with authorization check
      const academicYear = await academicYearService.getAcademicYearById(
        validatedParams.id,
        request.admin.schoolId
      );

      const response: ApiSuccessResponse<AcademicYear> = {
        success: true,
        message: 'Academic year retrieved successfully',
        data: academicYear,
      };

      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * Update academic year
   * PATCH /api/academic-years/:id
   */
  async updateAcademicYear(
    request: FastifyRequest<{ Params: GetAcademicYearParams; Body: UpdateAcademicYearInput }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      // Ensure admin is authenticated
      if (!request.admin) {
        throw new Error('Authentication required');
      }

      // Validate params
      const validatedParams = getAcademicYearParamsSchema.parse(request.params);

      // Validate body
      const validatedData = updateAcademicYearSchema.parse(request.body);

      // Update academic year with authorization check
      const academicYear = await academicYearService.updateAcademicYear(
        validatedParams.id,
        request.admin.schoolId,
        validatedData
      );

      const response: ApiSuccessResponse<AcademicYear> = {
        success: true,
        message: 'Academic year updated successfully',
        data: academicYear,
      };

      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }
}

export const academicYearController = new AcademicYearController();
