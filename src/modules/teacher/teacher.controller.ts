import { type FastifyRequest, type FastifyReply } from 'fastify';
import { teacherService, type TeacherWithSubjects } from './teacher.service.js';
import {
  createTeacherSchema,
  bulkCreateTeachersSchema,
  idempotencyKeySchema,
  updateTeacherSchema,
  listTeachersQuerySchema,
  teacherIdParamSchema,
  type CreateTeacherBody,
  type UpdateTeacherBody,
  type ListTeachersQuery,
  type TeacherIdParam,
} from './teacher.schema.js';
import { AppError, handleError } from '../../utils/errors.js';
import { type ApiSuccessResponse } from '../../types/api.js';
import { type Teacher } from '@prisma/client';

export class TeacherController {
  /**
   * POST /api/teachers
   */
  async createTeacher(
    request: FastifyRequest<{ Body: CreateTeacherBody }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const body = createTeacherSchema.parse(request.body);
      const teacher = await teacherService.createTeacher(request.admin.schoolId, body);
      const response: ApiSuccessResponse<Teacher> = {
        success: true,
        message: 'Teacher created successfully',
        data: teacher,
      };
      reply.status(201).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * POST /api/teachers/bulk   (Idempotency-Key header required)
   */
  async createTeachersBulk(request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const key = idempotencyKeySchema.safeParse(request.headers['idempotency-key']);
      if (!key.success) {
        throw new AppError(400, 'Validation failed', { 'Idempotency-Key': key.error.issues.map((i) => i.message) });
      }
      const body = bulkCreateTeachersSchema.parse(request.body);
      const result = await teacherService.createTeachersBulk(request.admin.schoolId, body, key.data);
      if (result.replayed) reply.header('Idempotent-Replay', 'true');
      reply.status(result.replayed ? 200 : 201).send({
        success: true,
        message: result.replayed
          ? 'This request was already processed; returning the original result'
          : `${result.teachers.length} teacher(s) created successfully`,
        replayed: result.replayed,
        data: result.teachers,
      });
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * GET /api/teachers
   */
  async getTeachers(
    request: FastifyRequest<{ Querystring: ListTeachersQuery }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const query = listTeachersQuerySchema.parse(request.query);
      const teachers = await teacherService.getTeachers(request.admin.schoolId, query.isActive);
      const response: ApiSuccessResponse<TeacherWithSubjects[]> = {
        success: true,
        message: 'Teachers retrieved successfully',
        data: teachers,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * GET /api/teachers/:id
   */
  async getTeacher(
    request: FastifyRequest<{ Params: TeacherIdParam }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = teacherIdParamSchema.parse(request.params);
      const teacher = await teacherService.getTeacherById(params.id, request.admin.schoolId);
      const response: ApiSuccessResponse<Teacher> = {
        success: true,
        message: 'Teacher retrieved successfully',
        data: teacher,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * PATCH /api/teachers/:id
   */
  async updateTeacher(
    request: FastifyRequest<{ Params: TeacherIdParam; Body: UpdateTeacherBody }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) {
        throw new Error('Authentication required');
      }
      const params = teacherIdParamSchema.parse(request.params);
      const body = updateTeacherSchema.parse(request.body);
      const teacher = await teacherService.updateTeacher(
        params.id,
        request.admin.schoolId,
        body
      );
      const response: ApiSuccessResponse<Teacher> = {
        success: true,
        message: 'Teacher updated successfully',
        data: teacher,
      };
      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }
}

export const teacherController = new TeacherController();
