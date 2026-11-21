import { type FastifyRequest, type FastifyReply } from 'fastify';
import { adminService } from '../modules/admin/admin.service.js';
import { type ApiErrorResponse } from '../types/api.js';

/**
 * Authentication middleware
 * Validates session and attaches admin to request
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Get session token from cookie
  const sessionToken = request.cookies[adminService.getSessionCookieName()];

  if (!sessionToken) {
    const response: ApiErrorResponse = {
      success: false,
      message: 'Authentication required',
    };
    reply.status(401).send(response);
    return;
  }

  // Validate session
  const admin = await adminService.validateSession(sessionToken);

  if (!admin) {
    const response: ApiErrorResponse = {
      success: false,
      message: 'Invalid or expired session',
    };
    reply.status(401).send(response);
    return;
  }

  // Attach admin to request
  request.admin = {
    id: admin.id,
    schoolId: admin.schoolId,
    email: admin.email,
    name: admin.name,
  };
}
