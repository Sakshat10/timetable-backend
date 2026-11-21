import { type FastifyRequest, type FastifyReply } from 'fastify';
import { handleError } from '../../utils/errors.js';
import { type ApiErrorResponse, type ApiSuccessResponse } from '../../types/api.js';
import { timetableVersionService, type DeletedVersion, type VersionListItem } from './timetable-version.service.js';
import { timetableVersionEditService, type LocksResult, type MoveResult } from './timetable-version.edit-service.js';
import { substitutionService } from '../substitution/substitution.service.js';
import { timetableVersionPublishService, type PublishResult, type ValidationReport } from './timetable-version.publish-service.js';
import { timetableVersionCloneService, type CloneResult } from './timetable-version.clone-service.js';
import { timetableVersionViewService, type TimetableView } from './timetable-version.view-service.js';
import { VersionRuleError } from './timetable-version.errors.js';
import {
  deleteVersionBodySchema,
  listVersionsQuerySchema,
  locksBodySchema,
  moveBodySchema,
  publishBodySchema,
  cloneBodySchema,
  type CloneBodyInput,
  timetableViewQuerySchema,
  type TimetableViewQueryInput,
  versionParamsSchema,
  type ListVersionsQuery,
  type LocksBody,
  type MoveBody,
  type PublishBody,
  type VersionDetailView,
  type VersionParams,
  type VersionSummaryView,
} from './timetable-version.schema.js';

// NOTE: these routes opt out of Fastify's Ajv validation (see the routes file), so the controller MUST parse with Zod itself.
export class TimetableVersionController {
  /** Rule refusals keep the standard envelope and add `data.code` (stable) plus bounded details; everything else is the shared handler. */
  private fail(error: unknown, reply: FastifyReply): void {
    if (error instanceof VersionRuleError) {
      for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
      const body: ApiErrorResponse & { data: Record<string, unknown> } = { success: false, message: error.message, data: { code: error.code, ...error.details } };
      reply.status(error.statusCode).send(body);
      return;
    }
    handleError(error, reply);
  }

  async list(request: FastifyRequest<{ Querystring: ListVersionsQuery }>, reply: FastifyReply): Promise<void> {
    try {
      if (!request.admin) throw new Error('Authentication required');
      const query = listVersionsQuerySchema.parse(request.query);
      const versions = await timetableVersionService.list(request.admin.schoolId, query.academicYearId, { statuses: query.status, includeStaleness: query.includeStaleness });
      const response: ApiSuccessResponse<VersionListItem[]> = { success: true, message: 'Timetable versions retrieved successfully', data: versions };
      reply.status(200).send(response);
    } catch (error) {
      this.fail(error, reply);
    }
  }

  async get(request: FastifyRequest<{ Params: VersionParams }>, reply: FastifyReply): Promise<void> {
    try {
      if (!request.admin) throw new Error('Authentication required');
      const { id } = versionParamsSchema.parse(request.params);
      const version = await timetableVersionService.get(request.admin.schoolId, id);
      const response: ApiSuccessResponse<VersionDetailView> = { success: true, message: 'Timetable version retrieved successfully', data: version };
      reply.status(200).send(response);
    } catch (error) {
      this.fail(error, reply);
    }
  }

  async delete(request: FastifyRequest<{ Params: VersionParams }>, reply: FastifyReply): Promise<void> {
    try {
      if (!request.admin) throw new Error('Authentication required');
      const { id } = versionParamsSchema.parse(request.params);
      const body = request.body === undefined || request.body === null ? undefined : deleteVersionBodySchema.parse(request.body);
      const result = await timetableVersionService.delete(request.admin.schoolId, id, body, request.admin.id);
      request.log.info({ event: 'timetable.version.deleted', adminId: request.admin.id, schoolId: request.admin.schoolId, ...result }, 'timetable version deleted');
      const response: ApiSuccessResponse<DeletedVersion> = { success: true, message: 'Timetable version deleted successfully', data: result };
      reply.status(200).send(response);
    } catch (error) {
      this.fail(error, reply);
    }
  }

