import { Prisma, type PrismaClient } from '@prisma/client';
import prisma from '../../config/database.js';
import { AppError, isUniqueViolation } from '../../utils/errors.js';
import { normalizeProblem, type NormalizedProblem } from '../timetable-generation/timetable-generation.normalizer.js';
import { loadGenerationSnapshot, readGenerationSnapshot } from '../timetable-generation/timetable-generation.loader.js';
import { type GenerationSnapshot } from '../timetable-generation/timetable-generation.normalizer.js';
import { type TimetableMetrics } from '../timetable-generation/timetable-generation.metrics.js';
import {
  assessStaleness, checkPublishable, isYearEditable, lockedCount, manualEditCount, problemFromCore, SnapshotUnusableError, validateVersion,
  type EditableEntry, type Staleness, type VersionStatus, type VersionValidation, type YearStatus,
} from './timetable-version.edit-core.js';
import { busyError, fromRefusal, isLockTimeout, VersionRuleError } from './timetable-version.errors.js';
import { ENTRY_SELECT, resolveOwnedVersion } from './timetable-version.edit-service.js';

const LOCK_TIMEOUT_SECONDS = 5;
const TX_OPTIONS = { maxWait: 15_000, timeout: 60_000 } as const;

export interface ValidationReport {
  versionId: string;
  status: VersionStatus;
  revision: number;
  /** Hard constraints hold for the timetable against the configuration it was generated from. */
  valid: boolean;
  violations: VersionValidation['violations'];
  violationCount: number;
  /** Strict rule: the live configuration is not exactly the one the timetable was generated from. */
  isStale: boolean;
  /** Authoritative metrics (WEIGHTS_V1); null when the timetable is not valid. */
  metrics: TimetableMetrics | null;
  informational: {
    staleReason: Staleness['reason'];
    /** Why the live configuration cannot be normalized, when it cannot (bounded). */
    configurationIssues: Array<{ code: string; message: string }>;
    academicYearStatus: YearStatus;
    entryCount: number;
    lockedCount: number;
    manualEditCount: number;
    /** DRAFT, valid, not stale, and the academic year allows publishing: what a publish request would be checked against. */
    publishable: boolean;
    stats: TimetableMetrics['informational'] | null;
  };
}

export interface PublishResult {
  versionId: string;
  status: 'PUBLISHED';
  revision: number;
  publishedAt: string;
  /** The version that was published until now (it is ARCHIVED by the same transaction), or null. */
  archivedVersionId: string | null;
}

export interface PublishHooks {
  /** Test seams (production passes none). Called inside the publish transaction. */
  afterLocks?: () => Promise<void> | void;
  afterArchive?: () => Promise<void> | void;
}

/**
 * The Phase 6 snapshot reader and the normalizer are reused unchanged. The normalizer insists the academic year is DRAFT (it was
 * written for generation). Publishing is also allowed in an ACTIVE year, and the year's own state is checked separately and
 * explicitly, so the copy handed to the normalizer carries status DRAFT: it is only about the CONFIGURATION.
 */
export function normalizeConfiguration(snapshot: GenerationSnapshot): ReturnType<typeof normalizeProblem> {
  return normalizeProblem({ ...snapshot, academicYear: { ...snapshot.academicYear, status: 'DRAFT' } });
}

/** Mirror of the rows the generation persistence share-locks, so a configuration writer waits until the publish has committed. */
async function lockConfigurationDependencies(tx: Prisma.TransactionClient, yearId: string, problem: NormalizedProblem): Promise<void> {
  const teacherIds = [...new Set(problem.core.assignments.map((a) => a.teacherId))].sort();
  const subjectIds = [...new Set(problem.core.assignments.map((a) => a.subjectId))].sort();
  const assignmentIds = problem.core.assignments.map((a) => a.id).sort();
  const requirementIds = [...new Set(problem.core.assignments.map((a) => a.subjectRequirementId))].sort();
  await tx.$queryRaw`SELECT "id" FROM "schedule_configs" WHERE "academicYearId" = ${yearId} FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "grades" WHERE "academicYearId" = ${yearId} ORDER BY "id" FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "teachers" WHERE "id" = ANY(${teacherIds}) ORDER BY "id" FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "teacher_subjects" WHERE "teacherId" = ANY(${teacherIds}) AND "subjectId" = ANY(${subjectIds}) ORDER BY "id" FOR SHARE`;
  await tx.$queryRaw`
    SELECT tsg."id" FROM "teacher_subject_grades" tsg
    JOIN "teacher_subjects" ts ON ts."id" = tsg."teacherSubjectId"
    JOIN "grades" g ON g."id" = tsg."gradeId"
    WHERE ts."teacherId" = ANY(${teacherIds}) AND ts."subjectId" = ANY(${subjectIds}) AND g."academicYearId" = ${yearId}
    ORDER BY tsg."id" FOR SHARE OF tsg`;
  await tx.$queryRaw`SELECT "id" FROM "section_subject_teachers" WHERE "id" = ANY(${assignmentIds}) ORDER BY "id" FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "subject_requirements" WHERE "id" = ANY(${requirementIds}) ORDER BY "id" FOR SHARE`;
}

