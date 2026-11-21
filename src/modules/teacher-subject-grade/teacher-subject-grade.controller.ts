import { type FastifyRequest, type FastifyReply } from 'fastify';
import {
  teacherSubjectGradeService,
  type TeacherSubjectGradeWithGrade,
} from './teacher-subject-grade.service.js';
import {
  createTeacherSubjectGradeSchema,
  teacherSubjectIdParamSchema,
  teacherSubjectGradeParamSchema,
  type CreateTeacherSubjectGradeInput,
  type TeacherSubjectIdParam,
  type TeacherSubjectGradeParam,
} from './teacher-subject-grade.schema.js';
import { handleError } from '../../utils/errors.js';
import { type ApiSuccessResponse } from '../../types/api.js';

export class TeacherSubjectGradeController {
  /**
   * POST /api/teacher-subjects/:teacherSubjectId/grades
   */
  async createEligibility(
    request: FastifyRequest<{ Params: TeacherSubjectIdParam; Body: CreateTeacherSubjectGradeInput }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = teacherSubjectIdParamSchema.parse(request.params);
      const body = createTeacherSubjectGradeSchema.parse(request.body);
      const eligibility = await teacherSubjectGradeService.createEligibility(
        request.admin.schoolId,
        params.teacherSubjectId,
        body
      );
      const response: ApiSuccessResponse<TeacherSubjectGradeWithGrade> = {
        success: true,
        message: 'Grade eligibility added successfully',
        data: eligibility,
      };
      reply.status(201).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * GET /api/teacher-subjects/:teacherSubjectId/grades
   */
  async getEligibility(
    request: FastifyRequest<{ Params: TeacherSubjectIdParam }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = teacherSubjectIdParamSchema.parse(request.params);
      const eligibility = await teacherSubjectGradeService.getEligibility(
        request.admin.schoolId,
        params.teacherSubjectId
      );
      const response: ApiSuccessResponse<TeacherSubjectGradeWithGrade[]> = {
        success: true,
        message: 'Grade eligibility retrieved successfully',
        data: eligibility,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * DELETE /api/teacher-subjects/:teacherSubjectId/grades/:gradeId
   */
  async deleteEligibility(
    request: FastifyRequest<{ Params: TeacherSubjectGradeParam }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = teacherSubjectGradeParamSchema.parse(request.params);
      await teacherSubjectGradeService.deleteEligibility(
        request.admin.schoolId,
        params.teacherSubjectId,
        params.gradeId
      );
      const response: ApiSuccessResponse<null> = {
        success: true,
        message: 'Grade eligibility removed successfully',
        data: null,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }
}

export const teacherSubjectGradeController = new TeacherSubjectGradeController();