  /** POST /api/timetable-versions/:id/clone */
  async clone(request: FastifyRequest<{ Params: VersionParams; Body: CloneBodyInput }>, reply: FastifyReply): Promise<void> {
    try {
      if (!request.admin) throw new Error('Authentication required');
      const { id } = versionParamsSchema.parse(request.params);
      const body = cloneBodySchema.parse(request.body ?? {});
      const result = await timetableVersionCloneService.clone({ id: request.admin.id, schoolId: request.admin.schoolId }, id, body.lockMode, { includeStaleness: body.includeStaleness });
      const response: ApiSuccessResponse<CloneResult> = { success: true, message: 'Timetable version cloned into a new draft', data: result };
      reply.header('Location', `/api/timetable-versions/${result.id}`).status(201).send(response);
    } catch (error) {
      this.fail(error, reply);
    }
  }

  /** GET /api/timetable-versions/:id/timetable */
  async timetable(request: FastifyRequest<{ Params: VersionParams; Querystring: TimetableViewQueryInput }>, reply: FastifyReply): Promise<void> {
    try {
      if (!request.admin) throw new Error('Authentication required');
      const { id } = versionParamsSchema.parse(request.params);
      const query = timetableViewQuerySchema.parse(request.query);
      const view = await timetableVersionViewService.view(request.admin.schoolId, id, query);
      const response: ApiSuccessResponse<TimetableView> = { success: true, message: 'Timetable view retrieved successfully', data: view };
      reply.status(200).send(response);
    } catch (error) {
      this.fail(error, reply);
    }
  }

  /** POST /api/timetable-versions/:id/moves */
  async move(request: FastifyRequest<{ Params: VersionParams; Body: MoveBody }>, reply: FastifyReply): Promise<void> {
    try {
      if (!request.admin) throw new Error('Authentication required');
      const { id } = versionParamsSchema.parse(request.params);
      const body = moveBodySchema.parse(request.body ?? {});
      const result = await timetableVersionEditService.move(request.admin.schoolId, id, body);
      const response: ApiSuccessResponse<MoveResult> = { success: true, message: result.mode === 'SWAP' ? 'Lessons swapped successfully' : 'Lesson moved successfully', data: result };
      reply.status(200).send(response);
    } catch (error) {
      this.fail(error, reply);
    }
  }

  /** PUT /api/timetable-versions/:id/locks */
  async setLocks(request: FastifyRequest<{ Params: VersionParams; Body: LocksBody }>, reply: FastifyReply): Promise<void> {
    try {
      if (!request.admin) throw new Error('Authentication required');
      const { id } = versionParamsSchema.parse(request.params);
      const body = locksBodySchema.parse(request.body ?? {});
      const result = await timetableVersionEditService.setLocks(request.admin.schoolId, id, body);
      const response: ApiSuccessResponse<LocksResult> = { success: true, message: result.changed > 0 ? (result.locked ? 'Lessons locked successfully' : 'Lessons unlocked successfully') : 'No change: the lessons were already in the requested state', data: result };
      reply.status(200).send(response);
    } catch (error) {
      this.fail(error, reply);
    }
  }

  /** GET /api/timetable-versions/:id/validation */
  async validation(request: FastifyRequest<{ Params: VersionParams }>, reply: FastifyReply): Promise<void> {
    try {
      if (!request.admin) throw new Error('Authentication required');
      const { id } = versionParamsSchema.parse(request.params);
      const report = await timetableVersionPublishService.validate(request.admin.schoolId, id);
      const response: ApiSuccessResponse<ValidationReport> = { success: true, message: report.valid && !report.isStale ? 'The timetable is valid and current' : 'The timetable has validation findings', data: report };
      reply.status(200).send(response);
    } catch (error) {
      this.fail(error, reply);
    }
  }

  /** POST /api/timetable-versions/:id/publish */
  async publish(request: FastifyRequest<{ Params: VersionParams; Body: PublishBody }>, reply: FastifyReply): Promise<void> {
    try {
      if (!request.admin) throw new Error('Authentication required');
      const { id } = versionParamsSchema.parse(request.params);
      const body = publishBodySchema.parse(request.body ?? {});
      const result = await timetableVersionPublishService.publish({ id: request.admin.id, schoolId: request.admin.schoolId }, id, body);
      // After the commit: reconcile and allocate cover requests for the new version. It never throws and never touches the publish result.
      const substitution = await substitutionService.afterPublish({ id: request.admin.id, schoolId: request.admin.schoolId }, result.versionId);
      const response: ApiSuccessResponse<PublishResult & { substitution: typeof substitution }> = { success: true, message: 'Timetable published successfully', data: { ...result, substitution } };
      reply.status(200).send(response);
    } catch (error) {
      this.fail(error, reply);
    }
  }
}

export const timetableVersionController = new TimetableVersionController();
