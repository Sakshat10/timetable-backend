import { type PrismaClient } from '@prisma/client';
import prisma from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import { isYearEditable } from './timetable-version.edit-core.js';
import { busyError, isLockTimeout, VersionRuleError } from './timetable-version.errors.js';
import { DAYS_OF_WEEK, type DeleteVersionBody, toVersionDetail, toVersionSummary, type EntryView, type VersionDetailView, type VersionSummaryView } from './timetable-version.schema.js';
import { type StalenessInfo } from './timetable-version.staleness-core.js';
import { TimetableVersionStalenessService } from './timetable-version.staleness-service.js';

/** The summary, plus (only when staleness was requested) the strict staleness of Phase 7D: the same answer as GET .../validation gives. */
export type VersionListItem = VersionSummaryView & { isStale?: boolean | null; staleReason?: StalenessInfo['reason'] };

const dayIndex = new Map<string, number>(DAYS_OF_WEEK.map((d, i) => [d, i]));

/** Read and delete generated timetable versions. Every method takes the school from the session, never from the client. */
export class TimetableVersionService {
  private readonly staleness: TimetableVersionStalenessService;

  constructor(private readonly db: PrismaClient = prisma) {
    this.staleness = new TimetableVersionStalenessService(db);
  }

  /**
   * GET /timetable-versions?academicYearId=&status=&includeStaleness= : newest first (version numbers are unique per year, so the order is total
   * and stable), without entries. `statuses` (Phase 7F-3) keeps only those statuses; omitted or empty: all. `includeStaleness` (opt-in) adds isStale and
   * staleReason to every returned version. 404 unknown year, 403 another school's year.
   */
  async list(schoolId: string, academicYearId: string, options: { statuses?: readonly string[] | undefined; includeStaleness?: boolean | undefined } = {}): Promise<VersionListItem[]> {
    const year = await this.db.academicYear.findUnique({ where: { id: academicYearId }, select: { schoolId: true } });
    if (!year) throw new AppError(404, 'Academic year not found');
    if (year.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this academic year');

    const versions = await this.db.timetableVersion.findMany({
      where: { schoolId, academicYearId, ...(options.statuses && options.statuses.length > 0 ? { status: { in: [...options.statuses] as Array<'DRAFT' | 'PUBLISHED' | 'ARCHIVED'> } } : {}) },
      orderBy: { versionNumber: 'desc' },
      omit: { inputSnapshot: true, solverDiagnostics: true },
    });
    // one aggregate for all versions: total, locked and manually edited lessons
    const ids = versions.map((v) => v.id);
    const sums = ids.length === 0 ? [] : await this.db.$queryRaw<Array<{ versionId: string; total: bigint; locked: bigint; manual: bigint }>>`
      SELECT "versionId", count(*) AS total, count(*) FILTER (WHERE "isLocked") AS locked, count(*) FILTER (WHERE "source" = 'MANUAL') AS manual
      FROM "timetable_entries" WHERE "versionId" = ANY(${ids}) GROUP BY "versionId"`;
    const byVersion = new Map(sums.map((r) => [r.versionId, { total: Number(r.total), locked: Number(r.locked), manual: Number(r.manual) }]));
    const items: VersionListItem[] = versions.map((v) => toVersionSummary(v, byVersion.get(v.id) ?? { total: 0, locked: 0, manual: 0 }));
    if (!options.includeStaleness || items.length === 0) return items;
    const answers = await this.staleness.assess(schoolId, academicYearId, ids);
    return items.map((item) => {
      const info = answers.get(item.id);
      return { ...item, isStale: info?.isStale ?? null, staleReason: info?.reason ?? 'ASSESSMENT_FAILED' };
    });
  }

  /** GET /timetable-versions/:id : the version with every entry. 404 unknown, 403 another school's version. */
  async get(schoolId: string, id: string): Promise<VersionDetailView> {
    const version = await this.db.timetableVersion.findUnique({ where: { id }, omit: { inputSnapshot: true } });
    if (!version) throw new AppError(404, 'Timetable version not found');
    if (version.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this timetable version');

    const rows = await this.db.timetableEntry.findMany({
      where: { versionId: id },
      select: { id: true, sectionId: true, subjectId: true, teacherId: true, subjectRequirementId: true, dayOfWeek: true, periodNumber: true, source: true, isLocked: true },
    });
    const entries: EntryView[] = rows
      .sort((a, b) => a.sectionId.localeCompare(b.sectionId) || (dayIndex.get(a.dayOfWeek) ?? 0) - (dayIndex.get(b.dayOfWeek) ?? 0) || a.periodNumber - b.periodNumber)
      .map((e) => ({ ...e, source: String(e.source) }));
    return toVersionDetail(version, entries);
  }

  /**
   * DELETE /timetable-versions/:id.
   *  - DRAFT: as before, no confirmation. The entries go with the version (FK cascade); the generation run that produced it stays (its versionId becomes NULL by the
   *    existing ON DELETE SET NULL; its stored resultSummary, which names the version, is not touched).
   *  - PUBLISHED or ARCHIVED: only with the explicit confirmation body (the version number typed back, the status and the revision the administrator was looking at), in an
   *    academic year that is still editable (DRAFT or ACTIVE; a COMPLETED year keeps its history), and only while no substitution cover request was made from the version.
   *    One transaction, in the same lock order as publishing (academic year FOR UPDATE, then the version FOR UPDATE), so a concurrent publish/delete is serialised and whichever
   *    runs second sees the new state. "Published" is the status itself (there is no separate pointer, and a partial unique index allows one per year), so deleting the published
   *    row leaves the year with NO published timetable; nothing is published in its place and no other version is touched (the only side effect on another row is the existing
   *    ON DELETE SET NULL of `clonedFromId` on drafts cloned from it, which only forgets the provenance).
   */
  async delete(schoolId: string, id: string, confirmation?: DeleteVersionBody, actorAdminId?: string): Promise<DeletedVersion> {
    const version = await this.db.timetableVersion.findUnique({ where: { id }, select: { schoolId: true, status: true, versionNumber: true, academicYearId: true } });
    if (!version) throw new AppError(404, 'Timetable version not found');
    if (version.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this timetable version');

    if (version.status === 'DRAFT') {
      // The status is part of the DELETE itself, so a version published between the check above and here is never removed by this unconfirmed path.
      const lessons = await this.db.timetableEntry.count({ where: { versionId: id } });
      const removed = await this.db.timetableVersion.deleteMany({ where: { id, schoolId, status: 'DRAFT' } });
      if (removed.count === 1) return { versionId: id, versionNumber: version.versionNumber, status: 'DRAFT', lessonsRemoved: lessons, publishedVersionNow: null, detachedClones: 0 };
      const now = await this.db.timetableVersion.findUnique({ where: { id }, select: { status: true } });
      if (!now) throw new AppError(404, 'Timetable version not found');
      throw confirmationRequired(now.status, version.versionNumber);
    }

    if (!confirmation) throw confirmationRequired(version.status, version.versionNumber);

    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_SECONDS}s'`);
        // 1. the academic year (the first lock of publish, generation and clone: they all serialise here)
        const years = await tx.$queryRaw<Array<{ status: 'DRAFT' | 'ACTIVE' | 'COMPLETED' }>>`SELECT "status"::text AS status FROM "academic_years" WHERE "id" = ${version.academicYearId} AND "schoolId" = ${schoolId} FOR UPDATE`;
        if (!years[0]) throw new AppError(404, 'Academic year not found');
        if (!isYearEditable(years[0].status)) throw new VersionRuleError(409, 'ACADEMIC_YEAR_NOT_EDITABLE', `The academic year is ${years[0].status.toLowerCase()}; its timetables are part of its history and can no longer be deleted`, { yearStatus: years[0].status });

        // 2. the version itself; everything below is judged on what it is NOW
        const rows = await tx.$queryRaw<Array<{ status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'; revision: number; versionNumber: number }>>`
          SELECT "status"::text AS status, "revision", "versionNumber" FROM "timetable_versions" WHERE "id" = ${id} AND "schoolId" = ${schoolId} FOR UPDATE`;
        const now = rows[0];
        if (!now) throw new AppError(404, 'Timetable version not found'); // deleted while we waited
        if (now.status === 'DRAFT') throw new VersionRuleError(409, 'STATUS_CHANGED', 'The timetable version is a draft now. Reload it and delete it as a draft', { status: now.status, revision: now.revision });
        if (now.status !== confirmation.expectedStatus) throw new VersionRuleError(409, 'STATUS_CHANGED', `The timetable version is ${now.status.toLowerCase()} now, not ${confirmation.expectedStatus.toLowerCase()}. Reload it and review before deleting`, { status: now.status, revision: now.revision });
        if (now.revision !== confirmation.expectedRevision) throw new VersionRuleError(409, 'REVISION_CONFLICT', 'The timetable version was changed by someone else. Reload it and review before deleting', { status: now.status, revision: now.revision });
        if (confirmation.confirmVersionNumber !== now.versionNumber) {
          throw new VersionRuleError(400, 'CONFIRMATION_MISMATCH', `The confirmation does not match: this is version ${now.versionNumber}. Type that number to confirm the deletion`, { versionNumber: now.versionNumber });
        }

        // 3. what history hangs off it. Cover requests (and their events) are substitution history made FROM this version's lessons; they are never cascade-deleted.
        const covers = await tx.coverRequest.groupBy({ by: ['status'], where: { timetableVersionId: id }, _count: { _all: true } });
        if (covers.length > 0) {
          const byStatus = Object.fromEntries(covers.map((c) => [c.status, c._count._all]));
          const total = covers.reduce((n, c) => n + c._count._all, 0);
          throw new VersionRuleError(409, 'VERSION_HAS_HISTORY', `This timetable version cannot be deleted: ${total} substitution cover request${total === 1 ? ' was' : 's were'} made from it (${Object.entries(byStatus).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ')}) and substitution history is never erased`, { coverRequests: byStatus, coverRequestTotal: total });
        }

        const [lessons, clones] = await Promise.all([tx.timetableEntry.count({ where: { versionId: id } }), tx.timetableVersion.count({ where: { clonedFromId: id } })]);
        await tx.timetableVersion.delete({ where: { id } });
        void actorAdminId;
        return { versionId: id, versionNumber: now.versionNumber, status: now.status, lessonsRemoved: lessons, publishedVersionNow: null, detachedClones: clones };
      }, { timeout: 20_000, maxWait: 10_000 });
    } catch (error) {
      if (isLockTimeout(error)) throw busyError();
      throw error;
    }
  }
}

/** What a deletion removed. `publishedVersionNow` is always null: deleting never publishes anything, so after deleting the published version the year has none. */
export interface DeletedVersion {
  versionId: string;
  versionNumber: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  lessonsRemoved: number;
  publishedVersionNow: null;
  detachedClones: number;
}

const LOCK_TIMEOUT_SECONDS = 5;

function confirmationRequired(status: string, versionNumber: number): VersionRuleError {
  const what = status.toLowerCase();
  return new VersionRuleError(
    409,
    'CONFIRMATION_REQUIRED',
    `Version ${versionNumber} is ${what}. Deleting a ${what} timetable is permanent and needs explicit confirmation: send { confirmVersionNumber: ${versionNumber}, expectedStatus: "${status}", expectedRevision } with the request`,
    { status, versionNumber }
  );
}

export const timetableVersionService = new TimetableVersionService();