const toEditable = (rows: Array<{ id: string; sectionId: string; subjectId: string; teacherId: string; subjectRequirementId: string; dayOfWeek: string; periodNumber: number; source: string; isLocked: boolean }>): EditableEntry[] =>
  rows.map((r) => ({ ...r, source: r.source as EditableEntry['source'] }));

export class TimetableVersionPublishService {
  constructor(private readonly db: PrismaClient = prisma, private readonly hooks: PublishHooks = {}) {}

  /**
   * GET /timetable-versions/:id/validation : READ-ONLY. Validates the whole timetable against the configuration it was generated
   * from (rebuilt from the stored snapshot), computes the authoritative metrics, and tells whether the live configuration has moved
   * on (strict staleness). Allowed for every status. Nothing is written and no lock is taken.
   */
  async validate(schoolId: string, versionId: string): Promise<ValidationReport> {
    const { academicYearId } = await resolveOwnedVersion(this.db, schoolId, versionId);

    // one consistent view of the version and its lessons
    const loaded = await this.db.$transaction(
      async (tx) => {
        const version = await tx.timetableVersion.findUnique({
          where: { id: versionId },
          select: { id: true, status: true, revision: true, inputSnapshot: true, academicYear: { select: { name: true, status: true } } },
        });
        if (!version) throw new AppError(404, 'Timetable version not found');
        const entries = toEditable(await tx.timetableEntry.findMany({ where: { versionId }, select: ENTRY_SELECT }));
        return { version, entries };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 30_000 }
    );
    const { version, entries } = loaded;

    let problem: NormalizedProblem;
    try {
      problem = problemFromCore(version.inputSnapshot, { schoolId, academicYear: { id: academicYearId, name: version.academicYear.name } });
    } catch (error) {
      if (error instanceof SnapshotUnusableError) throw new VersionRuleError(409, 'SNAPSHOT_UNUSABLE', 'This timetable cannot be validated because its stored configuration snapshot is unusable');
      throw error;
    }

    const verdict = validateVersion(problem, entries);
    const normalized = normalizeConfiguration(await loadGenerationSnapshot(this.db, schoolId, academicYearId));
    const staleness = assessStaleness(problem.core, normalized.ok ? normalized.problem.core : null);
    const yearStatus = version.academicYear.status as YearStatus;
    const status = version.status as VersionStatus;

    return {
      versionId,
      status,
      revision: version.revision,
      valid: verdict.valid,
      violations: verdict.violations,
      violationCount: verdict.violationCount,
      isStale: staleness.stale,
      metrics: verdict.metrics,
      informational: {
        staleReason: staleness.reason,
        configurationIssues: normalized.ok ? [] : normalized.issues.slice(0, 20).map((i) => ({ code: i.code, message: i.message })),
        academicYearStatus: yearStatus,
        entryCount: entries.length,
        lockedCount: lockedCount(entries),
        manualEditCount: manualEditCount(entries),
        publishable: status === 'DRAFT' && isYearEditable(yearStatus) && verdict.valid && !staleness.stale,
        stats: verdict.metrics ? verdict.metrics.informational : null,
      },
    };
  }

  /**
   * POST /timetable-versions/:id/publish : DRAFT -> PUBLISHED, and the version that was published until now -> ARCHIVED, in ONE
   * transaction. Lock order (the same everywhere): academic year FOR UPDATE, then the involved version rows FOR UPDATE ordered
   * by id, then the configuration FOR SHARE. Every precondition is re-checked under those locks, and the fresh configuration
   * is normalized and the lessons validated against it: a stale or invalid draft is never published. Any failure rolls back
   * everything, so the previously published version stays published and unchanged.
   */
  async publish(admin: { id: string; schoolId: string }, versionId: string, body: { expectedRevision: number; expectedPublishedVersionId: string | null }): Promise<PublishResult> {
    const { schoolId } = admin;
    const { academicYearId } = await resolveOwnedVersion(this.db, schoolId, versionId);

    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_SECONDS}s'`);

        // 1. the academic year (serialises every publish of this year, and every edit, which share-locks it)
        const years = await tx.$queryRaw<Array<{ name: string; status: YearStatus }>>`SELECT "name", "status"::text AS status FROM "academic_years" WHERE "id" = ${academicYearId} AND "schoolId" = ${schoolId} FOR UPDATE`;
        const year = years[0];
        if (!year) throw new AppError(404, 'Academic year not found');

        // 2. the target and the currently published version, in a deterministic order
        const rows = await tx.$queryRaw<Array<{ id: string; status: VersionStatus; revision: number }>>`
          SELECT "id", "status"::text AS status, "revision" FROM "timetable_versions"
          WHERE "academicYearId" = ${academicYearId} AND "schoolId" = ${schoolId} AND ("id" = ${versionId} OR "status" = 'PUBLISHED'::"TimetableVersionStatus")
          ORDER BY "id" FOR UPDATE`;
        const target = rows.find((r) => r.id === versionId);
        if (!target) throw new AppError(404, 'Timetable version not found'); // deleted while we waited
        const published = rows.find((r) => r.status === 'PUBLISHED' && r.id !== versionId) ?? null;

