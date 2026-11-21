import { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

export async function registerSwagger(app: FastifyInstance): Promise<void> {
  // Register Swagger plugin
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'School Timetable Maker API',
        description: 'Backend API for the School Timetable Maker application. Provides endpoints for managing schools, admin authentication, academic years, grades, streams, sections, subjects, teachers, teacher eligibility, subject requirements, section subject teacher assignments, the schedule configuration, the timetable feasibility report, timetable generation and generated timetable versions.',
        version: '1.0.0',
      },
      servers: [
        {
          url: 'http://localhost:4000',
          description: 'Development server',
        },
      ],
      tags: [
        { name: 'Health', description: 'Health check endpoints' },
        { name: 'School', description: 'School management endpoints' },
        { name: 'Admin', description: 'Admin authentication endpoints' },
        { name: 'Academic Year', description: 'Academic year management endpoints' },
        { name: 'Grade', description: 'Grade management endpoints' },
        { name: 'Stream', description: 'Stream management endpoints (optional grade subdivisions)' },
        { name: 'Section', description: 'Section management endpoints (class groups within a grade or stream)' },
        { name: 'Subject', description: 'Subject management endpoints (school-level subject masters)' },
        { name: 'Teacher', description: 'Teacher management endpoints (school-level teacher masters)' },
        { name: 'Teacher Subject', description: 'Teacher to subject association endpoints' },
        { name: 'Teacher Subject Grade', description: 'Teacher subject grade eligibility endpoints (academic-year specific)' },
        { name: 'Subject Requirement', description: 'Weekly period requirements per grade or stream and subject (academic-year specific)' },
        { name: 'Section Subject Teacher', description: 'Which teacher teaches which subject to which section (academic-year specific, configuration only)' },
        { name: 'Schedule Config', description: 'The standard weekly time grid per academic year: working days, periods and timing events' },
        { name: 'Timetable Feasibility', description: 'Read-only pre-generation readiness report for an academic year (not a timetable)' },
        { name: 'Timetable Generation', description: 'Asynchronous timetable generation: queue a run for a DRAFT academic year, then poll its status' },
        { name: 'Curriculum', description: 'The curriculum of a grade or stream: which subjects, how many periods a week, which sections (the WHAT of the timetable; teachers are separate)' },
        { name: 'Record management', description: 'Permanent deletion of unused records (grades, sections, streams, subjects, teachers, academic years, schedule configurations). Always dependency-checked; records with history are retired (teachers: deactivate), never erased' },
        { name: 'Substitution', description: 'Teacher absences, lessons needing cover (from the published timetable), replacement candidates and assignments' },
        { name: 'Timetable Version', description: 'Generated timetable versions of an academic year: list, read and delete drafts' },
      ],
      components: {
        securitySchemes: {
          cookieAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: 'session_token',
            description: 'Session cookie (HTTP-only, set by login endpoint)',
          },
        },
      },
    },
  });

  // Register Swagger UI
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      persistAuthorization: true,
    },
    staticCSP: true,
    transformStaticCSP: (header: string) => header,
  });
}
