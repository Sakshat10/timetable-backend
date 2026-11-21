import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { registerSwagger } from './config/swagger.js';
import { parseTrustProxy, resolveCookieSecret, resolveSetupTokenTtlHours, toFastifyTrustProxy } from './config/security.js';
import { schoolRoutes } from './modules/school/school.routes.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { academicYearRoutes } from './modules/academic-year/academic-year.routes.js';
import { gradeRoutes } from './modules/grade/grade.routes.js';
import { streamRoutes } from './modules/stream/stream.routes.js';
import { sectionRoutes } from './modules/section/section.routes.js';
import { subjectRoutes } from './modules/subject/subject.routes.js';
import { teacherRoutes } from './modules/teacher/teacher.routes.js';
import { teacherSubjectRoutes } from './modules/teacher-subject/teacher-subject.routes.js';
import { teacherSubjectGradeRoutes } from './modules/teacher-subject-grade/teacher-subject-grade.routes.js';
import { subjectRequirementRoutes } from './modules/subject-requirement/subject-requirement.routes.js';
import { sectionSubjectTeacherRoutes } from './modules/section-subject-teacher/section-subject-teacher.routes.js';
import { scheduleConfigRoutes } from './modules/schedule-config/schedule-config.routes.js';
import { timetableFeasibilityRoutes } from './modules/timetable-feasibility/timetable-feasibility.routes.js';
import { timetableGenerationRoutes } from './modules/timetable-generation/timetable-generation.routes.js';
import { timetableVersionRoutes } from './modules/timetable-version/timetable-version.routes.js';
import { substitutionRoutes } from './modules/substitution/substitution.routes.js';
import { curriculumRoutes } from './modules/curriculum/curriculum.routes.js';
import { recordDeletionRoutes } from './modules/record-deletion/record-deletion.routes.js';

export interface BuildAppOptions {
  /** The environment to configure from. Defaults to process.env (tests pass their own). */
  env?: Record<string, string | undefined>;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? process.env;

  // Security configuration is validated BEFORE anything else: a bad COOKIE_SECRET or TRUST_PROXY stops the app here (never a silent fallback in production).
  const cookieSecret = resolveCookieSecret(env);
  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  resolveSetupTokenTtlHours(env); // fail fast on an invalid SETUP_TOKEN_TTL_HOURS

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL || 'info',
    },
    // false (the default): request.ip is the socket address and X-Forwarded-For is ignored. Only the proxies named in TRUST_PROXY may set it.
    trustProxy: toFastifyTrustProxy(trustProxy),
  });
  if (cookieSecret.warning) app.log.warn(cookieSecret.warning);

  // Register plugins
  await app.register(cors, {
    origin: env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  });

  await app.register(cookie, {
    secret: cookieSecret.secret,
    hook: 'onRequest',
  });

  // Register Swagger documentation
  await registerSwagger(app);

  // Health check endpoint
  app.get('/health', {
    schema: {
      tags: ['Health'],
      description: 'Health check endpoint to verify API availability',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  }, async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Register routes
  await app.register(adminRoutes, { prefix: '/api' });
  await app.register(schoolRoutes, { prefix: '/api' });
  await app.register(academicYearRoutes, { prefix: '/api' });
  await app.register(gradeRoutes, { prefix: '/api' });
  await app.register(streamRoutes, { prefix: '/api' });
  await app.register(sectionRoutes, { prefix: '/api' });
  await app.register(subjectRoutes, { prefix: '/api' });
  await app.register(teacherRoutes, { prefix: '/api' });
  await app.register(teacherSubjectRoutes, { prefix: '/api' });
  await app.register(teacherSubjectGradeRoutes, { prefix: '/api' });
  await app.register(subjectRequirementRoutes, { prefix: '/api' });
  await app.register(sectionSubjectTeacherRoutes, { prefix: '/api' });
  await app.register(scheduleConfigRoutes, { prefix: '/api' });
  await app.register(timetableFeasibilityRoutes, { prefix: '/api' });
  await app.register(timetableGenerationRoutes, { prefix: '/api' });
  await app.register(timetableVersionRoutes, { prefix: '/api' });
  await app.register(substitutionRoutes, { prefix: '/api' });
  await app.register(curriculumRoutes, { prefix: '/api' });
  await app.register(recordDeletionRoutes, { prefix: '/api' });

  return app;
}
