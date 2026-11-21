import { type FastifyRequest, type FastifyReply } from 'fastify';
import { adminService } from './admin.service.js';
import { registerAdminSchema, loginAdminSchema, createAdminSchema, type RegisterAdminInput, type LoginAdminInput, type CreateAdminInput } from './admin.schema.js';
import { handleError } from '../../utils/errors.js';
import { type ApiSuccessResponse } from '../../types/api.js';
import { type Admin } from '@prisma/client';

export class AdminController {
  /**
   * Register a new admin
   */
  async register(
    request: FastifyRequest<{ Body: RegisterAdminInput }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      // Validate request body
      const validatedData = registerAdminSchema.parse(request.body);

      // Register admin
      const admin = await adminService.registerAdmin(validatedData);

      const response: ApiSuccessResponse<Omit<Admin, 'passwordHash'>> = {
        success: true,
        message: 'Admin registered successfully',
        data: admin,
      };

      reply.status(201).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * Create another admin for the CALLER'S school (authenticated). The school comes from the session, never from the request body.
   */
  async createAdmin(
    request: FastifyRequest<{ Body: CreateAdminInput }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      if (!request.admin) throw new Error('Authentication required');
      const validatedData = createAdminSchema.parse(request.body ?? {});

      const admin = await adminService.createAdminForSchool(request.admin.schoolId, validatedData);

      const response: ApiSuccessResponse<Omit<Admin, 'passwordHash'>> = {
        success: true,
        message: 'Admin created successfully',
        data: admin,
      };

      reply.status(201).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * Login admin
   */
  async login(
    request: FastifyRequest<{ Body: LoginAdminInput }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      // Validate request body
      const validatedData = loginAdminSchema.parse(request.body);

      // Login admin
      const { admin, sessionToken } = await adminService.loginAdmin(validatedData);

      // Set session cookie
      const isProduction = process.env.NODE_ENV === 'production';
      reply.setCookie(adminService.getSessionCookieName(), sessionToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'strict' : 'lax',
        path: '/',
        maxAge: adminService.getSessionDuration() / 1000, // Convert to seconds
      });

      const response: ApiSuccessResponse<Omit<Admin, 'passwordHash'>> = {
        success: true,
        message: 'Login successful',
        data: admin,
      };

      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * Logout admin
   */
  async logout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      // Get session token from cookie
      const sessionToken = request.cookies[adminService.getSessionCookieName()];

      if (sessionToken) {
        // Delete session from database
        await adminService.logoutAdmin(sessionToken);
      }

      // Clear cookie
      reply.clearCookie(adminService.getSessionCookieName(), { path: '/' });

      const response: ApiSuccessResponse<null> = {
        success: true,
        message: 'Logout successful',
        data: null,
      };

      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }

  /**
   * Get current admin (me)
   */
  async getMe(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      // Admin is already attached by auth middleware
      if (!request.admin) {
        throw new Error('Admin not found in request');
      }

      const response: ApiSuccessResponse<typeof request.admin> = {
        success: true,
        message: 'Admin retrieved successfully',
        data: request.admin,
      };

      reply.status(200).send(response);
    } catch (error) {
      handleError(error, reply);
    }
  }
}

export const adminController = new AdminController();
