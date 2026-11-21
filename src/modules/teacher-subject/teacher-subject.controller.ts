import { type FastifyRequest, type FastifyReply } from 'fastify';
import { teacherSubjectService, type TeacherSubjectWithSubject } from './teacher-subject.service.js';
import {
  createTeacherSubjectSchema,
  updateTeacherSubjectSchema,
  teacherIdParamSchema,
  teacherSubjectIdParamSchema,
  type CreateTeacherSubjectInput,
  type UpdateTeacherSubjectInput,
  type TeacherIdParam,
  type TeacherSubjectIdParam,
} from './teacher-subject.schema.js';
import { handleError } from '../../utils/errors.js';
import { type ApiSuccessResponse } from '../../types/api.js';

export class TeacherSubjectController {
  /**
   * POST /api/teachers/:teacherId/subjects
   */
  async createTeacherSubject(
    request: FastifyRequest<{ Params: TeacherIdParam; Body: CreateTeacherSubjectInput }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = teacherIdParamSchema.parse(request.params);
      const body = createTeacherSubjectSchema.parse(request.body);
      const teacherSubject = await teacherSubjectService.createTeacherSubject(
        request.admin.schoolId,
        params.teacherId,
        body
      );
      const response: ApiSuccessResponse<TeacherSubjectWithSubject> = {
        success: true,
        message: 'Subject added to teacher successfully',
        data: teacherSubject,
      };
      reply.status(201).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * GET /api/teachers/:teacherId/subjects
   */
  async getTeacherSubjects(
    request: FastifyRequest<{ Params: TeacherIdParam }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = teacherIdParamSchema.parse(request.params);
      const teacherSubjects = await teacherSubjectService.getTeacherSubjects(
        request.admin.schoolId,
        params.teacherId
      );
      const response: ApiSuccessResponse<TeacherSubjectWithSubject[]> = {
        success: true,
        message: 'Teacher subjects retrieved successfully',
        data: teacherSubjects,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * PATCH /api/teacher-subjects/:id
   */
  async updateTeacherSubject(
    request: FastifyRequest<{ Params: TeacherSubjectIdParam; Body: UpdateTeacherSubjectInput }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = teacherSubjectIdParamSchema.parse(request.params);
      const body = updateTeacherSubjectSchema.parse(request.body);
      const teacherSubject = await teacherSubjectService.updateTeacherSubject(
        params.id,
        request.admin.schoolId,
        body
      );
      const response: ApiSuccessResponse<TeacherSubjectWithSubject> = {
        success: true,
        message: 'Teacher subject updated successfully',
        data: teacherSubject,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * DELETE /api/teacher-subjects/:id
   */
  async deleteTeacherSubject(request: FastifyRequest<{ Params: TeacherSubjectIdParam }>, reply: FastifyReply): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = teacherSubjectIdParamSchema.parse(request.params);
      await teacherSubjectService.deleteTeacherSubject(params.id, request.admin.schoolId);
      const response: ApiSuccessResponse<null> = {
        success: true,
        message: 'Subject removed from teacher successfully',
        data: null,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }
}

export const teacherSubjectController = new TeacherSubjectController();
