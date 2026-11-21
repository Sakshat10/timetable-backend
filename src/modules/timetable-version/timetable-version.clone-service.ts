import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import prisma from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import { claimDraftSlot } from '../timetable-generation/timetable-generation.draft-slots.js';
import { resolveRunnerConfig } from '../timetable-generation/timetable-generation.runner-config.js';
import { checkCloneAllowed, type LockMode } from './timetable-version.clone-core.js';
import { type YearStatus } from './timetable-version.edit-core.js';
import { resolveOwnedVersion } from './timetable-version.edit-service.js';
import { busyError, isLockTimeout, VersionRuleError } from './timetable-version.errors.js';
import { toVersionSummary, type VersionSummaryView } from './timetable-version.schema.js';
import { assessmentFailed, type StalenessInfo } from './timetable-version.staleness-core.js';
import { TimetableVersionStalenessService } from './timetable-version.staleness-service.js';

const LOCK_TIMEOUT_SECONDS = 5;
const TX_OPTIONS = { maxWait: 15_000, timeout: 60_000 } as const;

export interface CloneResult extends VersionSummaryView {
  clonedFromId: string;
  clonedFromVersionNumber: number;
  lockMode: LockMode;
  /** The clone carries the source's frozen period times (false for a legacy source that has none). */
  periodTimesCaptured: boolean;
  /** ONLY when requested (includeStaleness: true): the clone's strict staleness, the same answer as GET .../validation gives for it. */
  staleness?: { isStale: boolean | null; reason: StalenessInfo['reason'] };
}

export interface CloneServiceDeps {
  prisma?: PrismaClient;
  env?: Record<string, string | undefined>;
  /** Test seam: how long a lock wait may last before 503 BUSY. Production uses the default (5 s). */
  lockTimeoutSeconds?: number;
}

/**
 * Phase 7F-2: POST /timetable-versions/:id/clone. Copies ANY version (DRAFT, PUBLISHED or ARCHIVED) of a DRAFT or ACTIVE academic year into
 * a NEW draft of the same year and school: next version number, revision 1, created by the cloning admin, status DRAFT, never published.
 *
 * Copied unchanged: the lessons (new ids, `source` preserved, `isLocked` per the lock mode), the immutable input snapshot and input hash (so the
 * clone is exactly as stale as its source, and the configuration hash and staleness rules are untouched), the metrics and baseline metrics, the solver
 * diagnostics, and the FROZEN period times with their capture time (a clone never re-reads the school's current schedule). `clonedFromId` records the
 * source; the year and school are taken from the locked SOURCE ROW, never from the request, and the database trigger re-checks them.
 *
 * Lock order (the one global order, never changed): academic year row FOR UPDATE -> source version row FOR SHARE -> the year's draft-slot
 * advisory lock (shared helper, CLONE rule) -> count -> max+1 -> writes. Every wait is bounded by a 5 s lock_timeout (503 BUSY).
 * The source is only ever READ (FOR SHARE keeps a DRAFT source from being deleted or edited while it is copied); it is never written.
 * Nothing is solved and the generation queue is not touched.
 */
export class TimetableVersionCloneService {
  private readonly db: PrismaClient;
  private readonly env: Record<string, string | undefined>;
  private readonly lockTimeoutSeconds: number;
  private readonly staleness: TimetableVersionStalenessService;

  constructor(deps: CloneServiceDeps = {}) {
    this.db = deps.prisma ?? prisma;
    this.staleness = new TimetableVersionStalenessService(this.db);
    this.env = deps.env ?? process.env;
    this.lockTimeoutSeconds = Math.max(1, Math.floor(deps.lockTimeoutSeconds ?? LOCK_TIMEOUT_SECONDS));
  }