        // 3. state-only preconditions, in a fixed order
        const refusal = checkPublishable({
          target: { status: target.status, revision: target.revision },
          yearStatus: year.status,
          currentPublishedId: published ? published.id : null,
          expectedRevision: body.expectedRevision,
          expectedPublishedVersionId: body.expectedPublishedVersionId,
        });
        if (refusal) throw fromRefusal(refusal);

        // 4. the draft, its lessons and its original problem
        const version = await tx.timetableVersion.findUniqueOrThrow({ where: { id: versionId }, select: { inputSnapshot: true } });
        const entries = toEditable(await tx.timetableEntry.findMany({ where: { versionId }, select: ENTRY_SELECT }));
        let stored: NormalizedProblem;
        try {
          stored = problemFromCore(version.inputSnapshot, { schoolId, academicYear: { id: academicYearId, name: year.name } });
        } catch (error) {
          if (error instanceof SnapshotUnusableError) throw new VersionRuleError(409, 'SNAPSHOT_UNUSABLE', 'This timetable cannot be published because its stored configuration snapshot is unusable');
          throw error;
        }

        // 5. configuration share-locks, then the FRESH configuration
        await lockConfigurationDependencies(tx, academicYearId, stored);
        await this.hooks.afterLocks?.();
        const fresh = normalizeConfiguration(await readGenerationSnapshot(tx, schoolId, academicYearId));
        if (!fresh.ok) {
          throw new VersionRuleError(409, 'STALE_CONFIGURATION', 'The academic year configuration no longer allows this timetable. Regenerate it', {
            reason: 'CONFIGURATION_NOT_NORMALIZABLE',
            issues: fresh.issues.slice(0, 20).map((i) => ({ code: i.code, message: i.message })),
          });
        }
        const staleness = assessStaleness(stored.core, fresh.problem.core);
        if (staleness.stale) {
          throw new VersionRuleError(409, 'STALE_CONFIGURATION', 'The academic year configuration changed after this timetable was generated. Regenerate it', { reason: staleness.reason });
        }

        // 6. fresh validation of every lesson against the fresh problem
        const verdict = validateVersion(fresh.problem, entries);
        if (!verdict.valid || verdict.metrics === null) {
          throw new VersionRuleError(409, 'VALIDATION_FAILED', 'The timetable does not satisfy the hard constraints and cannot be published', { violationCount: verdict.violationCount, violations: verdict.violations.slice(0, 20) });
        }

        // 7. archive first (the partial unique index allows one PUBLISHED per year), then publish; both fenced by status
        let archivedVersionId: string | null = null;
        if (published) {
          const archived = await tx.$executeRaw`
            UPDATE "timetable_versions"
            SET "status" = 'ARCHIVED'::"TimetableVersionStatus", "archivedAt" = now(), "revision" = "revision" + 1, "updatedAt" = now()
            WHERE "id" = ${published.id} AND "status" = 'PUBLISHED'::"TimetableVersionStatus"`;
          if (archived !== 1) throw new VersionRuleError(409, 'PUBLISHED_CHANGED', 'The published timetable changed while publishing. Reload and review it again');
          archivedVersionId = published.id;
        }
        await this.hooks.afterArchive?.();
        const done = await tx.$queryRaw<Array<{ publishedAt: Date }>>`
          UPDATE "timetable_versions"
          SET "status" = 'PUBLISHED'::"TimetableVersionStatus", "publishedAt" = now(), "publishedById" = ${admin.id}, "revision" = "revision" + 1,
              "metrics" = ${JSON.stringify(verdict.metrics)}::jsonb, "updatedAt" = now()
          WHERE "id" = ${versionId} AND "status" = 'DRAFT'::"TimetableVersionStatus" AND "revision" = ${body.expectedRevision}
          RETURNING "publishedAt"`;
        if (done.length !== 1) throw new VersionRuleError(409, 'REVISION_CONFLICT', 'The timetable was changed by someone else. Reload it and try again', { revision: target.revision });

        return { versionId, status: 'PUBLISHED' as const, revision: body.expectedRevision + 1, publishedAt: done[0]!.publishedAt.toISOString(), archivedVersionId };
      }, TX_OPTIONS);
    } catch (error) {
      if (isLockTimeout(error)) throw busyError();
      // the one-published-per-year index is the final backstop: losing that race is the same outcome as PUBLISHED_CHANGED
      if (isUniqueViolation(error)) throw new VersionRuleError(409, 'PUBLISHED_CHANGED', 'The published timetable changed while publishing. Reload and review it again');
      throw error;
    }
  }
}

export const timetableVersionPublishService = new TimetableVersionPublishService();
