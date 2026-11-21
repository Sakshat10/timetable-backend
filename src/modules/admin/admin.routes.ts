import { type FastifyInstance, type FastifySchemaCompiler } from 'fastify';
import { adminController } from './admin.controller.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { authRateLimiter, registrationRateLimiter } from '../../middleware/rate-limit.middleware.js';
import { type CreateAdminInput, type LoginAdminInput, type RegisterAdminInput } from './admin.schema.js';

// POST /admins validates with Zod in the controller (strict: unknown fields such as schoolId are a 400 in the standard envelope), not with
// Ajv, which would silently strip them.
const deferToZodValidator: FastifySchemaCompiler<unknown> = () => (data) => ({ value: data });

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // POST /admin/register - Register new admin
  app.post<{ Body: RegisterAdminInput }>('/admin/register', {
    schema: {
      tags: ['Admin'],
      summary: 'Register the first admin of a school (setup token required)',
      description:
        'Creates the FIRST admin of a school. It needs the one-time setup token that was returned, once, when the school was created ' +
        '(POST /api/schools), or that an operator issued with the recovery command. The token is single-use, bound to this school and expires ' +
        '(24 hours by default). It is consumed only if the admin is actually created: a validation error does not use it up. ' +
        'Every reason a token is refused (unknown school, wrong token, expired, already used) gives the same 401, so the response says nothing ' +
        'about which schools exist. A school that already has an admin refuses a second registration (409): further admins are added by an ' +
        'authenticated admin with POST /api/admins. Rate-limited to 3 per hour per client.',
      body: {
        type: 'object',
        required: ['schoolId', 'setupToken', 'name', 'email', 'password'],
        properties: {
          schoolId: {
            type: 'string',
            format: 'uuid',
            description: 'School UUID',
          },
          setupToken: {
            type: 'string',
            pattern: '^stk_[A-Za-z0-9_-]{43}$',
            description: 'The one-time setup token of this school (shown once in the school-creation response)',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            description: 'Admin name',
          },
          email: {
            type: 'string',
            format: 'email',
            description: 'Admin email',
          },
          password: {
            type: 'string',
            minLength: 8,
            maxLength: 100,
            description: 'Password (min 8 chars, must contain uppercase, lowercase, and number)',
          },
        },
      },
      response: {
        201: {
          description: 'Admin registered successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                schoolId: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                email: { type: 'string', format: 'email' },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
        400: {
          description: 'Validation error',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            errors: { type: 'object' },
          },
        },
        401: {
          description: 'Invalid or expired setup token (the same answer for an unknown school, a wrong, expired or already used token)',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        409: {
          description: 'The school already has an administrator',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        429: {
          description: 'Rate limit exceeded',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
    preHandler: registrationRateLimiter,
    handler: adminController.register.bind(adminController),
  });

  // POST /admins - Create another admin in the caller's own school (PROTECTED)
  app.post<{ Body: CreateAdminInput }>('/admins', {
    schema: {
      tags: ['Admin'],
      summary: 'Create another admin in your school',
      description:
        'An authenticated admin adds another admin to THEIR OWN school. The school always comes from the session: the body has no schoolId, and a ' +
        'schoolId (or any other unknown field) is rejected with 400. Same email and password rules as registration. The new admin can then log in with ' +
        'the school UUID, their email and password.',
      security: [{ cookieAuth: [] }],
      body: {
        type: 'object',
        required: ['name', 'email', 'password'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200, description: 'Admin name' },
          email: { type: 'string', format: 'email', description: 'Admin email (unique within the school)' },
          password: { type: 'string', minLength: 8, maxLength: 100, description: 'Password (min 8 chars, must contain uppercase, lowercase, and number)' },
        },
      },
      response: {
        201: {
          description: 'Admin created',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                schoolId: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                email: { type: 'string', format: 'email' },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
        400: { description: 'Validation error (including an unknown field such as schoolId)', type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' }, errors: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } } } },
        401: { description: 'Authentication required', type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } },
        409: { description: 'An admin with this email already exists for this school', type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } },
      },
    },
    validatorCompiler: deferToZodValidator,
    preHandler: authMiddleware,
    handler: adminController.createAdmin.bind(adminController),
  });

  // POST /admin/login - Admin login
  app.post<{ Body: LoginAdminInput }>('/admin/login', {
    schema: {
      tags: ['Admin'],
      summary: 'Admin login',
      description: 'Login as admin and receive session cookie (rate-limited to 5 per 15 minutes)',
      body: {
        type: 'object',
        required: ['schoolId', 'email', 'password'],
        properties: {
          schoolId: {
            type: 'string',
            format: 'uuid',
            description: 'School UUID',
          },
          email: {
            type: 'string',
            format: 'email',
            description: 'Admin email',
          },
          password: {
            type: 'string',
            description: 'Admin password',
          },
        },
      },
      response: {
        200: {
          description: 'Login successful (session cookie set)',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                schoolId: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                email: { type: 'string', format: 'email' },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
        401: {
          description: 'Invalid credentials',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        429: {
          description: 'Rate limit exceeded',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
    preHandler: authRateLimiter,
    handler: adminController.login.bind(adminController),
  });

  // POST /admin/logout - Admin logout
  app.post('/admin/logout', {
    schema: {
      tags: ['Admin'],
      summary: 'Admin logout',
      description: 'Logout and clear session cookie',
      response: {
        200: {
          description: 'Logout successful',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'null' },
          },
        },
      },
    },
    handler: adminController.logout.bind(adminController),
  });

  // GET /admin/me - Get current admin
  app.get('/admin/me', {
    schema: {
      tags: ['Admin'],
      summary: 'Get current admin',
      description: 'Get authenticated admin information (requires authentication)',
      security: [{ cookieAuth: [] }],
      response: {
        200: {
          description: 'Admin retrieved successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                schoolId: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                email: { type: 'string', format: 'email' },
              },
            },
          },
        },
        401: {
          description: 'Authentication required',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
    preHandler: authMiddleware,
    handler: adminController.getMe.bind(adminController),
  });
}