  async clone(admin: { id: string; schoolId: string }, versionId: string, lockMode: LockMode, options: { includeStaleness?: boolean } = {}): Promise<CloneResult> {
    const { academicYearId } = await resolveOwnedVersion(this.db, admin.schoolId, versionId); // 404 unknown, 403 another school's
    const maxDrafts = resolveRunnerConfig(this.env).config.maxDraftsPerYear;
    let created: CloneResult;
    try {
      created = await this.db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${this.lockTimeoutSeconds}s'`);
        // 1. the year, 2. the source (both re-checked under the locks: the source may have been deleted since the check above)
        const years = await tx.$queryRaw<Array<{ status: YearStatus }>>`SELECT "status"::text AS status FROM "academic_years" WHERE "id" = ${academicYearId} AND "schoolId" = ${admin.schoolId} FOR UPDATE`;
        const sources = await tx.$queryRaw<Array<{ versionNumber: number }>>`
          SELECT "versionNumber" FROM "timetable_versions" WHERE "id" = ${versionId} AND "schoolId" = ${admin.schoolId} AND "academicYearId" = ${academicYearId} FOR SHARE`;
        const year = years[0];
        const source = sources[0];
        if (!year || !source) throw new AppError(404, 'Timetable version not found');

        // 3. the year rule, then the draft-slot lock and the count (two statements, under the lock)
        const yearRefusal = checkCloneAllowed({ yearStatus: year.status, slots: { drafts: 0, activeRuns: 0 }, max: maxDrafts });
        if (yearRefusal) throw new VersionRuleError(yearRefusal.status, yearRefusal.code, yearRefusal.message, yearRefusal.details);
        const claim = await claimDraftSlot(tx, academicYearId, maxDrafts, 'CLONE');
        const capRefusal = checkCloneAllowed({ yearStatus: year.status, slots: claim.slots, max: maxDrafts });
        if (capRefusal) throw new VersionRuleError(capRefusal.status, capRefusal.code, capRefusal.message, capRefusal.details);

        // 4. the writes: one INSERT ... SELECT for the version and one for the entries, entirely inside the database
        const max = (await tx.$queryRaw<Array<{ n: number | null }>>`SELECT max("versionNumber")::int AS n FROM "timetable_versions" WHERE "academicYearId" = ${academicYearId}`)[0]?.n ?? 0;
        const newId = randomUUID();
        await tx.$executeRaw`
          INSERT INTO "timetable_versions" ("id", "schoolId", "academicYearId", "versionNumber", "status", "solutionSource", "solverStatus", "weightsVersion", "inputHash",
            "inputSnapshot", "metrics", "baselineMetrics", "solverDiagnostics", "createdById", "clonedFromId", "periodTimes", "periodTimesCapturedAt", "revision", "updatedAt")
          SELECT ${newId}, s."schoolId", s."academicYearId", ${max + 1}::int, 'DRAFT'::"TimetableVersionStatus", s."solutionSource", s."solverStatus", s."weightsVersion", s."inputHash",
            s."inputSnapshot", s."metrics", s."baselineMetrics", s."solverDiagnostics", ${admin.id}, s."id", s."periodTimes", s."periodTimesCapturedAt", 1, now()
          FROM "timetable_versions" s WHERE s."id" = ${versionId}`;
        const copied = await tx.$executeRaw`
          INSERT INTO "timetable_entries" ("id", "versionId", "sectionId", "subjectId", "teacherId", "subjectRequirementId", "dayOfWeek", "periodNumber", "source", "isLocked")
          SELECT gen_random_uuid()::text, ${newId}, e."sectionId", e."subjectId", e."teacherId", e."subjectRequirementId", e."dayOfWeek", e."periodNumber", e."source",
            CASE WHEN ${lockMode}::text = 'ALL' THEN true WHEN ${lockMode}::text = 'NONE' THEN false ELSE e."isLocked" END
          FROM "timetable_entries" e WHERE e."versionId" = ${versionId}`;
        const expected = Number((await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "timetable_entries" WHERE "versionId" = ${versionId}`)[0]!.n);
        if (copied !== expected) throw new Error(`clone copied ${copied} of ${expected} lessons`); // rolls everything back; never a partial clone

        const row = await tx.timetableVersion.findUniqueOrThrow({ where: { id: newId }, omit: { inputSnapshot: true, solverDiagnostics: true } });
        const counts = (await tx.$queryRaw<Array<{ total: bigint; locked: bigint; manual: bigint }>>`
          SELECT count(*) AS total, count(*) FILTER (WHERE "isLocked") AS locked, count(*) FILTER (WHERE "source" = 'MANUAL') AS manual FROM "timetable_entries" WHERE "versionId" = ${newId}`)[0]!;
        return {
          ...toVersionSummary(row, { total: Number(counts.total), locked: Number(counts.locked), manual: Number(counts.manual) }),
          clonedFromId: versionId,
          clonedFromVersionNumber: source.versionNumber,
          lockMode,
          periodTimesCaptured: row.periodTimes !== null,
        };
      }, TX_OPTIONS);
    } catch (error) {
      if (isLockTimeout(error)) throw busyError();
      throw error;
    }
    if (!options.includeStaleness) return created;

    // Phase 7F-3 (opt-in): assessed AFTER the commit, so the year lock is never held while the live configuration is normalized. The clone
    // exists whatever happens here: if the assessment itself fails the answer is "could not be established", never a failed clone.
    try {
      const info = (await this.staleness.assess(admin.schoolId, academicYearId, [created.id])).get(created.id) ?? assessmentFailed();
      return { ...created, staleness: { isStale: info.isStale, reason: info.reason } };
    } catch {
      const info = assessmentFailed();
      return { ...created, staleness: { isStale: info.isStale, reason: info.reason } };
    }
  }
}

export const timetableVersionCloneService = new TimetableVersionCloneService();
