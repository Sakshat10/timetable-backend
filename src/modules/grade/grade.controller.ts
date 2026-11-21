import { type FastifyRequest, type FastifyReply } from 'fastify';
import { gradeService } from './grade.service.js';
import { gradeStructureService } from './grade-structure.service.js';
import { bulkGradeStructureSchema } from './grade-structure.schema.js';
import {
  createGradeSchema,
  updateGradeSchema,
  getGradeParamsSchema,
  getGradesQuerySchema,
  type CreateGradeInput,
  type UpdateGradeInput,
  type GetGradeParams,
  type GetGradesQuery,
} from './grade.schema.js';
import { handleError } from '../../utils/errors.js';
import { type ApiSuccessResponse } from '../../types/api.js';
import { type Grade } from '@prisma/client';

export class GradeController {
  /**
   * Create grades with their streams and sections in one atomic request
   * POST /api/grades/bulk
   */
  async createGradeStructure(request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const body = bulkGradeStructureSchema.parse(request.body);
      const result = await gradeStructureService.createGradeStructure(request.admin.schoolId, body);
      const sections = result.grades.reduce((n, g) => n + g.sections.length, 0);
      const streams = result.grades.reduce((n, g) => n + g.streams.length, 0);
      reply.status(201).send({
        success: true,
        message: `${result.grades.length} grade(s), ${streams} stream(s) and ${sections} section(s) created successfully`,
        data: result,
      });
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * Create a new grade
   * POST /api/grades
   */
  async createGrade(
    request: FastifyRequest<{ Body: CreateGradeInput }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      // Ensure admin is authenticated
      if (!request.admin) {
        throw new Error('Authentication required');
      }

      // Validate request body
      const validatedData = createGradeSchema.parse(request.body);

      // Create grade using authenticated admin's school
      const grade = await gradeService.createGrade(request.admin.schoolId, validatedData);

      const response: ApiSuccessResponse<Grade> = {
        success: true,
        message: 'Grade created successfully',
        data: grade,
      };

      reply.status(201).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * Get all grades for authenticated admin's school
   * GET /api/grades
   */
  async getGrades(
    request: FastifyRequest<{ Querystring: GetGradesQuery }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      // Ensure admin is authenticated
      if (!request.admin) {
        throw new Error('Authentication required');
      }

      // Validate query parameters
      const validatedQuery = getGradesQuerySchema.parse(request.query);

      // Get grades for admin's school
      const grades = await gradeService.getGrades(
        request.admin.schoolId,
        validatedQuery.academicYearId
      );

      const response: ApiSuccessResponse<Grade[]> = {
        success: true,
        message: 'Grades retrieved successfully',
        data: grades,
      };

      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * Get grade by ID
   * GET /api/grades/:id
   */
  async getGrade(
    request: FastifyRequest<{ Params: GetGradeParams }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      // Ensure admin is authenticated
      if (!request.admin) {
        throw new Error('Authentication required');
      }

      // Validate params
      const validatedParams = getGradeParamsSchema.parse(request.params);

      // Get grade with authorization check
      const grade = await gradeService.getGradeById(
        validatedParams.id,
        request.admin.schoolId
      );

      const response: ApiSuccessResponse<Grade> = {
        success: true,
        message: 'Grade retrieved successfully',
        data: grade,
      };

      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * Update grade
   * PATCH /api/grades/:id
   */
  async updateGrade(
    request: FastifyRequest<{ Params: GetGradeParams; Body: UpdateGradeInput }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      // Ensure admin is authenticated
      if (!request.admin) {
        throw new Error('Authentication required');
      }

      // Validate params
      const validatedParams = getGradeParamsSchema.parse(request.params);

      // Validate body
      const validatedData = updateGradeSchema.parse(request.body);

      // Update grade with authorization check
      const grade = await gradeService.updateGrade(
        validatedParams.id,
        request.admin.schoolId,
        validatedData
      );

      const response: ApiSuccessResponse<Grade> = {
        success: true,
        message: 'Grade updated successfully',
        data: grade,
      };

      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }
}

export const gradeController = new GradeController();
