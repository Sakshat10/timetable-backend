import { type FastifyRequest, type FastifyReply } from 'fastify';
import { schoolService, type CreatedSchool } from './school.service.js';
import { createSchoolSchema, getSchoolParamsSchema, type CreateSchoolInput, type GetSchoolParams } from './school.schema.js';
import { handleError } from '../../utils/errors.js';
import { type ApiSuccessResponse } from '../../types/api.js';
import { type School } from '@prisma/client';

export class SchoolController {
  async createSchool(
    request: FastifyRequest<{ Body: CreateSchoolInput }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      // Validate request body
      const validatedData = createSchoolSchema.parse(request.body);

      // Create school
      const school = await schoolService.createSchool(validatedData);

      const response: ApiSuccessResponse<CreatedSchool> = {
        success: true,
        message: 'School created successfully',
        data: school,
      };

      reply.status(201).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  async getSchool(
    request: FastifyRequest<{ Params: GetSchoolParams }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      // Validate params
      const validatedParams = getSchoolParamsSchema.parse(request.params);

      // Get school with authorization check
      const school = await schoolService.getSchoolById(
        validatedParams.id,
        request.admin?.schoolId
      );

      const response: ApiSuccessResponse<School> = {
        success: true,
        message: 'School retrieved successfully',
        data: school,
      };

      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }
}

export const schoolController = new SchoolController();
